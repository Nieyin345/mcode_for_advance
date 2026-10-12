/**
 * panel-frame-version-smoke — `PanelFrame` 的**换版竞态**:同一条 `item.id` 的面板
 * HTML / 权限改了之后,旧 iframe 在**新文档 stage 完成之前**仍然挂着,而它发来的
 * `window.mcode` 调用会被派给**新** 的 `hostRef`(新 action/item/target)。
 *
 * ## 盯的是什么(台账 UI-016)
 *
 * 右栏页签 / 浮窗里,编辑同 id 面板的 HTML / network / title 时 React `key` 不变 →
 * `PanelFrame` 还是同一个实例。旧实现里:
 *
 *   - stage 发起只 `setError(null)`,**没有**立即使旧 url / 旧 iframe 失效;
 *   - `hostRef` 每次布局 effect 就换成**新** 的 action/item/target;
 *   - 于是"A 版面板"发出的调用,**按 B 版的配置**执行(用户刚改的权限由被替掉的
 *     那一版在生效);stage 卡住时,旧 iframe 可长期带着新上下文继续跑。
 *
 * ## 判据(立在用户可见行为上)
 *
 * 换版过渡期里,旧 iframe 发来的方法调用**不得**被执行 —— 面板收不到成功回包,而是收到
 * `panel closed`;真正执行层(`handlePanelCall` 替身)一条都不该记到。新版本 stage 成功后,
 * 新 iframe 的调用才带着**新** host 正常执行。
 *
 * ## 它怎么跑
 *
 * esbuild 打包真 `PanelFrame`;`react` / `react/jsx-runtime` 换极小运行时(带稳定
 * `contentWindow` 的假 iframe,见 fakeReact),`./panelBridge.js` 换记调用替身,
 * `@renderer/lib/api.js` 换成**能扣住 stage 回包**的替身。不起浏览器、不写盘。
 *
 * Run: scripts/panel-frame-version-smoke/run.sh
 */
import "./prelude.js";
import { dispatchMessage, messageListeners } from "./prelude.js";
import { __mount, __render, __flush, __nodes, __text } from "./fakeReact.js";
import { server, resetApi, release } from "./api-stub.js";
import { bridgeCalls, resetBridge } from "./panelBridgeStub.js";
import { PanelFrame } from "@renderer/components/customUi/PanelFrame.js";
import type { CustomUiItem, CustomUiTarget } from "@contracts/customUi";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

/** 每一幕前清掉上一幕的 message 监听器(`__mount` 清 slots,上一幕的 effect cleanup 不
 *  会再跑,监听器会留下)—— 本套每幕用新假窗口,留着也只是空转,清掉更确定。 */
function fresh(): void {
  resetApi();
  resetBridge();
  messageListeners.length = 0;
}

const TARGET: CustomUiTarget = { kind: "workspace", today: "2026-10-12" };

function item(html: string, extra?: { network?: boolean; title?: string }): CustomUiItem {
  return {
    id: "my-panel",
    slot: "rightPanel.tab",
    label: { zh: "面板", en: "panel" },
    action: { type: "panel", html, ...(extra?.network ? { network: true } : {}), ...(extra?.title ? { title: extra.title } : {}) },
  };
}

/** 树上当前的 iframe 元素(没有就 null)。 */
function iframeEl(): { win: { _msgs: unknown[]; postMessage: (m: unknown) => void }; key: unknown } | null {
  const n = __nodes().find((x) => x.type === "iframe");
  if (!n) return null;
  const ref = n.props.ref as { current: { contentWindow: { _msgs: unknown[]; postMessage: (m: unknown) => void } } | null };
  const win = ref?.current?.contentWindow;
  if (!win) return null;
  return { win, key: n.key };
}

/** 派一条"面板请求"进 message 监听器(带 `source`)。 */
function postFrom(win: { _msgs: unknown[] }, id: number, method: string): void {
  dispatchMessage(win, { __mcode: 1, id, method, params: {} });
}

/** 假窗口收到的回包(找那个 id 的)。 */
function replyFor(win: { _msgs: unknown[] }, id: number): Record<string, unknown> | undefined {
  return win._msgs.find((m) => m && (m as { id?: number }).id === id) as Record<string, unknown> | undefined;
}

const HOLD = "customUi:stagePanel";

