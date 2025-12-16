import 'dart:convert';
import 'dart:ui';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Localization service that loads translations from WebView's _locales
class LocalizationService {
  static final LocalizationService _instance = LocalizationService._internal();
  factory LocalizationService() => _instance;
  LocalizationService._internal();

  static const String _prefKey = 'selected_locale';

  Map<String, String> _messages = {};
  String _currentLocale = 'en';
  String? _userSelectedLocale; // null means auto (system locale)
  bool _initialized = false;

  /// Supported locales with their folder names
  static const List<String> supportedLocales = [
    'da', 'de', 'en', 'es', 'fi', 'fr', 'hi', 'id', 'it', 'ja',
    'ko', 'nl', 'no', 'pl', 'pt_BR', 'pt_PT', 'ru', 'sv', 'th',
    'tr', 'vi', 'zh_CN', 'zh_TW'
  ];

  /// Supported locales mapping (Flutter locale -> _locales folder name)
  static const Map<String, String> _localeMapping = {
    'da': 'da',
    'de': 'de',
    'en': 'en',
    'es': 'es',
    'fi': 'fi',
    'fr': 'fr',
    'hi': 'hi',
    'id': 'id',
    'it': 'it',
    'ja': 'ja',
    'ko': 'ko',
    'nl': 'nl',
    'no': 'no',
    'pl': 'pl',
    'pt': 'pt_BR', // Portuguese defaults to Brazilian
    'ru': 'ru',
    'sv': 'sv',
    'th': 'th',
    'tr': 'tr',
    'vi': 'vi',
    'zh': 'zh_CN', // Chinese defaults to Simplified
  };

  /// Get current locale
  String get currentLocale => _currentLocale;

  /// Get user selected locale (null means auto)
  String? get userSelectedLocale => _userSelectedLocale;

  /// Check if using auto locale
  bool get isAutoLocale => _userSelectedLocale == null;

  /// Check if initialized
  bool get isInitialized => _initialized;

  /// Initialize with saved or system locale
  Future<void> init() async {
    if (_initialized) return;

    // Load saved preference
    final prefs = await SharedPreferences.getInstance();
    _userSelectedLocale = prefs.getString(_prefKey);

    String localeCode;
    if (_userSelectedLocale != null) {
      // Use saved locale
      localeCode = _userSelectedLocale!;
    } else {
      // Use system locale
      localeCode = _getSystemLocale();
    }

    await _loadLocale(localeCode);
    _initialized = true;
  }

  /// Get system locale code
  String _getSystemLocale() {
    final systemLocale = PlatformDispatcher.instance.locale;
    String localeCode = systemLocale.languageCode;

    // Handle Chinese variants
    if (localeCode == 'zh') {
      final countryCode = systemLocale.countryCode?.toUpperCase();
      if (countryCode == 'TW' || countryCode == 'HK' || countryCode == 'MO') {
        return 'zh_TW';
      } else {
        return 'zh_CN';
      }
    } else if (localeCode == 'pt') {
      // Handle Portuguese variants
      final countryCode = systemLocale.countryCode?.toUpperCase();
      if (countryCode == 'PT') {
        return 'pt_PT';
      } else {
        return 'pt_BR';
      }
    } else {
      // Map to _locales folder name
      return _localeMapping[localeCode] ?? 'en';
    }
  }

  /// Change locale (null for auto/system locale)
  Future<void> setLocale(String? localeCode) async {
    final prefs = await SharedPreferences.getInstance();
    
    if (localeCode == null) {
      // Auto mode - use system locale
      await prefs.remove(_prefKey);
      _userSelectedLocale = null;
      await _loadLocale(_getSystemLocale());
    } else {
      // Manual selection
      await prefs.setString(_prefKey, localeCode);
      _userSelectedLocale = localeCode;
      await _loadLocale(localeCode);
    }
  }

  /// Load a specific locale
  Future<void> _loadLocale(String localeCode) async {
    try {
      final jsonString = await rootBundle.loadString(
        'build/mobile/_locales/$localeCode/messages.json',
      );
      final Map<String, dynamic> data = jsonDecode(jsonString);

      _messages = {};
      for (final entry in data.entries) {
        if (entry.value is Map && entry.value['message'] != null) {
          _messages[entry.key] = entry.value['message'] as String;
        }
      }
      _currentLocale = localeCode;
    } catch (e) {
      // Fallback to English if locale not found
      if (localeCode != 'en') {
        await _loadLocale('en');
      }
    }
  }

  /// Translate a key with optional substitutions
  /// Substitutions use {0}, {1}, etc. placeholders
  String translate(String key, [List<String>? substitutions]) {
    String message = _messages[key] ?? key;

    if (substitutions != null) {
      for (int i = 0; i < substitutions.length; i++) {
        message = message.replaceAll('{$i}', substitutions[i]);
      }
    }

    return message;
  }

  /// Shorthand for translate
  String t(String key, [List<String>? substitutions]) =>
      translate(key, substitutions);
}

/// Global instance for easy access
final localization = LocalizationService();
