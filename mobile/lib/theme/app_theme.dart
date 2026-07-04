import 'package:flutter/material.dart';

/// GitHub-inspired color palette for Markdown Viewer
class AppColors {
  AppColors._();

  // Primary - GitHub Blue
  static const Color primary = Color(0xFF0969DA);
  static const Color primaryMuted = Color(0xFF54AEFF);  // For backgrounds
  static const Color primarySubtle = Color(0xFFDDF4FF); // Light background

  // Secondary - GitHub Orange (for featured/star)
  static const Color secondary = Color(0xFFBF8700);
  static const Color secondarySubtle = Color(0xFFFFF8C5);

  // GitHub Gray scale
  static const Color gray50 = Color(0xFFF6F8FA);
  static const Color gray100 = Color(0xFFEAEEF2);
  static const Color gray200 = Color(0xFFD0D7DE);
  static const Color gray300 = Color(0xFFAFB8C1);
  static const Color gray400 = Color(0xFF8C959F);
  static const Color gray500 = Color(0xFF6E7781);
  static const Color gray600 = Color(0xFF57606A);
  static const Color gray700 = Color(0xFF424A53);
  static const Color gray800 = Color(0xFF32383F);
  static const Color gray900 = Color(0xFF24292F);

  // Semantic colors (GitHub style)
  static const Color success = Color(0xFF1A7F37);
  static const Color successSubtle = Color(0xFFDCFFE4);
  static const Color error = Color(0xFFCF222E);
  static const Color errorSubtle = Color(0xFFFFEBE9);
}

/// App theme for Markdown Viewer (GitHub-inspired)
final ThemeData appTheme = ThemeData(
  useMaterial3: true,
  brightness: Brightness.light,
  colorScheme: const ColorScheme.light(
    primary: AppColors.primary,
    onPrimary: Colors.white,
    primaryContainer: AppColors.gray100,        // Neutral gray for icon backgrounds
    onPrimaryContainer: AppColors.gray600,      // Gray icon color
    secondary: AppColors.secondary,
    onSecondary: Colors.white,
    secondaryContainer: AppColors.secondarySubtle,
    onSecondaryContainer: AppColors.secondary,
    error: AppColors.error,
    onError: Colors.white,
    errorContainer: AppColors.errorSubtle,
    surface: Colors.white,
    onSurface: AppColors.gray900,
    onSurfaceVariant: AppColors.gray600,
    surfaceContainerHighest: AppColors.gray100,
    outline: AppColors.gray300,
    outlineVariant: AppColors.gray200,
  ),
  scaffoldBackgroundColor: Colors.white,
  appBarTheme: const AppBarTheme(
    backgroundColor: Colors.white,
    foregroundColor: AppColors.gray900,
    elevation: 0,
    scrolledUnderElevation: 0.5,
    surfaceTintColor: Colors.transparent,
  ),
  cardTheme: CardThemeData(
    color: Colors.white,
    elevation: 0,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(6),
      side: const BorderSide(color: AppColors.gray200),
    ),
  ),
  dividerTheme: const DividerThemeData(
    color: AppColors.gray200,
    thickness: 1,
  ),
  popupMenuTheme: PopupMenuThemeData(
    color: Colors.white,
    elevation: 8,
    shadowColor: Colors.black26,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(6),
      side: const BorderSide(color: AppColors.gray200),
    ),
  ),
  bottomSheetTheme: const BottomSheetThemeData(
    backgroundColor: Colors.white,
    surfaceTintColor: Colors.transparent,
    showDragHandle: false,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
  ),
  snackBarTheme: SnackBarThemeData(
    backgroundColor: AppColors.gray800,
    contentTextStyle: const TextStyle(color: Colors.white),
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(8),
    ),
    behavior: SnackBarBehavior.floating,
  ),
  dialogTheme: DialogThemeData(
    backgroundColor: Colors.white,
    surfaceTintColor: Colors.transparent,
    elevation: 8,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(20),
    ),
  ),
  listTileTheme: const ListTileThemeData(
    contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 2),
    iconColor: AppColors.gray600,
    minVerticalPadding: 10,
  ),
  filledButtonTheme: FilledButtonThemeData(
    style: FilledButton.styleFrom(
      shape: const StadiumBorder(),
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
    ),
  ),
  textButtonTheme: TextButtonThemeData(
    style: TextButton.styleFrom(
      foregroundColor: AppColors.primary,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
    ),
  ),
  outlinedButtonTheme: OutlinedButtonThemeData(
    style: OutlinedButton.styleFrom(
      shape: const StadiumBorder(),
      side: const BorderSide(color: AppColors.gray300),
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
    ),
  ),
  chipTheme: ChipThemeData(
    backgroundColor: Colors.white,
    side: const BorderSide(color: AppColors.gray200),
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
    labelStyle: const TextStyle(fontSize: 13, color: AppColors.gray900),
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
  ),
  switchTheme: SwitchThemeData(
    thumbColor: WidgetStateProperty.resolveWith(
      (states) => states.contains(WidgetState.selected)
          ? Colors.white
          : AppColors.gray400,
    ),
    trackColor: WidgetStateProperty.resolveWith(
      (states) => states.contains(WidgetState.selected)
          ? AppColors.primary
          : AppColors.gray100,
    ),
    trackOutlineColor: WidgetStateProperty.resolveWith(
      (states) => states.contains(WidgetState.selected)
          ? AppColors.primary
          : AppColors.gray300,
    ),
  ),
  dividerColor: AppColors.gray200,
);