async function scenarioCore(): Promise<void> {
  fresh();
  server.hold.add(HOLD);

  let it = item("<p>version A</p>");
  __mount(() => PanelFrame({ item: it, target: TARGET, reloadKey: 0, probeMode: "tab" }));
  await __flush();
  check("首次挂载发起了 stage(A)", server.stageCalls.length === 1, server.stageCalls.length);

  release(HOLD, (i) => (i.html as string).includes("version A"));
  await __flush();
  const a = iframeEl();
  check("A 版 stage 成功后挂上 iframe", a !== null);
  check("★ A 版 iframe key 用的是 A 的 url", typeof a?.key === "string" && (a!.key as string).includes("mcode-panel://"), a?.key);

  // A 版自己发一个调用 —— 应正常执行(基线:换版前必须能工作,否则这条 smoke 空过)。
  const winA = a!.win;
  postFrom(winA, 1, "storage.get");
  await __flush();
  check("换版前:A 版调用正常执行(基线)", bridgeCalls.length === 1 && bridgeCalls[0].html.includes("version A"), bridgeCalls);
  check("换版前:A 版收到成功回包", (replyFor(winA, 1) as { ok?: boolean } | undefined)?.ok === true, replyFor(winA, 1));

  // ── 现在改成 B 版(同一个 item.id)—— 但 stage 扣着不回来。──
  it = item("<p>version B</p>");
  __render(); // 这一帧:hostRef 已换成 B,url 还是 A 的(旧 iframe 仍在树上)
  resetBridge();
  // ① 过渡第一帧:A 版 iframe 还在,且能发消息 —— 但它必须被判作废。
  postFrom(winA, 2, "storage.get");
  await __flush();
  check("★ 换版过渡期:旧 A 版调用不得被按新配置执行", bridgeCalls.length === 0, bridgeCalls);
  check(
    "★ 旧 A 版收到的是「面板已关闭」而不是成功",
    (replyFor(winA, 2) as { ok?: boolean; error?: string } | undefined)?.ok === false &&
      (replyFor(winA, 2) as { error?: string }).error === "panel closed",
    replyFor(winA, 2),
  );

  // ② flush 后旧 iframe 已被摘掉,界面切到"正在载入新版本"。
  check("换版过渡期:旧 iframe 已从树上摘掉", iframeEl() === null, iframeEl());
  check("换版过渡期:显示「正在载入新版本」", __text().includes("customUi.panel.loadingNew"), __text());

  // ③ 旧 A 版即使这时再发,也仍然被拒(frameRef 仍指向旧窗口)。
  postFrom(winA, 3, "files.write");
  await __flush();
  check("★ 旧 iframe 摘掉后仍拒旧版调用", bridgeCalls.length === 0, bridgeCalls);
  check("★ 旧 A 版仍收「面板已关闭」(第二次)", (replyFor(winA, 3) as { error?: string } | undefined)?.error === "panel closed", replyFor(winA, 3));

  // ④ 放行 B 版 stage —— 新 iframe 挂上,key 用 B 的 url。
  release(HOLD, (i) => (i.html as string).includes("version B"));
  await __flush();
  const b = iframeEl();
  check("B 版 stage 成功后挂上 iframe", b !== null);
  check("★ B 版 iframe 用的是 B 的 url(与 A 不同)", typeof b?.key === "string" && b!.key !== a!.key, { b: b?.key, a: a?.key });

  resetBridge();
  postFrom(b!.win, 4, "storage.get");
  await __flush();
  check("★ B 版调用带 B 的 host 正常执行", bridgeCalls.length === 1 && bridgeCalls[0].html.includes("version B"), bridgeCalls);
}

async function scenarioTargetNoReload(): Promise<void> {
  fresh();
  server.hold.add(HOLD);
  let target: CustomUiTarget = { kind: "workspace", today: "2026-10-12", project: { path: "/p/a", name: "a" } };
  const it = item("<p>stable</p>");
  __mount(() => PanelFrame({ item: it, target, reloadKey: 0, probeMode: "tab" }));
  await __flush();
  release(HOLD, (i) => (i.html as string).includes("stable"));
  await __flush();
  const before = iframeEl();
  const stageCount = server.stageCalls.length;

  // 只换 target(切项目 / 换天)—— 不该重 stage,也不该重建 iframe。
  target = { kind: "workspace", today: "2026-10-12", project: { path: "/p/b", name: "b" } };
  __render();
  await __flush();
  const after = iframeEl();
  check("★ 纯 target 变化不重新 stage", server.stageCalls.length === stageCount, { before: stageCount, after: server.stageCalls.length });
  check("★ 纯 target 变化 iframe 不重建(key/url 不变)", after?.key === before?.key, { after: after?.key, before: before?.key });
  check("纯 target 变化后 iframe 仍在(未被摘掉)", after !== null);
}

