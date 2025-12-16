import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';

/// Model for a recently opened file
class RecentFile {
  final String path;
  final String name;
  final int lastOpened;

  RecentFile({
    required this.path,
    required this.name,
    required this.lastOpened,
  });

  factory RecentFile.fromJson(Map<String, dynamic> json) {
    return RecentFile(
      path: json['path'] as String,
      name: json['name'] as String,
      lastOpened: json['lastOpened'] as int,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'path': path,
      'name': name,
      'lastOpened': lastOpened,
    };
  }
}

/// Service for managing recently opened files
class RecentFilesService {
  static const String _key = 'recent_files';
  static const int _maxItems = 20;

  SharedPreferences? _prefs;
  List<RecentFile> _files = [];

  /// Initialize the service
  Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
    _load();
  }

  /// Load recent files from storage
  void _load() {
    final json = _prefs?.getString(_key);
    if (json != null) {
      try {
        final list = jsonDecode(json) as List<dynamic>;
        _files = list
            .map((item) => RecentFile.fromJson(item as Map<String, dynamic>))
            .toList();
      } catch (e) {
        _files = [];
      }
    }
  }

  /// Save recent files to storage
  Future<void> _save() async {
    final json = jsonEncode(_files.map((f) => f.toJson()).toList());
    await _prefs?.setString(_key, json);
  }

  /// Get all recent files (sorted by lastOpened, newest first)
  List<RecentFile> getAll() {
    return List.unmodifiable(_files);
  }

  /// Add or update a file in the recent list
  Future<void> add(String path, String name) async {
    // Remove existing entry with same path
    _files.removeWhere((f) => f.path == path);

    // Add new entry at the beginning
    _files.insert(
      0,
      RecentFile(
        path: path,
        name: name,
        lastOpened: DateTime.now().millisecondsSinceEpoch,
      ),
    );

    // Trim to max items
    if (_files.length > _maxItems) {
      _files = _files.sublist(0, _maxItems);
    }

    await _save();
  }

  /// Remove a file from the recent list
  Future<void> remove(String path) async {
    _files.removeWhere((f) => f.path == path);
    await _save();
  }

  /// Clear all recent files
  Future<void> clear() async {
    _files.clear();
    await _save();
  }

  /// Check if a file exists in recent list
  bool contains(String path) {
    return _files.any((f) => f.path == path);
  }
}

/// Global instance
final recentFilesService = RecentFilesService();
