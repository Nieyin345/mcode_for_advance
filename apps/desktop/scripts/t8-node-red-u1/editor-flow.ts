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
