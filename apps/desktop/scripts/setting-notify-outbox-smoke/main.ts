/**
 * Headless smoke for **ARC-009 的桌面刷新通知 outbox**(`main/customUi/settingSync.ts`)。
 *
 * ## 它证的是什么
 *
 * `app_api_call` 在 RPC **已提交**之后调 `notifyAppSettingWrite` 通知桌面刷新。但
 * `sendToRenderer` 在没有主窗口时是**静默 return** 的 —— 于是一条已经落定的业务提交,
 * 它对桌面的刷新通知就这么丢了,而且没人知道。本套钉死:通知失败时**攒起来**、窗口
 * 一出现**补发一次**、队列**有界**且超限丢最旧(不静默)。
 *
 * ## 隔离
 *
 * `settingSync` 只认**注入的发件端口**(见文件头「为什么注入」),本套注入一个**假端口**
 * 记录所有发送,不碰 electron / 真窗口。
 *
 * Run: scripts/setting-notify-outbox-smoke/run.sh
 */
import {
  notifyAppSettingWrite,
  flushPendingSettingNotifications,
  pendingSettingNotifications,
  setSettingNotifyPort,
} from "@main/customUi/settingSync.js";
import { CUSTOM_UI_SETTING_KEY } from "@contracts/customUi";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/* 假发件端口:能切换"窗口在不在",记录每一条发出去的 (channel, payload)。 */
let liveWindow = true;
const sent: Array<{ channel: string; payload: unknown }> = [];
setSettingNotifyPort({
  hasLiveRenderer: () => liveWindow,
  send: (channel, payload) => { sent.push({ channel, payload }); },
});

const refresh = (key: string): void => notifyAppSettingWrite("setting.set", { key });

/* ── 1. 窗口在 → 立即发,不攒 ── */
{
  liveWindow = true;
  const before = sent.length;
  refresh(CUSTOM_UI_SETTING_KEY);
  eq("窗口在:立即发一条", sent.length - before, 1);
  eq("窗口在:不攒", pendingSettingNotifications(), 0);
  check("发出去的是 setting.changed", JSON.stringify(sent.at(-1)).includes("setting.changed"), sent.at(-1));
}

/* ── 2. 窗口不在 → 攒起来(不静默丢) ── */
{
  liveWindow = false;
  const before = sent.length;
  refresh(CUSTOM_UI_SETTING_KEY);
  eq("窗口不在:一条都不发", sent.length - before, 0);
  eq("★ 窗口不在:攒下一条(不静默丢)", pendingSettingNotifications(), 1);

  /* ── 3. 窗口回来 → 补发一次,队列清空 ── */
  liveWindow = true;
  eq("★ 窗口回来:补发一条", flushPendingSettingNotifications(), 1);
  eq("补发后队列清空", pendingSettingNotifications(), 0);
  eq("补发确实发出去了", sent.length - before, 1);
  eq("补发后的队列再 flush 是 0(不重复发)", flushPendingSettingNotifications(), 0);
}

/* ── 4. 窗口不在时 flush → 不动队列(留给下一次窗口出现) ── */
{
  liveWindow = false;
  refresh(CUSTOM_UI_SETTING_KEY);
  eq("窗口不在时 flush 不补发(留着)", flushPendingSettingNotifications(), 0);
  eq("队列仍攒着那条", pendingSettingNotifications(), 1);
  liveWindow = true;
  eq("窗口回来才补发", flushPendingSettingNotifications(), 1);
}

/* ── 5. 同键去重:攒多条只发一次(刷新通知语义 = 去读最新) ── */
{
  liveWindow = false;
  refresh(CUSTOM_UI_SETTING_KEY);
  refresh(CUSTOM_UI_SETTING_KEY);
  refresh(CUSTOM_UI_SETTING_KEY);
  eq("同键多写只攒一条(去重)", pendingSettingNotifications(), 1);
  liveWindow = true;
  eq("同键多写只补发一次", flushPendingSettingNotifications(), 1);
}

/* ── 6. 反复写不撑爆(单槽 + 同键去重 = 恒 <= 1) ── */
{
  liveWindow = false;
  for (let i = 0; i < 100; i++) refresh(CUSTOM_UI_SETTING_KEY);
  eq("反复写 100 次仍只攒一条(单槽 + 去重,不撑爆)", pendingSettingNotifications(), 1);
  liveWindow = true;
  eq("flush 后清空", flushPendingSettingNotifications(), 1);
  eq("清空后再查是 0", pendingSettingNotifications(), 0);
}

/* ── 7. 不相关的 key / 非 setting.set → 完全不动(不误发) ── */
{
  liveWindow = true;
  const before = sent.length;
  notifyAppSettingWrite("setting.set", { key: "some.other.key" });
  notifyAppSettingWrite("git.push", { key: CUSTOM_UI_SETTING_KEY });
  notifyAppSettingWrite("setting.set", null);
  eq("不相关 key / 非 setting.set 一律不发", sent.length - before, 0);
}

console.log(`\nsetting-notify-outbox-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
