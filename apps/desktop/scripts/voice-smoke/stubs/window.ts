/**
 * `@main/window.js` 的替身 —— 真的那个拿着 BrowserWindow,也就 import 了 electron。
 *
 * `ipc/voice.ts` 的 `wirePushes()` 用它的 `sendToRenderer` 把两条推送发出去:
 *
 *   - `voice:result`             —— 实时识别文字(partial/final)
 *   - `voice:downloadProgress`   —— 模型下载进度 / 终态
 *
 * 本套两样都接住、**按注册顺序**记下来。判据就是"用户看到的那些帧":推送漏发、
 * 发到错的 channel、或者 payload 里少了 `channel` 字段(preload 是按 `msg.channel`
 * 过滤的 —— 缺了它渲染端一条都收不到),在这里都会显形。
 *
 * ## 两条与真实现**故意不同**的地方(都在下面标注)
 *
 * 真 `sendToRenderer` 在窗口关闭时会**静默丢弃**推送。无头脚本里没有窗口,
 * 照搬那一条等于让所有推送断言空转。所以这里无条件记下来,并另设一个
 * "坏窗口模式"专门验**调用方**(`wirePushes`)有没有把 payload 拼对。
 */
import { IPC } from "@contracts/ipc";
import type {
  VoiceResultMessage,
  VoiceDownloadProgressMessage,
} from "@contracts/ipc";

/** 按注册顺序记下的每一条推送。`channel` 是**传给 sendToRenderer 的那个**, */
/** `payload` 是它带的那一个对象(真的那条只发一个参数)。 */
export interface Push {
  channel: string;
  payload: Record<string, unknown>;
}

export const pushes: Push[] = [];

export function resetPushes(): void {
  pushes.length = 0;
}

/** 只取某一类推送(判据用 —— "用户看到的那几帧")。 */
export function pushesOn(channel: string): Push[] {
  return pushes.filter((p) => p.channel === channel);
}

/** 模拟"窗口已经不在了":推送全部丢弃。用来验调用方不是**靠**推送来传错误。 */
let dropped = false;
export function __setWindowGone(on: boolean): void {
  dropped = on;
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (dropped) return; // 真实现在 win.isDestroyed() 时就是这么做的
  pushes.push({
    channel,
    payload: (args[0] ?? {}) as Record<string, unknown>,
  });
}

/** 本套不该走到这条 —— 它意味着有人在要真的窗口。 */
export function getMainWindow(): never {
  throw new Error("voice-smoke 不该走到 getMainWindow(本套不起窗口)");
}

/* ── 给断言用的类型守卫(把 payload 收窄成契约里那两个形状) ── */

export function asResultPush(p: Push): VoiceResultMessage {
  if (p.channel !== IPC.VOICE_RESULT) {
    throw new Error(`不是 voice:result: ${p.channel}`);
  }
  return p.payload as unknown as VoiceResultMessage;
}

export function asProgressPush(p: Push): VoiceDownloadProgressMessage {
  if (p.channel !== IPC.VOICE_DOWNLOAD_PROGRESS) {
    throw new Error(`不是 voice:downloadProgress: ${p.channel}`);
  }
  return p.payload as unknown as VoiceDownloadProgressMessage;
}

export { IPC };