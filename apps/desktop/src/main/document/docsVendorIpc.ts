/** ARC-007: absent-vendor fail-closed build seam (overridden by Vite main alias). */
import type { DocsPrivilegedPorts } from './docsPrivilegedPorts.js';
export const mcodeNativeDocsIpcAvailable = false;
export function registerDocsIpc(
  _ipc: Pick<import("electron").IpcMain, "handle" | "removeHandler" | "on" | "removeListener">,
  _isDocsSender: (sender: unknown) => boolean,
  _getUiLanguage?: () => 'zh' | 'en',
  _getDataRoot?: () => string,
  _privileged?: () => DocsPrivilegedPorts | null,
): () => void {
  return () => undefined;
}
