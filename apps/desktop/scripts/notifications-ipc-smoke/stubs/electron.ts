/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * ## 为什么整个包换掉,而不是只换 `@main/window.js`
 *
 * `NotificationManager` 自己文件里就有一句 `import { Notification } from "electron"`
 * (它不经过任何 `@main/*` 中转)。顺着 alias 一个个堵会变成打地鼠,而每漏一个报出来的
 * 都是"找不到模块 electron",看着和"被测代码坏了"一模一样。换掉整个包更窄:
 * **本套要验的两个 handler 碰不到任何一个 Electron API**,只有 `NotificationManager`
 * 在被 import 时才会 `new Notification(...)` —— 而那要等到真的弹通知,本套一次都不弹。
 *
 * ## 三件事在这里被做成"可断言的"
 *
 *  1. `Notification.show()` 记进 {@link shown} —— 于是"当前这次运行到底弹没弹"从
 *     不可观测变成可观测。这一条是"只落盘不更新内存"那个 bug 的唯一窗口。
 *  2. 窗口对象({@link setWindow})能被喂成 正常 / null / 已销毁 / 已最小化,而且
 *     `restore` / `show` / `focus` **按调用顺序**记进 {@link windowCalls} ——
 *     「先 restore 后 show」在部分平台上会丢焦点,顺序错了光看"最终都调过"是看不出来的。
 *  3. `new Notification(...)` 的**构造次数**记进 {@link constructed} —— FOCUS_SESSION
 *     那条路绝不该顺手弹一条通知。
 *
 * ⚠️ **不是空实现**:本套用不到的一律**显式抛**,真被调到了要立刻显形。
 */
import type { NotificationPrefs } from "@contracts/ipc";

/** 真的 show 出去的每一条(标题 + 正文)。 */
export const shown: Array<{ title: string; body: string }> = [];

/** `new Notification(...)` 被构造了几次 —— 构造了但没 show 也算。 */
export let constructed = 0;

export function resetShown(): void {
  shown.length = 0;
  constructed = 0;
}

export class Notification {
  static isSupported(): boolean {
    return true;
  }

  constructor(_opts: { title: string; body: string }) {
    constructed += 1;
  }

  on(_event: string, _cb: () => void): this {
    return this;
  }

  show(): void {
    // 本套不验文案(那是 frontend-smoke 的活),只需要一个"弹过"的痕迹。
    shown.push({ title: "", body: "" });
  }
}

/* ── 窗口:喂给你自己那个对象,并记下三个动作的顺序 ── */

export interface FakeWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/** `restore` / `show` / `focus` 的调用顺序,按发生次序 push。 */
export const windowCalls: string[] = [];

export function resetWindow(): void {
  windowCalls.length = 0;
}

/** 窗口在不在前台。`NotificationManager.onEvent` 的头两行拿它当闸门 ——
 *  本套 §3 要问的是"这一刻会不会弹",得让它别被前台挡住,所以默认 **false**。 */
export let windowFocused = false;

export function setFocused(v: boolean): void {
  windowFocused = v;
}

/** 现在喂给被测代码的那个窗口(null = 没有窗口)。 */
export let theWindow: FakeWindow | null = null;

/** 喂一个窗口进去。三种形态各写死一个,避免"喂了个四不像"。 */
export function setWindow(kind: "none" | "destroyed" | "minimized" | "normal"): void {
  if (kind === "none") {
    theWindow = null;
    return;
  }
  if (kind === "destroyed") {
    theWindow = {
      isDestroyed: () => true,
      isFocused: () => windowFocused,
      isMinimized: () => false,
      restore: () => windowCalls.push("restore"),
      show: () => windowCalls.push("show"),
      focus: () => windowCalls.push("focus"),
    };
    return;
  }
  if (kind === "minimized") {
    theWindow = {
      isDestroyed: () => false,
      // ⚠️ 最小化的窗口在真 Electron 里 `isFocused()` 是 **false**(Chromium 不把
      // 最小化的窗口算作 focused)而 `isMinimized()` 是 true。`NotificationManager`
      // 里那句 `focused && !minimized` 正是为这个写的。桩照抄这个形态,免得
      // "最小化"被喂成"前台",让上面那条闸门看起来是另一回事。
      isFocused: () => false,
      isMinimized: () => true,
      restore: () => windowCalls.push("restore"),
      show: () => windowCalls.push("show"),
      focus: () => windowCalls.push("focus"),
    };
    return;
  }
  theWindow = {
    isDestroyed: () => false,
    isFocused: () => windowFocused,
    isMinimized: () => false,
    restore: () => windowCalls.push("restore"),
    show: () => windowCalls.push("show"),
    focus: () => windowCalls.push("focus"),
  };
}

/** 本套一次都不该走到的 Electron 面。 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`notifications-ipc-smoke 不该走到 electron.${name}`);
  };
}

export const ipcMain = { handle: notHere("electron.ipcMain.handle") };
export const app = { getPath: notHere("app.getPath"), isPackaged: false };
export const shell = { openExternal: notHere("shell.openExternal") };
export const nativeTheme = { shouldUseDarkColors: false };
export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };

/** 让 `NotificationPrefs` 这个 import 有用处(桩里只用它的类型)。 */
export type { NotificationPrefs };
