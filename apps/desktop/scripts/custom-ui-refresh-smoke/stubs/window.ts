/**
 * `@main/window.js` 的替身(定制 UI 刷新 smoke)。测试通过 `setSink` 观察发出去的事件。
 *
 * ⚠️ 【MC-102】**必须像生产 `window.ts` 一样装配 `setSettingNotifyPort`** —— 生产里这句在
 * 模块加载时执行(`window.ts` 顶部),把「窗口能不能收 / 发一条」注入 `settingSync.ts`。本桩
 * 从前只导出 `setSink`/`sendToRenderer` 却没装端口,于是 `settingSync` 的桌面刷新通知**永远
 * 发不出去**(端口未接)→ 断言「approved external save must invalidate the desktop cache」稳定
 * 红 —— 那是**桩跟不上生产装配**的假红,不是产品不刷新。这里照生产补上同一句装配。
 *
 * 桩的窗口语义:`getMainWindow()` 恒 null(无真窗口),但刷新 smoke 要用 `setSink` 直接观察 /
 * 投递事件 —— 所以 `hasLiveRenderer` 恒 true(测试环境"桌面在"),`sendToRenderer` 走 sink。
 */
import { setSettingNotifyPort } from "@main/customUi/settingSync.js";

let sink: null | ((channel: string, payload: unknown) => void) = null;
export const setSink = (next: typeof sink) => { sink = next; };
export const sendToRenderer = (channel: string, payload: unknown) => { sink?.(channel, payload); };
export const getMainWindow = () => null;

// 与生产 `window.ts` 顶部同一句装配(端口未接 → 刷新通知发不出去,见文件头)。
setSettingNotifyPort({
  hasLiveRenderer: () => true,
  send: (channel, payload) => sendToRenderer(channel, payload),
});
