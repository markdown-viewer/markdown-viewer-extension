import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:ant_icons/ant_icons.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:webview_flutter/webview_flutter.dart';
// Import for Android features
import 'package:webview_flutter_android/webview_flutter_android.dart';

import 'services/cache_service.dart';
import 'services/localization_service.dart';
import 'services/recent_files_service.dart';
import 'services/settings_service.dart';
import 'services/theme_asset_service.dart';
import 'services/theme_registry_service.dart';
import 'widgets/theme_picker.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await settingsService.init();
  await cacheService.init();
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
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.blue),
        useMaterial3: true,
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: Colors.blue,
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      home: const MarkdownViewerHome(),
    );
  }
}

class MarkdownViewerHome extends StatefulWidget {
  const MarkdownViewerHome({super.key});

  @override
  State<MarkdownViewerHome> createState() => _MarkdownViewerHomeState();
}

class _MarkdownViewerHomeState extends State<MarkdownViewerHome> {
  late final WebViewController _controller;
  String? _currentFilename;
  String _currentTheme = 'default';
  bool _webViewReady = false;
  bool _hasContent = false;
  String? _pendingContent;
  String? _pendingFilename;
  String? _currentFileDir;
  String? _currentFilePath;
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
      AndroidWebViewController.enableDebugging(true);
      // Allow file access from the WebView
      androidController.setAllowFileAccess(true);
      // Allow content access
      androidController.setAllowContentAccess(true);
      // Allow mixed content (secure page loading insecure resources)
      androidController.setMixedContentMode(MixedContentMode.alwaysAllow);
      // Other settings
      androidController.setMediaPlaybackRequiresUserGesture(false);
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
    // Save to temp directory so we can share it later
    try {
      final tempDir = await getTemporaryDirectory();
      final tempFile = File('${tempDir.path}/$filename');
      await tempFile.writeAsString(content);
      
      _currentFilePath = tempFile.path;
      _currentFileDir = tempDir.path;
      
      // Add to recent files
      await recentFilesService.add(tempFile.path, filename);
      
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
          // Save filename for display immediately
          setState(() {
            _currentFilename = filename;
          });
          _pendingContent = content;
          _pendingFilename = filename;
          
          // Also save to temp so it can be shared
          try {
            final tempDir = await getTemporaryDirectory();
            final tempFile = File('${tempDir.path}/${filename ?? "document.md"}');
            await tempFile.writeAsString(content);
            _currentFilePath = tempFile.path;
            _currentFileDir = tempDir.path;
          } catch (e) {
            debugPrint('[Mobile] Failed to save initial file to temp: $e');
          }
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
    super.dispose();
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
      final legacyRequestId = decoded['_requestId'] as int?;

      // New unified envelope (WebView -> Host)
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
            // TODO: launch external URL
          }
          break;

        case 'DOWNLOAD_FILE':
          if (payload is Map) {
            if (isEnvelope) {
              _handleDownloadFileEnvelope(
                Map<String, dynamic>.from(payload),
                envelopeId!,
              );
            } else {
              _handleDownloadFile(Map<String, dynamic>.from(payload), legacyRequestId);
            }
          }
          break;

        case 'READ_RELATIVE_FILE':
          if (payload is Map) {
            if (isEnvelope) {
              _handleReadRelativeFileEnvelope(
                Map<String, dynamic>.from(payload),
                envelopeId!,
              );
            } else if (legacyRequestId != null) {
              _handleReadRelativeFile(Map<String, dynamic>.from(payload), legacyRequestId);
            }
          }
          break;

        case 'FETCH_ASSET':
          if (payload is Map) {
            if (isEnvelope) {
              _handleFetchAssetEnvelope(
                Map<String, dynamic>.from(payload),
                envelopeId!,
              );
            } else if (legacyRequestId != null) {
              _handleFetchAsset(Map<String, dynamic>.from(payload), legacyRequestId);
            }
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
            _handleStorageGet(Map<String, dynamic>.from(payload), envelopeId!);
          }
          break;

        case 'STORAGE_SET':
          if (payload is Map && isEnvelope) {
            _handleStorageSet(Map<String, dynamic>.from(payload), envelopeId!);
          }
          break;

        case 'CACHE_OPERATION':
          if (payload is Map && isEnvelope) {
            _handleCacheOperation(Map<String, dynamic>.from(payload), envelopeId!);
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
        // Add more keys as needed
      }
      
