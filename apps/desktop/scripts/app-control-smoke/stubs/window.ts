/** `@main/window.js` 的替身 —— 真的那个 import electron。smoke 里界面通道走 `setRendererPortForTest`。
 *
 * `sendToRenderer` 默认是 no-op;但 **ARC-009 的失败注入测试**需要让它真的抛(模拟"窗口在
 * 提交之后忽然不可用,UI 刷新通知发不出去"这条真实的故障路径)。用一个模块级开关控制 —— 与
 * 被测代码经同一个 alias 解析到**同一个文件**,所以开关状态是共享的(SKILL 里"两份模块实例"
 * 那个坑的反面:import 同一个文件才不会裂成两份)。
 */
import { setSettingNotifyPort } from "@main/customUi/settingSync.js";

let throwOnSend = false;
/** 测试用:窗口此刻在不在(默认 true —— 与"有窗口"的常态一致)。 */
let liveWindow = true;

/** 测试用:让下一次 `sendToRenderer` 抛错(默认 false)。 */
export function __setSendToRendererThrows(v: boolean): void {
  throwOnSend = v;
}

/** 测试用:切换"窗口在不在"(驱动 settingSync 的攒/补发真路径)。 */
export function __setLiveRendererWindow(v: boolean): void {
  liveWindow = v;
}

export function sendToRenderer(..._args: unknown[]): void {
  if (throwOnSend) throw new Error("主窗口已销毁,发不到渲染端(测试注入)");
}
export function getMainWindow(): null {
  return null;
}
export function hasLiveRendererWindow(): boolean {
  return liveWindow;
}

// 与真的 `window.ts` 同一步:把发件端口装给 settingSync(它不能 import 本文件,会循环)。
setSettingNotifyPort({
  hasLiveRenderer: hasLiveRendererWindow,
  send: (channel, payload) => sendToRenderer(channel, payload),
});
