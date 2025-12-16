import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import '../services/settings_service.dart';

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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Settings'),
      ),
      body: ListView(
        children: [
          // Display section
          _SectionHeader(title: 'Display'),
          _FontSizeTile(
            fontSize: settingsService.fontSize,
            onChanged: (size) {
              setState(() {
                settingsService.fontSize = size;
              });
              _applyFontSize(size);
            },
          ),
          _SwitchTile(
            title: 'Soft Line Breaks',
            subtitle: 'Break lines at soft line breaks in markdown',
            value: settingsService.lineBreaks,
            onChanged: (value) {
              setState(() {
                settingsService.lineBreaks = value;
              });
              _applyLineBreaks(value);
            },
          ),
          const Divider(),

          // Cache section
          _SectionHeader(title: 'Cache'),
          ListTile(
            leading: const Icon(Icons.cleaning_services_outlined),
            title: const Text('Clear Render Cache'),
            subtitle: const Text('Clear cached diagram renders'),
            trailing: _clearingCache
                ? const SizedBox(
                    width: 24,
                    height: 24,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.chevron_right),
            onTap: _clearingCache ? null : _clearCache,
          ),
          const Divider(),

          // About section
          _SectionHeader(title: 'About'),
          const ListTile(
            leading: Icon(Icons.info_outline),
            title: Text('Version'),
            subtitle: Text('0.1.0'),
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

  Future<void> _applyLineBreaks(bool enabled) async {
    final controller = widget.webViewController;
    if (controller == null) return;

    try {
      await controller.runJavaScript(
        "if(window.setLineBreaks){window.setLineBreaks($enabled);}",
      );
    } catch (e) {
      debugPrint('[Settings] Failed to apply line breaks: $e');
    }
  }

  Future<void> _clearCache() async {
    setState(() {
      _clearingCache = true;
    });

    try {
      final controller = widget.webViewController;
      if (controller != null) {
        await controller.runJavaScript(
          "if(window.clearCache){window.clearCache();}",
        );
      }

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Cache cleared')),
        );
      }
    } catch (e) {
      debugPrint('[Settings] Failed to clear cache: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to clear cache: $e')),
        );
      }
    } finally {
      if (mounted) {
        setState(() {
          _clearingCache = false;
        });
      }
    }
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
      leading: const Icon(Icons.format_size),
      title: const Text('Font Size'),
      subtitle: Text('$fontSize pt'),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            icon: const Icon(Icons.remove_circle_outline),
            onPressed: fontSize > 12 ? () => onChanged(fontSize - 1) : null,
          ),
          SizedBox(
            width: 40,
            child: Text(
              '$fontSize',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w500),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.add_circle_outline),
            onPressed: fontSize < 24 ? () => onChanged(fontSize + 1) : null,
          ),
        ],
      ),
    );
  }
}

class _SwitchTile extends StatelessWidget {
  final String title;
  final String subtitle;
  final bool value;
  final void Function(bool) onChanged;

  const _SwitchTile({
    required this.title,
    required this.subtitle,
    required this.value,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return SwitchListTile(
      secondary: const Icon(Icons.wrap_text),
      title: Text(title),
      subtitle: Text(subtitle),
      value: value,
      onChanged: onChanged,
    );
  }
}
