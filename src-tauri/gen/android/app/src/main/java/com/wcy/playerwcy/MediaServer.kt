package com.wcy.playerwcy

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.nio.channels.FileChannel

/**
 * 本地媒体 HTTP 服务（方案 A）：把 SAF 的 content:// 文档桥接给 WebView 的 <video>。
 *
 * 背景：Android WebView 的媒体请求绕过 shouldInterceptRequest（wry 自定义协议挂载点），
 * stream:// 协议无法喂 video（SAF 探针已证）；content:// 也不被 video 支持。
 * 唯一可靠供流方式 = 本机回环 HTTP：video.src = http://127.0.0.1:18899/media/<docId>。
 *
 * 实现为零依赖纯 Kotlin（本环境 gradle 对新增外部依赖进 Kotlin classpath 不稳定，
 * NanoHTTPD 模块依赖与 libs jar 均失效，故手写）。
 * Range/206 完整实现（对齐 Rust media_proto.rs 语义）：start-end / start- / -suffix。
 */
class MediaServer(private val context: Context, val port: Int) {

  companion object {
    const val PORT = 18899
    private val MIME = mapOf(
      "mp4" to "video/mp4", "m4v" to "video/mp4", "mov" to "video/quicktime",
      "webm" to "video/webm", "mkv" to "video/x-matroska", "avi" to "video/x-msvideo",
    )

    fun mimeOf(name: String): String =
      MIME[name.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"
  }

  private var serverSocket: ServerSocket? = null
  @Volatile private var running = false

  fun start() {
    running = true
    serverSocket = ServerSocket(port, 8, InetAddress.getByName("127.0.0.1"))
    Thread({
      try {
        while (running) {
          val client = serverSocket?.accept() ?: break
          Thread { handle(client) }.start()
        }
      } catch (_: Exception) {
        /* stop() 关闭 socket 触发退出 */
      }
    }, "MediaServer").apply { isDaemon = true }.start()
  }

  fun stop() {
    running = false
    try { serverSocket?.close() } catch (_: Exception) { /* 忽略 */ }
  }

  /* ---- 单个连接处理：GET /media/<docId>?name=xxx，支持 Range ---- */
  private fun handle(client: Socket) {
    client.use { sock ->
      try {
        sock.soTimeout = 15000
        val input = sock.getInputStream()
        val output = sock.getOutputStream()

        val requestLine = readLine(input) ?: return
        if (!requestLine.startsWith("GET ")) {
          writeSimple(output, 405, "Method Not Allowed"); return
        }
        var rangeHeader: String? = null
        while (true) {
          val line = readLine(input) ?: break
          if (line.isEmpty()) break
          val idx = line.indexOf(':')
          if (idx > 0 && line.substring(0, idx).equals("Range", true)) {
            rangeHeader = line.substring(idx + 1).trim()
          }
        }

        val pathQuery = requestLine.substring(4).trim().split(" ")[0]
        val pathPart = pathQuery.substringBefore('?')
        val queryName = pathQuery.substringAfter("name=", "").takeIf { pathQuery.contains("name=") }
        val docId = URLDecoder.decode(pathPart.removePrefix("/media/"), "UTF-8")
        if (docId.isEmpty() || docId.contains("..")) {
          writeSimple(output, 404, "bad docId"); return
        }

        val treeStr = context.getSharedPreferences("saf_probe", Context.MODE_PRIVATE)
          .getString("tree_uri", null)
        if (treeStr == null) { writeSimple(output, 404, "no folder"); return }

        val tree = Uri.parse(treeStr)
        val uri = DocumentsContract.buildDocumentUriUsingTree(tree, docId)
        val pfd = context.contentResolver.openFileDescriptor(uri, "r")
        if (pfd == null) { writeSimple(output, 404, "cannot open"); return }

        pfd.use {
          val size = it.statSize
          val mime = mimeOf(queryName?.let { n -> URLDecoder.decode(n, "UTF-8") } ?: docId)
          val range = rangeHeader?.let { h -> parseRange(h, size) }

          val (status, start, end) = when (range) {
            null -> Triple("200 OK", 0L, size - 1)
            else -> Triple("206 Partial Content", range.first, minOf(range.second, size - 1))
          }
          val len = end - start + 1
          if (len <= 0 || start < 0 || start >= size) {
            writeSimple(output, 416, "range err"); return
          }

          val head = buildString {
            append("HTTP/1.1 ").append(status).append("\r\n")
            append("Content-Type: ").append(mime).append("\r\n")
            append("Content-Length: ").append(len).append("\r\n")
            append("Accept-Ranges: bytes\r\n")
            if (status.startsWith("206")) {
              append("Content-Range: bytes ").append(start).append('-').append(end)
                .append('/').append(size).append("\r\n")
            }
            append("Connection: close\r\n\r\n")
          }
          output.write(head.toByteArray(Charsets.ISO_8859_1))
          output.flush()

          FileChannelInputStream(java.io.FileInputStream(it.fileDescriptor).channel, start, len)
            .use { body -> copy(body, output) }
          output.flush()
        }
      } catch (_: Exception) {
        /* 客户端断开等：直接结束连接 */
      }
    }
  }

  /* ---- 工具 ---- */

  private fun readLine(input: InputStream): String? {
    val sb = StringBuilder()
    while (true) {
      val b = input.read()
      if (b < 0) return if (sb.isEmpty()) null else sb.toString()
      if (b == '\n'.code) return sb.toString().trimEnd('\r')
      sb.append(b.toChar())
      if (sb.length > 16384) return null
    }
  }

  /** 解析 Range 头：bytes=start-end / start- / -suffix → (start, end) 含端点；非法返回 null */
  private fun parseRange(value: String, size: Long): Pair<Long, Long>? {
    val v = value.trim().removePrefix("bytes=")
    val maxEnd = size - 1
    if (v.startsWith("-")) {
      val n = v.substring(1).toLongOrNull() ?: return null
      if (n <= 0) return null
      return Pair(maxOf(0, size - n), maxEnd)
    }
    val parts = v.split("-", limit = 2)
    if (parts.size != 2) return null
    val start = parts[0].toLongOrNull() ?: return null
    if (start >= size) return null
    val end = if (parts[1].isEmpty()) maxEnd
    else (parts[1].toLongOrNull() ?: return null).coerceAtMost(maxEnd)
    if (start > end) return null
    return Pair(start, end)
  }

  private fun writeSimple(output: OutputStream, code: Int, msg: String) {
    val body = msg.toByteArray(Charsets.UTF_8)
    output.write(
      ("HTTP/1.1 $code $msg\r\nContent-Type: text/plain; charset=utf-8\r\n" +
        "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n")
        .toByteArray(Charsets.ISO_8859_1)
    )
    output.write(body)
    output.flush()
  }

  private fun copy(input: InputStream, output: OutputStream) {
    val buf = ByteArray(64 * 1024)
    while (true) {
      val n = input.read(buf)
      if (n < 0) break
      output.write(buf, 0, n)
    }
  }

  /** 从 FileChannel 指定位置起读固定长度 */
  private class FileChannelInputStream(
    private val channel: FileChannel,
    start: Long,
    private val remaining: Long,
  ) : InputStream() {
    private var left = remaining

    init { channel.position(start) }
    override fun read(): Int {
      if (left <= 0) return -1
      val buf = java.nio.ByteBuffer.allocate(1)
      val n = channel.read(buf)
      if (n <= 0) { left = 0; return -1 }
      left--
      return buf.get(0).toInt() and 0xFF
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
      if (left <= 0) return -1
      val want = minOf(len.toLong(), left, 64L * 1024).toInt()
      val buf = java.nio.ByteBuffer.wrap(b, off, want)
      val n = channel.read(buf)
      if (n <= 0) { left = 0; return -1 }
      left -= n
      return n
    }

    override fun close() { channel.close() }
  }
}
