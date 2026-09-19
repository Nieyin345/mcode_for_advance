/**
 * `@main/window.js` 的替身 —— 真的那个拿着 BrowserWindow,也就 import 了 `electron`。
 *
 * `runtimes/runtimeInstaller.ts` 与 `env/toolInstall.ts` 都用它推 `runtimes:event` /
 * `toolchain:event` 给面板。本套两边都接住、记下来:删掉一个运行时之后面板要能
 * 收到那条"我做完了"的事件,否则进度条会一直挂在那个 agent 上。
 */
import { IPC } from "@contracts/ipc";

export interface RecordedEvent {
  channel: string;
  payload: { agent?: string; tool?: string; phase?: string; progress?: number };
}

/** 按顺序记下推给界面的每一条进度事件。 */
export const events: RecordedEvent[] = [];

export function reset(): void {
  events.length = 0;
}

/** 只取某个 agent 的那些(断言里少写循环)。 */
export function phasesFor(agent: string): string[] {
  return events
    .filter((e) => e.channel === IPC.RUNTIMES_EVENT && e.payload.agent === agent)
    .map((e) => String(e.payload.phase));
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  const payload = args[0] ?? {};
  const p = payload as RecordedEvent["payload"];
  if (channel === IPC.RUNTIMES_EVENT || channel === IPC.TOOLCHAIN_EVENT) {
    events.push({ channel, payload: p });
    return;
  }
  process.stderr.write(`[stub] sendToRenderer(${channel}) ${JSON.stringify(payload)}\n`);
}

/** 本套这条路上没人碰窗口 —— 真被调到了要立刻显形(同 library-delete-smoke 的取舍)。 */
export function getMainWindow(): never {
  throw new Error("installers-ipc-smoke 不该走到 getMainWindow");
}
