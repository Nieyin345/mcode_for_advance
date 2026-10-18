/**
 * `@main/window.js` 的替身 —— 只给 document-view-host-smoke 用。
 *
 * 真的 `window.ts` 顶层 import 了 electron（BrowserWindow / shell / session …），
 * 而这一套全程在纯 node 里跑：宿主模块只需要 `getMainWindow` 这一个符号，
 * 套件里每次构造 `DocumentViewHost` 时都会**显式注入**自己的假窗口，所以这个桩
 * 永远返回 null。返回 null 而不是抛：生产单例 `documentViewHost` 在模块加载时
 * 就会拿它当默认解析器（但本套从不对单例调 open），抛会连 import 都过不去。
 */
export function getMainWindow(): null {
  return null;
}

/** 真的 `window.ts` 里同模块导出的其它符号 —— 被 import 到就要立刻显形。 */
export function sendToRenderer(..._args: unknown[]): never {
  throw new Error("document-view-host-smoke 不该走到 sendToRenderer");
}

export function hasLiveRendererWindow(): boolean {
  return false;
}
