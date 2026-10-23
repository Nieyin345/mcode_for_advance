/**
 * `@main/window.js` 的替身 —— 真的那个拿着 BrowserWindow,也就 import 了 `electron`。
 *
 * ## 与 library-import-smoke 那份的关系
 *
 * 那一份只有 `sendToRenderer`(它只需要"导入成功的信号送出去了没有")。本套要验的
 * 是 MCP 工具,而 `library_convert` 拉进来的 `BrowserManager` 还要 `getMainWindow`
 * —— 所以这一份多一个成员。
 *
 * ⚠️ **不是把那一份复制一份了事**:复制出来的东西下次加成员时会只加一处。真正该做的
 * 是让两边共用一份(本套已经复用了它的 `sendToRenderer` 语义),但跨套件共用桩需要
 * 桩住在某个"公共"目录里 —— 现在两个套件的桩都是各放各的。这里**改变的是成员集**,
 * 而成员集是**被测路径决定的**:library-import-smoke 那条路根本不经过 BrowserManager,
 * 所以它不需要 `getMainWindow`。所以这是两份不同的桩,不是同一份的两份。
 *
 * ## 为什么要换它
 *
 * `library/broadcast.ts` 用它推 `library:changed`(左栏那棵树要重拉)。本套不验
 * 广播的**内容**,但那是转换/关联成功的路径的一部分,所以这里接住、记下来 ——
 * 顺便能断言"改完之后确实通知了界面",不然用户改完左栏还是旧的。
 */
import { IPC } from "@contracts/ipc";

/** 按顺序记下推给界面的每一条 `library:changed`。 */
export const changedReasons: string[] = [];

export function resetSent(): void {
  changedReasons.length = 0;
}

export function sendToRenderer(channel: string, payload: unknown): void {
  if (channel === IPC.LIBRARY_CHANGED) {
    const reason = (payload as { reason?: unknown }).reason;
    changedReasons.push(typeof reason === "string" ? reason : String(reason));
    return;
  }
  process.stderr.write(`[stub] sendToRenderer(${channel}) ${JSON.stringify(payload)}\n`);
}

/**
 * 主窗口。本套**不该走到这里**(转换与关联都不碰窗口),所以是显式报错而不是
 * 返回 `null`:安静地给个 null 会让调用方走进"窗口不在"的分支,而那个分支在本套里
 * 一次都不该被走到 —— 真被调到了要立刻显形。
 */
export function getMainWindow(): never {
  throw new Error("本套不该走到 getMainWindow(MCP 工具不碰窗口)");
}

/**
 * 主题切换时刷标题栏颜色(产品见 `src/main/window.ts:79`)。真那份只做
 * `mainWindow?.setTitleBarOverlay(...)`,`mainWindow` 为 null 时本来就是空操作 ——
 * 无头里恒为 null,所以空实现与真实现在这条前提下的行为一致。
 *
 * 补它是因为 `lib/theme.ts` 从 `@main/window.js` import 了这一个名字;桩缺了就在
 * **打包期**报 `No matching export`(2026-10-23 T38,三套共用此桩)。
 */
export function updateTitleBarOverlay(): void {}

/**
 * "界面还开着吗"(`src/main/window.ts:310`):真那份要 `mainWindow` 非空、未销毁、
 * webContents 未崩溃 —— 无头里根本没有窗口,答案恒为 `false`。
 *
 * ⚠️ 这是**真实语义**,不是"随便给个值":生产里这条为 false 时,推送类分支会走
 * "没有界面"那一侧(例如 `desktopAttached: false`),而那正是无头 smoke 想要的。
 */
export function hasLiveRendererWindow(): boolean {
  return false;
}
