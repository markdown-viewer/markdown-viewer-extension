import 'package:flutter/material.dart';
import 'package:getwidget/getwidget.dart';
import 'package:webview_flutter/webview_flutter.dart';
import '../services/cache_storage.dart';
import '../services/localization_service.dart';
import '../services/settings_service.dart';
import '../services/theme_registry_service.dart';
import '../widgets/theme_picker.dart';

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
          GFListTile(
            avatar: GFAvatar(
              backgroundColor: Theme.of(context).colorScheme.primaryContainer,
              child: Icon(
                Icons.palette_outlined,
                color: Theme.of(context).colorScheme.onPrimaryContainer,
              ),
            ),
            titleText: localization.t('theme'),
            subTitleText: _getCurrentThemeDisplayName(),
            icon: const Icon(Icons.chevron_right),
            onTap: _pickTheme,
          ),
          GFListTile(
            avatar: GFAvatar(
              backgroundColor: Theme.of(context).colorScheme.primaryContainer,
              child: Icon(
                Icons.language_outlined,
                color: Theme.of(context).colorScheme.onPrimaryContainer,
              ),
            ),
            titleText: localization.t('language'),
            subTitleText: _getCurrentLanguageDisplayName(),
            icon: const Icon(Icons.chevron_right),
            onTap: _pickLanguage,
          ),
          const Divider(),

          // Display section
          _SectionHeader(title: localization.t('settings_general_title')),
          GFListTile(
            avatar: GFAvatar(
              backgroundColor: Theme.of(context).colorScheme.primaryContainer,
              child: Icon(
                Icons.article_outlined,
                color: Theme.of(context).colorScheme.onPrimaryContainer,
              ),
            ),
            titleText: localization.t('settings_frontmatter_display'),
            subTitleText: _getFrontmatterDisplayName(),
            icon: const Icon(Icons.chevron_right),
            onTap: _pickFrontmatterDisplay,
          ),
          GFListTile(
            avatar: GFAvatar(
              backgroundColor: Theme.of(context).colorScheme.primaryContainer,
              child: Icon(
                Icons.emoji_emotions_outlined,
                color: Theme.of(context).colorScheme.onPrimaryContainer,
              ),
            ),
            titleText: localization.t('settings_docx_emoji_style'),
            subTitleText: _getEmojiStyleDisplayName(),
            icon: const Icon(Icons.chevron_right),
            onTap: _pickEmojiStyle,
          ),
          _SwitchTile(
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
          _SwitchTile(
            title: localization.t('settings_docx_hr_page_break'),
            subtitle: localization.t('settings_docx_hr_page_break_note'),
            value: settingsService.hrPageBreak,
            onChanged: (value) {
              setState(() {
                settingsService.hrPageBreak = value;
              });
              // HR page break only affects DOCX export, no need to re-render
            },
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
          const Divider(),
          GFListTile(
            avatar: GFAvatar(
              backgroundColor: Theme.of(context).colorScheme.primaryContainer,
              child: Icon(
                Icons.cleaning_services_outlined,
                color: Theme.of(context).colorScheme.onPrimaryContainer,
              ),
            ),
            titleText: localization.t('cache_clear'),
            subTitleText: '${localization.t('cache_stat_size_label')}: ${_loadingStats ? '…' : (_cacheSize.isEmpty ? '…' : _cacheSize)}\n'
              '${localization.t('cache_stat_item_label')}: $_cacheCount',
            icon: _clearingCache
                ? const GFLoader(type: GFLoaderType.circle, size: GFSize.SMALL)
                : const Icon(Icons.chevron_right),
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
      await controller.runJavaScript(
        "if(window.setFontSize){window.setFontSize($size);}",
      );
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
          "if(window.setTheme){window.setTheme('$escapedTheme');}",
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
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
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
                  "if(window.setLocale){window.setLocale('$localeToSend');}",
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

  void _pickEmojiStyle() {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (context) {
        return Container(
          padding: const EdgeInsets.symmetric(vertical: 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              _buildEmojiStyleOption('system'),
              _buildEmojiStyleOption('windows'),
              _buildEmojiStyleOption('apple'),
            ],
          ),
        );
      },
    );
  }

  Widget _buildEmojiStyleOption(String style) {
    final isSelected = settingsService.emojiStyle == style;
    String displayName;
    switch (style) {
      case 'apple':
        displayName = localization.t('settings_docx_emoji_style_apple');
        break;
      case 'windows':
        displayName = localization.t('settings_docx_emoji_style_windows');
        break;
      case 'system':
        displayName = localization.t('settings_docx_emoji_style_system');
        break;
      default:
        displayName = style;
    }

    return ListTile(
      title: Text(displayName),
      trailing: isSelected ? const Icon(Icons.check, color: Colors.blue) : null,
      onTap: () {
        setState(() {
          settingsService.emojiStyle = style;
        });
        Navigator.pop(context);
      },
    );
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

  void _pickFrontmatterDisplay() {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (context) {
        return Container(
          padding: const EdgeInsets.symmetric(vertical: 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              _buildFrontmatterDisplayOption('hide'),
              _buildFrontmatterDisplayOption('table'),
              _buildFrontmatterDisplayOption('raw'),
            ],
          ),
        );
      },
    );
  }

  Widget _buildFrontmatterDisplayOption(String display) {
    final isSelected = settingsService.frontmatterDisplay == display;
    String displayName;
    switch (display) {
      case 'hide':
        displayName = localization.t('settings_frontmatter_hide');
        break;
      case 'table':
        displayName = localization.t('settings_frontmatter_table');
        break;
      case 'raw':
        displayName = localization.t('settings_frontmatter_raw');
        break;
      default:
        displayName = display;
    }

    return ListTile(
      title: Text(displayName),
      trailing: isSelected ? const Icon(Icons.check, color: Colors.blue) : null,
      onTap: () {
        setState(() {
          settingsService.frontmatterDisplay = display;
        });
        Navigator.pop(context);
        // Re-render to apply new frontmatter display setting
        final controller = widget.webViewController;
        if (controller != null) {
          controller.runJavaScript(
            "if(window.rerender){window.rerender();}",
          );
        }
      },
    );
  }
}

