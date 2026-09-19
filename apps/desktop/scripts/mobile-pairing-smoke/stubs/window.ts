/**
 * `@main/window.js` 的替身 —— 真的那个拿着 `BrowserWindow` / `session` /
 * `WebContentsView`,也就 import 了 `electron`。
 *
 * ## 本套为什么会被拖到它
 *
 * `lib/sessionSync.ts` 从它拿 `sendToRenderer`(把 `session:changed` 推给桌面窗口),
 * 而 `mobileRpc.ts` 又 import 了 `broadcastSessionChanged` / `broadcastSessionDeleted`。
 * 本套不验"桌面窗口收没收到",但 import 图会拉到。
 *
 * ⚠️ **接住而不是显式抛**:它是**被测路径的一部分**(任何一条真跑起来的 RPC 都可能
 * 广播),抛出去会让"发一条 setting:get"这种无害请求整条炸掉。记下来即可。
 *
 * ⚠️ `getMainWindow` **必须**返回 `null` 而不是抛:真实现里它是 `BrowserWindow | null`,
 * 调用方写的是"窗口不在就跳过"。抛会以一个无头环境特有的形状炸,与本套要验的门无关。
 */

/** 按顺序记下推给桌面界面的每一条。 */
export const sent: Array<{ channel: string; args: unknown[] }> = [];

export function resetSent(): void {
  sent.length = 0;
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  sent.push({ channel, args });
}

/** 与真实现同形:没有窗口时返回 `null`(无头环境就是这种)。 */
export function getMainWindow(): null {
  return null;
}

/** 本套不起窗口 —— 这两个真被调到要立刻显形。 */
export function createMainWindow(): never {
  throw new Error("mobile-pairing-smoke 不该走到 createMainWindow(本套不起窗口)");
}

export function updateTitleBarOverlay(): void {
  /* 主题相关,本套不验 */
}
