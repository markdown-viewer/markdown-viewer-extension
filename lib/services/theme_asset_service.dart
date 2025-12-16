import 'dart:convert';
import 'package:flutter/services.dart';

/// Service for loading theme assets from Flutter bundle
class ThemeAssetService {
  Map<String, dynamic>? _registry;
  Map<String, dynamic>? _fontConfig;
  final Map<String, Map<String, dynamic>> _themeCache = {};
  final Map<String, Map<String, dynamic>> _tableStyleCache = {};
  final Map<String, Map<String, dynamic>> _codeThemeCache = {};
  final Map<String, Map<String, dynamic>> _spacingCache = {};

  /// Load the theme registry
  Future<Map<String, dynamic>> getRegistry() async {
    if (_registry != null) return _registry!;
    final data = await rootBundle.loadString('build/mobile/themes/registry.json');
    _registry = jsonDecode(data) as Map<String, dynamic>;
    return _registry!;
  }

  /// Load font config
  Future<Map<String, dynamic>> getFontConfig() async {
    if (_fontConfig != null) return _fontConfig!;
    final data = await rootBundle.loadString('build/mobile/themes/font-config.json');
    _fontConfig = jsonDecode(data) as Map<String, dynamic>;
    return _fontConfig!;
  }

  /// Load a theme preset
  Future<Map<String, dynamic>> getThemePreset(String themeId) async {
    if (_themeCache.containsKey(themeId)) return _themeCache[themeId]!;
    final data = await rootBundle.loadString('build/mobile/themes/presets/$themeId.json');
    final theme = jsonDecode(data) as Map<String, dynamic>;
    _themeCache[themeId] = theme;
    return theme;
  }

  /// Load a table style
  Future<Map<String, dynamic>> getTableStyle(String styleName) async {
    if (_tableStyleCache.containsKey(styleName)) return _tableStyleCache[styleName]!;
    final data = await rootBundle.loadString('build/mobile/themes/table-styles/$styleName.json');
    final style = jsonDecode(data) as Map<String, dynamic>;
    _tableStyleCache[styleName] = style;
    return style;
  }

  /// Load a code theme
  Future<Map<String, dynamic>> getCodeTheme(String themeName) async {
    if (_codeThemeCache.containsKey(themeName)) return _codeThemeCache[themeName]!;
    final data = await rootBundle.loadString('build/mobile/themes/code-themes/$themeName.json');
    final theme = jsonDecode(data) as Map<String, dynamic>;
    _codeThemeCache[themeName] = theme;
    return theme;
  }

  /// Load a spacing scheme
  Future<Map<String, dynamic>> getSpacingScheme(String schemeName) async {
    if (_spacingCache.containsKey(schemeName)) return _spacingCache[schemeName]!;
    final data = await rootBundle.loadString('build/mobile/themes/spacing-schemes/$schemeName.json');
    final scheme = jsonDecode(data) as Map<String, dynamic>;
    _spacingCache[schemeName] = scheme;
    return scheme;
  }

  /// Load complete theme data (theme + table style + code theme + spacing)
  Future<Map<String, dynamic>> getCompleteThemeData(String themeId) async {
    final fontConfig = await getFontConfig();
    final theme = await getThemePreset(themeId);
    
    final tableStyleName = theme['tableStyle'] as String? ?? 'default';
    final codeThemeName = theme['codeTheme'] as String? ?? 'default';
    final spacingName = theme['spacing'] as String? ?? 'default';
    
    final tableStyle = await getTableStyle(tableStyleName);
    final codeTheme = await getCodeTheme(codeThemeName);
    final spacing = await getSpacingScheme(spacingName);
    
    return {
      'fontConfig': fontConfig,
      'theme': theme,
      'tableStyle': tableStyle,
      'codeTheme': codeTheme,
      'spacing': spacing,
    };
  }
}

/// Global theme asset service instance
final themeAssetService = ThemeAssetService();
