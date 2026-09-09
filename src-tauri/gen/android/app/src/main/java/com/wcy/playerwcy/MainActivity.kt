package com.wcy.playerwcy

import android.content.Intent
import android.content.pm.ActivityInfo
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : TauriActivity() {
  companion object {
    private const val REQ_SAF_TREE = 7101
    private const val PREFS = "saf_probe"
    private const val KEY_TREE = "tree_uri"
    private val VIDEO_EXTS = listOf("mp4", "mov", "m4v", "webm", "mkv", "avi")
  }

  private lateinit var mWebView: WebView
  private var mediaServer: MediaServer? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 本地媒体 HTTP 服务（方案A）：127.0.0.1:18899，供 <video> 拉流（WebView 媒体管线
    // 绕过 wry 拦截层，自定义协议不可用，content:// 亦不支持，回环 HTTP 是唯一通路）
    mediaServer = MediaServer(this, MediaServer.PORT).also { it.start() }
  }

  override fun onDestroy() {
    mediaServer?.stop()
    super.onDestroy()
  }

  override fun onWebViewCreate(webView: WebView) {
    mWebView = webView
    webView.addJavascriptInterface(
      object {
        /** 前端横屏反转：手动在 landscape(0°)/reverseLandscape(180°) 间切换，不随重力 */
        @JavascriptInterface
        fun rotate() {
          runOnUiThread {
            requestedOrientation =
              if (requestedOrientation == ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE)
                ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
              else
                ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
          }
        }

        /** 选择媒体文件夹（SAF，持久授权），结果经 __safPicked 回调前端 */
        @JavascriptInterface
        fun pickFolder() {
          runOnUiThread {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            intent.addFlags(
              Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            )
            @Suppress("DEPRECATION")
            startActivityForResult(intent, REQ_SAF_TREE)
          }
        }

        /** 用已持久化目录列出视频（启动恢复用，无需再次授权） */
        @JavascriptInterface
        fun listSaved() {
          emit(listVideos())
        }

        /** 是否已选过目录（前端决定"直接恢复"还是"引导选择"） */
        @JavascriptInterface
        fun hasFolder(): Boolean = treeUri() != null
      },
      "NativeBridge",
    )
  }

  @Deprecated("Deprecated in Java")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != REQ_SAF_TREE) return
    if (resultCode != android.app.Activity.RESULT_OK || data?.data == null) {
      emit(err("未选择目录或已取消"))
      return
    }
    val treeUri: Uri = data.data!!
    try {
      contentResolver.takePersistableUriPermission(
        treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION
      )
    } catch (e: SecurityException) {
      emit(err("持久化授权失败: ${e.message}"))
      return
    }
    getSharedPreferences(PREFS, MODE_PRIVATE)
      .edit().putString(KEY_TREE, treeUri.toString()).apply()
    emit(listVideos())
  }

  private fun treeUri(): Uri? =
    getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_TREE, null)?.let(Uri::parse)

  /** 列出已选目录下的视频（按文件名小写排序，对齐 macOS folder.rs 语义）：
   *  [{id(docId), name, size, url(本机HTTP可播地址)}] */
  private fun listVideos(): String {
    val tree = treeUri() ?: return err("尚未选择过目录")
    return try {
      val rootId = DocumentsContract.getTreeDocumentId(tree)
      val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, rootId)
      val found = mutableListOf<Triple<String, String, Long>>() // (docId, name, size)
      contentResolver.query(
        childrenUri,
        arrayOf(
          DocumentsContract.Document.COLUMN_DOCUMENT_ID,
          DocumentsContract.Document.COLUMN_DISPLAY_NAME,
          DocumentsContract.Document.COLUMN_SIZE,
        ),
        null, null, null,
      )?.use { c ->
        while (c.moveToNext()) {
          val docId = c.getString(0)
          val name = c.getString(1)
          val size = c.getLong(2)
          val ext = name.substringAfterLast('.', "").lowercase()
          if (ext in VIDEO_EXTS && size > 0) {
            found.add(Triple(docId, name, size))
          }
        }
      }
      found.sortBy { it.second.lowercase() }
      val arr = JSONArray()
      for ((docId, name, size) in found) {
        arr.put(
          JSONObject()
            .put("id", docId)
            .put("name", name)
            .put("size", size)
            .put("url", "http://127.0.0.1:${MediaServer.PORT}/media/" +
              java.net.URLEncoder.encode(docId, "UTF-8") +
              "?name=" + java.net.URLEncoder.encode(name, "UTF-8"))
        )
      }
      JSONObject()
        .put("ok", true).put("dir", rootId.substringAfterLast('/', ""))
        .put("count", arr.length()).put("items", arr)
        .toString()
    } catch (e: Exception) {
      err("读取目录失败: ${e.message}")
    }
  }

  private fun err(msg: String): String =
    JSONObject().put("ok", false).put("error", msg).toString()

  /** 回调前端（evaluateJavascript 需 UI 线程；json 直接作为 JS 对象字面量内插） */
  private fun emit(json: String) {
    if (!::mWebView.isInitialized) return
    mWebView.post {
      mWebView.evaluateJavascript("window.__safPicked && window.__safPicked($json)", null)
    }
  }
}
