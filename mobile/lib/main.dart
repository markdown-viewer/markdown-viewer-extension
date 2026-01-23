import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:ant_icons/ant_icons.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:getwidget/getwidget.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
// Import for Android features
import 'package:webview_flutter_android/webview_flutter_android.dart';
// Import for iOS/macOS features
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

import 'services/cache_storage.dart';
import 'services/localization_service.dart';
import 'theme/app_theme.dart';
import 'services/recent_files_service.dart';
import 'services/settings_service.dart';
import 'services/theme_registry_service.dart';
import 'pages/settings_page.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await settingsService.init();
  await cacheStorage.init();
  await localization.init();
  await themeRegistry.init();
  await recentFilesService.init();
  runApp(const MarkdownViewerApp());
}

class MarkdownViewerApp extends StatelessWidget {
  const MarkdownViewerApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: localization.t('extensionName'),
      debugShowCheckedModeBanner: false,
      theme: appTheme,
      home: const MarkdownViewerHome(),
    );
  }
}

/// Get file type from filename extension
String _getFileType(String filename) {
  final ext = filename.toLowerCase().split('.').last;
  switch (ext) {
    case 'mermaid':
      return 'mermaid';
    case 'vega':
      return 'vega';
    case 'vl':
    case 'vega-lite':
      return 'vega-lite';
    case 'gv':
    case 'dot':
      return 'dot';
    case 'infographic':
      return 'infographic';
    case 'md':
    case 'markdown':
    default:
      return 'markdown';
  }
}

/// Wrap non-markdown file content in markdown code block format
String _wrapFileContent(String content, String filename) {
  final fileType = _getFileType(filename);
  
  // If already markdown, return as-is
  if (fileType == 'markdown') {
    return content;
  }
  
  // Wrap the content in appropriate code block
  return '```$fileType\n$content\n```';
}

class MarkdownViewerHome extends StatefulWidget {
  const MarkdownViewerHome({super.key});

  @override
  State<MarkdownViewerHome> createState() => _MarkdownViewerHomeState();
}

class _MarkdownViewerHomeState extends State<MarkdownViewerHome> {
  late final WebViewController _controller;
  String? _currentFilename;
  String? _currentFilePath;  // Track current file path for scroll position save
  String _currentTheme = 'default';
  bool _webViewReady = false;
  bool _hasContent = false;
  String? _pendingContent;
  String? _pendingFilename;
  String? _currentFileDir;
  List<Map<String, dynamic>> _headings = [];
  
  // Export progress state
  bool _isExporting = false;
  int _exportProgress = 0;
  int _exportTotal = 0;
  String _exportPhase = 'processing';
  
  // Platform channel for receiving files from Android/iOS
  static const _fileChannel = MethodChannel('com.example.markdown_viewer_mobile/file');

