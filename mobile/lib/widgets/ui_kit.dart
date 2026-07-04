import 'package:ant_icons/ant_icons.dart';
import 'package:flutter/material.dart';

/// Shared, Material 3 based UI building blocks used across the app.
///
/// These replace the previous mix of GetWidget components so every screen
/// shares the same spacing, shape and touch-feedback language.

/// A rounded-square tinted icon container used as a leading element in list
/// tiles, sheet headers and dialogs. Replaces the old `GFAvatar` circles with a
/// squircle that matches Material 3 tonal surfaces.
class LeadingIcon extends StatelessWidget {
  final IconData icon;

  /// Optional background tint. Defaults to the primary tonal container.
  final Color? background;

  /// Optional foreground (icon) color. Defaults to the on-primary container.
  final Color? foreground;

  /// Overall box size.
  final double size;

  /// Icon glyph size.
  final double iconSize;

  const LeadingIcon(
    this.icon, {
    super.key,
    this.background,
    this.foreground,
    this.size = 40,
    this.iconSize = 20,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: background ?? scheme.primaryContainer,
        borderRadius: BorderRadius.circular(size * 0.28),
      ),
      child: Icon(
        icon,
        size: iconSize,
        color: foreground ?? scheme.onPrimaryContainer,
      ),
    );
  }
}

/// The little grab handle rendered at the top of modal bottom sheets.
class SheetGrabber extends StatelessWidget {
  const SheetGrabber({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(top: 10, bottom: 2),
      width: 36,
      height: 4,
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.outlineVariant,
        borderRadius: BorderRadius.circular(2),
      ),
    );
  }
}

/// A consistent header row for bottom sheets: tinted icon + title, an optional
/// trailing action, and a close button.
class SheetHeader extends StatelessWidget {
  final String title;
  final IconData? icon;
  final Widget? trailing;
  final bool showClose;

  const SheetHeader({
    super.key,
    required this.title,
    this.icon,
    this.trailing,
    this.showClose = true,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 6, 8, 12),
      child: Row(
        children: [
          if (icon != null) ...[
            LeadingIcon(icon!, size: 34, iconSize: 18),
            const SizedBox(width: 12),
          ],
          Expanded(
            child: Text(
              title,
              style: theme.textTheme.titleMedium
                  ?.copyWith(fontWeight: FontWeight.w600),
            ),
          ),
          if (trailing != null) trailing!,
          if (showClose)
            IconButton(
              icon: const Icon(AntIcons.close, size: 18),
              visualDensity: VisualDensity.compact,
              onPressed: () => Navigator.of(context).maybePop(),
            ),
        ],
      ),
    );
  }
}

/// One selectable option in [showSingleChoiceSheet].
class ChoiceOption<T> {
  final T value;
  final String label;
  final String? description;
  final IconData? icon;

  const ChoiceOption({
    required this.value,
    required this.label,
    this.description,
    this.icon,
  });
}

/// Shows a unified single-select bottom sheet and returns the chosen value
/// (or null if dismissed). Used by every "pick one of N" setting so they all
/// look and behave identically.
Future<T?> showSingleChoiceSheet<T>({
  required BuildContext context,
  required String title,
  required List<ChoiceOption<T>> options,
  required T selected,
  IconData? icon,
}) {
  return showModalBottomSheet<T>(
    context: context,
    showDragHandle: false,
    isScrollControlled: true,
    builder: (sheetContext) {
      final scheme = Theme.of(sheetContext).colorScheme;
      return SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SheetGrabber(),
            SheetHeader(title: title, icon: icon),
            const Divider(height: 1),
            Flexible(
              child: ListView.builder(
                shrinkWrap: true,
                padding: const EdgeInsets.symmetric(vertical: 4),
                itemCount: options.length,
                itemBuilder: (context, index) {
                  final option = options[index];
                  final isSelected = option.value == selected;
                  return ListTile(
                    leading: option.icon != null
                        ? Icon(
                            option.icon,
                            color: isSelected
                                ? scheme.primary
                                : scheme.onSurfaceVariant,
                          )
                        : null,
                    title: Text(
                      option.label,
                      style: TextStyle(
                        fontWeight:
                            isSelected ? FontWeight.w600 : FontWeight.normal,
                        color: isSelected ? scheme.primary : null,
                      ),
                    ),
                    subtitle: option.description != null
                        ? Text(option.description!)
                        : null,
                    trailing: isSelected
                        ? Icon(AntIcons.check_outline,
                            size: 20, color: scheme.primary)
                        : null,
                    onTap: () => Navigator.pop(context, option.value),
                  );
                },
              ),
            ),
          ],
        ),
      );
    },
  );
}