      _respondToWebViewEnvelope(requestId, data: {'success': true});
    } catch (e) {
      debugPrint('[Mobile] Storage set error: $e');
      _respondToWebViewEnvelope(requestId, error: e.toString());
    }
  }

  Future<void> _handleCacheOperation(Map<String, dynamic> payload, String requestId) async {
    try {
      final result = await cacheService.handleOperation(payload);
      _respondToWebViewEnvelope(requestId, data: result['data'], ok: result['ok'] as bool);
    } catch (e) {
      debugPrint('[Mobile] Cache operation error: $e');
      _respondToWebViewEnvelope(requestId, error: e.toString());
    }
  }

  Future<void> _handleDownloadFile(Map<String, dynamic> payload, int? requestId) async {
    try {
      final data = payload['data'] as String?;
      final filename = payload['filename'] as String?;
      final mimeType = payload['mimeType'] as String?;

      if (data == null || filename == null) {
        _respondToWebView(requestId, error: 'Invalid download request');
        return;
      }

      final bytes = base64Decode(data);
      final tempDir = await getTemporaryDirectory();
      final file = File('${tempDir.path}/$filename');
      await file.writeAsBytes(bytes);

      await Share.shareXFiles(
        [XFile(file.path, mimeType: mimeType)],
        sharePositionOrigin: const Rect.fromLTWH(0, 0, 100, 100),
      );

      _respondToWebView(requestId, result: {'success': true});
    } catch (e) {
      _respondToWebView(requestId, error: e.toString());
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
      
      await Share.shareXFiles(
        [XFile(file.path, mimeType: mimeType)],
        sharePositionOrigin: const Rect.fromLTWH(0, 0, 100, 100),
      );

      _respondToWebViewEnvelope(requestId, data: {'success': true});
    } catch (e) {
      _hideExportProgress();
      _respondToWebViewEnvelope(requestId, error: e.toString());
    }
  }

  Future<void> _handleReadRelativeFile(Map<String, dynamic> payload, int requestId) async {
    try {
      final relativePath = payload['path'] as String?;

      if (relativePath == null || relativePath.isEmpty) {
        _respondToWebView(requestId, error: 'No path provided');
        return;
      }

      if (_currentFileDir == null) {
        _respondToWebView(requestId, error: 'No markdown file opened');
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
        _respondToWebView(requestId, error: 'File not found: $absolutePath');
        return;
      }

      final content = await file.readAsString();
      _respondToWebView(requestId, result: {'content': content});
    } catch (e) {
      debugPrint('[Mobile] READ_RELATIVE_FILE error: $e');
      _respondToWebView(requestId, error: e.toString());
    }
  }

  Future<void> _handleReadRelativeFileEnvelope(
    Map<String, dynamic> payload,
    String requestId,
  ) async {
    try {
      final relativePath = payload['path'] as String?;

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

      final content = await file.readAsString();
      _respondToWebViewEnvelope(requestId, data: {'content': content});
    } catch (e) {
      debugPrint('[Mobile] READ_RELATIVE_FILE error: $e');
      _respondToWebViewEnvelope(requestId, error: e.toString());
    }
  }

  /// Handle FETCH_ASSET request from WebView
  /// Loads asset from Flutter's asset bundle
  Future<void> _handleFetchAsset(Map<String, dynamic> payload, int requestId) async {
    try {
      final path = payload['path'] as String?;
      if (path == null) {
        _respondToWebView(requestId, error: 'Missing path parameter');
        return;
      }

      final content = await rootBundle.loadString('build/mobile/$path');
      _respondToWebView(requestId, result: content);
    } catch (e) {
      debugPrint('[Mobile] FETCH_ASSET error for ${payload['path']}: $e');
      _respondToWebView(requestId, error: e.toString());
    }
  }

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

  void _respondToWebView(int? requestId, {dynamic result, String? error}) {
    if (requestId == null) return;

    final response = <String, dynamic>{
      '_responseId': requestId,
    };
    if (error != null) {
      response['error'] = error;
    } else {
      response['result'] = result;
    }

    _sendToWebView(response);
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
        allowedExtensions: ['md', 'markdown'],
      );

      if (result != null && result.files.isNotEmpty) {
        final filePath = result.files.single.path!;
        final file = File(filePath);
        final content = await file.readAsString();
        final filename = result.files.single.name;

        // Save the directory and path of the markdown file
        _currentFileDir = file.parent.path;
        _currentFilePath = filePath;

        // Add to recent files
        await recentFilesService.add(filePath, filename);

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
    final escaped = _escapeJs(content);
    try {
      // Get theme data and pass it along with content to avoid race condition
      final themeData = await themeAssetService.getCompleteThemeData(_currentTheme);
      final themeJson = jsonEncode(themeData);
      final escapedTheme = themeJson.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
      
      await _controller.runJavaScript(
        "if(window.loadMarkdown){window.loadMarkdown('$escaped','$filename','$escapedTheme');}else{console.error('loadMarkdown not defined');}",
      );
      setState(() {
        _hasContent = true;
      });
    } catch (e) {
      debugPrint('[Mobile] JS injection error: $e');
    }
  }

  /// Send complete theme data from Flutter assets to WebView
  Future<void> _sendThemeData(String themeId) async {
    try {
      final themeData = await themeAssetService.getCompleteThemeData(themeId);
      final json = jsonEncode(themeData);
      final escaped = json.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
      
      await _controller.runJavaScript(
        "if(window.applyThemeData){window.applyThemeData('$escaped');}else{console.error('applyThemeData not defined');}",
      );
    } catch (e) {
      debugPrint('[Mobile] Failed to send theme data: $e');
    }
  }

  Future<void> _applyTheme(String themeId) async {
    // Use _sendThemeData instead of asking WebView to fetch
    await _sendThemeData(themeId);
  }

  Future<void> _showThemePicker() async {
    final selectedTheme = await ThemePicker.show(context, _currentTheme);
    if (selectedTheme != null && selectedTheme != _currentTheme) {
      await _applyTheme(selectedTheme);
      setState(() {
        _currentTheme = selectedTheme;
      });
      settingsService.theme = selectedTheme;
    }
  }

  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();

  void _showToc() {
    if (_headings.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(localization.t('no_headings'))),
      );
      return;
    }
    _scaffoldKey.currentState?.openDrawer();
  }

  void _showFontSizeSlider() {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (context) => _FontSizeBottomSheet(
        initialSize: settingsService.fontSize,
        onChanged: (size) {
          settingsService.fontSize = size;
          _controller.runJavaScript(
            "if(window.setFontSize){window.setFontSize($size);}",
          );
        },
      ),
    );
  }

  Future<void> _shareFile() async {
    if (_currentFilePath == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(localization.t('no_file_to_share'))),
      );
      return;
    }

    try {
      await Share.shareXFiles(
        [XFile(_currentFilePath!)],
        sharePositionOrigin: const Rect.fromLTWH(0, 0, 100, 100),
      );
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(localization.t('failed_to_share', [e.toString()]))),
        );
      }
    }
  }

  /// Save current file - let user choose location
  Future<void> _saveToLibrary() async {
    if (_pendingContent == null && _currentFilePath == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(localization.t('no_file_to_share'))),
      );
      return;
    }
    
    try {
      // Get content from current file or pending content
      String content;
      if (_currentFilePath != null) {
        content = await File(_currentFilePath!).readAsString();
      } else {
        content = _pendingContent!;
      }
      
      final filename = _currentFilename ?? 'document.md';
      
      // Use file picker to let user choose save location
      final result = await FilePicker.platform.saveFile(
        dialogTitle: localization.t('save_file'),
        fileName: filename,
        type: FileType.custom,
        allowedExtensions: ['md', 'markdown'],
        bytes: utf8.encode(content),
      );
      
      if (result != null) {
        // On some platforms, saveFile returns path but doesn't write
        // We need to write the file ourselves
        if (!result.endsWith('.md') && !result.endsWith('.markdown')) {
          // File was saved by the picker (bytes were used)
        } else {
          // Write file to the selected path
          final file = File(result);
          await file.writeAsString(content);
        }
        
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(localization.t('save_success'))),
          );
        }
      }
    } catch (e) {
      debugPrint('[Mobile] Save file error: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(localization.t('save_failed'))),
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

  Future<void> _clearCache() async {
    try {
      await _controller.runJavaScript(
        "if(window.clearCache){window.clearCache();}",
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(localization.t('cache_clear_success'))),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(localization.t('cache_clear_failed'))),
        );
      }
    }
  }

  void _showLanguagePicker() {
    // Locale code to translation key mapping
    const localeKeyMap = {
      'da': 'settings_language_da',
      'de': 'settings_language_de',
      'en': 'settings_language_en',
      'es': 'settings_language_es',
      'fi': 'settings_language_fi',
      'fr': 'settings_language_fr',
      'hi': 'settings_language_hi',
      'id': 'settings_language_id',
      'it': 'settings_language_it',
      'ja': 'settings_language_ja',
      'ko': 'settings_language_ko',
      'nl': 'settings_language_nl',
      'no': 'settings_language_no',
      'pl': 'settings_language_pl',
      'pt_BR': 'settings_language_pt_br',
      'pt_PT': 'settings_language_pt_pt',
      'ru': 'settings_language_ru',
      'sv': 'settings_language_sv',
      'th': 'settings_language_th',
      'tr': 'settings_language_tr',
      'vi': 'settings_language_vi',
      'zh_CN': 'settings_language_zh_cn',
      'zh_TW': 'settings_language_zh_tw',
    };

    showModalBottomSheet(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.all(16.0),
              child: Text(
                localization.t('language'),
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  // Auto option
                  RadioListTile<String?>(
                    title: Text(localization.t('settings_language_auto')),
                    value: null,
                    groupValue: localization.userSelectedLocale,
                    onChanged: (value) async {
                      await localization.setLocale(null);
                      if (mounted) {
                        Navigator.pop(context);
                        setState(() {});
                        // Notify WebView
                        _controller.runJavaScript(
                          "if(window.setLocale){window.setLocale('${localization.currentLocale}');}"
                        );
                      }
                    },
                  ),
                  const Divider(height: 1),
                  // All supported locales
                  ...LocalizationService.supportedLocales.map((locale) {
                    final key = localeKeyMap[locale] ?? 'settings_language_en';
                    return RadioListTile<String?>(
                      title: Text(localization.t(key)),
                      value: locale,
                      groupValue: localization.userSelectedLocale,
                      onChanged: (value) async {
                        await localization.setLocale(value);
                        if (mounted) {
                          Navigator.pop(context);
                          setState(() {});
                          // Notify WebView
                          _controller.runJavaScript(
                            "if(window.setLocale){window.setLocale('$value');}"
                          );
                        }
                      },
                    );
                  }),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _showAbout() async {
    final packageInfo = await PackageInfo.fromPlatform();
    if (!mounted) return;
    showAboutDialog(
      context: context,
      applicationName: localization.t('extensionName'),
      applicationVersion: 'v${packageInfo.version}',
      applicationLegalese: '@xicilion',
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
    return Stack(
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
      color: Colors.black54,
      child: Center(
        child: Card(
          margin: const EdgeInsets.all(32),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const CircularProgressIndicator(),
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
                      color: Colors.grey[600],
                    ),
                  ),
                ],
              ],
            ),
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
      items: [
        PopupMenuItem<String>(
          value: 'open',
          child: _buildMenuItemContent(AntIcons.folder_open_outline, localization.t('open_file')),
        ),
        if (_hasContent)
          PopupMenuItem<String>(
            value: 'save',
            child: _buildMenuItemContent(AntIcons.save, localization.t('save_file')),
          ),
        if (_hasContent)
          PopupMenuItem<String>(
            value: 'export_docx',
            child: _buildMenuItemContent(AntIcons.file_word, localization.t('export_docx')),
          ),
        PopupMenuItem<String>(
          value: 'theme',
          child: _buildMenuItemContent(AntIcons.bg_colors, localization.t('theme')),
        ),
        PopupMenuItem<String>(
          value: 'zoom',
          child: _buildMenuItemContent(AntIcons.font_size, localization.t('zoom')),
        ),
        PopupMenuItem<String>(
          value: 'language',
          child: _buildMenuItemContent(AntIcons.global, localization.t('language')),
        ),
        const PopupMenuDivider(),
        PopupMenuItem<String>(
          value: 'clear_cache',
          child: _buildMenuItemContent(AntIcons.delete_outline, localization.t('cache_clear')),
        ),
        PopupMenuItem<String>(
          value: 'about',
          child: _buildMenuItemContent(AntIcons.info_circle_outline, localization.t('about')),
        ),
      ],
    ).then((value) {
      if (value == null) return;
      switch (value) {
        case 'open':
          _openFile();
          break;
        case 'save':
          _saveToLibrary();
          break;
        case 'export_docx':
          _exportDocx();
          break;
        case 'theme':
          _showThemePicker();
          break;
        case 'zoom':
          _showFontSizeSlider();
          break;
        case 'language':
          _showLanguagePicker();
          break;
        case 'clear_cache':
          _clearCache();
          break;
        case 'about':
          _showAbout();
          break;
      }
    });
  }

  Widget _buildMenuItemContent(IconData icon, String title) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 20),
        const SizedBox(width: 16),
        Text(title),
      ],
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
                      Icon(
                        AntIcons.file_markdown_outline,
                        size: 64,
                        color: Theme.of(context).colorScheme.primary.withOpacity(0.5),
                      ),
                      const SizedBox(height: 16),
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
                        icon: const Icon(AntIcons.folder_open_outline),
                        label: Text(localization.t('open_file')),
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
                          size: 18,
                          color: Theme.of(context).hintColor,
                        ),
                        const SizedBox(width: 8),
                        Text(
                          localization.t('recent_files'),
                          style: Theme.of(context).textTheme.titleSmall?.copyWith(
                            color: Theme.of(context).hintColor,
                          ),
                        ),
                        const Spacer(),
                        TextButton(
                          onPressed: _clearRecentFiles,
                          child: Text(localization.t('clear_all')),
                        ),
                      ],
                    ),
                  ),
                ),
                SliverList(
                  delegate: SliverChildBuilderDelegate(
                    (context, index) {
                      final file = recentFiles[index];
                      return _RecentFileItem(
                        file: file,
                        onTap: () => _openRecentFile(file),
                        onDelete: () => _removeRecentFile(file),
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
      final f = File(file.path);
      if (!await f.exists()) {
        // File no longer exists, remove from recent and show error
        await recentFilesService.remove(file.path);
        setState(() {});
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(localization.t('file_not_found'))),
          );
        }
        return;
      }

      final content = await f.readAsString();
      _currentFileDir = f.parent.path;
      _currentFilePath = file.path;

      // Update last opened time
      await recentFilesService.add(file.path, file.name);

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

  /// Remove a file from recent list
  Future<void> _removeRecentFile(RecentFile file) async {
    await recentFilesService.remove(file.path);
    setState(() {});
  }

  /// Clear all recent files
  Future<void> _clearRecentFiles() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(localization.t('clear_recent_files')),
        content: Text(localization.t('clear_recent_files_confirm')),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(localization.t('cancel')),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(localization.t('clear_all')),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      await recentFilesService.clear();
      setState(() {});
    }
  }
}

