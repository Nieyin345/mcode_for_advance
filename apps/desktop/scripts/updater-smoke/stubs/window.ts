/**
 * `@main/window.js` 的替身 —— 真的那个拿着 `BrowserWindow`,也就 import 了 electron。
 *
 * ## 本套为什么会被拖到它
 *
 * `updater.ts` 的每一条推送(`update:available` / `update:downloadProgress` /
 * `update:downloaded`)都走 `sendToRenderer`。**那三条推送本身就是本套要验的东西**
 * (判据是"用户能不能看到那张卡/那条进度"),所以这里不是空实现 —— 把每一条按
 * 顺序记下来,断言直接读它。
 *
 * ⚠️ **接住而不是显式抛**:`sendToRenderer` 是被测路径的一部分(每次发现新版本都会
 * 调到)。抛出去会把整条流程炸掉。真实现里窗口不在就是 `return`(见 window.ts 里
 * `if (!win || win.isDestroyed()) return`),这里与它同义。
 */

/** 按顺序记下推给界面的每一条。 */
export const sent: Array<{ channel: string; args: unknown[] }> = [];

export function resetSent(): void {
  sent.length = 0;
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  sent.push({ channel, args });
}

/** 只看某个 channel 的那些载荷 —— 断言里用得多。 */
export function sentOf(channel: string): Array<Record<string, unknown>> {
  return sent
    .filter((m) => m.channel === channel)
    .map((m) => (m.args[0] ?? {}) as Record<string, unknown>);
}

/** 与真实现同形:无头环境没有窗口。 */
export function getMainWindow(): null {
  return null;
}

/** 本套不起窗口 —— 这两个真被调到要立刻显形。 */
export function createMainWindow(): never {
  throw new Error("updater-smoke 不该走到 createMainWindow(本套不起窗口)");
}

export function updateTitleBarOverlay(): void {
  /* 主题相关,本套不验 */
}