/**
 * Plugin Type Definitions
 * Types for plugin system and async task queue
 */

import type { TranslateFunction } from './core';

// =============================================================================
// Task Types
// =============================================================================

/**
 * Task status enumeration
 */
export type TaskStatus = 'ready' | 'fetching' | 'error' | 'completed';

/**
 * Task data
 */
export interface TaskData {
  id: string;
  code?: string;
  sourceHash: string;
  [key: string]: unknown;
}

/**
 * Async task object
 */
export interface AsyncTaskObject {
  id: string;
  callback: (data: TaskData) => Promise<void>;
  data: TaskData;
  type: string;
  status: TaskStatus;
  error: Error | null;
  setReady: () => void;
  setError: (error: Error) => void;
}

/**
 * Placeholder result for async task
 */
export interface PlaceholderResult {
  type: 'html';
  value: string;
}

/**
 * Async task registration result
 */
export interface AsyncTaskResult {
  task: AsyncTaskObject;
  placeholder: PlaceholderResult;
}

/**
 * Async task plugin interface
 */
export interface AsyncTaskPlugin {
  type: string;
  isInline: () => boolean;
}

/**
 * Async task queue manager interface
 */
export interface AsyncTaskQueueManager {
  asyncTask: (
    callback: (data: TaskData) => Promise<void>,
    data?: Record<string, unknown>,
    plugin?: AsyncTaskPlugin | null,
    translate?: TranslateFunction | null,
    initialStatus?: TaskStatus
  ) => AsyncTaskResult;
  processAsyncTasks: (
    translate: TranslateFunction,
    showProcessingIndicator: () => void,
    hideProcessingIndicator: () => void,
    updateProgress: (completed: number, total: number) => void
  ) => Promise<void>;
  getQueueLength: () => number;
}

// =============================================================================
// Plugin Types
// =============================================================================

/**
 * AST Node for markdown processing
 */
export interface ASTNode {
  type: string;
  value?: string;
  lang?: string;
  meta?: string;
  url?: string;
  alt?: string;
  title?: string;
  children?: ASTNode[];
  data?: unknown;
}

/**
 * Plugin interface
 */
export interface IPlugin {
  type: string;
  match(node: ASTNode): boolean;
  transform(node: ASTNode, context: unknown): string;
  render?(data: unknown): Promise<string>;
  isInline?(): boolean;
  createTaskData?(content: string): TaskData;
}

// =============================================================================
// Renderer Interface (for plugins)
// =============================================================================

/**
 * Renderer interface used by plugins
 */
export interface PluginRenderer {
  render(
    type: string,
    content: string | object
  ): Promise<PluginRenderResult | null>;
}

/**
 * Render result from plugin renderer
 */
export interface PluginRenderResult {
  base64?: string;
  width: number;
  height: number;
  format: string;
  error?: string;
}
