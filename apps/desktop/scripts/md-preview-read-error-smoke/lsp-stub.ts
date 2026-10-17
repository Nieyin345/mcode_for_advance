/**
 * `@renderer/lib/lspProviders.js` 替身。引用组合这条路径**不经过 LSP** —— 但
 * `EditPane` 在挂载/post-swap 时会调 `ensureLspProviders` / `openLspDocument` /
 * `closeLspDocument`,并在渲染 `<Editor>` 时调 `filePathToUri`。全部退化成 no-op
 * (或恒等),让 LSP 这层不干扰判据。
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
export function gotoLocation(): void {}
