/**
 * `@main/window.js` 的替身 —— 只给 `genoffice-ai-ask-smoke` 用。
 *
 * 探针自己 new BrowserWindow 并**显式注入** `getMainWindow`，所以这份永远返回
 * null。必须换掉的原因不是权限，而是**打包**：真的 `window.ts` 会拖进语音引擎的
 * 原生模块（sherpa-onnx `.node`），esbuild 在 node 平台下解析不了，而本套件一个
 * 字节都不需要它。（与 document-view-electron-smoke/stubs/window.ts 同一手法。）
 */
export function getMainWindow(): null {
  return null;
}
export function sendToRenderer(..._args: unknown[]): never {
  throw new Error("genoffice-ai-ask-smoke 不该走到 sendToRenderer");
}
export function hasLiveRendererWindow(): boolean {
  return false;
}