/// Language picker bottom sheet with GetWidget style
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
        // Header
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
            border: Border(
              bottom: BorderSide(color: Theme.of(context).dividerColor),
            ),
          ),
          child: Row(
            children: [
              const Icon(Icons.language_outlined),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  localization.t('language'),
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
                ),
              ),
              IconButton(
                icon: const Icon(Icons.close),
                onPressed: () => Navigator.pop(context),
              ),
            ],
          ),
        ),
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

/// Single language item with GetWidget style
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
    return GFListTile(
      avatar: isSelected
          ? Icon(Icons.check, color: Theme.of(context).colorScheme.primary, size: 20)
          : const SizedBox(width: 20),
      titleText: title,
      onTap: onTap,
      selected: isSelected,
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
    return GFListTile(
      avatar: GFAvatar(
        backgroundColor: Theme.of(context).colorScheme.primaryContainer,
        child: Icon(
          Icons.format_size,
          color: Theme.of(context).colorScheme.onPrimaryContainer,
        ),
      ),
      titleText: localization.t('zoom'),
      subTitleText: '$fontSize pt',
      icon: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            icon: Icon(Icons.remove_circle_outline, 
              color: fontSize > 12 ? Theme.of(context).colorScheme.primary : Theme.of(context).disabledColor,
            ),
            iconSize: 28,
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
            icon: Icon(Icons.add_circle_outline,
              color: fontSize < 24 ? Theme.of(context).colorScheme.primary : Theme.of(context).disabledColor,
            ),
            iconSize: 28,
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
    this.iconData = Icons.insert_page_break_outlined,
  });

  @override
  Widget build(BuildContext context) {
    return GFListTile(
      avatar: GFAvatar(
        backgroundColor: Theme.of(context).colorScheme.primaryContainer,
        child: Icon(
          iconData,
          color: Theme.of(context).colorScheme.onPrimaryContainer,
        ),
      ),
      titleText: title,
      subTitleText: subtitle,
      icon: GFToggle(
        onChanged: (val) => onChanged(val ?? false),
        value: value,
        type: GFToggleType.ios,
        enabledThumbColor: Theme.of(context).colorScheme.primary,
        enabledTrackColor: Theme.of(context).colorScheme.primaryContainer,
      ),
    );
  }
}
