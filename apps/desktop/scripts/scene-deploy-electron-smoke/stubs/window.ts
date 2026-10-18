/**
 * `@main/window.js` 的替身 —— 只给 scene-deploy-electron-smoke 的主进程 bundle 用。
 *
 * 真的 `window.ts` 顶层 import electron 并拖上语音引擎等原生依赖；本套件要验的是
 * **场景部署从 UI 到主进程**那一段，window 的职责（发消息/建窗）不在被测面里。
 *
 * ⚠️ 不是空实现：`sendToRenderer` 被调到就显式抛 —— 场景部署链不该给渲染端发消息。
 * `hasLiveRendererWindow` 返回 false（探针自己建窗，不经 window.ts 的单例）。
 * `updateTitleBarOverlay` 是 `ipc/claude.ts` / `lib/theme.ts` 静态引用到的符号，
 * 打包期必须能解析；本套件不调它，给一个 no-op（真调了也没有被测语义）。
 */
export function getMainWindow(): null {
  return null;
}
export function sendToRenderer(..._args: unknown[]): never {
  throw new Error("scene-deploy-electron-smoke 不该走到 sendToRenderer");
}
export function hasLiveRendererWindow(): boolean {
  return false;
}
export function updateTitleBarOverlay(): void {
  /* 本套件不建真主窗口，无标题栏可更新 */
}
