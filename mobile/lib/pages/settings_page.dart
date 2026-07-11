import 'dart:io' show Platform;
import 'package:ant_icons/ant_icons.dart';
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import '../services/cache_storage.dart';
import '../services/localization_service.dart';
import '../services/settings_service.dart';
import '../services/theme_registry_service.dart';
import '../widgets/theme_picker.dart';
import '../widgets/ui_kit.dart';

/// Settings page for the app
class SettingsPage extends StatefulWidget {
  final WebViewController? webViewController;

  const SettingsPage({
    super.key,
    this.webViewController,
  });

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  bool _clearingCache = false;
  bool _loadingStats = false;
  String _cacheSize = '';
  int _cacheCount = 0;

  @override
  void initState() {
    super.initState();
    _loadCacheStats();
  }

  Future<void> _loadCacheStats() async {
    setState(() {
      _loadingStats = true;
    });

    try {
      // Get stats directly from Flutter cache service
      final stats = await cacheStorage.getStats();
      
      if (mounted) {
        setState(() {
          _cacheSize = '${stats.totalSizeMB} MB';
          _cacheCount = stats.itemCount;
        });
      }
    } catch (e) {
      debugPrint('[Settings] Failed to load cache stats: $e');
      if (mounted) {
        setState(() {
          _cacheSize = '';
        });
      }
    } finally {
      if (mounted) {
        setState(() {
          _loadingStats = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(localization.t('tab_settings')),
      ),
      body: ListView(
        children: [
          // Interface section
          _SectionHeader(title: localization.t('settings_interface_title')),
          ListTile(
            leading: const LeadingIcon(AntIcons.bg_colors),
            title: Text(localization.t('theme')),
            subtitle: Text(_getCurrentThemeDisplayName()),
            trailing: const Icon(AntIcons.right_outline, size: 16),
            onTap: _pickTheme,
          ),
          ListTile(
            leading: const LeadingIcon(AntIcons.global),
            title: Text(localization.t('language')),
            subtitle: Text(_getCurrentLanguageDisplayName()),
            trailing: const Icon(AntIcons.right_outline, size: 16),
            onTap: _pickLanguage,
          ),
          const Divider(),

          // Display section
          _SectionHeader(title: localization.t('settings_general_title')),
          ListTile(
            leading: const LeadingIcon(AntIcons.file_text_outline),
            title: Text(localization.t('settings_frontmatter_display')),
            subtitle: Text(_getFrontmatterDisplayName()),
            trailing: const Icon(AntIcons.right_outline, size: 16),
            onTap: _pickFrontmatterDisplay,
          ),
          ListTile(
            leading: const LeadingIcon(AntIcons.smile_outline),
            title: Text(localization.t('settings_docx_emoji_style')),
            subtitle: Text(_getEmojiStyleDisplayName()),
            trailing: const Icon(AntIcons.right_outline, size: 16),
            onTap: _pickEmojiStyle,
          ),
          _SwitchTile(
            iconData: AntIcons.border_horizontal,
            title: localization.t('settings_table_merge_empty'),
            subtitle: localization.t('settings_table_merge_empty_note'),
            value: settingsService.tableMergeEmpty,
            onChanged: (value) {
              setState(() {
                settingsService.tableMergeEmpty = value;
              });
              _notifySettingChanged();
            },
          ),
          ListTile(
            leading: const LeadingIcon(AntIcons.table),
            title: Text(localization.t('settings_table_layout')),
            subtitle: Text(_getTableLayoutName()),
            trailing: const Icon(AntIcons.right_outline, size: 16),
            onTap: _pickTableLayout,
          ),
          ListTile(
            leading: const LeadingIcon(AntIcons.minus_outline),
            title: Text(localization.t('settings_docx_hr_display')),
            subtitle: Text(_getHrDisplayName()),
            trailing: const Icon(AntIcons.right_outline, size: 16),
            onTap: _pickHrDisplay,
          ),
          _FontSizeTile(
            fontSize: settingsService.fontSize,
            onChanged: (size) {
              setState(() {
                settingsService.fontSize = size;
              });
              _applyFontSize(size);
            },
          ),
          ListTile(
            leading: const LeadingIcon(AntIcons.align_left),
            title: Text(localization.t('settings_first_line_indent')),
            subtitle: Text(_getFirstLineIndentName()),
            trailing: const Icon(AntIcons.right_outline, size: 16),
            onTap: _pickFirstLineIndent,
          ),
          const Divider(),
          ListTile(
            leading: const LeadingIcon(AntIcons.delete_outline),
            title: Text(localization.t('cache_clear')),
            subtitle: Text(
              '${localization.t('cache_stat_size_label')}: ${_loadingStats ? '…' : (_cacheSize.isEmpty ? '…' : _cacheSize)}\n'
              '${localization.t('cache_stat_item_label')}: $_cacheCount',
            ),
            trailing: _clearingCache
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(AntIcons.right_outline, size: 16),
            onTap: _clearingCache ? null : _clearCache,
          ),
        ],
      ),
    );
  }

  Future<void> _applyFontSize(int size) async {
    final controller = widget.webViewController;
    if (controller == null) return;

    try {
      if (Platform.isIOS || Platform.isMacOS) {
        // Use viewport meta tag initial-scale for browser-level zoom on iOS
        final scale = size / 16.0;
        await controller.runJavaScript(
          "var m=document.querySelector('meta[name=viewport]');"
          "if(m){var w=Math.round(screen.width/$scale);"
          "m.setAttribute('content','width='+w+',initial-scale=$scale,maximum-scale=$scale,user-scalable=no');}",
        );
      } else {
        await controller.runJavaScript(
          "if(window.setFontSize){window.setFontSize($size);}",
        );
      }
    } catch (e) {
      debugPrint('[Settings] Failed to apply font size: $e');
    }
  }

  /// Notify WebView to re-render after settings change
  void _notifySettingChanged() {
    final controller = widget.webViewController;
    if (controller != null) {
      controller.runJavaScript(
        "if(window.rerender){window.rerender();}",
      );
    }
  }

  Future<void> _clearCache() async {
    setState(() {
      _clearingCache = true;
    });

    try {
      // Clear Flutter cache service directly
      await cacheStorage.clear();

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(localization.t('cache_clear_success'))),
        );
        // Close settings page immediately after successful cache clear
        Navigator.pop(context);
      }
    } catch (e) {
      debugPrint('[Settings] Failed to clear cache: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(localization.t('cache_clear_failed'))),
        );
        setState(() {
          _clearingCache = false;
        });
      }
    }
  }

  String _getCurrentThemeDisplayName() {
    final currentTheme = settingsService.theme;
    final useChinese = themeRegistry.useChineseNames;
    final theme = themeRegistry.themes
        .where((t) => t.id == currentTheme)
        .cast<dynamic?>()
        .firstWhere((t) => t != null, orElse: () => null);
    if (theme == null) return currentTheme;

    final zhName = (theme as dynamic).displayNameZh as String?;
    final enName = (theme as dynamic).displayName as String?;
    return (useChinese ? (zhName ?? enName) : (enName ?? zhName)) ?? currentTheme;
  }

  Future<void> _pickTheme() async {
    final selectedTheme = await ThemePicker.show(context, settingsService.theme);
    if (!mounted) return;
    if (selectedTheme == null || selectedTheme == settingsService.theme) return;

    settingsService.theme = selectedTheme;

    final controller = widget.webViewController;
    if (controller != null) {
      try {
        // Send themeId only - WebView loads theme data itself
        final escapedTheme = selectedTheme.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
        await controller.runJavaScript(
          "if(window.syncHostUi){window.syncHostUi({themeId:'$escapedTheme'});}else{console.error('syncHostUi not defined');}",
        );
      } catch (e) {
        debugPrint('[Settings] Failed to apply theme: $e');
      }
    }

    // Close settings page after theme selection
    if (mounted) {
      Navigator.pop(context);
    }
  }

  String _getCurrentLanguageDisplayName() {
    final selected = localization.userSelectedLocale;
    if (selected == null) {
      return localization.t('settings_language_auto');
    }
    // Use display name from registry.json
    return localization.getLocaleDisplayName(selected);
  }

  void _pickLanguage() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (context) => DraggableScrollableSheet(
        initialChildSize: 0.6,
        minChildSize: 0.4,
        maxChildSize: 0.9,
        expand: false,
        builder: (context, scrollController) => _LanguagePickerSheet(
          scrollController: scrollController,
          onLocaleSelected: (locale) async {
            await localization.setLocale(locale);
            if (mounted) {
              // Close language picker first
              Navigator.pop(context);
              // Apply locale to webview
              final controller = widget.webViewController;
              if (controller != null) {
                final localeToSend = locale ?? localization.currentLocale;
                controller.runJavaScript(
                  "if(window.syncHostUi){window.syncHostUi({locale:'$localeToSend'});}else{console.error('syncHostUi not defined');}",
                );
              }
              // Close settings page
              if (mounted) {
                Navigator.pop(context);
              }
            }
          },
        ),
      ),
    );
  }

  String _getEmojiStyleDisplayName() {
    final style = settingsService.emojiStyle;
    switch (style) {
      case 'apple':
        return localization.t('settings_docx_emoji_style_apple');
      case 'windows':
        return localization.t('settings_docx_emoji_style_windows');
      case 'system':
        return localization.t('settings_docx_emoji_style_system');
      default:
        return localization.t('settings_docx_emoji_style_system');
    }
  }

  String _getTableLayoutName() {
    final layout = settingsService.tableLayout;
    switch (layout) {
      case 'center':
        return localization.t('settings_table_layout_center');
      case 'center-full-width':
        return localization.t('settings_table_layout_full_width');
      case 'left':
        return localization.t('settings_table_layout_left');
      default:
        return localization.t('settings_table_layout_left');
    }
  }

  String _getHrDisplayName() {
    final display = settingsService.hrDisplay;
    switch (display) {
      case 'pageBreak':
        return localization.t('settings_docx_hr_display_page_break');
      case 'line':
        return localization.t('settings_docx_hr_display_line');
      case 'hide':
        return localization.t('settings_docx_hr_display_hide');
      default:
        return localization.t('settings_docx_hr_display_hide');
    }
  }

  String _getFirstLineIndentName() {
    final indent = settingsService.firstLineIndent;
    switch (indent) {
      case 0:
        return localization.t('settings_first_line_indent_off');
      case 1:
        return localization.t('settings_first_line_indent_1');
      case 2:
        return localization.t('settings_first_line_indent_2');
      case 3:
        return localization.t('settings_first_line_indent_3');
      case 4:
        return localization.t('settings_first_line_indent_4');
      default:
        return localization.t('settings_first_line_indent_2');
    }
  }

  Future<void> _pickFirstLineIndent() async {
    final selected = await showSingleChoiceSheet<int>(
      context: context,
      title: localization.t('settings_first_line_indent'),
      icon: AntIcons.align_left,
      selected: settingsService.firstLineIndent,
      options: [
        ChoiceOption(
            value: 0,
            label: localization.t('settings_first_line_indent_off')),
        ChoiceOption(
            value: 1,
            label: localization.t('settings_first_line_indent_1')),
        ChoiceOption(
            value: 2,
            label: localization.t('settings_first_line_indent_2')),
        ChoiceOption(
            value: 3,
            label: localization.t('settings_first_line_indent_3')),
        ChoiceOption(
            value: 4,
            label: localization.t('settings_first_line_indent_4')),
      ],
    );
    if (selected == null || !mounted) return;
    setState(() {
      settingsService.firstLineIndent = selected;
    });
    // firstLineIndent is baked into theme CSS, so reload theme + re-render
    final controller = widget.webViewController;
    if (controller != null) {
      controller.runJavaScript(
        "if(window.reloadThemeAndRerender){window.reloadThemeAndRerender();}",
      );
    }
    if (mounted) Navigator.pop(context);
  }

  Future<void> _pickHrDisplay() async {
    final selected = await showSingleChoiceSheet<String>(
      context: context,
      title: localization.t('settings_docx_hr_display'),
      icon: AntIcons.minus_outline,
      selected: settingsService.hrDisplay,
      options: [
        ChoiceOption(
            value: 'hide',
            label: localization.t('settings_docx_hr_display_hide')),
        ChoiceOption(
            value: 'line',
            label: localization.t('settings_docx_hr_display_line')),
        ChoiceOption(
            value: 'pageBreak',
            label: localization.t('settings_docx_hr_display_page_break')),
      ],
    );
    if (selected == null || !mounted) return;
    setState(() {
      settingsService.hrDisplay = selected;
    });
    if (mounted) Navigator.pop(context);
  }

  Future<void> _pickTableLayout() async {
    final selected = await showSingleChoiceSheet<String>(
      context: context,
      title: localization.t('settings_table_layout'),
      icon: AntIcons.table,
      selected: settingsService.tableLayout,
      options: [
        ChoiceOption(
            value: 'left',
            label: localization.t('settings_table_layout_left')),
        ChoiceOption(
            value: 'center',
            label: localization.t('settings_table_layout_center')),
        ChoiceOption(
            value: 'center-full-width',
            label: localization.t('settings_table_layout_full_width')),
      ],
    );
    if (selected == null || !mounted) return;
    setState(() {
      settingsService.tableLayout = selected;
    });
    _notifySettingChanged();
    if (mounted) Navigator.pop(context);
  }

  Future<void> _pickEmojiStyle() async {
    final selected = await showSingleChoiceSheet<String>(
      context: context,
      title: localization.t('settings_docx_emoji_style'),
      icon: AntIcons.smile_outline,
      selected: settingsService.emojiStyle,
      options: [
        ChoiceOption(
            value: 'system',
            label: localization.t('settings_docx_emoji_style_system')),
        ChoiceOption(
            value: 'windows',
            label: localization.t('settings_docx_emoji_style_windows')),
        ChoiceOption(
            value: 'apple',
            label: localization.t('settings_docx_emoji_style_apple')),
      ],
    );
    if (selected == null || !mounted) return;
    setState(() {
      settingsService.emojiStyle = selected;
    });
    if (mounted) Navigator.pop(context);
  }

  String _getFrontmatterDisplayName() {
    final display = settingsService.frontmatterDisplay;
    switch (display) {
      case 'hide':
        return localization.t('settings_frontmatter_hide');
      case 'table':
        return localization.t('settings_frontmatter_table');
      case 'raw':
        return localization.t('settings_frontmatter_raw');
      default:
        return localization.t('settings_frontmatter_hide');
    }
  }

  Future<void> _pickFrontmatterDisplay() async {
    final selected = await showSingleChoiceSheet<String>(
      context: context,
      title: localization.t('settings_frontmatter_display'),
      icon: AntIcons.file_text_outline,
      selected: settingsService.frontmatterDisplay,
      options: [
        ChoiceOption(
            value: 'hide', label: localization.t('settings_frontmatter_hide')),
        ChoiceOption(
            value: 'table',
            label: localization.t('settings_frontmatter_table')),
        ChoiceOption(
            value: 'raw', label: localization.t('settings_frontmatter_raw')),
      ],
    );
    if (selected == null || !mounted) return;
    setState(() {
      settingsService.frontmatterDisplay = selected;
    });
    // Re-render to apply new frontmatter display setting
    final controller = widget.webViewController;
    if (controller != null) {
      controller.runJavaScript(
        "if(window.rerender){window.rerender();}",
      );
    }
    if (mounted) Navigator.pop(context);
  }
}

