/// Theme information model
class ThemeInfo {
  final String id;
  final String displayName;
  final String? displayNameZh;
  final String category;
  final bool featured;
  final int order;

  const ThemeInfo({
    required this.id,
    required this.displayName,
    this.displayNameZh,
    required this.category,
    this.featured = false,
    this.order = 0,
  });

  factory ThemeInfo.fromJson(Map<String, dynamic> json) {
    return ThemeInfo(
      id: json['id'] as String,
      displayName: json['displayName'] as String? ?? json['id'] as String,
      displayNameZh: json['displayNameZh'] as String?,
      category: json['category'] as String? ?? 'other',
      featured: json['featured'] as bool? ?? false,
      order: json['order'] as int? ?? 0,
    );
  }
}

/// Category information model
class CategoryInfo {
  final String id;
  final String name;
  final String nameEn;
  final String description;
  final int order;

  const CategoryInfo({
    required this.id,
    required this.name,
    required this.nameEn,
    required this.description,
    this.order = 0,
  });

  factory CategoryInfo.fromJson(String id, Map<String, dynamic> json) {
    return CategoryInfo(
      id: id,
      name: json['name'] as String? ?? id,
      nameEn: json['name_en'] as String? ?? id,
      description: json['description_en'] as String? ?? '',
      order: json['order'] as int? ?? 0,
    );
  }
}

/// Built-in theme registry data
/// This matches the data from src/themes/registry.json and preset files exactly
class ThemeRegistry {
  static const List<ThemeInfo> themes = [
    // Professional
    ThemeInfo(id: 'default', displayName: 'Standard', displayNameZh: '标准文档', category: 'professional', featured: true, order: 1),
    ThemeInfo(id: 'business', displayName: 'Business', displayNameZh: '商务报告', category: 'professional', featured: true, order: 3),
    ThemeInfo(id: 'technical', displayName: 'Technical', displayNameZh: '技术文档', category: 'professional', featured: true, order: 4),
    // Academic
    ThemeInfo(id: 'academic', displayName: 'Academic', displayNameZh: '学术论文', category: 'academic', featured: true, order: 2),
    // Serif
    ThemeInfo(id: 'elegant', displayName: 'Magazine', displayNameZh: '文学杂志', category: 'serif', featured: true, order: 5),
    ThemeInfo(id: 'palatino', displayName: 'Book Publishing', displayNameZh: '书籍出版', category: 'serif', featured: true, order: 12),
    ThemeInfo(id: 'garamond', displayName: 'Long Reading', displayNameZh: '长文阅读', category: 'serif', featured: true, order: 13),
    ThemeInfo(id: 'cambria', displayName: 'Modern Document', displayNameZh: '现代文档', category: 'serif', featured: true, order: 14),
    // Sans-serif
    ThemeInfo(id: 'verdana', displayName: 'Web Display', displayNameZh: '网页显示', category: 'sans-serif', featured: true, order: 15),
    ThemeInfo(id: 'trebuchet', displayName: 'Blog Post', displayNameZh: '博客文章', category: 'sans-serif', featured: true, order: 16),
    ThemeInfo(id: 'century', displayName: 'Presentation', displayNameZh: '演示文稿', category: 'sans-serif', featured: true, order: 17),
    // Chinese
    ThemeInfo(id: 'songti', displayName: 'Song Style', displayNameZh: '传统宋体', category: 'chinese', featured: false, order: 7),
    ThemeInfo(id: 'heiti', displayName: 'Hei Style', displayNameZh: '现代黑体', category: 'chinese', featured: false, order: 8),
    ThemeInfo(id: 'mixed', displayName: 'Mixed Languages', displayNameZh: '中英混排', category: 'chinese', featured: false, order: 9),
    // Creative
    ThemeInfo(id: 'typewriter', displayName: 'Typewriter', displayNameZh: '复古打字', category: 'creative', featured: true, order: 6),
    ThemeInfo(id: 'sakura', displayName: 'Sakura Fresh', displayNameZh: '樱花清新', category: 'creative', featured: false, order: 10),
    ThemeInfo(id: 'water', displayName: 'Ink Poetry', displayNameZh: '水墨诗意', category: 'creative', featured: false, order: 11),
  ];

  static const Map<String, CategoryInfo> categories = {
    'professional': CategoryInfo(
      id: 'professional',
      name: '专业',
      nameEn: 'Professional',
      description: 'For business reports and formal documents',
      order: 1,
    ),
    'academic': CategoryInfo(
      id: 'academic',
      name: '学术',
      nameEn: 'Academic',
      description: 'For academic papers and research documents',
      order: 2,
    ),
    'serif': CategoryInfo(
      id: 'serif',
      name: '衬线体',
      nameEn: 'Serif Fonts',
      description: 'Elegant serif fonts for long-form reading',
      order: 3,
    ),
    'sans-serif': CategoryInfo(
      id: 'sans-serif',
      name: '无衬线',
      nameEn: 'Sans-serif',
      description: 'Clean sans-serif fonts with modern feel',
      order: 4,
    ),
    'chinese': CategoryInfo(
      id: 'chinese',
      name: '中文字体',
      nameEn: 'Chinese Fonts',
      description: 'Traditional Chinese font typography',
      order: 5,
    ),
    'creative': CategoryInfo(
      id: 'creative',
      name: '创意',
      nameEn: 'Creative',
      description: 'Creative and unique styles',
      order: 6,
    ),
  };

  /// Get themes grouped by category
  static Map<String, List<ThemeInfo>> getThemesByCategory() {
    final result = <String, List<ThemeInfo>>{};
    for (final theme in themes) {
      result.putIfAbsent(theme.category, () => []).add(theme);
    }
    // Sort themes within each category
    for (final list in result.values) {
      list.sort((a, b) => a.order.compareTo(b.order));
    }
    return result;
  }

  /// Get sorted categories
  static List<CategoryInfo> getSortedCategories() {
    final cats = categories.values.toList();
    cats.sort((a, b) => a.order.compareTo(b.order));
    return cats;
  }
}
