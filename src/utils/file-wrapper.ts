/**
 * File Wrapper Utility
 * Wraps non-markdown file formats (mermaid, vega, etc.) into markdown format for rendering
 */

import { EXTENSION_TO_FILE_TYPE } from '../types/formats';

/**
 * Get the file type from extension
 * @param filePath - The file path
 * @returns The file type (mermaid, vega, vega-lite, dot, infographic, svg, or markdown)
 */
export function getFileType(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop() || '';
  if (ext === 'svg') return 'svg';
  return EXTENSION_TO_FILE_TYPE[ext] || 'markdown';
}

/**
 * Wrap file content in markdown format for rendering
 * @param content - The raw file content
 * @param filePath - The file path (used to determine file type)
 * @returns The wrapped markdown content
 */
export function wrapFileContent(content: string, filePath: string): string {
  const fileType = getFileType(filePath);
  
  // If already markdown, return as-is
  if (fileType === 'markdown') {
    return content;
  }
  
  // Wrap the content in appropriate code block based on file type
  return `\`\`\`${fileType}\n${content}\n\`\`\``;
}

/**
 * Check if a file type is supported based on settings
 * @param filePath - The file path
 * @param supportedExtensions - The supported extensions from settings
 * @returns Whether the file type is supported
 */
export function isFileSupportedBySettings(
  filePath: string,
  supportedExtensions?: Record<string, boolean>
): boolean {
  const fileType = getFileType(filePath);
  
  // Markdown is always supported
  if (fileType === 'markdown') {
    return true;
  }
  
  // Check if the file type is in supported extensions
  if (!supportedExtensions) {
    // Default settings: all registered formats supported, svg not
    return fileType !== 'svg';
  }
  
  return supportedExtensions[fileType] ?? false;
}
