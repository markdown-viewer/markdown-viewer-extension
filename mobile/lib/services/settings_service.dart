import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';

/// Service for persisting user settings
class SettingsService {
  static const String _keyTheme = 'theme';
  static const String _keyFontSize = 'fontSize';
  static const String _keyHrPageBreak = 'hrPageBreak';
  static const String _keyEmojiStyle = 'emojiStyle';
  static const String _keyFrontmatterDisplay = 'frontmatterDisplay';
  static const String _keyLocale = 'locale';
  static const String _keySupportMermaid = 'supportMermaid';
  static const String _keySupportVega = 'supportVega';
  static const String _keySupportVegaLite = 'supportVegaLite';
  static const String _keySupportDot = 'supportDot';
  static const String _keySupportInfographic = 'supportInfographic';
  static const String _keyTableMergeEmpty = 'tableMergeEmpty';
  static const String _keyScrollPositions = 'scrollPositions';
  static const int _maxScrollPositions = 100; // Limit stored positions

  SharedPreferences? _prefs;

  /// Initialize the settings service
  Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
  }

  // Theme
  String get theme => _prefs?.getString(_keyTheme) ?? 'default';
  set theme(String value) => _prefs?.setString(_keyTheme, value);

  // Font size
  int get fontSize => _prefs?.getInt(_keyFontSize) ?? 16;
  set fontSize(int value) => _prefs?.setInt(_keyFontSize, value);

  // HR as page break in DOCX export
  bool get hrPageBreak => _prefs?.getBool(_keyHrPageBreak) ?? true;
  set hrPageBreak(bool value) => _prefs?.setBool(_keyHrPageBreak, value);

  // Emoji style in DOCX export: 'apple', 'windows', or 'system'
  String get emojiStyle => _prefs?.getString(_keyEmojiStyle) ?? 'system';
  set emojiStyle(String value) => _prefs?.setString(_keyEmojiStyle, value);

  // Frontmatter display mode: 'hide', 'table', or 'raw'
  String get frontmatterDisplay => _prefs?.getString(_keyFrontmatterDisplay) ?? 'hide';
  set frontmatterDisplay(String value) => _prefs?.setString(_keyFrontmatterDisplay, value);

  // Locale
  String get locale => _prefs?.getString(_keyLocale) ?? 'system';
  set locale(String value) => _prefs?.setString(_keyLocale, value);

  // Supported file extensions
  bool get supportMermaid => _prefs?.getBool(_keySupportMermaid) ?? true;
  set supportMermaid(bool value) => _prefs?.setBool(_keySupportMermaid, value);

  bool get supportVega => _prefs?.getBool(_keySupportVega) ?? true;
  set supportVega(bool value) => _prefs?.setBool(_keySupportVega, value);

  bool get supportVegaLite => _prefs?.getBool(_keySupportVegaLite) ?? true;
  set supportVegaLite(bool value) => _prefs?.setBool(_keySupportVegaLite, value);

  bool get supportDot => _prefs?.getBool(_keySupportDot) ?? true;
  set supportDot(bool value) => _prefs?.setBool(_keySupportDot, value);

  bool get supportInfographic => _prefs?.getBool(_keySupportInfographic) ?? true;
  set supportInfographic(bool value) => _prefs?.setBool(_keySupportInfographic, value);

  // Table merge empty cells
  bool get tableMergeEmpty => _prefs?.getBool(_keyTableMergeEmpty) ?? true;
  set tableMergeEmpty(bool value) => _prefs?.setBool(_keyTableMergeEmpty, value);

  /// Get list of allowed file extensions based on settings
  List<String> get allowedExtensions {
    final extensions = ['md', 'markdown'];
    if (supportMermaid) extensions.add('mermaid');
    if (supportVega) extensions.add('vega');
    if (supportVegaLite) {
      extensions.add('vl');
      extensions.add('vega-lite');
    }
    if (supportDot) extensions.add('gv');
    if (supportInfographic) extensions.add('infographic');
    return extensions;
  }

  /// Get all settings as a map
  Map<String, dynamic> toMap() {
    return {
      'theme': theme,
      'fontSize': fontSize,
      'hrPageBreak': hrPageBreak,
      'emojiStyle': emojiStyle,
      'frontmatterDisplay': frontmatterDisplay,
      'locale': locale,
      'supportMermaid': supportMermaid,
      'supportVega': supportVega,
      'supportVegaLite': supportVegaLite,
      'supportDot': supportDot,
      'supportInfographic': supportInfographic,
      'tableMergeEmpty': tableMergeEmpty,
    };
  }

  // File state memory (file path -> FileState)
  // FileState includes: scrollLine, tocVisible, zoom, layoutMode
  static const String _keyFileStates = 'fileStates';
  static const int _maxFileStates = 100;
  Map<String, Map<String, dynamic>> _fileStatesCache = {};
  bool _fileStatesLoaded = false;

  /// Load file states from storage
  void _loadFileStates() {
    if (_fileStatesLoaded) return;
    _fileStatesLoaded = true;
    
    final json = _prefs?.getString(_keyFileStates);
    if (json != null) {
      try {
        final decoded = jsonDecode(json) as Map<String, dynamic>;
        _fileStatesCache = decoded.map((k, v) => 
          MapEntry(k, Map<String, dynamic>.from(v as Map)));
      } catch (e) {
        _fileStatesCache = {};
      }
    }
    
    // Migration: also try loading from legacy scroll positions
    final legacyJson = _prefs?.getString(_keyScrollPositions);
    if (legacyJson != null && _fileStatesCache.isEmpty) {
      try {
        final decoded = jsonDecode(legacyJson) as Map<String, dynamic>;
        for (final entry in decoded.entries) {
          _fileStatesCache[entry.key] = {
            'scrollLine': (entry.value as num).toDouble(),
          };
        }
        _saveFileStates();
        // Clear legacy data after migration
        _prefs?.remove(_keyScrollPositions);
      } catch (e) {
        // Ignore migration errors
      }
    }
  }

  /// Save file states to storage
  void _saveFileStates() {
    // Limit the number of stored states
    if (_fileStatesCache.length > _maxFileStates) {
      final entries = _fileStatesCache.entries.toList();
      _fileStatesCache = Map.fromEntries(
        entries.sublist(entries.length - _maxFileStates),
      );
    }
    _prefs?.setString(_keyFileStates, jsonEncode(_fileStatesCache));
  }

  /// Get file state for a file
  Map<String, dynamic>? getFileState(String filePath) {
    _loadFileStates();
    return _fileStatesCache[filePath];
  }

  /// Update file state (merge with existing state)
  void setFileState(String filePath, Map<String, dynamic> state) {
    _loadFileStates();
    final existing = _fileStatesCache[filePath] ?? {};
    existing.addAll(state);
    _fileStatesCache[filePath] = existing;
    _saveFileStates();
  }

  /// Clear file state for a file
  void clearFileState(String filePath) {
    _loadFileStates();
    if (_fileStatesCache.containsKey(filePath)) {
      _fileStatesCache.remove(filePath);
      _saveFileStates();
    }
  }

  /// Get scroll position for a file (legacy API, delegates to getFileState)
  double getScrollPosition(String filePath) {
    final state = getFileState(filePath);
    final scrollLine = state?['scrollLine'];
    return (scrollLine is num) ? scrollLine.toDouble() : 0;
  }

  /// Save scroll position for a file (legacy API, delegates to setFileState)
  void setScrollPosition(String filePath, double line) {
    if (line > 0) {
      setFileState(filePath, {'scrollLine': line});
    } else {
      final state = getFileState(filePath);
      if (state != null) {
        state.remove('scrollLine');
        if (state.isEmpty) {
          clearFileState(filePath);
        } else {
          _saveFileStates();
        }
      }
    }
  }
}

/// Global settings service instance
final settingsService = SettingsService();