async function scenarioStageFailure(): Promise<void> {
  fresh();
  server.hold.add(HOLD);
  let it = item("<p>good</p>");
  __mount(() => PanelFrame({ item: it, target: TARGET, reloadKey: 0, probeMode: "tab" }));
  await __flush();
  release(HOLD, (i) => (i.html as string).includes("good"));
  await __flush();
  const winA = iframeEl()!.win;

  // 换成 B 版,并让 B 的 stage **直接失败**(不再扣住 —— 要它当场拒绝)。
  it = item("<p>broken</p>");
  server.stageThrows = "stage failed: disk full";
  server.hold.delete(HOLD);
  resetBridge();
  __render();
  await __flush();

  check("★ stage 失败:显示错误(不是旧内容)", __text().includes("customUi.panel.loadFailed"), __text());
  check("stage 失败:提供重试", __text().includes("customUi.panel.retry"), __text());
  check("★ stage 失败:旧 iframe 已作废", iframeEl() === null, iframeEl());

  postFrom(winA, 10, "shell");
  await __flush();
  check("★ stage 失败后旧版调用仍被拒", bridgeCalls.length === 0, bridgeCalls);
  check("★ stage 失败后旧版收「面板已关闭」", (replyFor(winA, 10) as { error?: string } | undefined)?.error === "panel closed", replyFor(winA, 10));

  // 点「重试」:这次不失败 —— 应重新 stage 并挂上 B 版。
  server.stageThrows = null;
  const retryBtn = __nodes().find((n) => n.type === "button" && typeof n.props.onClick === "function");
  check("找到重试按钮", retryBtn !== undefined);
  (retryBtn!.props.onClick as () => void)();
  await __flush();
  release(HOLD, (i) => (i.html as string).includes("broken"));
  await __flush();
  const b = iframeEl();
  check("★ 重试后挂上 B 版 iframe", b !== null);
  resetBridge();
  postFrom(b!.win, 11, "storage.get");
  await __flush();
  check("★ 重试后 B 版调用带 B 的 host 执行", bridgeCalls.length === 1 && bridgeCalls[0].html.includes("broken"), bridgeCalls);
}

async function scenarioLateB(): Promise<void> {
  // 高频 A→B→C:B 的 stage 迟到回来时,C 已经是当前版 —— B 不许落地。
  fresh();
  server.hold.add(HOLD);
  let it = item("<p>A</p>");
  __mount(() => PanelFrame({ item: it, target: TARGET, reloadKey: 0, probeMode: "tab" }));
  await __flush();
  release(HOLD, (i) => (i.html as string).includes(">A<"));
  await __flush();

  it = item("<p>B</p>");
  __render();
  it = item("<p>C</p>");
  __render();
  await __flush();

  // 先放行 B 的 stage(迟到),再放行 C 的。
  release(HOLD, (i) => (i.html as string).includes(">B<"));
  await __flush();
  check("★ B 的迟到 stage 不落地(B 不是当前版,不出 iframe)", iframeEl() === null, { text: __text() });
  release(HOLD, (i) => (i.html as string).includes(">C<"));
  await __flush();
  const c = iframeEl();
  check("★ 最终只出现 C 版", c !== null, { text: __text() });
  resetBridge();
  postFrom(c!.win, 20, "storage.get");
  await __flush();
  check("★ C 版调用带 C 的 host 执行", bridgeCalls.length === 1 && bridgeCalls[0].html.includes(">C<"), bridgeCalls);
}

await scenarioCore();
await scenarioTargetNoReload();
await scenarioStageFailure();
await scenarioLateB();

console.log(`\npanel-frame-version-smoke:${checks - failures}/${checks} 通过`);
process.exit(failures > 0 ? 1 : 0);
