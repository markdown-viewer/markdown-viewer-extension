/**
 * File System Access API permission methods.
 *
 * The TypeScript DOM lib does not (yet) declare queryPermission /
 * requestPermission on FileSystemHandle (they shipped in Chrome 116+ and
 * are required by the workspace picker to re-request read access on
 * recent-workspace entries). The extension only runs in Chromium, so
 * augment the global interface here.
 */
declare global {
  interface FileSystemHandle {
    queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  }
}

export {};
