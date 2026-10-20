/**
 * `@main/window.js` 的替身 —— 供本套件 probe 的打包解析（probe 本身不 import
 * 任何主进程业务模块，这里只是让 alias 有落点，避免真 window.ts 拖入原生模块）。
 */
export function getMainWindow(): null {
  return null;
}
export function sendToRenderer(): void {
  /* probe 不用 */
}
export function hasLiveRendererWindow(): boolean {
  return false;
}
