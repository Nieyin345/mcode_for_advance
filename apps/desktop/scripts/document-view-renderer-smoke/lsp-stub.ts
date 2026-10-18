/**
 * `@renderer/lib/lspProviders.js` 替身。本套不验 LSP —— `FileEditor` 的 import 面
 * 要能解析，工具栏里会读 `monacoLanguageToLsp` / `LSP_LANGUAGE_DISPLAY` /
 * `resolveShortcut`（那是 shortcuts 模块，不在这份里）。
 */
export function monacoLanguageToLsp(): null {
  return null;
}
export const LSP_LANGUAGE_DISPLAY: Record<string, string> = {};
export function bindModelToPath(): void {}
export function unbindModel(): void {}
export function ensureLspProviders(): void {}
export function useLspDiagnostics(): void {}
export function useLspGotoActivities(): unknown[] {
  return [];
}
export function filePathToUri(p: string): string {
  return p;
}
export async function openLspDocument(): Promise<void> {}
export async function notifyLspChange(): Promise<void> {}
export async function notifyLspSave(): Promise<void> {}
export async function closeLspDocument(): Promise<void> {}
