/**
 * **Agent 写设置的桌面刷新通知**(ARC-009 的「提交后独立可重试 outbox」在**这条**通知上的最小切片)。
 *
 * ## 它补的洞
 *
 * `app_api_call` 在 RPC **已提交**之后调这里通知桌面刷新。但 `sendToRenderer` 在
 * **没有主窗口 / 窗口已销毁 / webContents 已销毁**时是**静默 return** 的(见 `window.ts`)——
 * 于是一条已经落定的业务提交,它对桌面的刷新通知就这么**丢了**,而且**没人知道丢了**。
 * 用户在无窗口环境(窗口还没建好、或关掉又重开的那一段)用 Agent 改了自定义 UI 设置,
 * 桌面那一侧永远看不到刷新。
 *
 * ## 修法:攒下**这一条**通知,窗口出现时补发
 *
 * 通知失败(窗口此刻不在)时把事件**攒起来**,等窗口真的能收(`flushPendingSettingNotifications`)
 * 再补发一次。**只有一个槽** —— 因为只有 `CUSTOM_UI_SETTING_KEY` 这一条通知路径会走到这里,
 * 而它的语义是「这个键变了,去读最新」,同键攒多条没有意义(见下 `pending` 的说明)。
 *
 * ## 为什么不是「重试到底」
 *
 * 桌面刷新是**投影**,不是业务事实 —— 业务提交早已落定(ARC-009 的判据:通知失败不逆转
 * 已确认提交)。所以这里**只补发一次**(窗口一出现就兑),不做无限重试、不落盘、不建独立
 * outbox 存储。将来若要跨重启,再按 ARC-009 的 outbox 另建;**本切片只保证「同一进程内,
 * 窗口一出现就把这条丢过的通知补上」**,不假装更多。
 *
 * ## 为什么 send 是**注入**的,不直接 import window.ts
 *
 * `window.ts` 会在 `did-finish-load` 里调本模块的 {@link flushPendingSettingNotifications},
 * 于是两文件互为依赖。若本模块直接 `import { sendToRenderer, hasLiveRendererWindow } from
 * window.js`,就成**循环 import** —— 谁先被加载谁拿到的另一半是 `undefined`,补发会在运行时炸。
 * 所以这里留一个**可注入的发件端口**(默认由 `window.ts` 侧装配时 `setSettingNotifyPort`
 * 装入),本模块只认这个窄接口,不 import window。
 */
import { IPC } from "@contracts/ipc";
import { CUSTOM_UI_SETTING_KEY } from "@contracts/customUi";
import { log } from "@main/lib/logger.js";

/** 发件端口:能不能收 + 发一条。由 `window.ts` 装配时装入(见文件头「为什么注入」)。 */
export interface SettingNotifyPort {
  hasLiveRenderer(): boolean;
  send(channel: string, payload: unknown): void;
}

let port: SettingNotifyPort | null = null;

/** 装配发件端口。`window.ts` 在自己的模块初始化时调一次(它手上有 sendToRenderer/hasLiveRendererWindow)。 */
export function setSettingNotifyPort(p: SettingNotifyPort): void {
  port = p;
}

/**
 * 攒着的、还没能送到桌面的刷新通知。**只可能有一条** —— 见下:只有 `CUSTOM_UI_SETTING_KEY`
 * 这一条通知路径会走到这里,而它的语义是「这个键变了,去读最新」,同键攒多条没有意义。
 *
 * ⚠️ 因此这里**没有**队列上限 / 丢最旧的逻辑:单槽 + 同键去重下,那个上限**永远达不到**,
 * 写了就是**不可达的死代码**(评审会点名)。将来若真有第二条可攒的键,那时再加有界队列,
 * 并配一条能把它压满的断言 —— 而不是现在先摆一个没人走得进去的上限。
 */
let pending: { channel: string; payload: unknown } | null = null;

function customUiRefreshPayload(): { channel: string; payload: unknown } {
  return {
    channel: IPC.CLAUDE_EVENT,
    payload: {
      channel: IPC.CLAUDE_EVENT,
      sessionId: "",
      event: { type: "setting.changed", sessionId: "", key: CUSTOM_UI_SETTING_KEY, value: "" },
    },
  };
}

export function notifyAppSettingWrite(method: string, raw: unknown): void {
  if (method !== "setting.set" || !raw || typeof raw !== "object") return;
  if ((raw as { key?: unknown }).key !== CUSTOM_UI_SETTING_KEY) return;
  const entry = customUiRefreshPayload();
  // 端口未装(极早期)/ 窗口不在 → 攒起来(同键覆盖),窗口出现时补发,而不是静默丢。
  if (!port || !port.hasLiveRenderer()) {
    pending = entry;
    return;
  }
  port.send(entry.channel, entry.payload);
}

/**
 * **窗口出现时补发**攒着的通知。由窗口就绪路径调用(`window.ts` 的 `did-finish-load`)。
 * 返回**真的补发了几条**(便于断言与日志);没有窗口 / 端口未装时**不动**攒下的那条。
 */
export function flushPendingSettingNotifications(): number {
  if (!port || !port.hasLiveRenderer()) return 0;
  if (pending === null) return 0;
  const entry = pending;
  pending = null;
  port.send(entry.channel, entry.payload);
  log.info("[settingSync] 补发了 1 条窗口不在时丢下的桌面刷新通知");
  return 1;
}

/** 测试 / 诊断用:当前攒着没有(0 或 1)。 */
export function pendingSettingNotifications(): number {
  return pending === null ? 0 : 1;
}