/// Language picker bottom sheet.
class _LanguagePickerSheet extends StatelessWidget {
  final ScrollController scrollController;
  final void Function(String?) onLocaleSelected;

  const _LanguagePickerSheet({
    required this.scrollController,
    required this.onLocaleSelected,
  });

  @override
  Widget build(BuildContext context) {
    final currentLocale = localization.userSelectedLocale;

    return Column(
      children: [
        const SheetGrabber(),
        SheetHeader(
          title: localization.t('language'),
          icon: AntIcons.global,
        ),
        const Divider(height: 1),
        // Language list
        Expanded(
          child: ListView(
            controller: scrollController,
            children: [
              // Auto option
              _LanguageItem(
                title: localization.t('settings_language_auto'),
                isSelected: currentLocale == null,
                onTap: () => onLocaleSelected(null),
              ),
              const Divider(height: 1, indent: 56),
              // All supported locales
              ...localization.supportedLocales.map((locale) {
                return _LanguageItem(
                  title: localization.getLocaleDisplayName(locale),
                  isSelected: currentLocale == locale,
                  onTap: () => onLocaleSelected(locale),
                );
              }),
            ],
          ),
        ),
      ],
    );
  }
}

/// Single language row.
class _LanguageItem extends StatelessWidget {
  final String title;
  final bool isSelected;
  final VoidCallback onTap;

