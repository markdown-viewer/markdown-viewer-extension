import 'dart:convert';
import 'package:flutter/services.dart';
import '../models/theme_info.dart';
import 'localization_service.dart';

/// Service to load theme registry from assets
class ThemeRegistryService {
  static final ThemeRegistryService _instance = ThemeRegistryService._internal();
  factory ThemeRegistryService() => _instance;
  ThemeRegistryService._internal();

  List<ThemeInfo> _themes = [];
  Map<String, CategoryInfo> _categories = {};
  bool _initialized = false;

  List<ThemeInfo> get themes => _themes;
  Map<String, CategoryInfo> get categories => _categories;
  bool get isInitialized => _initialized;

  /// Check if current locale is Chinese
  bool get useChineseNames {
    final locale = localization.currentLocale;
    return locale.startsWith('zh');
  }

  /// Initialize by loading from assets
  Future<void> init() async {
    if (_initialized) return;

    try {
      // Load registry.json
      final registryJson = await rootBundle.loadString('build/mobile/themes/registry.json');
      final registry = json.decode(registryJson) as Map<String, dynamic>;

      // Parse categories
      final categoriesMap = registry['categories'] as Map<String, dynamic>;
      _categories = categoriesMap.map((id, data) => MapEntry(
        id,
        CategoryInfo.fromJson(id, data as Map<String, dynamic>),
      ));

      // Load theme metadata from preset files
      final themesList = registry['themes'] as List<dynamic>;
      final loadedThemes = <ThemeInfo>[];

      for (final themeEntry in themesList) {
        final entry = themeEntry as Map<String, dynamic>;
        final file = entry['file'] as String;
        final category = entry['category'] as String? ?? 'other';
        final featured = entry['featured'] as bool? ?? false;
        final order = entry['order'] as int? ?? 0;

        try {
          final themeJson = await rootBundle.loadString('build/mobile/themes/presets/$file');
          final themeData = json.decode(themeJson) as Map<String, dynamic>;

          loadedThemes.add(ThemeInfo(
            id: themeData['id'] as String,
            displayName: themeData['name_en'] as String? ?? themeData['name'] as String,
            displayNameZh: themeData['name'] as String?,
            category: category,
            featured: featured,
            order: order,
          ));
        } catch (e) {
          // Skip themes that fail to load
          continue;
        }
      }

      _themes = loadedThemes;
      _initialized = true;
    } catch (e) {
      // Fallback to hardcoded if loading fails
      _themes = ThemeRegistry.themes;
      _categories = ThemeRegistry.categories;
      _initialized = true;
    }
  }

  /// Get themes grouped by category
  Map<String, List<ThemeInfo>> getThemesByCategory() {
    final result = <String, List<ThemeInfo>>{};
    for (final theme in _themes) {
      result.putIfAbsent(theme.category, () => []).add(theme);
    }
    // Sort themes within each category
    for (final list in result.values) {
      list.sort((a, b) => a.order.compareTo(b.order));
    }
    return result;
  }

  /// Get sorted categories
  List<CategoryInfo> getSortedCategories() {
    final cats = _categories.values.toList();
    cats.sort((a, b) => a.order.compareTo(b.order));
    return cats;
  }
}

/// Global instance
final themeRegistry = ThemeRegistryService();
