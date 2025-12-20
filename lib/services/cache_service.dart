import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

/// Cache entry stored in file system
class CacheEntry {
  final String key;
  final dynamic value;
  final String type;
  final int size;
  final int timestamp;
  final int accessTime;

  CacheEntry({
    required this.key,
    required this.value,
    required this.type,
    required this.size,
    required this.timestamp,
    required this.accessTime,
  });

  factory CacheEntry.fromJson(Map<String, dynamic> json) {
    return CacheEntry(
      key: json['key'] as String,
      value: json['value'],
      type: json['type'] as String? ?? 'unknown',
      size: json['size'] as int? ?? 0,
      timestamp: json['timestamp'] as int? ?? 0,
      accessTime: json['accessTime'] as int? ?? 0,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'key': key,
      'value': value,
      'type': type,
      'size': size,
      'timestamp': timestamp,
      'accessTime': accessTime,
    };
  }

  CacheEntry copyWithAccessTime(int newAccessTime) {
    return CacheEntry(
      key: key,
      value: value,
      type: type,
      size: size,
      timestamp: timestamp,
      accessTime: newAccessTime,
    );
  }
}

/// Cache statistics
class CacheStats {
  final int itemCount;
  final int maxItems;
  final int totalSize;
  final String totalSizeMB;
  final List<Map<String, dynamic>> items;

  CacheStats({
    required this.itemCount,
    required this.maxItems,
    required this.totalSize,
    required this.totalSizeMB,
    required this.items,
  });

  Map<String, dynamic> toJson() {
    return {
      'itemCount': itemCount,
      'maxItems': maxItems,
      'totalSize': totalSize,
      'totalSizeMB': totalSizeMB,
      'items': items,
    };
  }
}

/// Cache service using file system storage
/// Implements LRU eviction strategy similar to Chrome extension
class CacheService {
  static const String _cacheDir = 'render_cache';
  static const String _indexFile = 'cache_index.json';

  final int maxItems;
  Directory? _cacheDirectory;
  Map<String, CacheEntry> _index = {};
  bool _initialized = false;

  // Cleanup state
  bool _cleanupInProgress = false;
  bool _cleanupScheduled = false;

  CacheService({this.maxItems = 500});

  /// Initialize cache service
  Future<void> init() async {
    if (_initialized) return;

    try {
      final appDir = await getApplicationDocumentsDirectory();
      _cacheDirectory = Directory('${appDir.path}/$_cacheDir');

      if (!await _cacheDirectory!.exists()) {
        await _cacheDirectory!.create(recursive: true);
      }

      await _loadIndex();
      _initialized = true;
    } catch (e) {
      debugPrint('[CacheService] Init failed: $e');
    }
  }

  /// Load cache index from file
  Future<void> _loadIndex() async {
    try {
      final indexFile = File('${_cacheDirectory!.path}/$_indexFile');
      if (await indexFile.exists()) {
        final content = await indexFile.readAsString();
        final json = jsonDecode(content) as Map<String, dynamic>;
        _index = json.map((key, value) =>
            MapEntry(key, CacheEntry.fromJson(value as Map<String, dynamic>)));
      }
    } catch (e) {
      debugPrint('[CacheService] Load index failed: $e');
      _index = {};
    }
  }

  /// Save cache index to file
  Future<void> _saveIndex() async {
    try {
      final indexFile = File('${_cacheDirectory!.path}/$_indexFile');
      final json = _index.map((key, value) => MapEntry(key, value.toJson()));
      await indexFile.writeAsString(jsonEncode(json));
    } catch (e) {
      debugPrint('[CacheService] Save index failed: $e');
    }
  }

  /// Get cache file path for a key
  String _getCacheFilePath(String key) {
    // Use hash of key as filename to avoid filesystem issues
    final hash = key.hashCode.toRadixString(16);
    return '${_cacheDirectory!.path}/$hash.cache';
  }

  /// Get cached item by key
  Future<dynamic> get(String key) async {
    await init();

    final entry = _index[key];
    if (entry == null) return null;

    try {
      final file = File(_getCacheFilePath(key));
      if (!await file.exists()) {
        _index.remove(key);
        await _saveIndex();
        return null;
      }

      // Update access time
      _index[key] = entry.copyWithAccessTime(DateTime.now().millisecondsSinceEpoch);
      // Save index asynchronously
      _saveIndex();

      final content = await file.readAsString();
      final data = jsonDecode(content);
      return data['value'];
    } catch (e) {
      debugPrint('[CacheService] Get failed for $key: $e');
      return null;
    }
  }

  /// Set cached item
  Future<bool> set(String key, dynamic value, {String type = 'unknown', int? size}) async {
    await init();

    try {
      final now = DateTime.now().millisecondsSinceEpoch;
      final valueJson = jsonEncode({'value': value});
      final actualSize = size ?? valueJson.length;

      final entry = CacheEntry(
        key: key,
        value: null, // Don't store value in index
        type: type,
        size: actualSize,
        timestamp: now,
        accessTime: now,
      );

      // Write to file
      final file = File(_getCacheFilePath(key));
      await file.writeAsString(valueJson);

      // Update index
      _index[key] = entry;
      await _saveIndex();

      // Schedule cleanup if needed
      _scheduleCleanup();

      return true;
    } catch (e) {
      debugPrint('[CacheService] Set failed for $key: $e');
      return false;
    }
  }