/// Widget for displaying a recent file item
class _RecentFileItem extends StatelessWidget {
  final RecentFile file;
  final VoidCallback onTap;
  final VoidCallback onDelete;

  const _RecentFileItem({
    required this.file,
    required this.onTap,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: const Icon(AntIcons.file_markdown_outline),
      title: Text(
        file.name,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text(
        _formatPath(file.path),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontSize: 12,
          color: Theme.of(context).hintColor,
        ),
      ),
      trailing: IconButton(
        icon: const Icon(AntIcons.close, size: 18),
        onPressed: onDelete,
        tooltip: localization.t('remove'),
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
    return Drawer(
      child: SafeArea(
        child: headings.isEmpty
            ? Center(
                child: Text(
                  localization.t('no_headings'),
                  style: const TextStyle(color: Colors.grey),
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

                        return InkWell(
                          onTap: () => onHeadingTap(id),
                          child: Padding(
                            padding: EdgeInsets.only(
                              left: 16.0 + (level - 1) * 16.0,
                              right: 16,
                              top: 6,
                              bottom: 6,
                            ),
                            child: Text(
                              text,
                              style: TextStyle(
                                fontSize: level == 1 ? 16 : (level == 2 ? 15 : 14),
                                fontWeight: level <= 2 ? FontWeight.w600 : FontWeight.normal,
                                color: level > 3 ? Theme.of(context).hintColor : null,
                              ),
                            ),
                          ),
                        );
                      },
                    ),
      ),
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
                const Icon(AntIcons.font_size),
                const SizedBox(width: 12),
                Text(
                  localization.t('zoom'),
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                if (!isDefault)
                  TextButton(
                    onPressed: () {
                      setState(() {
                        _currentSize = 16;
                      });
                      widget.onChanged(16);
                    },
                    child: Text(localization.t('reset')),
                  ),
                Text(
                  '$zoomPercent%',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    color: Theme.of(context).colorScheme.primary,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
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
