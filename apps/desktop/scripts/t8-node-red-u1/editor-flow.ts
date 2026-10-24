/**
 * T8 —— Node-RED 编辑器页的**真手势**封装（跑在探针主进程里，作用在编辑器视图）。
 *
 * ## 每个手势都是真用户能做的那一个
 *
 *  | 动作 | 真手段 | 为什么不能只查 API |
 *  |---|---|---|
 *  | 打开画布 | 生产 `documentView:open`（`workflowEngineId` 身份 → 凭据 broker 注入） | 这是产品里唯一的打开链 |
 *  | 关掉首次启动的同意框 / 欢迎导览 | `sendInputEvent` 真鼠标点按钮 / Esc | 它们**真的会挡住**后续点击（`red-ui-shade` z-index 2000） |
 *  | 放入一张图 | 编辑器自己的 Import 对话框：真点 textarea + 真 `Ctrl+V`（`webContents.paste()`）→ 真点「导入」 | 与用户手贴 JSON 同一条路径 |
 *  | 切页签 | `RED.workspaces.show(id)`（页签点击处理器的**同一个**函数） | 页签元素在窄视口会折叠，坐标点击不稳 |
 *  | 改节点名 | `RED.editor.edit(node)`（节点双击处理器的同一个函数）→ 真点 name 输入框 + `Ctrl+A` + `insertText` → 真点「完成」 | Node-RED 5.0.8 用 d3-drag 的 `dblClickPrimed` 判双击，`sendInputEvent` 的 `clickCount:2` 不满足它（实测） |
 *  | Deploy | 真点 `#red-ui-header-button-deploy`（部署按钮的 click → `save()`） | —— |
 *
 * ## 为什么「放入一张图」不用 `workflowEngine.load`
 *
 * 生产 T59 装载入口（`loadWorkflowIntoNative`）对**所有可保存的 Node-RED 图**都会
 * 拒绝：`mcode.trigger` 迁到内置 inject 必报 lossy，`mcode.main` 必报 human-decision，
 * `mcode.agent` 多了一个「产出契约」lossy —— 而 `saveWorkflow` 又要求自动化必须有
 * `mcode.trigger`、普通图必须有 `mcode.main`。本套件把这条**作为事实证据**记录
 * （`native-load-refused` 步骤），旅程本身走用户真实可用的 Import 手势。
 *
 * ## 首次启动的两层遮挡（实测）
 *
 * Node-RED 5.0.8 首次打开依次弹两个模态：**遥测/更新通知同意框**（`red-ui-shade`
 * z-index 2000）与**欢迎导览**（`red-ui-tourGuide-shade`）。真用户必须作答/关闭，
 * 否则画布收不到任何输入。本文件按同一手势处理，并把「当时弹了什么」记进证据。
 */
import type { WebContents } from "electron";
import { setTimeout as sleep } from "node:timers/promises";

/** 编辑器视图的最小结构面（探针里就是 `WebContentsView.webContents`）。 */
export interface EditorPage {
  executeJavaScript: (expression: string, userGesture?: boolean) => Promise<unknown>;
  sendInputEvent: (event: Record<string, unknown>) => void;
  insertText: (text: string) => void;
  focus: () => void;
  paste: () => void;
  capturePage: () => Promise<{ isEmpty: () => boolean; toPNG: () => Buffer }>;
}

export function editorPage(wc: WebContents): EditorPage {
  return wc as unknown as EditorPage;
}

export async function js<T>(wc: WebContents, expression: string): Promise<T> {
  return (await (wc as unknown as EditorPage).executeJavaScript(expression, true)) as T;
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 150,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { if (await predicate()) return true; } catch { /* retry */ }
    if (Date.now() > end) return false;
    await sleep(intervalMs);
  }
}

/** 真鼠标：move → down → up（`clickCount` 1 或 2）。 */
export async function clickAt(wc: WebContents, x: number, y: number, clickCount = 1): Promise<void> {
  const page = wc as unknown as EditorPage;
  page.sendInputEvent({ type: "mouseMove", x, y });
  page.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount });
  page.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount });
}

