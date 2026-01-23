/**
 * Unified Type Definitions
 * 
 * All shared types should be imported from this file.
 * This is the single source of truth for type definitions.
 */

// Import global type declarations for side effects
import './platform.d';

// =============================================================================
// Core Types
// =============================================================================

export type {
  TranslateFunction,
  EscapeHtmlFunction,
  FileState,
  AllFileStates,
  HistoryEntry,
  BackgroundMessage,
  MessageHandler,
  UploadSession,
} from './core';

// =============================================================================
// Cache Types
// =============================================================================

export type {
  CacheItem,
  IndexedDBCacheStats,
  CacheStats,
  SimpleCacheStats,
  ICacheManager,
  RendererCacheManager,
} from './cache';

// =============================================================================
// Render Types
// =============================================================================

export type {
  RenderResult,
  RenderResultType,
  RenderResultContent,
  RenderResultDisplay,
  UnifiedRenderResult,
  RendererThemeConfig,
} from './render';

// =============================================================================
// Theme Types
// =============================================================================

export type {
  ColorScheme,
  HeadingConfig,
  FontScheme,
  BorderConfig,
  TableStyleConfig,
  CodeThemeConfig,
  LayoutHeadingConfig,
  LayoutBlockConfig,
  LayoutScheme,
  Theme,
  ThemeDefinition,
  ThemeCategoryInfo,
  ThemeRegistry,
  ThemeRegistryInfo,
} from './theme';

// =============================================================================
// Platform Types
// =============================================================================

export type {
  PlatformType,
  PlatformMessageAPI,
  PlatformStorageAPI,
  PlatformResourceAPI,
  PlatformI18nAPI,
  PlatformBridgeAPI,
  DownloadOptions,
  CacheService,
  RendererService,
  StorageService,
  FileService,
  ResourceService,
  I18nService,
  MessageService,
  PlatformAPI,
} from './platform';

// =============================================================================
// Messaging Types
// =============================================================================

export type {
  RenderMessageType,
  ServiceMessageType,
  CommonMessageType,
  AnyMessageType,
  RenderPayloadMap,
  ServicePayloadMap,
  RequestEnvelope,
  ResponseEnvelope,
  RenderRequestEnvelope,
  ServiceRequestEnvelope,
  RenderResponseData,
} from './messaging';

export {
  RenderMessageType as RenderMessageTypes,
  ServiceMessageType as ServiceMessageTypes,
  CommonMessageType as CommonMessageTypes,
} from './messaging';

// =============================================================================
// Plugin Types
// =============================================================================

export type {
  TaskStatus,
  TaskData,
  AsyncTaskObject,
  PlaceholderResult,
  AsyncTaskResult,
  AsyncTaskPlugin,
  AsyncTaskQueueManager,
  ASTNode,
  IPlugin,
  PluginRenderer,
  PluginRenderResult,
} from './plugin';

// =============================================================================
// DOCX Types
// =============================================================================

export type {
  AlignmentTypeValue,
  BorderStyleValue,
  DOCXRunStyle,
  DOCXParagraphSpacing,
  DOCXParagraphStyle,
  DOCXHeadingStyle,
  DOCXCharacterStyle,
  DOCXBorder,
  DOCXTableBorders,
  DOCXTableStyle,
  DOCXCodeColors,
  DOCXThemeStyles,
  LinkDefinition,
  ImageBufferResult,
  DOCXImageType,
  FetchImageResult,
  DOCXExportResult,
  DOCXProgressCallback,
  DocxExporter,
  DOCXASTNode,
  DOCXListNode,
  DOCXBlockquoteNode,
  DOCXTableNode,
  DOCXInlineNode,
} from './docx';

export { BorderStyle, AlignmentType } from './docx';

// =============================================================================
// Settings Types
// =============================================================================

export type {
  SettingKey,
  SettingTypes,
  SetSettingOptions,
  ISettingsService,
} from './settings';

export { DEFAULT_SETTINGS } from './settings';

// =============================================================================
// Toolbar Types
// =============================================================================

export type {
  LayoutConfig,
  ToolbarManagerOptions,
  GenerateToolbarHTMLOptions,
  ToolbarManagerInstance,
} from './toolbar';