  @override
  void initState() {
    super.initState();

    // Load saved theme
    _currentTheme = settingsService.theme;
    
    // Listen to recent files changes
    recentFilesService.addListener(_onRecentFilesChanged);
    
    // Listen to locale changes for UI rebuild
    localization.addListener(_onLocaleChanged);
    
    // Set up file receiving handler
    _setupFileReceiver();

    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setOnConsoleMessage((message) {
        debugPrint('[WebView Console] ${message.level.name}: ${message.message}');
      })
      ..addJavaScriptChannel(
        'MarkdownViewer',
        onMessageReceived: (JavaScriptMessage message) {
          _handleWebViewMessage(message.message);
        },
      )
      ..setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) {
            return NavigationDecision.navigate;
          },
          onPageFinished: (url) {
            _checkWebViewReady();
          },
          onWebResourceError: (error) {
            debugPrint('[Mobile] WebResource error: ${error.description} (${error.errorCode})');
          },
        ),
      );

    // Configure Android-specific settings for font access in SVG/Canvas
    if (_controller.platform is AndroidWebViewController) {
      final androidController = _controller.platform as AndroidWebViewController;
      // Enable debugging for development
      // AndroidWebViewController.enableDebugging(true);
      // Allow file access from the WebView
      androidController.setAllowFileAccess(true);
      // Allow content access
      androidController.setAllowContentAccess(true);
      // Allow mixed content (secure page loading insecure resources)
      androidController.setMixedContentMode(MixedContentMode.alwaysAllow);
      // Other settings
      androidController.setMediaPlaybackRequiresUserGesture(false);
    }

    // Configure iOS/macOS-specific settings
    if (_controller.platform is WebKitWebViewController) {
      // Enable Safari Web Inspector for debugging (set to true when needed)
      // final webkitController = _controller.platform as WebKitWebViewController;
      // webkitController.setInspectable(true);
    }

    _initWebView();
  }
  
  /// Set up platform channel to receive files from native side
  void _setupFileReceiver() {
    // Listen for files sent while app is running
    _fileChannel.setMethodCallHandler((call) async {
      if (call.method == 'onFileReceived') {
        final args = call.arguments as Map<dynamic, dynamic>;
        final content = args['content'] as String?;
        final filename = args['filename'] as String?;
        
        if (content != null) {
          debugPrint('[Mobile] Received file from native: $filename');
          await _handleReceivedFile(content, filename ?? 'document.md');
        }
      }
    });
    
    // Check for initial file (app launched with file)
    _checkInitialFile();
  }
  
  /// Handle file received from external source (Intent/Share)
  Future<void> _handleReceivedFile(String content, String filename) async {
    // Save to Documents/Imported directory for permanent storage
    try {
      final appDir = await getApplicationDocumentsDirectory();
      final importedDir = Directory('${appDir.path}/Imported');
      if (!await importedDir.exists()) {
        await importedDir.create(recursive: true);
      }
      
      // Generate unique filename if file already exists
      var targetFile = File('${importedDir.path}/$filename');
      if (await targetFile.exists()) {
        final nameWithoutExt = filename.replaceAll(RegExp(r'\.[^.]+$'), '');
        final ext = filename.contains('.') ? filename.substring(filename.lastIndexOf('.')) : '.md';
        final timestamp = DateTime.now().millisecondsSinceEpoch;
        targetFile = File('${importedDir.path}/${nameWithoutExt}_$timestamp$ext');
      }
      
      await targetFile.writeAsString(content);
      
      _currentFilePath = targetFile.path;
      _currentFileDir = importedDir.path;
      
      // Add to recent files with content for caching
      await recentFilesService.add(targetFile.path, filename, content: content);
      
      setState(() {
        _currentFilename = filename;
      });
      
      if (_webViewReady) {
        await _loadMarkdownIntoWebView(content, filename);
      } else {
        _pendingContent = content;
        _pendingFilename = filename;
      }
    } catch (e) {
      debugPrint('[Mobile] Failed to save received file: $e');
      // Still try to display even if save fails
      if (_webViewReady) {
        await _loadMarkdownIntoWebView(content, filename);
      } else {
        _pendingContent = content;
        _pendingFilename = filename;
      }
    }
  }
  
  /// Check if app was launched with a file
  Future<void> _checkInitialFile() async {
    try {
      final result = await _fileChannel.invokeMethod('getInitialFile');
      if (result != null) {
        final data = Map<String, dynamic>.from(result as Map);
        final content = data['content'] as String?;
        final filename = data['filename'] as String?;
        
        if (content != null) {
          debugPrint('[Mobile] Got initial file: $filename');
          // Reuse _handleReceivedFile to avoid duplication
          await _handleReceivedFile(content, filename ?? 'document.md');
        }
      }
    } on PlatformException catch (e) {
      debugPrint('[Mobile] Failed to get initial file: ${e.message}');
    } on MissingPluginException {
      // Platform doesn't support this (e.g., macOS, web)
      debugPrint('[Mobile] File channel not available on this platform');
    }
  }

  @override
  void dispose() {
    recentFilesService.removeListener(_onRecentFilesChanged);
    localization.removeListener(_onLocaleChanged);
    super.dispose();
  }

  /// Called when recent files list changes
  void _onRecentFilesChanged() {
    if (mounted) {
      setState(() {});
    }
  }

  /// Called when locale changes to rebuild UI
  void _onLocaleChanged() {
    if (mounted) {
      setState(() {});
    }
  }

  Future<void> _initWebView() async {
    try {
      await _controller.loadFlutterAsset('build/mobile/index.html');
    } catch (e, stack) {
      debugPrint('[Mobile] initWebView error: $e');
      debugPrint('[Mobile] Stack: $stack');
    }
  }

  Future<void> _checkWebViewReady() async {
    for (int i = 0; i < 20; i++) {
      try {
        final result = await _controller.runJavaScriptReturningResult(
          'typeof window.loadMarkdown',
        );

        if (result.toString().contains('function')) {
          setState(() {
            _webViewReady = true;
          });

          // Send theme data to WebView (Flutter loads from assets, not WebView fetch)
          await _sendThemeData(_currentTheme);

          // Apply saved font size (zoom level) before loading content
          final savedFontSize = settingsService.fontSize;
          await _controller.runJavaScript(
            "if(window.setFontSize){window.setFontSize($savedFontSize);}",
          );
          
          // Load pending content if any
          if (_pendingContent != null) {
            await _loadMarkdownIntoWebView(_pendingContent!, _pendingFilename ?? 'document.md');
            _pendingContent = null;
            _pendingFilename = null;
          }
          return;
        }
      } catch (e) {
        // Ignore check errors, will retry
      }
      await Future.delayed(const Duration(milliseconds: 300));
    }
  }

  void _handleWebViewMessage(String raw) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return;

      final type = decoded['type'];
      final payload = decoded['payload'];

      // Unified envelope format (WebView -> Host)
      final envelopeId = decoded['id']?.toString();
      final isEnvelope = envelopeId != null && decoded.containsKey('timestamp');

      switch (type) {
        case 'WEBVIEW_READY':
          _webViewReady = true;
          if (_pendingContent != null) {
            _loadMarkdownIntoWebView(_pendingContent!, _pendingFilename ?? 'document.md');
            _pendingContent = null;
            _pendingFilename = null;
          }
          break;

        case 'THEME_CHANGED':
          if (payload is Map && payload['themeId'] != null) {
            final newTheme = payload['themeId'] as String;
            if (newTheme != _currentTheme) {
              setState(() {
                _currentTheme = newTheme;
              });
              settingsService.theme = _currentTheme;
            }
          }
          break;

        case 'OPEN_URL':
          if (payload is Map) {
            final url = payload['url'] as String?;
            if (url != null) {
              _launchURL(url);
            }
          }
          break;

        case 'LOAD_RELATIVE_MARKDOWN':
          if (payload is Map) {
            final path = payload['path'] as String?;
            if (path != null) {
              _loadRelativeMarkdown(path);
            }
          }
          break;

        case 'OPEN_RELATIVE_FILE':
          if (payload is Map) {
            final path = payload['path'] as String?;
            if (path != null) {
              _openRelativeFile(path);
            }
          }
          break;

        case 'DOWNLOAD_FILE':
          if (payload is Map && isEnvelope) {
            _handleDownloadFileEnvelope(
              Map<String, dynamic>.from(payload),
              envelopeId,
            );
          }
          break;

        case 'READ_RELATIVE_FILE':
          if (payload is Map && isEnvelope) {
            _handleReadRelativeFileEnvelope(
              Map<String, dynamic>.from(payload),
              envelopeId,
            );
          }
          break;

        case 'FETCH_ASSET':
          if (payload is Map && isEnvelope) {
            _handleFetchAssetEnvelope(
              Map<String, dynamic>.from(payload),
              envelopeId,
            );
          }
          break;

        case 'HEADINGS_UPDATED':
          if (payload is List) {
            setState(() {
              _headings = List<Map<String, dynamic>>.from(
                payload.map((h) => Map<String, dynamic>.from(h)),
              );
            });
          }
          break;

        case 'LOG':
          if (payload is Map) {
            debugPrint('[WebView] ${payload['message']}');
          }
          break;

        case 'STORAGE_GET':
          if (payload is Map && isEnvelope) {
            _handleStorageGet(Map<String, dynamic>.from(payload), envelopeId);
          }
          break;

        case 'STORAGE_SET':
          if (payload is Map && isEnvelope) {
            _handleStorageSet(Map<String, dynamic>.from(payload), envelopeId);
          }
          break;

        case 'CACHE_OPERATION':
          if (payload is Map && isEnvelope) {
            _handleCacheOperation(Map<String, dynamic>.from(payload), envelopeId);
          }
          break;

        case 'UPLOAD_OPERATION':
          if (payload is Map && isEnvelope) {
            _handleUploadOperation(Map<String, dynamic>.from(payload), envelopeId);
          }
          break;

        case 'DOCX_DOWNLOAD_FINALIZE':
          if (payload is Map && isEnvelope) {
            _handleDocxDownloadFinalize(Map<String, dynamic>.from(payload), envelopeId);
          }
          break;

        case 'EXPORT_PROGRESS':
          if (payload is Map) {
            final completed = payload['completed'] as int? ?? 0;
            final total = payload['total'] as int? ?? 0;
            final phase = payload['phase'] as String? ?? 'processing';
            _updateExportProgress(completed, total, phase);
          }
          break;

        case 'EXPORT_ERROR':
          if (payload is Map) {
            _hideExportProgress();
            final error = payload['error'] as String? ?? localization.t('docx_export_failed_default');
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text(error)),
            );
          }
          break;

        case 'SCROLL_LINE_CHANGED':
          // Legacy: Save scroll position (line number) for current file
          // New code should use FILE_STATE_OPERATION instead
          if (payload is Map && _currentFilePath != null) {
            final lineValue = payload['line'];
            final line = (lineValue is num) ? lineValue.toDouble() : null;
            if (line != null) {
              settingsService.setScrollPosition(_currentFilePath!, line);
            }
          }
          break;

        case 'FILE_STATE_OPERATION':
          // Unified file state operation handler
          if (payload is Map && isEnvelope) {
            _handleFileStateOperation(Map<String, dynamic>.from(payload), envelopeId);
          }
          break;
      }
    } catch (e) {
      debugPrint('[Mobile] Message handler error: $e');
    }
  }

  Future<void> _handleStorageGet(Map<String, dynamic> payload, String requestId) async {
    try {
      final keys = payload['keys'] as List?;
      if (keys == null) {
        _respondToWebViewEnvelope(requestId, data: {});
        return;
      }
      
      final result = <String, dynamic>{};
      for (final key in keys) {
        if (key == 'selectedTheme') {
          result['selectedTheme'] = settingsService.theme;
        } else if (key == 'markdownViewerSettings') {
          // Return all viewer settings for DOCX export and other features
          result['markdownViewerSettings'] = {
            'docxHrAsPageBreak': settingsService.hrPageBreak,
            'docxEmojiStyle': settingsService.emojiStyle,
            'frontmatterDisplay': settingsService.frontmatterDisplay,
            'tableMergeEmpty': settingsService.tableMergeEmpty,
          };
        }
        // Add more keys as needed
      }
      
      _respondToWebViewEnvelope(requestId, data: result);
    } catch (e) {
      debugPrint('[Mobile] Storage get error: $e');
      _respondToWebViewEnvelope(requestId, error: e.toString());
    }
  }

  Future<void> _handleStorageSet(Map<String, dynamic> payload, String requestId) async {
    try {
      final items = payload['items'] as Map?;
      if (items != null) {
        if (items.containsKey('selectedTheme')) {
          settingsService.theme = items['selectedTheme'] as String;
        }
        if (items.containsKey('markdownViewerSettings')) {
          final viewerSettings = items['markdownViewerSettings'] as Map?;
          if (viewerSettings != null) {
            if (viewerSettings.containsKey('docxHrAsPageBreak')) {
              settingsService.hrPageBreak = viewerSettings['docxHrAsPageBreak'] as bool;
            }
            if (viewerSettings.containsKey('docxEmojiStyle')) {
              settingsService.emojiStyle = viewerSettings['docxEmojiStyle'] as String;
            }
            if (viewerSettings.containsKey('frontmatterDisplay')) {
              settingsService.frontmatterDisplay = viewerSettings['frontmatterDisplay'] as String;
            }
            if (viewerSettings.containsKey('tableMergeEmpty')) {
              settingsService.tableMergeEmpty = viewerSettings['tableMergeEmpty'] as bool;
            }
          }
        }
        // Add more keys as needed
      }
      
      _respondToWebViewEnvelope(requestId, data: {'success': true});
    } catch (e) {
      debugPrint('[Mobile] Storage set error: $e');
      _respondToWebViewEnvelope(requestId, error: e.toString());
    }
  }

  void _handleFileStateOperation(Map<String, dynamic> payload, String requestId) {
    try {
      final operation = payload['operation'] as String?;
      final url = payload['url'] as String?;
      
      if (url == null) {
        _respondToWebViewEnvelope(requestId, error: 'Missing url parameter');
        return;
      }
      
      switch (operation) {
        case 'get':
          final state = settingsService.getFileState(url);
          _respondToWebViewEnvelope(requestId, data: state ?? {});
          break;
        case 'set':
          final state = payload['state'] as Map<String, dynamic>?;
          if (state != null) {
            settingsService.setFileState(url, state);
          }
          _respondToWebViewEnvelope(requestId, data: {'success': true});
          break;
        case 'clear':
          settingsService.clearFileState(url);
          _respondToWebViewEnvelope(requestId, data: {'success': true});
          break;
        default:
          _respondToWebViewEnvelope(requestId, error: 'Unknown operation: $operation');
      }
    } catch (e) {
      debugPrint('[Mobile] File state operation error: $e');
      _respondToWebViewEnvelope(requestId, error: e.toString());
    }
  }

  Future<void> _handleCacheOperation(Map<String, dynamic> payload, String requestId) async {
    try {
      final result = await cacheStorage.handleOperation(payload);
      _respondToWebViewEnvelope(requestId, data: result['data'], ok: result['ok'] as bool);
    } catch (e) {
      debugPrint('[Mobile] Cache operation error: $e');
      _respondToWebViewEnvelope(requestId, error: e.toString());
    }
  }

  // Upload session storage for chunked uploads
  final Map<String, _UploadSession> _uploadSessions = {};

  Future<void> _handleUploadOperation(Map<String, dynamic> payload, String requestId) async {
    try {
      final operation = payload['operation'] as String?;
      
      switch (operation) {
        case 'init':
          final purpose = payload['purpose'] as String? ?? 'general';
          final encoding = payload['encoding'] as String? ?? 'text';
          final expectedSize = payload['expectedSize'] as int?;
          final chunkSize = payload['chunkSize'] as int? ?? 255 * 1024;
          final metadata = payload['metadata'] as Map<String, dynamic>? ?? {};
          
          final token = '${DateTime.now().millisecondsSinceEpoch}-${_uploadSessions.length}';
          _uploadSessions[token] = _UploadSession(
            purpose: purpose,
            encoding: encoding,
            expectedSize: expectedSize,
            chunkSize: chunkSize,
            metadata: Map<String, dynamic>.from(metadata),
          );
          
          _respondToWebViewEnvelope(requestId, data: {
            'token': token,
            'chunkSize': chunkSize,
          });
          break;
          
        case 'chunk':
          final token = payload['token'] as String?;
          final chunk = payload['chunk'] as String?;
          
          if (token == null || chunk == null) {
            _respondToWebViewEnvelope(requestId, error: 'Invalid chunk payload');
            return;
          }
          
          final session = _uploadSessions[token];
          if (session == null) {
            _respondToWebViewEnvelope(requestId, error: 'Upload session not found');
            return;
          }
          
          session.chunks.add(chunk);
          _respondToWebViewEnvelope(requestId, data: {});
          break;
          
        case 'finalize':
          final token = payload['token'] as String?;
          
          if (token == null) {
            _respondToWebViewEnvelope(requestId, error: 'Missing token');
            return;
          }
          
          final session = _uploadSessions[token];
          if (session == null) {
            _respondToWebViewEnvelope(requestId, error: 'Upload session not found');
            return;
          }
          
          // Concatenate all chunks
          session.data = session.chunks.join('');
          session.completed = true;
          
          _respondToWebViewEnvelope(requestId, data: {
            'token': token,
            'purpose': session.purpose,
            'bytes': session.data.length,
            'encoding': session.encoding,
          });
          break;
          
        case 'abort':
          final token = payload['token'] as String?;
          if (token != null) {
            _uploadSessions.remove(token);
          }
          _respondToWebViewEnvelope(requestId, data: {});
          break;
          
        default:
          _respondToWebViewEnvelope(requestId, error: 'Unknown upload operation: $operation');
      }
    } catch (e) {
      debugPrint('[Mobile] Upload operation error: $e');
      _respondToWebViewEnvelope(requestId, error: e.toString());
    }
  }

  Future<void> _handleDocxDownloadFinalize(Map<String, dynamic> payload, String requestId) async {
    try {
      final token = payload['token'] as String?;
      
      if (token == null) {
        _respondToWebViewEnvelope(requestId, error: 'Missing token');
        return;
      }
      
      final session = _uploadSessions[token];
      if (session == null) {
        _respondToWebViewEnvelope(requestId, error: 'Upload session not found');
        return;
      }
      
      if (!session.completed) {
        _respondToWebViewEnvelope(requestId, error: 'Upload not finalized');
        return;
      }
      
      // Update progress to sharing phase
      _updateExportProgress(_exportProgress, _exportTotal, 'sharing');
      
      final filename = session.metadata['filename'] as String? ?? 'document.docx';
      final mimeType = session.metadata['mimeType'] as String? ?? 
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      
      // Decode base64 data
      final bytes = base64Decode(session.data);
      final tempDir = await getTemporaryDirectory();
      final file = File('${tempDir.path}/$filename');
      await file.writeAsBytes(bytes);
      
      _hideExportProgress();
      
      await SharePlus.instance.share(
        ShareParams(
          files: [XFile(file.path, mimeType: mimeType)],
          sharePositionOrigin: const Rect.fromLTWH(0, 0, 100, 100),
        ),
      );
      
      // Clean up session
      _uploadSessions.remove(token);
      
      _respondToWebViewEnvelope(requestId, data: {'success': true});
    } catch (e) {
      _hideExportProgress();
      debugPrint('[Mobile] DOCX download finalize error: $e');
      _respondToWebViewEnvelope(requestId, error: e.toString());
    }
  }

  Future<void> _handleDownloadFileEnvelope(
    Map<String, dynamic> payload,
    String requestId,
  ) async {
    try {
      // Update progress to sharing phase
      _updateExportProgress(_exportProgress, _exportTotal, 'sharing');
      
      final data = payload['data'] as String?;
      final filename = payload['filename'] as String?;
      final mimeType = payload['mimeType'] as String?;

      if (data == null || filename == null) {
        _hideExportProgress();
        _respondToWebViewEnvelope(requestId, error: 'Invalid download request');
        return;
      }

      final bytes = base64Decode(data);
      final tempDir = await getTemporaryDirectory();
      final file = File('${tempDir.path}/$filename');
      await file.writeAsBytes(bytes);

      _hideExportProgress();
      
      await SharePlus.instance.share(
        ShareParams(
          files: [XFile(file.path, mimeType: mimeType)],
          sharePositionOrigin: const Rect.fromLTWH(0, 0, 100, 100),
        ),
      );

      _respondToWebViewEnvelope(requestId, data: {'success': true});
    } catch (e) {
      _hideExportProgress();
      _respondToWebViewEnvelope(requestId, error: e.toString());
    }
  }

  Future<void> _handleReadRelativeFileEnvelope(
    Map<String, dynamic> payload,
    String requestId,
  ) async {
    try {
      final relativePath = payload['path'] as String?;
      final binary = payload['binary'] as bool? ?? false;

      if (relativePath == null || relativePath.isEmpty) {
        _respondToWebViewEnvelope(requestId, error: 'No path provided');
        return;
      }

      if (_currentFileDir == null) {
        _respondToWebViewEnvelope(requestId, error: 'No markdown file opened');
        return;
      }

      String absolutePath;
      if (relativePath.startsWith('./')) {
        absolutePath = '$_currentFileDir/${relativePath.substring(2)}';
      } else if (relativePath.startsWith('../')) {
        final baseDir = Directory(_currentFileDir!);
        absolutePath = '${baseDir.path}/$relativePath';
        absolutePath = File(absolutePath).absolute.path;
      } else if (relativePath.startsWith('/')) {
        absolutePath = relativePath;
      } else {
        absolutePath = '$_currentFileDir/$relativePath';
      }

      final file = File(absolutePath);
      if (!await file.exists()) {
        _respondToWebViewEnvelope(requestId, error: 'File not found: $absolutePath');
        return;
      }

      if (binary) {
        // Read as binary and return base64 encoded
        final bytes = await file.readAsBytes();
        final base64Content = base64Encode(bytes);
        _respondToWebViewEnvelope(requestId, data: {'content': base64Content});
      } else {
        final content = await file.readAsString();
        _respondToWebViewEnvelope(requestId, data: {'content': content});
      }
    } catch (e) {
      debugPrint('[Mobile] READ_RELATIVE_FILE error: $e');
      _respondToWebViewEnvelope(requestId, error: e.toString());
    }
  }

  /// Handle FETCH_ASSET request from WebView
  /// Loads asset from Flutter's asset bundle
  Future<void> _handleFetchAssetEnvelope(
    Map<String, dynamic> payload,
    String requestId,
  ) async {
    try {
      final path = payload['path'] as String?;
      if (path == null) {
        _respondToWebViewEnvelope(requestId, error: 'Missing path parameter');
        return;
      }

      final content = await rootBundle.loadString('build/mobile/$path');
      _respondToWebViewEnvelope(requestId, data: content);
    } catch (e) {
      debugPrint('[Mobile] FETCH_ASSET error for ${payload['path']}: $e');
      _respondToWebViewEnvelope(requestId, error: e.toString());
    }
  }

  Future<void> _sendToWebView(Map<String, dynamic> message) async {
    final json = jsonEncode(message);
    final js = 'window.__receiveMessageFromHost($json);';
    await _controller.runJavaScript(js);
  }

  void _respondToWebViewEnvelope(String requestId, {dynamic data, String? error, bool? ok}) {
    final response = <String, dynamic>{
      'type': 'RESPONSE',
      'requestId': requestId,
      'ok': ok ?? (error == null),
    };

    if (error != null) {
      response['error'] = <String, dynamic>{
        'message': error,
      };
    } else {
      response['data'] = data;
    }

    _sendToWebView(response);
  }

  Future<void> _openFile() async {
    try {
      final result = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: settingsService.allowedExtensions,
      );

      if (result != null && result.files.isNotEmpty) {
        final filePath = result.files.single.path!;
        final file = File(filePath);
        final content = await file.readAsString();
        final filename = result.files.single.name;

        // Save the directory and path of the markdown file
        _currentFileDir = file.parent.path;
        _currentFilePath = filePath;

        // Add to recent files with content for caching
        await recentFilesService.add(filePath, filename, content: content);

        setState(() {
          _currentFilename = filename;
        });

        if (_webViewReady) {
          await _loadMarkdownIntoWebView(content, filename);
        } else {
          // Store for later when WebView is ready
          _pendingContent = content;
          _pendingFilename = filename;
        }
      }
    } catch (e) {
      debugPrint('[Mobile] Open file error: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(localization.t('failed_to_open_file', [e.toString()]))),
        );
      }
    }
  }

  Future<void> _loadMarkdownIntoWebView(String content, String filename) async {
    // Wrap non-markdown files in code blocks
    final wrappedContent = _wrapFileContent(content, filename);
    final escaped = _escapeJs(wrappedContent);
    try {
      // Prepare filePath for JS side state persistence
      final escapedFilePath = _escapeJs(_currentFilePath ?? filename);
      
      // Send themeId only - WebView loads theme data itself using shared loadAndApplyTheme
      final escapedTheme = _escapeJs(_currentTheme);
      
      // Call loadMarkdown with object payload (filePath used by FileStateService)
      await _controller.runJavaScript("""
        if(window.loadMarkdown){
          window.loadMarkdown({
            content: '$escaped',
            filename: '$filename',
            filePath: '$escapedFilePath',
            themeId: '$escapedTheme'
          });
        }else{
          console.error('loadMarkdown not defined');
        }
      """);
      setState(() {
        _hasContent = true;
      });
    } catch (e) {
      debugPrint('[Mobile] JS injection error: $e');
    }
  }

  /// Launch external URL in system browser
  Future<void> _launchURL(String urlString) async {
    try {
      final url = Uri.parse(urlString);
      if (await canLaunchUrl(url)) {
        await launchUrl(url, mode: LaunchMode.externalApplication);
      } else {
        debugPrint('[Mobile] Cannot launch URL: $urlString');
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(localization.t('failed_to_open_url', [urlString]))),
          );
        }
      }
    } catch (e) {
      debugPrint('[Mobile] Launch URL error: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(localization.t('failed_to_open_url', [e.toString()]))),
        );
      }
    }
  }

  /// Load relative markdown file
  Future<void> _loadRelativeMarkdown(String relativePath) async {
    try {
      if (_currentFileDir == null) {
        debugPrint('[Mobile] Cannot load relative markdown: no current file directory');
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(localization.t('no_file_opened'))),
          );
        }
        return;
      }

      // Resolve relative path
      String absolutePath;
      if (relativePath.startsWith('./')) {
        absolutePath = '$_currentFileDir/${relativePath.substring(2)}';
      } else if (relativePath.startsWith('../')) {
        final baseDir = Directory(_currentFileDir!);
        absolutePath = '${baseDir.path}/$relativePath';
        absolutePath = File(absolutePath).absolute.path;
      } else if (relativePath.startsWith('/')) {
        absolutePath = relativePath;
      } else {
        absolutePath = '$_currentFileDir/$relativePath';
      }

      // Normalize path
      final file = File(absolutePath);
      absolutePath = file.absolute.path;

      if (!await file.exists()) {
        debugPrint('[Mobile] Relative markdown file not found: $absolutePath');
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(localization.t('file_not_found'))),
          );
        }
        return;
      }

      // Read and load the markdown file
      final content = await file.readAsString();
      final filename = file.uri.pathSegments.last;

      // Update current file directory and path
      _currentFileDir = file.parent.path;
      _currentFilePath = absolutePath;

      // Add to recent files
      await recentFilesService.add(absolutePath, filename, content: content);

      setState(() {
        _currentFilename = filename;
      });

      if (_webViewReady) {
        await _loadMarkdownIntoWebView(content, filename);
      } else {
        _pendingContent = content;
        _pendingFilename = filename;
      }
    } catch (e) {
      debugPrint('[Mobile] Load relative markdown error: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(localization.t('failed_to_open_file', [e.toString()]))),
        );
      }
    }
  }

  /// Open relative file with system handler
  Future<void> _openRelativeFile(String relativePath) async {
    try {
      if (_currentFileDir == null) {
        debugPrint('[Mobile] Cannot open relative file: no current file directory');
        return;
      }

      // Resolve relative path
      String absolutePath;
      if (relativePath.startsWith('./')) {
        absolutePath = '$_currentFileDir/${relativePath.substring(2)}';
      } else if (relativePath.startsWith('../')) {
        final baseDir = Directory(_currentFileDir!);
        absolutePath = '${baseDir.path}/$relativePath';
        absolutePath = File(absolutePath).absolute.path;
      } else if (relativePath.startsWith('/')) {
        absolutePath = relativePath;
      } else {
        absolutePath = '$_currentFileDir/$relativePath';
      }

      // Normalize path
      final file = File(absolutePath);
      absolutePath = file.absolute.path;

      if (!await file.exists()) {
        debugPrint('[Mobile] Relative file not found: $absolutePath');
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(localization.t('file_not_found'))),
          );
        }
        return;
      }

      // Try to open with system handler using url_launcher
      final url = Uri.file(absolutePath);
      if (await canLaunchUrl(url)) {
        await launchUrl(url, mode: LaunchMode.externalApplication);
      } else {
        debugPrint('[Mobile] Cannot open file: $absolutePath');
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(localization.t('failed_to_open_file', [absolutePath]))),
          );
        }
      }
    } catch (e) {
      debugPrint('[Mobile] Open relative file error: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(localization.t('failed_to_open_file', [e.toString()]))),
        );
      }
    }
  }

  /// Send theme ID to WebView (WebView loads theme data itself)
  Future<void> _sendThemeData(String themeId) async {
    try {
      final escapedThemeId = _escapeJs(themeId);
      
      await _controller.runJavaScript(
        "if(window.setTheme){window.setTheme('$escapedThemeId');}else{console.error('setTheme not defined');}",
      );
    } catch (e) {
      debugPrint('[Mobile] Failed to send theme: $e');
    }
  }

  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();

  /// Go back to empty state, clearing current document
  void _goBack() {
    setState(() {
      _hasContent = false;
      _currentFilename = null;
      _currentFilePath = null;
      _currentFileDir = null;
      _headings = [];
    });
    // Clear only the markdown content container, preserve WebView structure
    _controller.runJavaScript('''
      (function() {
        var content = document.getElementById('markdown-content');
        if (content) content.innerHTML = '';
      })();
    ''');
  }

  void _showToc() {
    if (_headings.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(localization.t('no_headings'))),
      );
      return;
    }
    _scaffoldKey.currentState?.openDrawer();
  }

  Future<void> _shareFile() async {
    if (_currentFilePath == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(localization.t('no_file_to_share'))),
      );
      return;
    }

    try {
      await SharePlus.instance.share(
        ShareParams(
          files: [XFile(_currentFilePath!)],
          sharePositionOrigin: const Rect.fromLTWH(0, 0, 100, 100),
        ),
      );
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(localization.t('failed_to_share', [e.toString()]))),
        );
      }
    }
  }

  /// Update export progress
  void _updateExportProgress(int completed, int total, String phase) {
    setState(() {
      _isExporting = true;
      _exportProgress = completed;
      _exportTotal = total;
      _exportPhase = phase;
    });
  }

  /// Hide export progress
  void _hideExportProgress() {
    setState(() {
      _isExporting = false;
      _exportProgress = 0;
      _exportTotal = 0;
      _exportPhase = 'processing';
    });
  }

  /// Export current file to DOCX
  Future<void> _exportDocx() async {
    if (!_hasContent) return;
    
    setState(() {
      _isExporting = true;
      _exportProgress = 0;
      _exportTotal = 0;
      _exportPhase = 'processing';
    });
    
    try {
      await _controller.runJavaScript('window.exportDocx()');
    } catch (e) {
      debugPrint('[Mobile] Export DOCX error: $e');
      _hideExportProgress();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(localization.t('docx_export_failed_default'))),
        );
      }
    }
  }

  void _showRecentFiles() {
    final recentFiles = recentFilesService.getAll();
    
    if (recentFiles.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(localization.t('no_recent_files'))),
      );
      return;
    }
    
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (context) => DraggableScrollableSheet(
        initialChildSize: 0.5,
        minChildSize: 0.3,
        maxChildSize: 0.9,
        expand: false,
        builder: (context, scrollController) => SafeArea(
          child: Column(
            children: [
              // Handle bar
              Container(
                margin: const EdgeInsets.only(top: 8),
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: Theme.of(context).hintColor.withValues(alpha: 0.3),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              // Title
              Padding(
                padding: const EdgeInsets.all(16.0),
                child: Row(
                  children: [
                    GFAvatar(
                      backgroundColor: Theme.of(context).colorScheme.primaryContainer,
                      size: GFSize.SMALL,
                      child: Icon(
                        AntIcons.history,
                        size: 18,
                        color: Theme.of(context).colorScheme.onPrimaryContainer,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Text(
                      localization.t('recent_files'),
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const Spacer(),
                    TextButton(
                      onPressed: () {
                        Navigator.pop(context);
                        _clearRecentFiles();
                      },
                      style: TextButton.styleFrom(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                        minimumSize: Size.zero,
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      ),
                      child: Text(
                        localization.t('clear_all'),
                        style: TextStyle(
                          fontSize: 13,
                          color: Theme.of(context).colorScheme.primary,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              // File list
              Expanded(
                child: ListView.builder(
                  controller: scrollController,
                  itemCount: recentFiles.length,
                  itemBuilder: (context, index) {
                    final file = recentFiles[index];
                    return GFListTile(
                      avatar: GFAvatar(
                        backgroundColor: Theme.of(context).colorScheme.surfaceContainerHighest,
                        size: GFSize.SMALL,
                        child: Icon(
                          AntIcons.file_markdown_outline,
                          size: 18,
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                      titleText: file.name,
                      subTitleText: _formatRecentFilePath(file.path),
                      onTap: () {
                        Navigator.pop(context);
                        _openRecentFile(file);
                      },
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  String _formatRecentFilePath(String path) {
    final parts = path.split('/');
    if (parts.length > 3) {
      return '.../${parts.sublist(parts.length - 3).join('/')}';
    }
    return path;
  }

  void _showAbout() async {
    final packageInfo = await PackageInfo.fromPlatform();
    if (!mounted) return;
    
    showDialog(
      context: context,
      builder: (context) => _AboutDialog(
        appName: localization.t('extensionName'),
        version: 'v${packageInfo.version}',
        author: '@xicilion',
      ),
    );
  }

  String _escapeJs(String str) {
    return str
        .replaceAll('\\', '\\\\')
        .replaceAll("'", "\\'")
        .replaceAll('\n', '\\n')
        .replaceAll('\r', '\\r');
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: !_hasContent,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop && _hasContent) {
          _goBack();
        }
      },
      child: Stack(
        children: [
          Scaffold(
          key: _scaffoldKey,
          drawer: _headings.isNotEmpty ? _TocDrawer(
            headings: _headings,
            onHeadingTap: (id) {
              // Close drawer first
              _scaffoldKey.currentState?.closeDrawer();
              // Escape id for JavaScript
              final escapedId = id
                  .replaceAll('\\', '\\\\')
                  .replaceAll("'", "\\'");
              // Scroll to heading with offset for better visibility
              Future.delayed(const Duration(milliseconds: 100), () {
                _controller.runJavaScript('''
                  (function() {
                    var el = document.getElementById('$escapedId');
                    if (el) {
                      var y = el.getBoundingClientRect().top + window.scrollY - 20;
                      window.scrollTo({top: y, behavior: 'smooth'});
                    }
                  })();
                ''');
              });
            },
          ) : null,
          appBar: AppBar(
            titleSpacing: 0,
            leadingWidth: 0,
            leading: const SizedBox.shrink(),
            title: Row(
              children: [
                // Left side: TOC only
                IconButton(
                  icon: const Icon(AntIcons.menu),
                  onPressed: _hasContent ? _showToc : null,
                  tooltip: localization.t('toc'),
                ),
                // Center title (flexible)
                Expanded(
                  child: Text(
                    _hasContent ? (_currentFilename ?? '') : localization.t('extensionName'),
                    style: const TextStyle(fontSize: 16),
                    textAlign: TextAlign.center,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                // Right side: Share (More is in actions)
                if (_hasContent)
                  IconButton(
                    icon: const Icon(AntIcons.share_alt),
                    onPressed: _shareFile,
                    tooltip: localization.t('share'),
                  ),
              ],
            ),
            actions: [
              Builder(
                builder: (context) => IconButton(
                  icon: const Icon(AntIcons.ellipsis),
                  tooltip: localization.t('more'),
                  onPressed: () => _showMoreMenu(context),
                ),
              ),
            ],
          ),
          body: _hasContent ? _buildContentView() : _buildEmptyState(),
        ),
        // Export progress overlay
        if (_isExporting)
          _buildExportProgressOverlay(),
        ],
      ),
    );
  }

  Widget _buildExportProgressOverlay() {
    String phaseText;
    switch (_exportPhase) {
      case 'generating':
        phaseText = localization.t('exporting');
        break;
      case 'sharing':
        phaseText = localization.t('preparing_share');
        break;
      default:
        phaseText = localization.t('exporting');
    }
    
    return Container(
      color: Colors.black.withValues(alpha: 0.6),
      child: Center(
        child: GFCard(
          boxFit: BoxFit.cover,
          margin: const EdgeInsets.all(32),
          padding: const EdgeInsets.all(24),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const GFLoader(type: GFLoaderType.circle),
              const SizedBox(height: 16),
              Text(
                phaseText,
                style: const TextStyle(fontSize: 16),
              ),
              if (_exportTotal > 0) ...[
                const SizedBox(height: 8),
                Text(
                  '$_exportProgress / $_exportTotal',
                  style: TextStyle(
                    fontSize: 14,
                    color: Theme.of(context).hintColor,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  void _showMoreMenu(BuildContext context) {
    final RenderBox button = context.findRenderObject() as RenderBox;
    final buttonPosition = button.localToGlobal(Offset.zero);
    
    showMenu<String>(
      context: context,
      position: RelativeRect.fromLTRB(
        buttonPosition.dx,
        buttonPosition.dy + button.size.height,
        buttonPosition.dx + button.size.width,
        buttonPosition.dy + button.size.height,
      ),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      items: [
        _buildPopupMenuItem('open', AntIcons.folder_open_outline, localization.t('open_file')),
        _buildPopupMenuItem('recent', AntIcons.history, localization.t('recent_files')),
        if (_hasContent)
          _buildPopupMenuItem('export_docx', AntIcons.file_word, localization.t('export_docx')),
        const PopupMenuDivider(),
        _buildPopupMenuItem('settings', AntIcons.setting_outline, localization.t('tab_settings')),
        _buildPopupMenuItem('about', AntIcons.info_circle_outline, localization.t('about')),
      ],
    ).then((value) {
      if (value == null || !mounted) return;
      switch (value) {
        case 'open':
          _openFile();
          break;
        case 'export_docx':
          _exportDocx();
          break;
        case 'settings':
          Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) => SettingsPage(webViewController: _controller),
            ),
          );
          break;
        case 'recent':
          _showRecentFiles();
          break;
        case 'about':
          _showAbout();
          break;
      }
    });
  }

  PopupMenuItem<String> _buildPopupMenuItem(String value, IconData icon, String title) {
    return PopupMenuItem<String>(
      value: value,
      child: Row(
        children: [
          Icon(icon, size: 20),
          const SizedBox(width: 12),
          Text(title),
        ],
      ),
    );
  }


  Widget _buildContentView() {
    return SafeArea(
      bottom: false, // Allow content to extend to bottom edge on iOS
      child: WebViewWidget(controller: _controller),
    );
  }

  Widget _buildEmptyState() {
    final recentFiles = recentFilesService.getAll();
    
    return SafeArea(
      bottom: false, // Allow content to extend to bottom edge on iOS
      child: Stack(
        children: [
          // Hidden WebView (still needs to be in widget tree for initialization)
          Opacity(
            opacity: 0,
            child: SizedBox(
              width: 1,
              height: 1,
              child: WebViewWidget(controller: _controller),
            ),
          ),
          // Empty state UI
          CustomScrollView(
            slivers: [
              // Header section
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(32, 48, 32, 24),
                  child: Column(
                    children: [
                      ClipRRect(
                        borderRadius: BorderRadius.circular(16),
                        child: Image.asset(
                          'build/mobile/icons/icon128.png',
                          width: 72,
                          height: 72,
                        ),
                      ),
                      const SizedBox(height: 20),
                      Text(
                        localization.t('extensionName'),
                        style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        localization.t('welcome_message'),
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: Theme.of(context).hintColor,
                        ),
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 24),
                      FilledButton.icon(
                        onPressed: _openFile,
                        icon: Icon(AntIcons.folder_open_outline),
                        label: Text(localization.t('open_file')),
                        style: FilledButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
                          shape: const StadiumBorder(),
                          textStyle: const TextStyle(fontSize: 16),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              // Recent files section
              if (recentFiles.isNotEmpty) ...[
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                    child: Row(
                      children: [
                        Icon(
                          AntIcons.history,
                          size: 16,
                          color: Theme.of(context).hintColor,
                        ),
                        const SizedBox(width: 6),
                        Text(
                          localization.t('recent_files'),
                          style: Theme.of(context).textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const Spacer(),
                        TextButton(
                          onPressed: _clearRecentFiles,
                          style: TextButton.styleFrom(
                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                            minimumSize: Size.zero,
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          ),
                          child: Text(
                            localization.t('clear_all'),
                            style: TextStyle(
                              fontSize: 13,
                              color: Theme.of(context).colorScheme.primary,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                SliverList(
                  delegate: SliverChildBuilderDelegate(
                    (context, index) {
                      final file = recentFiles[index];
                      return FutureBuilder<bool>(
                        future: recentFilesService.isImportedFile(file.path),
                        builder: (context, snapshot) {
                          final isImported = snapshot.data ?? false;
                          return _RecentFileItem(
                            file: file,
                            onTap: () => _openRecentFile(file),
                            onRemove: () => _removeRecentFile(file),
                            onDeleteFile: isImported ? () => _deleteSharedFile(file) : null,
                            isImportedFile: isImported,
                          );
                        },
                      );
                    },
                    childCount: recentFiles.length,
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }

  /// Open a recent file
  Future<void> _openRecentFile(RecentFile file) async {
    try {
      // Use readContent which handles both original file and cached content
      final content = await recentFilesService.readContent(file);
      
      if (content == null) {
        // Neither original nor cache available, remove from recent
        await recentFilesService.remove(file.path);
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(localization.t('file_not_found'))),
          );
        }
        return;
      }

      final f = File(file.path);
      _currentFileDir = f.parent.path;
      _currentFilePath = file.path;

      // Update last opened time with content for caching
      await recentFilesService.add(file.path, file.name, content: content);

      setState(() {
        _currentFilename = file.name;
      });

      if (_webViewReady) {
        await _loadMarkdownIntoWebView(content, file.name);
      } else {
        _pendingContent = content;
        _pendingFilename = file.name;
      }
    } catch (e) {
      debugPrint('[Mobile] Open recent file error: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(localization.t('failed_to_open_file', [e.toString()]))),
        );
      }
    }
  }

  /// Remove a file from recent list (keeps original file)
  Future<void> _removeRecentFile(RecentFile file) async {
    await recentFilesService.remove(file.path);
  }

  /// Delete a shared file and remove from recent list
  Future<void> _deleteSharedFile(RecentFile file) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => _ConfirmDialog(
        title: localization.t('delete_file'),
        content: localization.t('delete_file_confirm', [file.name]),
        confirmText: localization.t('delete'),
        cancelText: localization.t('cancel'),
        isDestructive: true,
      ),
    );

    if (confirmed == true) {
      final deleted = await recentFilesService.removeAndDeleteFile(file.path);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              deleted
                  ? localization.t('file_deleted')
                  : localization.t('file_removed'),
            ),
          ),
        );
      }
    }
  }

  /// Clear all recent files
  Future<void> _clearRecentFiles() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => _ConfirmDialog(
        title: localization.t('clear_recent_files'),
        content: localization.t('clear_recent_files_confirm'),
        confirmText: localization.t('clear_all'),
        cancelText: localization.t('cancel'),
      ),
    );

    if (confirmed == true) {
      await recentFilesService.clear();
    }
  }
}

/// Widget for displaying a recent file item
class _RecentFileItem extends StatelessWidget {
  final RecentFile file;
  final VoidCallback onTap;
  final VoidCallback onRemove;
  final VoidCallback? onDeleteFile;
  final bool isImportedFile;

  const _RecentFileItem({
    required this.file,
    required this.onTap,
    required this.onRemove,
    this.onDeleteFile,
    this.isImportedFile = false,
  });

  void _showOptionsMenu(BuildContext context) {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Handle bar
            Container(
              margin: const EdgeInsets.only(top: 8),
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: Theme.of(context).hintColor.withValues(alpha: 0.3),
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            const SizedBox(height: 8),
            // File name header
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Row(
                children: [
                  GFAvatar(
                    backgroundColor: Theme.of(context).colorScheme.surfaceContainerHighest,
                    size: GFSize.SMALL,
                    child: Icon(
                      AntIcons.file_markdown_outline,
                      size: 16,
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      file.name,
                      style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            GFListTile(
              avatar: GFAvatar(
                backgroundColor: Theme.of(context).colorScheme.surfaceContainerHighest,
                size: GFSize.SMALL,
                child: Icon(
                  AntIcons.close,
                  size: 16,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
              titleText: localization.t('remove_from_list'),
              onTap: () {
                Navigator.pop(context);
                onRemove();
              },
            ),
            if (isImportedFile && onDeleteFile != null)
              GFListTile(
                avatar: GFAvatar(
                  backgroundColor: Theme.of(context).colorScheme.errorContainer,
                  size: GFSize.SMALL,
                  child: Icon(
                    AntIcons.delete_outline,
                    size: 16,
                    color: Theme.of(context).colorScheme.error,
                  ),
                ),
                title: Text(
                  localization.t('delete_file'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
                onTap: () {
                  Navigator.pop(context);
                  onDeleteFile!();
                },
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return GFListTile(
      avatar: GFAvatar(
        backgroundColor: isImportedFile 
            ? Theme.of(context).colorScheme.secondaryContainer
            : Theme.of(context).colorScheme.surfaceContainerHighest,
        child: Icon(
          AntIcons.file_markdown_outline,
          color: isImportedFile 
              ? Theme.of(context).colorScheme.secondary 
              : Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      ),
      title: Text(
        file.name,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subTitle: Row(
        children: [
          if (isImportedFile) ...[
            Icon(
              AntIcons.share_alt,
              size: 12,
              color: Theme.of(context).colorScheme.secondary,
            ),
            const SizedBox(width: 4),
          ],
          Expanded(
            child: Text(
              _formatPath(file.path),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12,
                color: Theme.of(context).hintColor,
              ),
            ),
          ),
        ],
      ),
      icon: GFIconButton(
        icon: const Icon(Icons.more_vert, size: 20),
        type: GFButtonType.transparent,
        onPressed: () => _showOptionsMenu(context),
      ),
      onTap: onTap,
    );
  }

  String _formatPath(String path) {
    // Shorten path for display
    final parts = path.split('/');
    if (parts.length > 3) {
      return '.../${parts.sublist(parts.length - 3).join('/')}';
    }
    return path;
  }
}

/// Drawer for Table of Contents
class _TocDrawer extends StatelessWidget {
  final List<Map<String, dynamic>> headings;
  final void Function(String id) onHeadingTap;

  const _TocDrawer({
    required this.headings,
    required this.onHeadingTap,
  });

  @override
  Widget build(BuildContext context) {
    return GFDrawer(
      child: SafeArea(
        child: Column(
          children: [
            // Header
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                border: Border(
                  bottom: BorderSide(color: Theme.of(context).dividerColor),
                ),
              ),
              child: Row(
                children: [
                  GFAvatar(
                    backgroundColor: Theme.of(context).colorScheme.primaryContainer,
                    size: GFSize.SMALL,
                    child: Icon(
                      AntIcons.unordered_list,
                      size: 18,
                      color: Theme.of(context).colorScheme.onPrimaryContainer,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      localization.t('toc'),
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  GFIconButton(
                    icon: const Icon(Icons.close),
                    type: GFButtonType.transparent,
                    onPressed: () => Navigator.pop(context),
                  ),
                ],
              ),
            ),
            // Content
            Expanded(
              child: headings.isEmpty
                  ? Center(
                      child: Text(
                        localization.t('no_headings'),
                        style: TextStyle(color: Theme.of(context).hintColor),
                      ),
                    )
                  : ListView.builder(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      itemCount: headings.length,
                      itemBuilder: (context, index) {
                        final heading = headings[index];
                        final level = heading['level'] as int? ?? 1;
                        final text = heading['text'] as String? ?? '';
                        final id = heading['id'] as String? ?? '';

                        return _TocItem(
                          text: text,
                          level: level,
                          onTap: () => onHeadingTap(id),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Single TOC item with GetWidget style
class _TocItem extends StatelessWidget {
  final String text;
  final int level;
  final VoidCallback onTap;

  const _TocItem({
    required this.text,
    required this.level,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GFListTile(
      padding: EdgeInsets.only(
        left: 16.0 + (level - 1) * 16.0,
        right: 16,
        top: 4,
        bottom: 4,
      ),
      avatar: level <= 2
          ? Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(
                color: level == 1
                    ? Theme.of(context).colorScheme.primary
                    : Theme.of(context).colorScheme.secondary,
                shape: BoxShape.circle,
              ),
            )
          : const SizedBox(width: 6),
      title: Text(
        text,
        style: TextStyle(
          fontSize: level == 1 ? 15 : (level == 2 ? 14 : 13),
          fontWeight: level <= 2 ? FontWeight.w600 : FontWeight.normal,
          color: level > 3 ? Theme.of(context).hintColor : null,
        ),
      ),
      onTap: onTap,
    );
  }
}

/// Bottom sheet for font size adjustment
class _FontSizeBottomSheet extends StatefulWidget {
  final int initialSize;
  final void Function(int) onChanged;

  const _FontSizeBottomSheet({
    required this.initialSize,
    required this.onChanged,
  });

  @override
  State<_FontSizeBottomSheet> createState() => _FontSizeBottomSheetState();
}

class _FontSizeBottomSheetState extends State<_FontSizeBottomSheet> {
  late int _currentSize;

  @override
  void initState() {
    super.initState();
    _currentSize = widget.initialSize;
  }

  @override
  Widget build(BuildContext context) {
    // Calculate zoom percentage: 16pt = 100%
    final zoomPercent = (_currentSize * 100 / 16).round();
    final isDefault = _currentSize == 16;
    
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                GFAvatar(
                  backgroundColor: Theme.of(context).colorScheme.primaryContainer,
                  size: GFSize.SMALL,
                  child: Icon(
                    AntIcons.font_size,
                    size: 18,
                    color: Theme.of(context).colorScheme.onPrimaryContainer,
                  ),
                ),
                const SizedBox(width: 12),
                Text(
                  localization.t('zoom'),
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                if (!isDefault)
                  GFButton(
                    onPressed: () {
                      setState(() {
                        _currentSize = 16;
                      });
                      widget.onChanged(16);
                    },
                    text: localization.t('reset'),
                    type: GFButtonType.transparent,
                    size: GFSize.SMALL,
                  ),
                GFBadge(
                  text: '$zoomPercent%',
                  color: Theme.of(context).colorScheme.primaryContainer,
                  textColor: Theme.of(context).colorScheme.primary,
                  shape: GFBadgeShape.pills,
                ),
              ],
            ),
            const SizedBox(height: 20),
            Row(
              children: [
                const Text('A', style: TextStyle(fontSize: 12)),
                Expanded(
                  child: Slider(
                    value: _currentSize.toDouble(),
                    min: 12,
                    max: 24,
                    divisions: 12,
                    onChanged: (value) {
                      setState(() {
                        _currentSize = value.round();
                      });
                      widget.onChanged(_currentSize);
                    },
                  ),
                ),
                const Text('A', style: TextStyle(fontSize: 24)),
              ],
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}

/// Confirm dialog with GetWidget style
class _ConfirmDialog extends StatelessWidget {
  final String title;
  final String content;
  final String confirmText;
  final String cancelText;
  final bool isDestructive;

  const _ConfirmDialog({
    required this.title,
    required this.content,
    required this.confirmText,
    required this.cancelText,
    this.isDestructive = false,
  });

  @override
  Widget build(BuildContext context) {
    return Dialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                GFAvatar(
                  backgroundColor: isDestructive
                      ? Theme.of(context).colorScheme.errorContainer
                      : Theme.of(context).colorScheme.primaryContainer,
                  size: GFSize.SMALL,
                  child: Icon(
                    isDestructive ? Icons.warning_amber_rounded : Icons.help_outline,
                    size: 18,
                    color: isDestructive
                        ? Theme.of(context).colorScheme.error
                        : Theme.of(context).colorScheme.onPrimaryContainer,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    title,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Text(
              content,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            const SizedBox(height: 24),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                GFButton(
                  onPressed: () => Navigator.pop(context, false),
                  text: cancelText,
                  type: GFButtonType.outline2x,
                  shape: GFButtonShape.pills,
                  size: GFSize.SMALL,
                ),
                const SizedBox(width: 12),
                GFButton(
                  onPressed: () => Navigator.pop(context, true),
                  text: confirmText,
                  shape: GFButtonShape.pills,
                  size: GFSize.SMALL,
                  color: isDestructive
                      ? Theme.of(context).colorScheme.error
                      : Theme.of(context).colorScheme.primary,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// About dialog with GetWidget style
class _AboutDialog extends StatelessWidget {
  final String appName;
  final String version;
  final String author;

  const _AboutDialog({
    required this.appName,
    required this.version,
    required this.author,
  });

  @override
  Widget build(BuildContext context) {
    return Dialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(16),
              child: Image.asset(
                'build/mobile/icons/icon128.png',
                width: 72,
                height: 72,
              ),
            ),
            const SizedBox(height: 16),
            Text(
              appName,
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 12),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  version,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).hintColor,
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  author,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).hintColor,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),
            GFButton(
              onPressed: () => Navigator.pop(context),
              text: 'OK',
              shape: GFButtonShape.pills,
              fullWidthButton: true,
            ),
          ],
        ),
      ),
    );
  }
}

/// Upload session for chunked file uploads
class _UploadSession {
  final String purpose;
  final String encoding;
  final int? expectedSize;
  final int chunkSize;
  final Map<String, dynamic> metadata;
  final List<String> chunks = [];
  String data = '';
  bool completed = false;

  _UploadSession({
    required this.purpose,
    required this.encoding,
    this.expectedSize,
    required this.chunkSize,
    required this.metadata,
  });
}
