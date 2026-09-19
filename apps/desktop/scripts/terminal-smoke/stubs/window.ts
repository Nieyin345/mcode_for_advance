/**
 * `@main/window.js` 的替身 —— 真的那个拿着 `BrowserWindow` / `WebContentsView`,
 * 也就 import 了 `electron`(`main/window.ts` 顶层还有一大串窗口管理的 import)。
 *
 * ## 本套为什么会被拖到它
 *
 * `TerminalManager` 的 `onData` / `onExit` / `kill` 三处都调 `sendToRenderer`,
 * 推 `terminal:data` / `terminal:exit`。**这三条推送本身就是本套要验的东西**
 * (见 main.ts §2「关掉之后界面能收到吗」),所以这里不是空实现 —— 把每一条按顺序
 * 记下来,断言直接读它。
 *
 * ⚠️ **接住而不是显式抛**:`sendToRenderer` 是被测路径的一部分(每一次写数据都会
 * 调到)。抛出去会把"开一个终端"整条炸掉。真实现里窗口不在就是 `return`(见
 * window.ts 里那句 `if (!win || win.isDestroyed()) return`),这里与它同义。
 */

/** 按顺序记下推给界面的每一条。 */
export const sent: Array<{ channel: string; args: unknown[] }> = [];

export function resetSent(): void {
  sent.length = 0;
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  sent.push({ channel, args });
}

/** 只看某个 channel 的那些条 —— 断言里用得多。 */
export function sentOf(channel: string): Array<Record<string, unknown>> {
  return sent.filter((m) => m.channel === channel).map((m) => (m.args[0] ?? {}) as Record<string, unknown>);
}

/** 与真实现同形:无头环境没有窗口。 */
export function getMainWindow(): null {
  return null;
}

/** 本套不起窗口 —— 这两个真被调到要立刻显形。 */
export function createMainWindow(): never {
  throw new Error("terminal-smoke 不该走到 createMainWindow(本套不起窗口)");
}

export function updateTitleBarOverlay(): void {
  /* 主题相关,本套不验 */
}
