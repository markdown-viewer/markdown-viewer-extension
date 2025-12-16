package com.example.markdown_viewer_mobile

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.BufferedReader
import java.io.InputStreamReader

class MainActivity : FlutterActivity() {
    private val CHANNEL = "com.example.markdown_viewer_mobile/file"
    private var pendingFileContent: String? = null
    private var pendingFileName: String? = null
    private var methodChannel: MethodChannel? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        
        methodChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
        methodChannel?.setMethodCallHandler { call, result ->
            when (call.method) {
                "getInitialFile" -> {
                    if (pendingFileContent != null) {
                        result.success(mapOf(
                            "content" to pendingFileContent,
                            "filename" to pendingFileName
                        ))
                        // Clear after sending
                        pendingFileContent = null
                        pendingFileName = null
                    } else {
                        result.success(null)
                    }
                }
                else -> result.notImplemented()
            }
        }
        
        // Process initial intent
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent == null) return
        
        val action = intent.action
        val uri = intent.data
        
        if ((action == Intent.ACTION_VIEW || action == Intent.ACTION_SEND) && uri != null) {
            try {
                val content = readContentFromUri(uri)
                val filename = getFilenameFromUri(uri)
                
                if (content != null) {
                    // If Flutter is ready, send directly via channel
                    if (methodChannel != null) {
                        methodChannel?.invokeMethod("onFileReceived", mapOf(
                            "content" to content,
                            "filename" to filename
                        ))
                    }
                    // Also store as pending in case Flutter isn't ready yet
                    pendingFileContent = content
                    pendingFileName = filename
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    private fun readContentFromUri(uri: Uri): String? {
        return try {
            contentResolver.openInputStream(uri)?.use { inputStream ->
                BufferedReader(InputStreamReader(inputStream)).use { reader ->
                    reader.readText()
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
            null
        }
    }

    private fun getFilenameFromUri(uri: Uri): String {
        var filename = "document.md"
        
        // Try to get filename from URI path
        uri.lastPathSegment?.let { segment ->
            if (segment.contains(".")) {
                filename = segment.substringAfterLast("/")
            }
        }
        
        // Try to get filename from content resolver
        try {
            contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                    if (nameIndex >= 0) {
                        cursor.getString(nameIndex)?.let { name ->
                            filename = name
                        }
                    }
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        
        return filename
    }
}
