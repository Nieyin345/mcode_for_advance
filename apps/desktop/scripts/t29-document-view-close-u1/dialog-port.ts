/**
 * T29 —— 主进程 `dialog.showMessageBox` 的**确定性端口**。
 *
 * ## 为什么需要
 *
 * 修复后的关闭路径把决定权交回 vendor 的 `request*Close`：脏视图关闭时它会
 * 弹「保存 / 放弃修改 / 取消」。在无头 U1 里不能真的弹系统模态框（永远没人点，
 * 旅程会挂到超时），所以这里把**同一个** `dialog.showMessageBox` 换成确定性应答，
 * 并记录每次弹窗的完整参数 —— 于是旅程可以同时断言：
 *
 *  - 「有未保存状态时，关闭前确实出现了三选一确认」（不是静默丢改动）；
 *  - 选「取消」→ vendor 返回 false → 宿主拒绝关闭、视图保留；
 *  - 页面把 dirty 清掉后再关 → vendor 直接放行。
 *
 * ## 只换方法，不换模块
 *
 * Electron 44 的 `dialog` 对象属性可写可配置（本机实测
 * `{writable:true, configurable:true}`），vendor 主进程持有的是**同一个对象**，
 * 因此运行期替换方法对它们全部生效；还原时写回原函数引用。不 mock 整个
 * `electron` 模块 —— 那会把真窗口、真视图一起假掉，U1 就失去意义。
 */
import { dialog } from "electron";

export interface MessageBoxCall {
  message: string;
  detail: string;
  buttons: string[];
  cancelId: number | undefined;
  defaultId: number | undefined;
  at: number;
}

export interface DialogPort {
  /** 已发生的全部系统消息框调用（按时间顺序）。 */
  readonly calls: MessageBoxCall[];
  /** 改变后续弹窗的应答（按钮下标）。默认 2 = 「取消」。 */
  respondWith(response: number): void;
  /** 丢弃记录（每个断言段之间用）。 */
  reset(): void;
  /** 写回原函数（进程退出/旅程结束时调用；幂等）。 */
  restore(): void;
}

/** 当前进程里已安装的端口（steps 读它拿弹窗证据）。 */
let current: DialogPort | null = null;

export function getDialogPort(): DialogPort | null {
  return current;
}

/**
 * 安装确定性端口。`initialResponse` 缺省 2（「取消」）—— 默认取向与产品一致：
 * 没人确认时**不**丢用户修改。
 */
export function installDialogPort(initialResponse = 2): DialogPort {
  if (current !== null) return current;
  const original = dialog.showMessageBox;
  const calls: MessageBoxCall[] = [];
  let response = initialResponse;
  const patched = async (...args: unknown[]): Promise<{ response: number; checkboxChecked: boolean }> => {
    // vendor 两种调用形态：`showMessageBox(options)` 与
    // `showMessageBox(parent, options)`。记录一律取最后一个参数。
    const options = (args.length > 1 ? args[args.length - 1] : args[0]) as {
      message?: unknown; detail?: unknown; buttons?: unknown;
      cancelId?: unknown; defaultId?: unknown;
    } | undefined;
    calls.push({
      message: typeof options?.message === "string" ? options.message : "",
      detail: typeof options?.detail === "string" ? options.detail : "",
      buttons: Array.isArray(options?.buttons) ? options!.buttons.map(String) : [],
      cancelId: typeof options?.cancelId === "number" ? options.cancelId : undefined,
      defaultId: typeof options?.defaultId === "number" ? options.defaultId : undefined,
      at: Date.now(),
    });
    return { response, checkboxChecked: false };
  };
  dialog.showMessageBox = patched as unknown as typeof dialog.showMessageBox;
  const port: DialogPort = {
    get calls() { return calls; },
    respondWith(next) { response = next; },
    reset() { calls.length = 0; },
    restore() {
      if (dialog.showMessageBox === (patched as unknown as typeof dialog.showMessageBox)) {
        dialog.showMessageBox = original;
      }
      if (current === port) current = null;
    },
  };
  current = port;
  return port;
}
