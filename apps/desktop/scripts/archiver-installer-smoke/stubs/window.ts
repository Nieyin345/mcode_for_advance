/**
 * `@main/window.js` 的替身 —— 真的那个拿着 BrowserWindow(`sendToRenderer` 往
 * `webContents.send` 推),而且它一上来就 import `electron` / `theme` / `startupTimer`。
 * 换掉它,那张 import 图(以及底下那个真的 electron)就整个从这套里消失了。
 *
 * 本套要断言的是**进度有没有推给界面**:设置面板那几张卡片就是靠 `runtimes:event`
 * 从"下载中"翻成"已安装"的。所以这里按顺序把每条 payload 记下来,而不是静默丢弃。
 *
 * (真 `sendToRenderer` 在没窗口时是静默 return;installer 自己把这一句包在
 * try/catch 里,所以替身这边怎么处理都不影响安装的成败 —— 它只影响"能不能断言"。)
 */
import type { RuntimeProgressPayload } from "@contracts/ipc";

/** 按顺序记下每一条 `runtimes:event` 的 payload。 */
export const runtimeEvents: RuntimeProgressPayload[] = [];

export function resetRuntimeEvents(): void {
  runtimeEvents.length = 0;
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  const envelope = args[0] as { payload?: RuntimeProgressPayload } | undefined;
  if (channel === "runtimes:event" && envelope?.payload) {
    runtimeEvents.push(envelope.payload);
    return;
  }
  process.stderr.write(`[stub] sendToRenderer(${channel}) ${JSON.stringify(args[0])}\n`);
}

/** 本套不该走到窗口本身。 */
export function getMainWindow(): never {
  throw new Error("本套不该走到 getMainWindow(安装/删除这条路上没人碰窗口)");
}

/** `theme.ts` 会 import 它(经 window.ts 才被拉进来) —— 给它一个显式替身,
 *  免得将来有人把 theme 带进图里时报出来的是"少一个导出"而不是一句人话。 */
export function updateTitleBarOverlay(): never {
  throw new Error("本套不该走到 updateTitleBarOverlay");
}