  const _LanguageItem({
    required this.title,
    required this.isSelected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: isSelected
          ? Icon(AntIcons.check_outline,
              color: Theme.of(context).colorScheme.primary, size: 20)
          : const SizedBox(width: 20),
      title: Text(
        title,
        style: TextStyle(
          fontWeight: isSelected ? FontWeight.w600 : FontWeight.normal,
          color: isSelected ? Theme.of(context).colorScheme.primary : null,
        ),
      ),
      selected: isSelected,
      onTap: onTap,
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final String title;

  const _SectionHeader({required this.title});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      child: Text(
        title,
        style: TextStyle(
          fontSize: 14,
          fontWeight: FontWeight.w600,
          color: Theme.of(context).colorScheme.primary,
        ),
      ),
    );
  }
}

class _FontSizeTile extends StatelessWidget {
  final int fontSize;
  final void Function(int) onChanged;

  const _FontSizeTile({
    required this.fontSize,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: const LeadingIcon(AntIcons.font_size),
      title: Text(localization.t('zoom')),
      subtitle: Text('$fontSize pt'),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            icon: Icon(AntIcons.minus_circle,
              color: fontSize > 12 ? Theme.of(context).colorScheme.primary : Theme.of(context).disabledColor,
            ),
            iconSize: 26,
            onPressed: fontSize > 12 ? () => onChanged(fontSize - 1) : null,
          ),
          SizedBox(
            width: 40,
            child: Text(
              '$fontSize',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w600,
                color: Theme.of(context).colorScheme.primary,
              ),
            ),
          ),
          IconButton(
            icon: Icon(AntIcons.plus_circle,
              color: fontSize < 24 ? Theme.of(context).colorScheme.primary : Theme.of(context).disabledColor,
            ),
            iconSize: 26,
            onPressed: fontSize < 24 ? () => onChanged(fontSize + 1) : null,
          ),
        ],
      ),
    );
  }
}

class _SwitchTile extends StatelessWidget {
  final String title;
  final String? subtitle;
  final bool value;
  final void Function(bool) onChanged;
  final IconData iconData;

  const _SwitchTile({
    required this.title,
    this.subtitle,
    required this.value,
    required this.onChanged,
    this.iconData = AntIcons.border_horizontal,
  });

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: LeadingIcon(iconData),
      title: Text(title),
      subtitle: subtitle != null ? Text(subtitle!) : null,
      trailing: Switch(
        value: value,
        onChanged: onChanged,
      ),
      onTap: () => onChanged(!value),
    );
  }
}
