package com.wcy.playerwcy

import android.app.Activity
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
import java.io.File

class MainActivity : TauriActivity() {
  companion object {
    private const val REQ_SAF_TREE = 7101
    private const val PREFS = "saf_probe"
    private const val KEY_TREE = "tree_uri"
    private val VIDEO_EXTS = listOf("mp4", "mov", "m4v", "webm", "mkv", "avi")
  }

  private lateinit var mWebView: WebView

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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

        /** SAF 探针：选择文件夹（ACTION_OPEN_DOCUMENT_TREE，支持持久化授权） */
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

        /** SAF 探针：用已持久化的目录直接列出视频（验证重启后授权仍有效） */
        @JavascriptInterface
        fun listSaved() {
          emit(listVideos())
        }

        /** SAF 探针二期：content URI 直接播失败（WebView video 不支持 content scheme），
         *  改为复制第一个视频到 app 缓存（真实路径），前端走 stream 协议播放——
         *  同时验证 stream 自定义协议在 Android WebView 的可用性 */
        @JavascriptInterface
        fun playFirst() {
          try {
            emit(stage("1:进入playFirst"))
            val tree = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_TREE, null)
            emit(stage("2:tree=$tree"))
            if (tree == null) {
              emit(err("尚未选目录，先点SAF选文件夹"))
              return
            }
            emit(playFirstViaCache())
          } catch (e: Throwable) {
            emit(err("3:playFirst异常 ${e}"))
          }
        }
      },
      "NativeBridge",
    )
  }

  @Deprecated("Deprecated in Java")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != REQ_SAF_TREE) return
    if (resultCode != Activity.RESULT_OK || data?.data == null) {
      emit(err("未选择目录或已取消"))
      return
    }
    val treeUri: Uri = data.data!!
    // 核心验证点：持久化读权限（重启后无需再次授权）
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

  /** 列出已选目录下的视频（DocumentsContract 子文档查询，过滤视频扩展名） */
  private fun listVideos(): String {
    val treeStr = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_TREE, null)
      ?: return err("尚未选择过目录")
    return try {
      val treeUri = Uri.parse(treeStr)
      val rootId = DocumentsContract.getTreeDocumentId(treeUri)
      val childrenUri =
        DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, rootId)
      val arr = JSONArray()
      contentResolver.query(
        childrenUri,
        arrayOf(
          DocumentsContract.Document.COLUMN_DOCUMENT_ID,
          DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        ),
        null, null, null,
      )?.use { c ->
        while (c.moveToNext()) {
          val docId = c.getString(0)
          val name = c.getString(1)
          val ext = name.substringAfterLast('.', "").lowercase()
          if (ext in VIDEO_EXTS) {
            arr.put(
              JSONObject()
                .put("name", name)
                .put(
                  "uri",
                  DocumentsContract.buildDocumentUriUsingTree(treeUri, docId).toString(),
                )
            )
          }
        }
      }
      JSONObject().put("ok", true).put("count", arr.length()).put("items", arr).toString()
    } catch (e: Exception) {
      err("读取目录失败: ${e.message}")
    }
  }

  private fun err(msg: String): String =
    JSONObject().put("ok", false).put("error", msg).toString()

  /** 探针二期：找到第一个视频（限 200MB 内），经 ContentResolver 复制到 cacheDir，
   *  返回真实路径供前端 stream 协议播放（带阶段打点） */
  private fun playFirstViaCache(): String {
    val treeStr = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_TREE, null)
      ?: return err("尚未选择过目录，先点 SAF选文件夹")
    return try {
      val treeUri = Uri.parse(treeStr)
      val rootId = DocumentsContract.getTreeDocumentId(treeUri)
      val childrenUri =
        DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, rootId)
      var found: Triple<String, String, Long>? = null // (docId, name, size)
      contentResolver.query(
        childrenUri,
        arrayOf(
          DocumentsContract.Document.COLUMN_DOCUMENT_ID,
          DocumentsContract.Document.COLUMN_DISPLAY_NAME,
          DocumentsContract.Document.COLUMN_SIZE,
        ),
        null, null, null,
      )?.use { c ->
        while (c.moveToNext() && found == null) {
          val name = c.getString(1)
          val ext = name.substringAfterLast('.', "").lowercase()
          val size = c.getLong(2)
          if (ext in VIDEO_EXTS && size in 1..(200L * 1024 * 1024)) {
            found = Triple(c.getString(0), name, size)
          }
        }
      }
      val f = found ?: return err("4:目录中没有 ≤200MB 的视频")
      emit(stage("5:选中 ${f.second} (${f.third / 1024 / 1024}MB)，开始复制"))
      val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, f.first)
      val cacheFile = File(cacheDir, "probe_video")
      contentResolver.openInputStream(docUri)?.use { input ->
        cacheFile.outputStream().use { output -> input.copyTo(output) }
      } ?: return err("6:打开文档流失败")
      if (cacheFile.length() != f.third) {
        return err("7:复制不完整 ${cacheFile.length()}/${f.third}")
      }
      emit(stage("8:复制完成，开始播放"))
      JSONObject()
        .put("ok", true).put("mode", "play")
        .put("path", cacheFile.absolutePath)
        .toString()
    } catch (e: Exception) {
      err("9:复制/播放准备失败 ${e}")
    }
  }

  private fun stage(msg: String): String =
    JSONObject().put("ok", true).put("mode", "stage").put("msg", msg).toString()

  /** 回调前端（evaluateJavascript 需 UI 线程；json 直接作为 JS 对象字面量内插） */
  private fun emit(json: String) {
    if (!::mWebView.isInitialized) return
    mWebView.post {
      mWebView.evaluateJavascript("window.__safProbe && window.__safProbe($json)", null)
    }
  }
}
