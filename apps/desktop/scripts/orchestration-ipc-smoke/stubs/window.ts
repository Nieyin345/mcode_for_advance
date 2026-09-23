/**
 * `@main/window.js` 的替身 —— 真的那个拿着 `BrowserWindow`(也就 import 了 electron)。
 *
 * ## 本套要靠它接住**广播**
 *
 * `ipc/orchestration.ts` 每次写成功都调 `notifyWorkflowsChanged(reason)`,而那一个的
 * 全部作用就是 `sendToRenderer(IPC.WORKFLOW_CHANGED, …)`。少了这个桩,广播这条链会
 * 因为 `@main/window.js` 拉 electron 而跑不起来;有了它,**"哪几次写真的广播了"**就
 * 成了可断言的 —— 而它正是 AI 与界面之间那道缝(见 broadcast.ts 文件头):
 * 漏发一次,AI 改完的东西要等用户关掉设置页再打开才出现,用户会以为它没干活。
 *
 * 记名而不是空实现。窗口"没开着"这种情况也留着(`setWindow({alive:false})`):
 * 广播的实现里那句 try/catch 就是为它写的。
 */
let windowAlive = true;

export function setWindow(opts: { alive?: boolean }): void {
  if (opts.alive !== undefined) windowAlive = opts.alive;
}

export const sent: Array<{ channel: string; payload: unknown }> = [];

export function resetSent(): void {
  sent.length = 0;
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (!windowAlive) throw new Error("没有窗口在听");
  sent.push({ channel, payload: args.length === 1 ? args[0] : args });
}

export function sendToRendererQuiet(channel: string, ...args: unknown[]): void {
  try {
    sendToRenderer(channel, ...args);
  } catch {
    /* 同真的那一个:没窗口就当没发生 */
  }
}

/** 本套不用窗口本身,但 import 图里可能会问。 */
export function getMainWindow(): null {
  return null;
}

export function updateTitleBarOverlay(): void {
  /* 本套不关心标题栏 */
}