/**
 * `./panelBridge.js` 替身 —— PanelFrame 只用它三样:`handlePanelCall` / `panelContextOf` /
 * `readPanelTheme`(以及 `PanelHost` 类型)。
 *
 * 这套 smoke 的判据是"**旧面板的调用会不会被派给新 host 执行**",所以 `handlePanelCall`
 * 在这里把**它收到的整个 host**记下来 —— 测试据此断言:换版过渡期里旧 iframe 发来的
 * 调用要么压根没到这里(被 PanelFrame 的 generation 闸拒掉),要么带的是**它自己那一版**
 * 的 host。真 bridge 那一长串副作用(确认框、写文件、跑命令)这里一条都不碰。
 */
import type { CustomUiItem, CustomUiTarget } from "@contracts/customUi";

export interface PanelAction {
  type: "panel";
  title?: string;
  html: string;
  network?: boolean;
  confirm?: boolean;
}
export interface PanelHost {
  item: CustomUiItem;
  action: PanelAction;
  target: CustomUiTarget;
}

/** 每一次真正抵达"执行层"的调用(host 是 PanelFrame 交给它的那一份)。 */
export const bridgeCalls: Array<{ html: string; itemId: string; method: string }> = [];
export function resetBridge(): void {
  bridgeCalls.length = 0;
}

export async function handlePanelCall(host: PanelHost, method: string): Promise<unknown> {
  bridgeCalls.push({ html: host.action.html, itemId: host.item.id, method });
  return `executed:${method}`;
}

export function panelContextOf(host: PanelHost): Record<string, unknown> {
  return { itemId: host.item.id, html: host.action.html, target: host.target.kind };
}

export function readPanelTheme(): { mode: "light" | "dark"; colors: Record<string, string>; fontSize?: string } {
  return { mode: "light", colors: {}, fontSize: "14px" };
}
