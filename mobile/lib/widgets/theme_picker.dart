import 'package:ant_icons/ant_icons.dart';
import 'package:flutter/material.dart';
import '../models/theme_info.dart';
import '../services/localization_service.dart';
import '../services/theme_registry_service.dart';
import 'ui_kit.dart';

/// Bottom sheet for selecting themes
class ThemePicker extends StatelessWidget {
  final String currentTheme;
  final void Function(String themeId) onThemeSelected;

  const ThemePicker({
    super.key,
    required this.currentTheme,
    required this.onThemeSelected,
  });

  /// Check if current locale is Chinese
  static bool get _useChineseNames {
    return themeRegistry.useChineseNames;
  }

  /// Show the theme picker as a modal bottom sheet
  static Future<String?> show(BuildContext context, String currentTheme) {
    return showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (context) => DraggableScrollableSheet(
        initialChildSize: 0.7,
        minChildSize: 0.5,
        maxChildSize: 0.9,
        expand: false,
        builder: (context, scrollController) => ThemePicker(
          currentTheme: currentTheme,
          onThemeSelected: (themeId) => Navigator.pop(context, themeId),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final themesByCategory = themeRegistry.getThemesByCategory();
    final categories = themeRegistry.getSortedCategories();

    return Column(
      children: [
        const SheetGrabber(),
        SheetHeader(
          title: localization.t('settings_theme_label').replaceAll(':', ''),
          icon: AntIcons.bg_colors,
        ),
        const Divider(height: 1),
        // Theme list
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: 16),
            itemCount: categories.length,
            itemBuilder: (context, index) {
              final category = categories[index];
              final themes = themesByCategory[category.id] ?? [];
              if (themes.isEmpty) return const SizedBox.shrink();

              return _CategorySection(
                category: category,
                themes: themes,
                currentTheme: currentTheme,
                onThemeSelected: onThemeSelected,
              );
            },
          ),
        ),
      ],
    );
  }
}

class _CategorySection extends StatelessWidget {
  final CategoryInfo category;
  final List<ThemeInfo> themes;
  final String currentTheme;
  final void Function(String) onThemeSelected;

  const _CategorySection({
    required this.category,
    required this.themes,
    required this.currentTheme,
    required this.onThemeSelected,
  });

  @override
  Widget build(BuildContext context) {
    final useChinese = ThemePicker._useChineseNames;
    final hasSelectedTheme = themes.any((t) => t.id == currentTheme);
    
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Category header
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          child: Row(
            children: [
              Text(
                useChinese ? category.name : category.nameEn,
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: hasSelectedTheme 
                      ? Theme.of(context).colorScheme.primary 
                      : Theme.of(context).hintColor,
                ),
              ),
              if (hasSelectedTheme) ...[
                const SizedBox(width: 6),
                Icon(
                  AntIcons.check_circle,
                  size: 14,
                  color: Theme.of(context).colorScheme.primary,
                ),
              ],
            ],
          ),
        ),
        // Theme chips
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: themes.map((theme) {
              final isSelected = theme.id == currentTheme;
              return _ThemeChip(
                theme: theme,
                isSelected: isSelected,
                onTap: () => onThemeSelected(theme.id),
                useChinese: useChinese,
              );
            }).toList(),
          ),
        ),
      ],
    );
  }
}

class _ThemeChip extends StatelessWidget {
  final ThemeInfo theme;
  final bool isSelected;
  final VoidCallback onTap;
  final bool useChinese;

  const _ThemeChip({
    required this.theme,
    required this.isSelected,
    required this.onTap,
    required this.useChinese,
  });

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    // Use Chinese name if available and locale is Chinese
    final displayName = useChinese && theme.displayNameZh != null 
        ? theme.displayNameZh! 
        : theme.displayName;

    Widget? avatar;
    if (isSelected) {
      avatar = Icon(AntIcons.check_outline, size: 16, color: colorScheme.onPrimary);
    } else if (theme.featured) {
      avatar = Icon(AntIcons.star, size: 14, color: colorScheme.secondary);
    }

    return ActionChip(
      onPressed: onTap,
      label: Text(displayName),
      avatar: avatar,
      backgroundColor: isSelected ? colorScheme.primary : null,
      side: isSelected ? BorderSide.none : BorderSide(color: colorScheme.outline),
      labelStyle: TextStyle(
        fontWeight: isSelected ? FontWeight.w600 : FontWeight.normal,
        color: isSelected ? colorScheme.onPrimary : colorScheme.onSurface,
      ),
      padding: const EdgeInsets.symmetric(horizontal: 8),
    );
  }
}