  /// Delete cached item
  Future<bool> delete(String key) async {
    await init();

    try {
      _index.remove(key);
      await _saveIndex();

      final file = File(_getCacheFilePath(key));
      if (await file.exists()) {
        await file.delete();
      }

      return true;
    } catch (e) {
      debugPrint('[CacheService] Delete failed for $key: $e');
      return false;
    }
  }

  /// Clear all cache
  Future<bool> clear() async {
    await init();

    try {
      _index.clear();

      // Delete all cache files
      if (await _cacheDirectory!.exists()) {
        await for (final file in _cacheDirectory!.list()) {
          if (file is File && file.path.endsWith('.cache')) {
            await file.delete();
          }
        }
      }

      await _saveIndex();
      return true;
    } catch (e) {
      debugPrint('[CacheService] Clear failed: $e');
      return false;
    }
  }

  /// Get cache statistics
  Future<CacheStats> getStats({int limit = 50}) async {
    await init();

    int totalSize = 0;
    final items = <Map<String, dynamic>>[];

    // Sort by access time (recent first)
    final sortedEntries = _index.values.toList()
      ..sort((a, b) => b.accessTime.compareTo(a.accessTime));

    for (final entry in sortedEntries) {
      totalSize += entry.size;
      if (items.length < limit) {
        items.add({
          'key': '${entry.key.substring(0, entry.key.length > 32 ? 32 : entry.key.length)}...',
          'type': entry.type,
          'size': entry.size,
          'sizeMB': (entry.size / (1024 * 1024)).toStringAsFixed(3),
          'created': DateTime.fromMillisecondsSinceEpoch(entry.timestamp).toIso8601String(),
          'lastAccess': DateTime.fromMillisecondsSinceEpoch(entry.accessTime).toIso8601String(),
        });
      }
    }

    return CacheStats(
      itemCount: _index.length,
      maxItems: maxItems,
      totalSize: totalSize,
      totalSizeMB: (totalSize / (1024 * 1024)).toStringAsFixed(2),
      items: items,
    );
  }

  /// Schedule cleanup if over limit
  void _scheduleCleanup() {
    if (_cleanupScheduled || _cleanupInProgress) return;
    if (_index.length <= maxItems) return;

    _cleanupScheduled = true;

    Future.delayed(const Duration(milliseconds: 10), () async {
      _cleanupScheduled = false;
      if (_cleanupInProgress) return;
      await _cleanup();
    });
  }

  /// Cleanup oldest items when over limit
  Future<void> _cleanup() async {
    if (_cleanupInProgress) return;
    _cleanupInProgress = true;

    try {
      if (_index.length <= maxItems) return;

      final itemsToDelete = _index.length - maxItems;

      // Sort by access time (oldest first)
      final sortedEntries = _index.entries.toList()
        ..sort((a, b) => a.value.accessTime.compareTo(b.value.accessTime));

      // Delete oldest items
      for (int i = 0; i < itemsToDelete && i < sortedEntries.length; i++) {
        final key = sortedEntries[i].key;
        _index.remove(key);

        final file = File(_getCacheFilePath(key));
        if (await file.exists()) {
          await file.delete();
        }
      }

      await _saveIndex();
    } catch (e) {
      debugPrint('[CacheService] Cleanup failed: $e');
    } finally {
      _cleanupInProgress = false;
    }
  }

  /// Handle cache operation from WebView
  Future<Map<String, dynamic>> handleOperation(Map<String, dynamic> payload) async {
    final operation = payload['operation'] as String?;
    final key = payload['key'] as String?;
    final value = payload['value'];
    final dataType = payload['dataType'] as String? ?? 'unknown';
    final size = payload['size'] as int?;
    final limit = payload['limit'] as int? ?? 50;

    try {
      switch (operation) {
        case 'get':
          if (key == null) {
            return {'ok': false, 'error': {'message': 'Missing key'}};
          }
          final result = await get(key);
          return {'ok': true, 'data': result};

        case 'set':
          if (key == null) {
            return {'ok': false, 'error': {'message': 'Missing key'}};
          }
          final success = await set(key, value, type: dataType, size: size);
          return {'ok': true, 'data': {'success': success}};

        case 'delete':
          if (key == null) {
            return {'ok': false, 'error': {'message': 'Missing key'}};
          }
          final success = await delete(key);
          return {'ok': true, 'data': {'success': success}};

        case 'clear':
          final success = await clear();
          return {'ok': true, 'data': {'success': success}};

        case 'getStats':
          final stats = await getStats(limit: limit);
          return {'ok': true, 'data': stats.toJson()};

        default:
          return {'ok': false, 'error': {'message': 'Unknown operation: $operation'}};
      }
    } catch (e) {
      return {'ok': false, 'error': {'message': e.toString()}};
    }
  }
}

/// Global cache service instance
final cacheService = CacheService();