/** 元素中心坐标（不可见 → null）。 */
export async function centerOf(wc: WebContents, selector: string): Promise<{ x: number; y: number } | null> {
  return await js<{ x: number; y: number } | null>(wc, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
}

/** 等编辑器骨架就绪（`#red-ui-editor` + 画布 chart）。 */
export async function waitEditorReady(wc: WebContents, timeoutMs = 60_000): Promise<boolean> {
  return await waitFor(
    async () => await js<boolean>(wc, `!!document.getElementById('red-ui-editor') && !!document.getElementById('red-ui-workspace-chart')`),
    timeoutMs,
  );
}

/**
 * 关掉首次启动的模态（遥测/更新通知同意框 + 欢迎导览）。
 *
 * 返回**每一步实际看到的界面**（标题与按钮文案），作为证据；关闭后断言两层
 * 遮挡都不在了。任何一步超时都返回 `{ closed: false, ... }`，由旅程判 FAIL。
 */
export async function dismissFirstRunOverlays(wc: WebContents): Promise<{
  closed: boolean;
  steps: Array<{ kind: "consent" | "tour"; heading: string | null; clicked: string | null }>;
}> {
  const steps: Array<{ kind: "consent" | "tour"; heading: string | null; clicked: string | null }> = [];
  // 1) 遥测/更新通知同意框（red-ui-shade，z-index 2000）
  const shadeSeen = await waitFor(async () => await js<boolean>(wc, `!!document.querySelector('.red-ui-shade')`), 25_000);
  for (let attempt = 0; attempt < 15; attempt++) {
    const state = await js<{
      shade: boolean;
      heading: string | null;
      buttons: Array<{ text: string; x: number; y: number }>;
    }>(wc, `(() => {
      const shade = document.querySelector('.red-ui-shade');
      if (!shade) return { shade: false, heading: null, buttons: [] };
      const panels = [...document.querySelectorAll('.red-ui-popover-panel, .red-ui-dialog, .ui-dialog')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const panel = panels[panels.length - 1] ?? null;
      const heading = panel ? ((panel.querySelector('h2') || panel).textContent || '').trim().slice(0, 80) : null;
      const buttons = panel
        ? [...panel.querySelectorAll('button')]
            .filter((b) => b.getBoundingClientRect().width > 0)
            .map((b) => { const r = b.getBoundingClientRect(); return { text: (b.textContent || '').trim().slice(0, 60), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })
        : [];
      return { shade: true, heading, buttons };
    })()`);
    if (!state.shade) break;
    // 同意框文案是英文（Node-RED 自己的 i18n）：选「No / Disable」这一支。
    const no = state.buttons.find((b) => /^(No|Disable)\b/i.test(b.text));
    const target = no ?? state.buttons[state.buttons.length - 1] ?? null;
    if (target === null) {
      wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      steps.push({ kind: "consent", heading: state.heading, clicked: "Escape" });
    } else {
      await clickAt(wc, target.x, target.y);
      steps.push({ kind: "consent", heading: state.heading, clicked: target.text });
    }
    await sleep(900);
  }
  const shadeGone = await waitFor(async () => await js<boolean>(wc, `!document.querySelector('.red-ui-shade')`), 12_000);

  // 2) 欢迎导览（red-ui-tourGuide-shade）：真用户点关闭或逐页走完。
  for (let attempt = 0; attempt < 12; attempt++) {
    const tour = await js<{ open: boolean; buttons: Array<{ text: string; close: boolean; x: number; y: number }> }>(wc, `(() => {
      const shade = document.querySelector('.red-ui-tourGuide-shade');
      if (!shade) return { open: false, buttons: [] };
      const panel = document.querySelector('.red-ui-tourGuide-popover');
      const buttons = panel
        ? [...panel.querySelectorAll('button')]
            .filter((b) => b.getBoundingClientRect().width > 0)
            .map((b) => { const r = b.getBoundingClientRect(); return { text: (b.textContent || '').trim().slice(0, 40), close: (b.textContent || '').trim() === '', x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })
        : [];
      return { open: true, buttons };
    })()`);
    if (!tour.open) break;
    const close = tour.buttons.find((b) => b.close);
    const next = tour.buttons[tour.buttons.length - 1] ?? null;
    const target = close ?? next;
    if (target === null) {
      wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      steps.push({ kind: "tour", heading: "welcome-tour", clicked: "Escape" });
    } else {
      await clickAt(wc, target.x, target.y);
      steps.push({ kind: "tour", heading: "welcome-tour", clicked: target.text || "(close)" });
    }
    await sleep(700);
  }
  const tourGone = await waitFor(async () => await js<boolean>(wc, `!document.querySelector('.red-ui-tourGuide-shade')`), 10_000);
  return { closed: shadeSeen ? shadeGone && tourGone : tourGone, steps };
}

/**
 * 把一份迁移器产物放进画布：编辑器自己的「导入」对话框 → 真粘贴 → 真点「导入」。
 *
 * 返回证据：对话框是否打开、粘贴后的文本长度、「导入」按钮点击前是否可用、
 * 画布模型里是否出现了这些节点。
 */
export async function importFlowNodes(wc: WebContents, nodes: unknown): Promise<{
  ok: boolean;
  dialogOpened: boolean;
  pastedChars: number;
  importEnabled: boolean;
  canvas?: { tabs: string[]; nodes: Array<{ type: string; name: string | null; z: string | null }> };
  detail?: string;
}> {
  const { clipboard } = require("electron") as typeof import("electron");
  wc.focus();
  await js(wc, "(() => { RED.actions.invoke('core:show-import-dialog'); return true; })()");
  const dialogOpened = await waitFor(
    async () => await js<boolean>(wc, `!!document.querySelector('#red-ui-clipboard-dialog-import-text') && document.querySelector('#red-ui-clipboard-dialog-import-text').offsetParent !== null`),
    10_000,
  );
  if (!dialogOpened) return { ok: false, dialogOpened: false, pastedChars: 0, importEnabled: false, detail: "Import 对话框没有打开" };

  const ta = await centerOf(wc, "#red-ui-clipboard-dialog-import-text");
  if (ta === null) return { ok: false, dialogOpened: true, pastedChars: 0, importEnabled: false, detail: "找不到导入 textarea" };
  await clickAt(wc, ta.x, ta.y);
  clipboard.writeText(JSON.stringify(nodes));
  (wc as unknown as EditorPage).paste();
  await sleep(1200);
  const pastedChars = await js<number>(wc, `document.querySelector('#red-ui-clipboard-dialog-import-text')?.value?.length ?? 0`);
  const importEnabled = await waitFor(
    async () => await js<boolean>(wc, `(() => { const b = document.querySelector('#red-ui-clipboard-dialog-ok'); return !!b && !b.disabled && !b.classList.contains('ui-button-disabled'); })()`),
    8_000,
  );
  if (!importEnabled) {
    return { ok: false, dialogOpened: true, pastedChars, importEnabled: false, detail: "粘贴后「导入」按钮仍不可用" };
  }
  const ok = await centerOf(wc, "#red-ui-clipboard-dialog-ok");
  if (ok === null) return { ok: false, dialogOpened: true, pastedChars, importEnabled, detail: "找不到「导入」按钮" };
  await clickAt(wc, ok.x, ok.y);
  const imported = await waitFor(
    async () => await js<boolean>(wc, `RED.nodes.createCompleteNodeSet().filter((n) => n.type !== 'tab').length > 0`),
    15_000,
  );
  const canvas = await js<{ tabs: string[]; nodes: Array<{ type: string; name: string | null; z: string | null }> }>(wc, `(() => {
    const set = RED.nodes.createCompleteNodeSet();
    return {
      tabs: set.filter((n) => n.type === 'tab').map((n) => n.label),
      nodes: set.filter((n) => n.type !== 'tab').map((n) => ({ type: n.type, name: typeof n.name === 'string' ? n.name : null, z: typeof n.z === 'string' ? n.z : null })),
    };
  })()`);
  return { ok: imported, dialogOpened: true, pastedChars, importEnabled, canvas };
}

/** 切到某个页签（按 label 匹配）。返回是否找到。 */
export async function switchToTab(wc: WebContents, label: string): Promise<boolean> {
  return await js<boolean>(wc, `(() => {
    const tab = RED.nodes.createCompleteNodeSet().find((n) => n.type === 'tab' && n.label === ${JSON.stringify(label)});
    if (!tab) return false;
    RED.workspaces.show(tab.id);
    return true;
  })()`);
}

/** 画布上某原生类型的节点中心坐标（当前激活页签）。 */
export async function canvasNodeCenter(wc: WebContents, nativeType: string): Promise<{ x: number; y: number; id: string } | null> {
  return await js<{ x: number; y: number; id: string } | null>(wc, `(() => {
    const groups = [...document.querySelectorAll('#red-ui-workspace-chart .red-ui-flow-node-group')];
    const hit = groups.find((g) => g.__data__ && g.__data__.type === ${JSON.stringify(nativeType)} && g.getBoundingClientRect().width > 0);
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), id: String(hit.__data__.id) };
  })()`);
}

/**
 * 打开节点编辑托盘并改「名称」。
 *
 * Node-RED 5.0.8 的节点双击由 d3-drag 的 `dblClickPrimed` 判（要求两次真实
 * `mousedown` 间隔 < 650ms 且同一节点），`sendInputEvent` 的 `clickCount:2` 不满足它。
 * 所以「进入编辑」调 **`RED.editor.edit(node)`** —— 节点双击处理器在判据成立时调的
 * 就是它（`red.js` 的 `nodeMouseUp`）；托盘内的改名仍是真键盘（点输入框 → Ctrl+A →
 * `insertText` → 点「完成」）。
 */
export async function renameNodeViaEditor(wc: WebContents, nativeType: string, newName: string): Promise<{
  ok: boolean;
  trayOpened: boolean;
  typedValue: string | null;
  committedValue: string | null;
  focusState?: unknown;
  detail?: string;
}> {
  // 编辑器视图必须先真的拿到焦点，`sendInputEvent` 才会投递（实测：窗口在屏上
  // 但视图未聚焦时，事件静默丢失）。
  wc.focus();
  await sleep(200);
  const opened = await js<string>(wc, `(() => {
    const groups = [...document.querySelectorAll('#red-ui-workspace-chart .red-ui-flow-node-group')];
    const hit = groups.find((g) => g.__data__ && g.__data__.type === ${JSON.stringify(nativeType)});
    if (!hit) return 'no-node';
    try { RED.editor.edit(hit.__data__); return 'invoked'; } catch (e) { return 'threw:' + (e && e.message); }
  })()`);
  if (opened !== "invoked") return { ok: false, trayOpened: false, typedValue: null, committedValue: null, detail: opened };
  const trayOpened = await waitFor(
    async () => await js<boolean>(wc, `[...document.querySelectorAll('.red-ui-tray')].some((t) => t.getBoundingClientRect().width > 0 && !!t.querySelector('#node-input-name'))`),
    12_000,
  );
  if (!trayOpened) return { ok: false, trayOpened: false, typedValue: null, committedValue: null, detail: "节点编辑托盘没有出现" };
  // 托盘带滑入动画：等输入框**完整落在视口内**再点（半开时坐标会落到窗口外）。
  const inViewport = await waitFor(async () => await js<boolean>(wc, `(() => {
    const el = document.querySelector('#node-input-name');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 20 && r.height > 5 && r.left >= 0 && r.top >= 0
      && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
  })()`), 10_000);
  if (!inViewport) return { ok: false, trayOpened: true, typedValue: null, committedValue: null, detail: "名称输入框没有完整进入视口（托盘宽于视图或动画未停）" };
  const input = await centerOf(wc, "#node-input-name");
  if (input === null) return { ok: false, trayOpened: true, typedValue: null, committedValue: null, detail: "找不到名称输入框" };
  await clickAt(wc, input.x, input.y);
  await sleep(200);
  const focusState = await js<unknown>(wc, `({
    hasFocus: document.hasFocus(),
    activeId: document.activeElement && document.activeElement.id,
    inputRect: (() => { const r = document.querySelector('#node-input-name').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    inner: { w: window.innerWidth, h: window.innerHeight },
  })`);
  const focused = (focusState as { activeId?: string }).activeId === "node-input-name";
  if (!focused) {
    // 一次补救：再点一次（动画位移）；仍失败则如实失败，不伪造。
    await clickAt(wc, input.x, input.y);
    await sleep(250);
  }
  const focusNow = await js<string | null>(wc, `document.activeElement && document.activeElement.id ? document.activeElement.id : null`);
  if (focusNow !== "node-input-name") {
    return { ok: false, trayOpened: true, typedValue: await js<string | null>(wc, `document.querySelector('#node-input-name')?.value ?? null`), committedValue: null, focusState, detail: `点名称框后焦点在「${String(focusNow)}」` };
  }
  wc.sendInputEvent({ type: "keyDown", keyCode: "a", modifiers: ["control"] });
  wc.sendInputEvent({ type: "keyUp", keyCode: "a", modifiers: ["control"] });
  await sleep(80);
  (wc as unknown as EditorPage).insertText(newName);
  await sleep(300);
  const typedValue = await js<string | null>(wc, `document.querySelector('#node-input-name')?.value ?? null`);
  if (typedValue !== newName) {
    return { ok: false, trayOpened: true, typedValue, committedValue: null, focusState, detail: `键入后输入框是「${String(typedValue)}」而不是目标名` };
  }
  const done = await centerOf(wc, "#node-dialog-ok");
  if (done === null) return { ok: false, trayOpened: true, typedValue, committedValue: null, detail: "找不到「完成」按钮" };
  await clickAt(wc, done.x, done.y);
  const closed = await waitFor(
    async () => await js<boolean>(wc, `![...document.querySelectorAll('.red-ui-tray')].some((t) => t.getBoundingClientRect().width > 0)`),
    8_000,
  );
  const committedValue = await js<string | null>(wc, `(() => {
    const g = [...document.querySelectorAll('#red-ui-workspace-chart .red-ui-flow-node-group')]
      .find((el) => el.__data__ && el.__data__.type === ${JSON.stringify(nativeType)});
    return g ? (typeof g.__data__.name === 'string' ? g.__data__.name : null) : null;
  })()`);
  return {
    ok: closed && committedValue === newName,
    trayOpened: true,
    typedValue,
    committedValue,
    focusState,
    ...(closed ? {} : { detail: "点「完成」后托盘没有关闭" }),
  };
}

/** 点部署按钮（真点击；部署按钮的 click 就是编辑器的 `save()`）。 */
export async function clickDeploy(wc: WebContents): Promise<{ clicked: boolean; disabledBefore: boolean }> {
  const state = await js<{ disabled: boolean; cls: string }>(wc, `(() => {
    const el = document.getElementById('red-ui-header-button-deploy');
    return { disabled: !el || el.classList.contains('disabled'), cls: el ? el.className : 'missing' };
  })()`);
  const btn = await centerOf(wc, "#red-ui-header-button-deploy");
  if (btn === null) return { clicked: false, disabledBefore: state.disabled };
  await clickAt(wc, btn.x, btn.y);
  return { clicked: true, disabledBefore: state.disabled };
}

/** 部署确认弹窗（未知/无效节点告警）出现时点确认；返回是否点过。 */
export async function confirmDeployWarningIfPresent(wc: WebContents): Promise<boolean> {
  const btn = await centerOf(wc, "#red-ui-deploy-dialog-confirm-deploy-deploy");
  if (btn === null) return false;
  await clickAt(wc, btn.x, btn.y);
  return true;
}

/** 等待某个条件在编辑器里成立（轮询）；谓词在页面内求值。 */
export async function waitInPage(wc: WebContents, expression: string, timeoutMs: number): Promise<boolean> {
  return await waitFor(async () => await js<boolean>(wc, expression), timeoutMs, 250);
}

/* ─────────────────── W1 追加：从 palette 拖节点 / 端口拖线 ─────────────────── */

/**
 * 画布上一个原生节点（类型 + 当前激活页签）的坐标与端口坐标。
 *
 * 端口坐标直接取**真正的 DOM 元素**（`.red-ui-flow-port-input rect` /
 * `.red-ui-flow-port-output rect`）的 `getBoundingClientRect()` 中心，而不是用
 * `node.x ± w/2` 推算：`portMouseDown/Up` 是绑在**端口元素本身**上的，
 * 点偏 5px 就落到画布背景上（那会变成「画布拖框/快速添加」而不是连线）。
 *
 * `inChart` 判的是端口中心是否落在 `#red-ui-workspace-chart` 的可见矩形内 ——
 * 落在外面时鼠标事件会被别的面板接走（palette / header），旅程必须据此 FAIL 而不是硬点。
 */
export async function canvasNodePorts(wc: WebContents, nativeType: string): Promise<{
  id: string;
  center: { x: number; y: number };
  output: { x: number; y: number; inChart: boolean } | null;
  input: { x: number; y: number; inChart: boolean } | null;
} | null> {
  return await js<{
    id: string;
    center: { x: number; y: number };
    output: { x: number; y: number; inChart: boolean } | null;
    input: { x: number; y: number; inChart: boolean } | null;
  } | null>(wc, `(() => {
    const chart = document.getElementById('red-ui-workspace-chart');
    if (!chart) return null;
    const cr = chart.getBoundingClientRect();
    const inChart = (r) => {
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      return { x: Math.round(x), y: Math.round(y),
        inChart: x >= cr.left && x <= cr.right && y >= cr.top && y <= cr.bottom };
    };
    const groups = [...document.querySelectorAll('#red-ui-workspace-chart .red-ui-flow-node-group')];
    const g = groups.find((el) => el.__data__ && el.__data__.type === ${JSON.stringify(nativeType)} && el.getBoundingClientRect().width > 0);
    if (!g) return null;
    const gr = g.getBoundingClientRect();
    const outEl = g.querySelector('.red-ui-flow-port-output rect');
    const inEl = g.querySelector('.red-ui-flow-port-input rect');
    return {
      id: String(g.__data__.id),
      center: { x: Math.round(gr.left + gr.width / 2), y: Math.round(gr.top + gr.height / 2) },
      output: outEl ? inChart(outEl.getBoundingClientRect()) : null,
      input: inEl ? inChart(inEl.getBoundingClientRect()) : null,
    };
  })()`);
}

/**
 * 从 palette 把一个节点类型拖到画布坐标（真鼠标：move → down → 多次 move → up）。
 *
 * 上游约束（`palette.js` 的 `$(d).draggable({...})`，5.0.8）：
 *   1. `revert: 'invalid'` —— 落点不在 `#red-ui-workspace-chart` 上，jQuery UI 会把
 *      helper 弹回、drop 不触发；
 *   2. `dropEnabled = !(workspace locked)` —— 页签被锁时全局拖拽直接失效（本函数
 *      在按下前先查一次，锁着就如实返回 `dropped:false` + 原因）；
 *   3. jQuery UI 的 `_mouseDistanceMet` 要求至少 `distance=1` 的位移，且 drop 判定
 *      用的是**鼠标当前位置**与 droppable（`chart.droppable`，`tolerance:"intersect"`）
 *      的求交 —— 所以要发**至少两次** `mouseMove`（先中间点、再终点），最后一次
 *      必须真的落在画布可见区域内。
 *
 * 判据不用「drop 回调跑没跑」（无从观测），而是**画布模型**：
 * `RED.nodes.createCompleteNodeSet()` 里该类型节点数 +1。返回值里的
 * `before/after` 是两次计数的实际数字，旅程把它们原样落进证据。
 */
export async function dragPaletteNodeToCanvas(
  wc: WebContents,
  nodeType: string,
  target: { x: number; y: number },
): Promise<{
  dropped: boolean;
  detail?: string;
  before: number;
  after: number;
  paletteSelector: string | null;
  targetInChart: boolean;
  workspaceLocked: boolean;
}> {
  const countOf = async (): Promise<number> =>
    await js<number>(wc, `RED.nodes.createCompleteNodeSet().filter((n) => n.type === ${JSON.stringify(nodeType)}).length`);
  const before = await countOf();

  // 起点：palette 里这个类型的条目。条目在「通用」分类下，分类折叠时不可见 ——
  // 真用户会先展开分类再拖，这里用同一动作（点分类标题）把它展开。
  const selector = `.red-ui-palette-node[data-palette-type="${nodeType}"]`;
  const entryVisible = await js<boolean>(wc, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && el.offsetParent !== null;
  })()`);
  if (!entryVisible) {
    const cat = await js<{ x: number; y: number } | null>(wc, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const category = el.closest('.red-ui-palette-category');
      const header = category ? category.querySelector('.red-ui-palette-header') : null;
      if (!header) return null;
      const r = header.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (cat !== null) {
      await clickAt(wc, cat.x, cat.y);
      await sleep(500);
    }
  }

  const locked = await js<boolean>(wc, `(() => {
    const ws = RED.nodes.workspace(RED.workspaces.active());
    return !!(ws && ws.locked);
  })()`);
  const palette = await centerOf(wc, selector);
  if (palette === null) {
    return { dropped: false, before, after: before, paletteSelector: selector, targetInChart: false, workspaceLocked: locked, detail: `palette 里找不到可见的 ${nodeType} 条目` };
  }

  const geometry = await js<{ x: number; y: number; inChart: boolean } | null>(wc, `(() => {
    const chart = document.getElementById('red-ui-workspace-chart');
    if (!chart) return null;
    const r = chart.getBoundingClientRect();
    const x = ${target.x}, y = ${target.y};
    return { x, y, inChart: x >= r.left && x <= r.right && y >= r.top && y <= r.bottom };
  })()`);
  if (geometry === null || !geometry.inChart) {
    return { dropped: false, before, after: before, paletteSelector: selector, targetInChart: false, workspaceLocked: locked, detail: `落点 (${target.x},${target.y}) 不在画布可见区域内` };
  }
  if (locked) {
    return { dropped: false, before, after: before, paletteSelector: selector, targetInChart: true, workspaceLocked: true, detail: "当前页签被锁定，上游 dropEnabled=false，拖拽不会落成" };
  }

  // 真按下前先移过去（palette 条目有 hover 弹出框；jQuery UI 也需要 mousedown 在条目上）。
  // 中间点取「起点与终点的中点」：只需一次真实位移就满足 distance>=1，再发终点让
  // droppable 在最终位置上求交（tolerance:"intersect"）。
  const midX = Math.round((palette.x + target.x) / 2);
  const midY = Math.round((palette.y + target.y) / 2);
  const page = wc as unknown as EditorPage;
  page.sendInputEvent({ type: "mouseMove", x: palette.x, y: palette.y });
  await sleep(80);
  page.sendInputEvent({ type: "mouseDown", x: palette.x, y: palette.y, button: "left", clickCount: 1 });
  await sleep(120);
  page.sendInputEvent({ type: "mouseMove", x: midX, y: midY, button: "left" });
  await sleep(120);
  page.sendInputEvent({ type: "mouseMove", x: target.x, y: target.y, button: "left" });
  await sleep(150);
  // 落点再补一次 move（jQuery UI 的 ddmanager 在 mouseup 前按最后一次移动位置求交）。
  page.sendInputEvent({ type: "mouseMove", x: target.x + 1, y: target.y, button: "left" });
  await sleep(80);
  page.sendInputEvent({ type: "mouseUp", x: target.x + 1, y: target.y, button: "left", clickCount: 1 });

  // `revertDuration: 200` 之后 stop 才跑完；多等一拍再数。
  const landed = await waitFor(async () => (await countOf()) > before, 5_000, 150);
  const after = await countOf();
  return {
    dropped: landed && after > before,
    before, after, paletteSelector: selector, targetInChart: true, workspaceLocked: false,
    ...(landed ? {} : { detail: `拖拽后 ${nodeType} 节点数仍是 ${after}（before=${before}）—— 落点无效被弹回，或拖拽没有触发` }),
  };
}

/**
 * 用鼠标从一个节点的输出端口拖到另一个节点的输入端口，建立连线。
 *
 * 上游 `view.js`：端口上的 `mousedown` → `portMouseDown`（进入 `RED.state.JOINING`），
 * 随后 `canvasMouseMove` 更新拖拽线；落点的 `mouseup` → `portMouseUp` 才真正
 * `RED.nodes.addLink(link)`。**关键在于**：mouseup 必须命中**目标端口元素**
 * （`portMouseUpProxy` 绑在端口 rect 上），或者命中目标节点的 `nodeMouseUp`
 * （它内部再 `portMouseUp(d, direction, 0)`）。落在节点中间的空白处不算连线，
 * 会退化成「画布点了一下」。
 *
 * 本函数用**目标节点的输入端口 rect** 作为落点 —— 它同时是 `portMouseUp` 的直接
 * 绑定元素，语义上就是「连到这个输入」。
 *
 * 判据：`RED.nodes.filterLinks({ source: <src>, target: <dst> })` 里出现这条线；
 * 返回里的 `wires` 是 `createCompleteNodeSet()` 里 src 的 `wires[0]`，旅程据此断言。
 */
export async function dragNodeOutputToInput(
  wc: WebContents,
  sourceType: string,
  targetType: string,
): Promise<{
  linked: boolean;
  detail?: string;
  sourceId: string | null;
  targetId: string | null;
  sourcePort: { x: number; y: number; inChart: boolean } | null;
  targetPort: { x: number; y: number; inChart: boolean } | null;
  wires: string[] | null;
  linkCount: number;
}> {
  const src = await canvasNodePorts(wc, sourceType);
  const dst = await canvasNodePorts(wc, targetType);
  const empty = { linked: false, sourceId: src?.id ?? null, targetId: dst?.id ?? null, sourcePort: src?.output ?? null, targetPort: dst?.input ?? null, wires: null, linkCount: 0 };
  if (src === null) return { ...empty, detail: `画布上找不到 ${sourceType} 节点` };
  if (dst === null) return { ...empty, detail: `画布上找不到 ${targetType} 节点` };
  if (src.output === null) return { ...empty, detail: `${sourceType} 没有输出端口（outputs=0？）` };
  if (dst.input === null) return { ...empty, detail: `${targetType} 没有输入端口（inputs=0？）` };
  if (!src.output.inChart) return { ...empty, detail: `${sourceType} 的输出端口不在画布可见区域内（${src.output.x},${src.output.y}）` };
  if (!dst.input.inChart) return { ...empty, detail: `${targetType} 的输入端口不在画布可见区域内（${dst.input.x},${dst.input.y}）` };

  const page = wc as unknown as EditorPage;
  const start = src.output;
  const end = dst.input;
  const midX = Math.round((start.x + end.x) / 2);
  const midY = Math.round((start.y + end.y) / 2);
  page.sendInputEvent({ type: "mouseMove", x: start.x, y: start.y });
  await sleep(100);
  page.sendInputEvent({ type: "mouseDown", x: start.x, y: start.y, button: "left", clickCount: 1 });
  await sleep(150);
  // 两段位移：JOINING 模式靠 canvasMouseMove 维护拖拽线，静止不动时 d3 也不会
  // 在目标上触发 mouseup 的命中断言。移动本身也让 jQuery/d3 有机会更新 mouse_position。
  page.sendInputEvent({ type: "mouseMove", x: midX, y: midY, button: "left" });
  await sleep(120);
  page.sendInputEvent({ type: "mouseMove", x: end.x, y: end.y, button: "left" });
  await sleep(150);
  page.sendInputEvent({ type: "mouseUp", x: end.x, y: end.y, button: "left", clickCount: 1 });

  const linked = await waitFor(async () => await js<boolean>(wc, `(() => {
    const src = RED.nodes.node(${JSON.stringify(src.id)});
    const dst = RED.nodes.node(${JSON.stringify(dst.id)});
    if (!src || !dst) return false;
    return RED.nodes.filterLinks({ source: src, target: dst }).length > 0;
  })()`), 5_000, 150);

  const observed = await js<{ wires: string[] | null; linkCount: number }>(wc, `(() => {
    const src = RED.nodes.node(${JSON.stringify(src.id)});
    const dst = RED.nodes.node(${JSON.stringify(dst.id)});
    const set = RED.nodes.createCompleteNodeSet();
    const inSet = set.find((n) => n.id === ${JSON.stringify(src.id)});
    const wires = inSet && Array.isArray(inSet.wires) && Array.isArray(inSet.wires[0]) ? inSet.wires[0].slice() : null;
    const linkCount = (src && dst) ? RED.nodes.filterLinks({ source: src, target: dst }).length : 0;
    return { wires, linkCount };
  })()`);

  return {
    linked,
    sourceId: src.id, targetId: dst.id, sourcePort: start, targetPort: end,
    wires: observed.wires, linkCount: observed.linkCount,
    ...(linked ? {} : { detail: `从 ${sourceType} 输出拖到 ${targetType} 输入后没有出现连线（filterLinks=${observed.linkCount}, wires=${JSON.stringify(observed.wires)}）` }),
  };
}

/** 画布上某类型的**全部**节点（激活页签内），按出现顺序。 */
export async function canvasNodesOfType(wc: WebContents, nativeType: string): Promise<Array<{ id: string; x: number; y: number }>> {
  return await js<Array<{ id: string; x: number; y: number }>>(wc, `(() => {
    return [...document.querySelectorAll('#red-ui-workspace-chart .red-ui-flow-node-group')]
      .filter((el) => el.__data__ && el.__data__.type === ${JSON.stringify(nativeType)} && el.getBoundingClientRect().width > 0)
      .map((el) => ({ id: String(el.__data__.id), x: el.__data__.x, y: el.__data__.y }));
  })()`);
}

/* ─────────────────── W2 追加：运行一次 inject / 读 debug 侧栏 ─────────────────── */

/**
 * 给 inject 节点设一个**固定的字符串 payload**（`payloadType:"str"`）。
 *
 * 走的是编辑器「编辑节点」对话框里同一批字段：`node-input-payload`（typedInput）
 * + `node-input-payloadType`（隐藏的 typedInput 类型）。W1 拖出来的 inject 默认是
 * `payloadType:"date"`（每次注入是时间戳），断言「具体文本」要求固定值。
 *
 * **不点对话框**：与 `renameNodeViaEditor` 的取舍相反 —— 本函数只改模型字段并
 * `redraw()`。理由是 W1 已经证明「点托盘输入框拿不到焦点」是**编辑器视图焦点投递**
 * 的已知缺陷（`rename-node-via-tray` 的红，另一张卡负责），让 W2 依赖同一条坏路径
 * 会把「跑一次 inject」的验收押在一个已知红上。**这不是降级：** 本卡判的是「点击
 * inject 按钮 → debug 侧栏出现 payload」，inject 的 payload 只是**被测数据的输入**，
 * 不是被测动作。被测动作（点按钮）仍走真鼠标。
 *
 * 返回值把「模型里最终是什么」和「对话框文案对应的 label」都交出去，旅程原样落证据。
 */
export async function setInjectPayload(wc: WebContents, injectId: string, payload: string): Promise<{
  ok: boolean;
  payloadType: string | null;
  payloadValue: string | null;
  detail?: string;
}> {
  const read = async (): Promise<{ payloadType: string | null; payloadValue: string | null }> =>
    await js<{ payloadType: string | null; payloadValue: string | null }>(wc, `(() => {
      const n = RED.nodes.node(${JSON.stringify(injectId)});
      if (!n) return { payloadType: null, payloadValue: null };
      const prop = Array.isArray(n.props) ? n.props.find((p) => p.p === 'payload') : null;
      return {
        payloadType: prop ? String(prop.vt ?? '') : (typeof n.payloadType === 'string' ? n.payloadType : null),
        payloadValue: prop ? String(prop.v ?? '') : (typeof n.payload === 'string' ? n.payload : null),
      };
    })()`);
  const wrote = await js<boolean>(wc, `(() => {
    const n = RED.nodes.node(${JSON.stringify(injectId)});
    if (!n) return false;
    // 上游 inject 运行时读的是 props[]（见 20-inject.js 的 legacy 迁移），编辑器
    // 默认值同时维护 payload/payloadType 两个镜像字段。两边都写，保持与上游一致。
    if (!Array.isArray(n.props)) n.props = [];
    let prop = n.props.find((p) => p.p === 'payload');
    if (!prop) { prop = { p: 'payload' }; n.props.push(prop); }
    prop.v = ${JSON.stringify(payload)};
    prop.vt = 'str';
    n.payload = ${JSON.stringify(payload)};
    n.payloadType = 'str';
    n.changed = true;
    n.dirty = true;
    RED.nodes.dirty(true);
    RED.view.redraw(true);
    return true;
  })()`);
  if (!wrote) return { ok: false, payloadType: null, payloadValue: null, detail: `画布上找不到 inject 节点 ${injectId}` };
  const after = await read();
  const ok = after.payloadType === "str" && after.payloadValue === payload;
  return { ok, ...after, ...(ok ? {} : { detail: `写入后模型里是 type=${String(after.payloadType)} value=${String(after.payloadValue)}` }) };
}

/**
 * 打开 debug 侧栏（需要时真点页签按钮）并**清空已有消息**。
 *
 * 侧栏页签按钮的选择器是 `button[data-tab-id="debug"]`（`sidebar.js` 给每个
 * `RED.sidebar.addTab` 的按钮加的属性；zh-CN 下 aria-label 是「名称」，不能按文案匹配）。
 *
 * ## 为什么不「固定点一次/两次」来证明开关（2026-10-24 实测四次，每次都是真 Electron）
 *
 * `sidebar.js:255` 的页签点击是**条件性开关**：
 * `active === id && RED.menu.isSelected(menuToggle)` 才 `hideTab`，否则
 * `RED.sidebar.show(id)`。debug 是 right sidebar **bottom 段唯一**的页签、默认 active，
 * 全新编辑器里**直接可见**。实测：
 *  - 点 top 段的 info/help/context/config **不隐藏** debug（不同 section）；
 *  - 点已选中的 debug **没有隐藏**（菜单选中态与视觉可见性不同步，走了 show 分支）；
 *  - 点右侧栏的展开/收起按钮（`sidebar.js:507`）也**没有**让 debug 容器消失
 *    （`toggleSidebar` 收起的是 section 与整栏宽度，debug 容器本身的几何仍在；
 *    实测 `containerVisible` 保持 true）。
 *
 * 所以本函数**按真实初始状态决定动作**，并如实记账：
 *  - 一开始可见（全新编辑器的默认态）→ **不伪造点击**，记 `clickedToOpen:false`；
 *  - 不可见（用户之前收起过）→ 真点一次页签，断言它变为可见。
 *
 * **这不让后续判据变弱**：主判据（debug 侧栏出现 payload）要求消息元素
 * `visible:true`（同一套几何判定：rect>0 且 `offsetParent !== null`）。侧栏若被收起，
 * 那条断言必然红 —— 「打开」这一步若失真，主判据会把它抓出来。
 *
 * 另外断言 debug 面板**自己的工具条**（`#red-ui-sidebar-debug-clear`，debug 独有）
 * 在同一容器里可见 —— 「这块区域确实是 debug，而不是别的 tab」的面板级证据。
 */
export async function openDebugSidebarAndClear(wc: WebContents): Promise<{
  opened: boolean;
  clickedToOpen: boolean;
  visibleInitially: boolean;
  cleared: boolean;
  chromeVisible: boolean;
  messagesBefore: number;
  detail?: string;
}> {
  const probe = async (): Promise<{ exists: boolean; containerVisible: boolean; chromeVisible: boolean }> =>
    await js<{ exists: boolean; containerVisible: boolean; chromeVisible: boolean }>(wc, `(() => {
      const b = document.querySelector('button[data-tab-id="debug"]');
      const c = document.querySelector('#red-ui-sidebar-container .red-ui-debug-container');
      let containerVisible = false, chromeVisible = false;
      if (c) {
        const r = c.getBoundingClientRect();
        containerVisible = r.width > 40 && r.height > 40 && c.offsetParent !== null;
      }
      // debug 面板独有的工具条（清空按钮）；别的 tab 没有这个 id。
      const chrome = document.querySelector('#red-ui-sidebar-container #red-ui-sidebar-debug-clear');
      if (chrome) {
        const r = chrome.getBoundingClientRect();
        chromeVisible = r.width > 1 && r.height > 1 && chrome.offsetParent !== null;
      }
      return { exists: !!b || !!c, containerVisible, chromeVisible };
    })()`);
  const before = await js<number>(wc, `document.querySelectorAll('#red-ui-sidebar-container .red-ui-debug-msg').length`);
  const initial = await probe();
  const fail = (detail: string, clickedToOpen = false) => ({
    opened: false, clickedToOpen, visibleInitially: initial.containerVisible, cleared: false,
    chromeVisible: initial.chromeVisible, messagesBefore: before, detail,
  });
  if (!initial.exists) return fail("找不到 debug 侧栏按钮或容器");

  let clickedToOpen = false;
  if (!initial.containerVisible) {
    const btn = await centerOf(wc, 'button[data-tab-id="debug"]');
    if (btn === null) return fail("debug 页签按钮不可见，无法点击打开");
    await clickAt(wc, btn.x, btn.y);
    clickedToOpen = true;
    const shown = await waitFor(async () => (await probe()).containerVisible, 8_000);
    if (!shown) return fail("点击 debug 页签后内容区仍不可见", true);
  }
  const now = await probe();
  if (!now.chromeVisible) return fail("debug 容器可见，但它自己的工具条（#red-ui-sidebar-debug-clear）不在——这块区域可能不是 debug 面板", clickedToOpen);

  // 清空（编辑器自己的 action；与清空按钮同一个处理器 `21-debug.html:437`）。
  await js(wc, `(() => { RED.actions.invoke('core:clear-debug-messages'); return true; })()`);
  const cleared = await waitFor(async () => (await js<number>(wc, `document.querySelectorAll('#red-ui-sidebar-container .red-ui-debug-msg').length`)) === 0, 5_000);
  return {
    opened: true, clickedToOpen, visibleInitially: initial.containerVisible, cleared,
    chromeVisible: now.chromeVisible, messagesBefore: before,
    ...(cleared ? {} : { detail: "清空后 debug 列表里仍有旧消息" }),
  };
}

/**
 * 点 inject 节点左侧的**小方块按钮**（真鼠标）。
 *
 * 上游（`view.js:5653-5697`）：按钮是 `<g class="red-ui-flow-node-button">` 里的
 * `<rect class="red-ui-flow-node-button-button" width=16 height=18>`，`click` 绑在
 * 这个 rect 上 → `nodeButtonClicked` → inject 的 `button.onclick` → `doInject()`
 * （`POST inject/<id>` → 运行时 `node.receive()`）。**必须命中那个 rect**：
 * 点 `g.red-ui-flow-node-group` 的中心会落到节点主体（`nodeMouseUp`，只是选中）。
 *
 * 返回 `clicked`（真发出鼠标事件）与 `geometry`（按钮 rect 的实际矩形与是否在画布内），
 * **不断言触发成功** —— 触发成功由「debug 侧栏出现 payload」那一步判。
 */
export async function clickInjectNodeButton(wc: WebContents, injectId: string): Promise<{
  clicked: boolean;
  buttonRect: { x: number; y: number; w: number; h: number; inChart: boolean } | null;
  shape: string;
  detail?: string;
}> {
  const found = await js<{ x: number; y: number; w: number; h: number; inChart: boolean; shape: string } | null>(wc, `(() => {
    const g = [...document.querySelectorAll('#red-ui-workspace-chart .red-ui-flow-node-group')]
      .find((el) => el.__data__ && el.__data__.id === ${JSON.stringify(injectId)});
    if (!g) return null;
    // 上游两种画法：常规节点是 rect，link 型节点是 circle。inject 是 rect，但按
    // class 取而不是按标签取 —— 上游改形状时这里不会静默取空。
    const shape = (g.querySelector('circle.red-ui-flow-node-button-button') ? 'circle'
      : (g.querySelector('rect.red-ui-flow-node-button-button') ? 'rect' : 'none'));
    const b = g.querySelector('.red-ui-flow-node-button-button');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const chart = document.getElementById('red-ui-workspace-chart');
    const cr = chart ? chart.getBoundingClientRect() : null;
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const inChart = !!cr && x >= cr.left && x <= cr.right && y >= cr.top && y <= cr.bottom;
    return { x, y, w: Math.round(r.width), h: Math.round(r.height), inChart, shape };
  })()`);
  if (found === null) return { clicked: false, buttonRect: null, shape: "none", detail: `inject 节点 ${injectId} 没有可见的按钮 rect` };
  if (!found.inChart) return { clicked: false, buttonRect: found, shape: found.shape, detail: `按钮中心 (${found.x},${found.y}) 不在画布可见区域内` };
  const page = wc as unknown as EditorPage;
  // 真用户手势：移过去 → 按下 → 松开（`nodeButtonClicked` 绑在 click 上，d3 的
  // click 由 mousedown+mouseup 同点产生；这里 mouseDown/Up 用同一坐标）。
  page.sendInputEvent({ type: "mouseMove", x: found.x, y: found.y });
  await sleep(100);
  page.sendInputEvent({ type: "mouseDown", x: found.x, y: found.y, button: "left", clickCount: 1 });
  await sleep(80);
  page.sendInputEvent({ type: "mouseUp", x: found.x, y: found.y, button: "left", clickCount: 1 });
  return { clicked: true, buttonRect: found, shape: found.shape };
}

/**
 * 读 debug 侧栏里的消息（只读 DOM 事实）。
 *
 * `#red-ui-sidebar-container` 在 5.0.8 里是**两个**侧栏（左右各一个）的共同前缀；
 * 这里限定到 `#red-ui-sidebar-container` 之下的 `.red-ui-debug-msg`，而不是全页
 * `.red-ui-debug-msg` —— 后者会把「调试窗口」弹窗（`#red-ui-sidebar-debug-open`
 * 开的新窗口 / 表格视图）也算进来。
 *
 * 每条消息交出：`.red-ui-debug-msg-payload` 的**文本**（字符串 payload 会被渲染成
 * 带引号的 `"w2-probe"`，见 `utils.js:541` 的 `'"'+formatString(...)+'"'`）、
 * 来源节点名（`.red-ui-debug-msg-name`）、以及整条消息的 class（含
 * `red-ui-debug-msg-flow-<tabId>`，用来判「它出现在当前流程而不是别的流程」）。
 */
export async function readDebugMessages(wc: WebContents): Promise<{
  total: number;
  visible: number;
  messages: Array<{ payloadText: string | null; sourceName: string | null; flowClass: string | null; visible: boolean }>;
}> {
  return await js<{
    total: number;
    visible: number;
    messages: Array<{ payloadText: string | null; sourceName: string | null; flowClass: string | null; visible: boolean }>;
  }>(wc, `(() => {
    const nodes = [...document.querySelectorAll('#red-ui-sidebar-container .red-ui-debug-msg')];
    const messages = nodes.map((el) => {
      const payloadEl = el.querySelector('.red-ui-debug-msg-payload');
      const nameEl = el.querySelector('.red-ui-debug-msg-name');
      const cls = el.className || '';
      const m = /(^|\\s)red-ui-debug-msg-flow-(\\S+)/.exec(cls);
      const r = el.getBoundingClientRect();
      return {
        payloadText: payloadEl ? (payloadEl.textContent || '').trim() : null,
        sourceName: nameEl ? (nameEl.textContent || '').trim() : null,
        flowClass: m ? m[2] : null,
        visible: r.width > 0 && r.height > 0 && el.offsetParent !== null,
      };
    });
    return { total: messages.length, visible: messages.filter((m) => m.visible).length, messages };
  })()`);
}

/**
 * 读「通知条」（`#red-ui-notifications .red-ui-notification`）的文本。
 *
 * inject 的按钮回调 `doInject()` 成功后弹 `成功注入: <label>`（zh-CN
 * `messages.json:84`），失败弹 `节点未部署` 等。**这是旁证**：证明 POST
 * `inject/<id>` 真的被运行时接受（200），而不是「点了但 HTTP 失败」。
 * 它**不**替代「debug 侧栏有 payload」那条主判据 —— 通知只说明运行时收到了注入请求，
 * 不说明这条消息走到了 debug 节点。
 */
export async function readNotifications(wc: WebContents): Promise<{
  texts: string[];
  successCount: number;
  errorCount: number;
}> {
  return await js<{ texts: string[]; successCount: number; errorCount: number }>(wc, `(() => {
    const els = [...document.querySelectorAll('#red-ui-notifications .red-ui-notification')];
    const texts = els.map((el) => (el.textContent || '').trim());
    return {
      texts,
      successCount: els.filter((el) => el.classList.contains('red-ui-notification-success')).length,
      errorCount: els.filter((el) => el.classList.contains('red-ui-notification-error')).length,
    };
  })()`);
}

/* ─────────────────── W5：部署观测探针（三层信号，页面内） ─────────────────── */

/**
 * 部署观测探针 —— 在**页面内**同时挂三个互不替代的信号源。
 *
 *  | 层 | 上游事实 | 失败长什么样 |
 *  |---|---|---|
 *  | 网络 | `deploy.js` 的 `save()` 发 `POST flows`（jQuery `$.ajax` → `XMLHttpRequest`） | 连接被拒时 `status = 0`、`responseText = ""` |
 *  | 事件 | 成功回调里 `RED.events.emit("deploy")`（`ui/deploy.js:674`） | **失败回调从不发** —— 「有事件」只在成功路径上成立 |
 *  | DOM | `#red-ui-notifications` 的 `red-ui-notification-success/error` | 失败弹 `deploy.deployFailed` + `deploy.errors.noResponse`（zh-CN「部署失败: 服务器没有响应」） |
 *
 * **为什么需要探针**：`flows.json` 在更早的 `loadWorkflowIntoNative`（
 * `nativeLibraryLoad.ts` 的 `replaceNativeCanvas`）里就被宿主写过。编辑器点部署
 * 成不成功**完全不影响这份文件** —— 只读它无法证明「这次部署被服务器接受」。
 *
 * **通知必须抢在它消失前记录**：`notifications.js` 的 `setTimeout(n.close, timeout||5000)`
 * 让一条通知只活 5 秒，轮询可能错过；所以这里用 `MutationObserver` 记录它出现的
 * **那一刻**（含 5 秒内闪过的失败通知）。
 *
 * 「部署请求」的口径由 {@link readDeployProbe} 统一（POST 且路径以 `/flows` 结尾）——
 * `flows/state`（启停流程）与 `flow/:id`（单流程操作）都不算部署。
 */
export async function installDeployProbe(wc: WebContents): Promise<{ installed: boolean; reused: boolean; reason?: string }> {
  return await js<{ installed: boolean; reused: boolean; reason?: string }>(wc, `(() => {
    try {
      if (window.__mcodeDeployProbe) return { installed: true, reused: true };
      if (typeof RED === 'undefined' || !RED.events) {
        return { installed: false, reused: false, reason: 'RED.events 不可用（编辑器页还没就绪）' };
      }
      const XHR = window.XMLHttpRequest;
      if (!XHR || !XHR.prototype) return { installed: false, reused: false, reason: 'XMLHttpRequest 不可用' };
      const probe = { xhr: [], fetch: [], deployEvents: [], notifications: [], observer: null };
      const rawOpen = XHR.prototype.open;
      const rawSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        try { this.__mcodeDeployCall = { method: String(method || 'GET').toUpperCase(), url: String(url || '') }; }
        catch (e) { /* 记录失败不影响请求本身 */ }
        return rawOpen.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        try {
          const call = this.__mcodeDeployCall;
          if (call) {
            const xhr = this;
            // 请求体是「编辑器这一刻真的要部署的那张图」—— 部署成功时用它核对
            // 内容，比读 flows.json 强：文件可能是更早的装载写下的（那正是本卡缺陷）。
            let body = '';
            try {
              const raw = arguments[0];
              body = typeof raw === 'string' ? raw : (raw === undefined || raw === null ? '' : '[non-string body]');
            } catch (e) { body = '[unreadable body]'; }
            xhr.addEventListener('loadend', function () {
              probe.xhr.push({
                method: call.method,
                url: call.url,
                status: Number(xhr.status) || 0,
                responseText: String(xhr.responseText || '').slice(0, 300),
                body: body.slice(0, 200000),
                at: Date.now(),
              });
            });
          }
        } catch (e) { /* 探针只记录，不改写请求 */ }
        return rawSend.apply(this, arguments);
      };
      if (typeof window.fetch === 'function') {
        const rawFetch = window.fetch;
        window.fetch = function (input, init) {
          const url = typeof input === 'string' ? input : ((input && input.url) || '');
          const method = String((init && init.method) || 'GET').toUpperCase();
          const pending = rawFetch.apply(this, arguments);
          try {
            pending.then(function (res) {
              probe.fetch.push({ method: method, url: String(url), status: res.status, responseText: '', body: '', at: Date.now() });
            }, function (err) {
              probe.fetch.push({ method: method, url: String(url), status: 0, responseText: String((err && err.message) || err || ''), body: '', at: Date.now() });
            });
          } catch (e) { /* 同 XHR：只记录 */ }
          return pending;
        };
      }
      try {
        RED.events.on('deploy', function () { probe.deployEvents.push({ at: Date.now() }); });
      } catch (e) {
        return { installed: false, reused: false, reason: '挂 deploy 事件失败：' + String(e) };
      }
      const host = document.getElementById('red-ui-notifications');
      if (host) {
        const record = function () {
          const els = host.querySelectorAll('.red-ui-notification');
          const baseline = probe.existingNotificationIds || [];
          for (let i = 0; i < els.length; i += 1) {
            const el = els[i];
            if (!el.id) continue;
            // 点击前就存在的通知不算本次部署的因果（见 resetDeployProbe）。
            let preexisting = false;
            for (let k = 0; k < baseline.length; k += 1) {
              if (baseline[k] === el.id) { preexisting = true; break; }
            }
            if (preexisting) continue;
            let seen = false;
            for (let j = 0; j < probe.notifications.length; j += 1) {
              if (probe.notifications[j].id === el.id) { seen = true; break; }
            }
            if (seen) continue;
            probe.notifications.push({
              id: el.id,
              text: String(el.textContent || '').trim().slice(0, 300),
              cls: String(el.className || ''),
              at: Date.now(),
            });
          }
        };
        record();
        probe.observer = new MutationObserver(record);
        probe.observer.observe(host, { childList: true, subtree: true });
      }
      window.__mcodeDeployProbe = probe;
      return { installed: true, reused: false };
    } catch (e) {
      return { installed: false, reused: false, reason: String((e && e.message) || e) };
    }
  })()`);
}

/** 清空探针已记录的事件（监听器保留），把观测窗口收窄到「这一次点击」。
 *
 * 同时记下**此刻已经存在**的通知 id：点击后 DOM 一变动，`MutationObserver` 会把
 * 现存通知重新扫进来（`record()` 是全量扫描）。判据只把**新出现的**通知算成本次
 * 部署的因果，旧通知（例如上一轮残留的失败提示）不参与判定。
 * Node-RED 的通知 id 是页面内单调递增的 `red-ui-notification-<n>`，不会复用。 */
export async function resetDeployProbe(wc: WebContents): Promise<boolean> {
  return await js<boolean>(wc, `(() => {
    const p = window.__mcodeDeployProbe;
    if (!p) return false;
    p.xhr = [];
    p.fetch = [];
    p.deployEvents = [];
    p.notifications = [];
    const ids = [];
    const host = document.getElementById('red-ui-notifications');
    if (host) {
      const els = host.querySelectorAll('.red-ui-notification');
      for (let i = 0; i < els.length; i += 1) if (els[i].id) ids.push(els[i].id);
    }
    p.existingNotificationIds = ids;
    return true;
  })()`);
}

/** 读探针并挑出「部署请求」。
 *
 * 判据是**方法 + 路径**，不是「有没有失败通知」：`deploy.js` 的 `save()` 用
 * `url: "flows"`（相对页面根），而 `stopStartFlows()` 用 `flows/state`、
 * 单流程操作走 `/flow/<id>`。三者都在同一个页面上发生，只用「有 XHR」会把
 * 启停流程也算成部署。
 *
 * `body` 是点击那一刻编辑器提交的图（`{"flows":[...],"rev":N}`）—— 部署成功时
 * 用它核对「提交的图 == 要部署的图」，失败时用它证明「请求确实带了内容，只是
 * 服务器没接」。
 */
export async function readDeployProbe(wc: WebContents): Promise<{
  deployRequests: Array<{ method: string; url: string; status: number; responseText: string; body: string; at: number }>;
  otherRequests: number;
  deployEvents: number;
  notifications: Array<{ id: string; text: string; cls: string; at: number }>;
}> {
  return await js(wc, `(() => {
    const p = window.__mcodeDeployProbe;
    if (!p) return { deployRequests: [], otherRequests: 0, deployEvents: 0, notifications: [] };
    const all = p.xhr.concat(p.fetch);
    const isDeploy = function (r) {
      if (r.method !== 'POST') return false;
      let path = String(r.url || '');
      const q = path.indexOf('?');
      if (q >= 0) path = path.slice(0, q);
      const hash = path.indexOf('#');
      if (hash >= 0) path = path.slice(0, hash);
      if (path === 'flows' || path === '/flows') return true;
      return path.length > 6 && path.slice(-6) === '/flows';
    };
    return {
      deployRequests: all.filter(isDeploy),
      otherRequests: all.filter(function (r) { return !isDeploy(r); }).length,
      deployEvents: p.deployEvents.length,
      notifications: p.notifications.slice(),
    };
  })()`);
}

/**
 * 从探针的部署请求体里抽出节点名（`{"flows":[{"type":"mcode-agent","name":"…"}, …]}`）。
 *
 * 只返回能解析的请求体；解析不了返回 `null` —— 调用方必须把「解析不了」和
 * 「名字不匹配」分开记，它们意味着不同的失败。
 */
export function deployRequestNames(body: string): { ok: boolean; names: string[]; types: string[]; parseError?: string } {
  try {
    const parsed = JSON.parse(body) as unknown;
    const flows = Array.isArray(parsed)
      ? parsed
      : (parsed !== null && typeof parsed === "object" ? (parsed as { flows?: unknown }).flows : undefined);
    if (!Array.isArray(flows)) return { ok: false, names: [], types: [], parseError: "请求体里没有 flows 数组" };
    const nodes = flows.filter((n): n is Record<string, unknown> => n !== null && typeof n === "object");
    return {
      ok: true,
      names: nodes.filter((n) => typeof n["name"] === "string").map((n) => n["name"] as string),
      types: nodes.filter((n) => typeof n["type"] === "string").map((n) => n["type"] as string),
    };
  } catch (err) {
    return { ok: false, names: [], types: [], parseError: err instanceof Error ? err.message : String(err) };
  }
}
