/**
 * `@main/window.js` 的替身 —— 中继**每一处状态变化**都经过它。
 *
 * `RelayManager.setState()` 的最后一件事就是 `sendToRenderer(IPC.RELAY_EVENT, …)`,
 * 而那条正是渲染端"远程访问"面板唯一的状态来源。本套要验的那几条
 * (重连退避、半截状态、错误文案)判据全部立在**推给界面的那一个个快照**上,
 * 所以这里不是"记一下就行"的桩,它是主要的观察面。
 *
 * 与 `mobile-pairing-smoke` 那份的差别:那一份**不需要** `sendToRenderer`,
 * 只借它的 `getMainWindow()`;这一份**只**需要 `sendToRenderer`。
 */

export interface Push {
  channel: string;
  status: {
    state: string;
    endpoint: string | null;
    vpsHost: string | null;
    publicPort: number;
    error: string | null;
    forwarderType: string | null;
  };
  /** 从进程开始到这一条为止的毫秒数 —— 退避间隔全靠它算。 */
  at: number;
}

const pushes: Push[] = [];
const t0 = Date.now();

export function sendToRenderer(channel: string, payload: unknown): void {
  const p = payload as { status: Push["status"] };
  pushes.push({ channel, status: { ...p.status }, at: Date.now() - t0 });
}

/** 全部推送,按顺序。 */
export function __pushes(): Push[] {
  return pushes;
}

/** 清空(每条场景开始时叫一次,免得前面的推送算进后面的窗口)。 */
export function __reset(): void {
  pushes.length = 0;
}

/** 真实现里 `BrowserWindow | null` —— 无头环境就是 null,调用方写的是"没窗口就跳过"。 */
export function getMainWindow(): null {
  return null;
}

export function createMainWindow(): never {
  throw new Error("relay-smoke 不该走到 createMainWindow(本套不起窗口)");
}

export function updateTitleBarOverlay(): void {
  /* 主题相关,本套不验 */
}
