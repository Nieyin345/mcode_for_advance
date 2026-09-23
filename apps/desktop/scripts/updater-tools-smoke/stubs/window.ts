/**
 * `@main/window.js` 的替身 —— 真的那个拿着 BrowserWindow 往 `webContents.send` 推,
 * 而且它一上来就 import electron / theme / startupTimer。换掉它,那张 import 图
 * (以及底下那个真的 electron)就整个从这套里消失。
 *
 * ## 本套要断言的是「推给界面的那几帧」
 *
 * `toolInstall.emit()` 是那条链上唯一一处"用户看得见"的出口 —— 设置面板的进度条
 * 与"装完了/装失败了"全在这里。所以这里**原样按顺序记下每一帧**,包括 channel 与
 * envelope,而不是只挑一个字段收。断言才有东西可立。
 *
 * ## 为什么要连 channel 一起记
 *
 * `emit()` 发的是 `{ channel: IPC.TOOLCHAIN_EVENT, payload }` 这个信封,而
 * **preload 是按 `msg.channel` 分发的**(`src/preload/index.ts` 里那个
 * `if (msg.channel === IPC.TOOLCHAIN_EVENT) handler(msg)`)。字段名对、但 channel
 * 写错或漏掉,界面就一帧都收不到 —— 那种错静默、而且只在真应用里显形。所以这里
 * 收 channel,断言里也点一句。
 */
import type { ToolchainProgressPayload } from "@contracts/ipc";

export interface Frame {
  channel: string;
  /** 原样收下的第一个参数(信封)。 */
  envelope: unknown;
  /** 从信封里取出来的 payload —— 取不到就是 undefined,断言会显形。 */
  payload: ToolchainProgressPayload | undefined;
}

/** 按顺序记下每一条 `sendToRenderer`。 */
export const frames: Frame[] = [];

export function resetFrames(): void {
  frames.length = 0;
}

/** 只看 `toolchain:event` 那些帧的 payload。 */
export function toolchainEvents(): ToolchainProgressPayload[] {
  return frames.filter((f) => f.channel === "toolchain:event").map((f) => f.payload!);
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  const envelope = args[0] as { channel?: string; payload?: ToolchainProgressPayload } | undefined;
  frames.push({ channel, envelope, payload: envelope?.payload });
}

/** 本套不该走到窗口本身。 */
export function getMainWindow(): never {
  throw new Error("本套不该走到 getMainWindow(安装/删除这条路上没人碰窗口)");
}

/** `theme.ts` 经 window.ts 才被拉进来 —— 给它一个显式替身,免得将来有人把 theme
 *  带进图里时报出来的是"少一个导出"而不是一句人话。 */
export function updateTitleBarOverlay(): never {
  throw new Error("本套不该走到 updateTitleBarOverlay");
}