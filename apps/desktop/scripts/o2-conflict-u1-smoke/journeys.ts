/**
 * O2 —— 六格式的**保存冲突**旅程（每个格式一条，不抽样）。
 *
 * ## 每条旅程的形状（与卡 §三 判据逐条对应）
 *
 * ```
 * 打开（记录打开时版本）
 *   ├─ 阶段 A（负控 #5）：页面里真编辑一处 → 保存 → 必须成功
 *   │     · 主进程回包 ok === true
 *   │     · 盘上字节真的变了（不是「回包成功但没写」）
 *   │     · 页面出现了「已保存」（成功探针自身的正控：证明探针不是恒假）
 *   └─ 阶段 B（冲突 4a/4b/4c）：再编辑一处 → 外部进程改盘 → 保存
 *         · 4a 主进程回包是**版本冲突**（证据来自 IPC 回包，不是 DOM）
 *         · 4b 盘上**逐字节**仍是外部内容
 *         · 4c 页面上真的出现了冲突提示（可见元素）
 * ```
 *
 * ## 为什么三条判据的证据源必须分开
 *
 * 卡 §五变异 2：删掉冲突提示的 DOM 元素时，**只有 4c 该红，4a/4b 必须仍绿**。
 * 如果 4a 从 DOM 反推（「看到失败字样 = 保存被拒」），4a 与 4c 就是同一件事。
 * 所以：
 *  - 4a 只读 `o2-conflict-u1-smoke/ipc-recorder.ts` 记下的**主进程回包**；
 *  - 4b 只读磁盘 sha256；
 *  - 4c 只读页面 DOM（`lib.ts` 的 `noticeExpression`）。
 *
 * ## 三种触发形态（六格式的保存入口本来就不同，见卡 §二）
 *
 *  - docs/pdf/markdown/html：页面自己的 Ctrl+S（`sendInputEvent`，与用户按键同路径）；
 *  - slides：页面 QAT「保存」按钮；按钮不可点（例如页面认为不脏）时退回它
 *    `onSave` 调用的**同一个桥** `slidesApi.save()`（T7 记录过这条边界）；
 *  - sheets：QAT「保存」按钮（sheets 页面没有 Ctrl+S handler，快捷键归 shell 菜单）。
 *
 * ## 预期红（四个格式）是**结论**，不是失败
 *
 * `expectations.ts` 记了每个格式的源码出处。docs/sheets 在生产链上有版本判据，
 * 4a/4b 应绿；slides/pdf/markdown/html 没有，4a/4b/4c 会红 —— 那些旅程标
 * `expect: "fail"` 且 `failBecause` 要求失败**落在 4a 且原因是「保存其实成功了」**。
 * 这样「红了但红错地方」（例如保存因坏档失败）会变成 unexpected failure。
 */
import { defineU1Journey, step } from "../electron-u1/driver/index.js";
import { editorSetup, invokeAs, js, waitFor } from "../t7-genoffice-u1/editor-flow.js";
import { UNIQUE } from "../t7-genoffice-u1/fixtures.js";
import type { FixturePaths } from "../t7-genoffice-u1/fixtures.js";
import type { GenofficeHarness } from "../t7-genoffice-u1/harness.js";
import type { WebContents } from "electron";

import { EXPECTATIONS } from "./expectations.js";
import {
  clickInPage,
  injectHideNotice,
  judgeConflictReply,
  mutationMode,
  pollUntil,
  sha256Of,
  triggerAndObserve,
  wcOf,
  writeExternalEdit,
  type EditorKind,
  type O2Runtime,
  type SaveObservation,
} from "./lib.js";

const EDITED_1 = "O2-EDIT-ONE-5b1e9c";
const EDITED_2 = "O2-EDIT-TWO-8d2f40";
const EXTERNAL_TEXT = "O2-EXTERNAL-TEXT-c41a77";

interface Snapshot {
  baselineSha: string;
  negativePreSha: string;
}

function pressKey(wc: WebContents, keyCode: string, modifiers: Array<"control" | "shift" | "alt"> = []): void {
  wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
}

/* ───────────────────────────── 打开与就绪 ───────────────────────────── */

const READY_SELECTORS: Record<Exclude<EditorKind, "docs">, string> = {
  sheets: '[data-u-comp="defined-name"] input',
  slides: "[class*='thumb']",
  pdf: ".app",
  markdown: ".doc-editor",
  html: ".cm-content",
};

async function openAndWaitReady(rt: O2Runtime): Promise<{ ok: boolean; observed?: unknown; detail?: string }> {
  const wc = wcOf(rt);
  if (wc === null) return { ok: false, detail: "视图 webContents 不存在" };
  if (rt.kind === "docs") {
    const reply = (await invokeAs(wc, rt.harness, "documentView:openPath", {
      docId: rt.docId,
      filePath: rt.fixtures.docs,
    })) as { ok?: boolean; reason?: string };
    if (reply.ok !== true) return { ok: false, observed: reply, detail: `openPath 被拒：${reply.reason ?? ""}` };
  }
  const session = await waitFor(async () => rt.harness.host.sessionFor(rt.docId), 30_000, 200);
  if (session === null) return { ok: false, detail: "30s 内宿主没有建立打开会话" };
  const selector = rt.kind === "docs" ? ".ProseMirror" : READY_SELECTORS[rt.kind];
  const ready = await waitFor(async () => await js<boolean>(wc, `!!document.querySelector(${JSON.stringify(selector)})`), 40_000, 200);
  if (ready !== true) return { ok: false, observed: { selector }, detail: `40s 内页面没有就绪标记 ${selector}` };
  // pdf 的「就绪」比 `.app` 挂载深一层：pdf.js worker 首启（本机实测偶发 >40s，
  // T7 的 pdf 旅程为此留了 reload 兜底）之前，ribbon 还在「正在打开…」。
  // 编辑动作是点 ribbon 的「页面」tab —— 没就绪时它不存在，会在 negative-edit
  // 里报「找不到页面 tab」，看起来像 UI 变了（实际是没等到）。
  if (rt.kind === "pdf") {
    const renderProbe = `(() => {
      const spans = [...document.querySelectorAll('.textLayer span')];
      return spans.length > 0 && document.querySelectorAll('.pdf-page, .page').length > 0;
    })()`;
    // pdf.js 的首启 worker 预热在繁忙机器上偶发 >40s（T7 的 pdf 旅程记录了同一个
    // 现象并给了 reload 兜底）。
    //
    // ⚠️ 这里的等待上限受 `electron-u1` 宿主的**进程级超时**约束（`electron-host.cjs`
    // 的 150s，run `app.exit(97)`）—— 超了整趟会以「没有写出 journey-result.json」
    // 收场，连失败在哪一步都留不下。所以预算必须留在 150s 内：40s + 一轮 45s
    // reload，最坏 ~90s，剩下 ~60s 给编辑/保存/重读。宁可**明确报「没渲染出来」**，
    // 也不要撞在宿主的全局超时上丢掉证据。
    let rendered = await pollUntil(async () => await js<boolean>(wc, renderProbe), 40_000, 300);
    if (rendered !== true) {
      wc.reload();
      await new Promise((r) => setTimeout(r, 800));
      rendered = await pollUntil(async () => await js<boolean>(wc, renderProbe), 45_000, 300);
    }
    if (rendered !== true) {
      return { ok: false, observed: { reloads: 1 }, detail: "pdf 页 40s + 一次 reload（45s）后仍未渲染出页面" };
    }
  }
  return { ok: true, observed: { filePath: session.filePath, revision: await session.revision } };
}

/* ───────────────────────────── 页面内编辑 ───────────────────────────── */

/** ProseMirror（docs / markdown）：把含 `find` 的文本节点替换为 `replace`。 */
async function editProseMirror(wc: WebContents, selector: string, find: string, replace: string): Promise<{ ok: boolean; detail?: string; observed?: unknown }> {
  const result = await js<{ ok: boolean; reason?: string }>(wc, `(() => {
    const pm = document.querySelector(${JSON.stringify(selector)});
    const editor = pm && pm.editor;
    if (!editor) return { ok: false, reason: 'ProseMirror editor handle 不可用' };
    const doc = editor.state.doc;
    let from = -1, to = -1;
    doc.descendants((node, pos) => {
      if (from >= 0) return false;
      if (node.isText && node.text && node.text.includes(${JSON.stringify(find)})) {
        const idx = node.text.indexOf(${JSON.stringify(find)});
        from = pos + idx; to = from + ${JSON.stringify(find)}.length;
        return false;
      }
      return true;
    });
    if (from < 0) return { ok: false, reason: '文档模型里找不到锚点文本 ' + ${JSON.stringify(find)} };
    pm.focus();
    editor.commands.setTextSelection({ from, to });
    editor.commands.insertContent(${JSON.stringify(replace)});
    return { ok: true };
  })()`);
  if (result.ok !== true) return { ok: false, detail: result.reason ?? "ProseMirror 编辑失败", observed: result };
  // 编辑真的进了页面模型：DOM 里读回新文本（不是「调了 API 就算」）。
  const seen = await waitFor(async () => {
    const text = await js<string>(wc, `(document.querySelector(${JSON.stringify(selector)})?.innerText) ?? ''`);
    return text.includes(replace) ? text : null;
  }, 10_000, 150);
  return seen === null
    ? { ok: false, detail: `编辑后 10s 内 DOM 里没有 ${replace}`, observed: { find, replace } }
    : { ok: true, observed: { domSlice: seen.slice(0, 160) } };
}

/** sheets：名称框选 range → Return → 点网格 → 真键入（T7 已验证的编排）。
 *
 *  ⚠️ 第一版在第二次编辑时失败过：负控保存成功后，vendor 会**换一个会话重开工作簿**
 *  （`reopenCarryingLateEdits`），状态栏此时是「正在流式加载 …」。在这个窗口里键入
 *  的字符不进 journal，QAT 保存按钮保持 disabled —— 冲突阶段根本发不出保存。
 *  所以这里先等「重开完成」（保存按钮回到 disabled：pendingEdits = 0），键入后
 *  再等「journal 有改动」（保存按钮变可用）。**键入动作完成 ≠ 改动进了工作簿**。 */
async function editSheetCell(rt: O2Runtime, range: string, text: string): Promise<{ ok: boolean; detail?: string; observed?: unknown }> {
  const wc = wcOf(rt);
  if (wc === null) return { ok: false, detail: "sheets 视图 webContents 不存在" };
  const saveButton = `(() => {
    const btn = [...document.querySelectorAll('.qa-btn')].find((b) => /保存|Save/.test(b.getAttribute('aria-label') || ''));
    return btn ? btn.hasAttribute('disabled') : null;
  })()`;
  // 稳定态 = 「没有待保存改动」（保存按钮 disabled）。**不要**等状态栏的
  // 「正在流式加载 …」消失：那条消息在会话切换/重开工作簿之后不会被清掉
  // （实测它挂 90s 以上）。它出现之后键入不进 journal —— 这个由下面
  // 「键入后保存按钮必须变可用」的判据做**整体重试**兜住，不在这里猜。
  //
  // ⚠️ 已知残余不稳定（如实记录）：**整跑六条时** sheets 的第二次编辑偶发
  //   失败（单跑连跑三次全绿；整跑曾见到 `stage:"type"`、`boxValue:"B1"`）。
  //   根因是保存后 vendor 重开工作簿 + Univer 重建 DOM 与键入之间的竞争，
  //   本套件用「整体重试 5 次」压低频率、但没有根除。失败时证据里会写明
  //   卡在哪一步（select/type）与当时的选择框/状态栏 —— 见到偶发红先单跑
  //   这一条复核，不要把它读成「冲突判据失效」。
  // 「保存按钮 disabled」**不足以**说明工作簿就绪：还没打开完（状态栏
  // 「正在打开工作簿…」）时它同样是 disabled，而那一刻键入会被吞掉
  // （实测 attempt=5 stage=type boxValue=A1，而 status=正在打开工作簿…）。
  // 所以稳定态用**正向标记**：工作簿已开（工作表标签存在、名称框显示真实
  // 单元格引用）**且**没有待保存改动。
  const settled = await pollUntil(async () => {
    const state = await js<{ disabled: boolean | null; box: string; tab: boolean }>(wc, `(() => {
      const btn = [...document.querySelectorAll('.qa-btn')].find((b) => /保存|Save/.test(b.getAttribute('aria-label') || ''));
      const box = (document.querySelector('[data-u-comp="defined-name"] input')?.value) || '';
      return {
        disabled: btn ? btn.hasAttribute('disabled') : null,
        box,
        tab: !!document.querySelector('[data-u-comp="slide-tab-item"]'),
      };
    })()`);
    return state.disabled === true && state.tab && /^[A-Z]+\d+$/i.test(state.box.trim()) ? state : null;
  }, 90_000, 300);
  if (settled === null) {
    const state = await js<Record<string, unknown>>(wc, `(() => ({
      saveDisabled: ${saveButton},
      status: (document.querySelector('.status-msg')?.textContent || '').slice(0, 160),
      box: (document.querySelector('[data-u-comp="defined-name"] input')?.value) || '',
    }))()`);
    return { ok: false, detail: "90s 内工作簿没有落到就绪态（工作簿已开且无待保存改动）", observed: state };
  }
  // 整段编辑（选 range → 点网格 → 键入 → 提交）**可重试**。
  // 实测两处会失败且各自只在某些时机出现：重开工作簿会重建名称框（键入落在被
  // 替换掉的旧元素上），以及点击画布后 Univer 没有进入单元格编辑（字符没进
  // journal）。两次失败都表现为「保存按钮不亮」—— 用这个状态做整体重试，
  // 不在内部逐段猜。
  let lastState: Record<string, unknown> = {};
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    // 1) 选 range：真键盘（焦点 + insertText + Return）—— 与 T7 已验证的编排一致。
    await js(wc, `(() => {
      const el = document.querySelector('[data-u-comp="defined-name"] input');
      if (!el) return false;
      el.focus();
      el.select();
      return true;
    })()`);
    wc.insertText(range);
    pressKey(wc, "Return");
    // 提交后把焦点交还页面（名称框失焦，Univer 才接得住后续键盘）。
    await js(wc, `(() => { document.querySelector('[data-u-comp="defined-name"] input')?.blur(); return true; })()`);
    const selected = await waitFor(async () => {
      const value = await js<string>(wc, `(document.querySelector('[data-u-comp="defined-name"] input')?.value) ?? ''`);
      return new RegExp(`^${range}$`, "i").test(value) ? value : null;
    }, 6_000, 150);
    if (selected === null) { lastState = { attempt, stage: "select", boxValue: await js<string>(wc, `(document.querySelector('[data-u-comp="defined-name"] input')?.value) ?? ''`) }; await new Promise((r) => setTimeout(r, 500)); continue; }
    // 2) 点画布让 Univer 接管键盘（点击位置决定落格，range 只用于证据）。
    //    点**当前选中单元格**的矩形中心（不是固定偏移：固定 left+120 在列宽变化后
    //    会落到 B 列 —— 实测 boxValue=B1 —— 于是 A2 一直没被写，保存按钮不亮）。
    const point = await js<{ x: number; y: number }>(wc, `(() => {
      const el = document.getElementById('univer-container');
      const r = el.getBoundingClientRect();
      const sel = document.querySelector('.univer-sheet-selection, [class*="selection"]');
      const sr = sel && sel.getBoundingClientRect();
      if (sr && sr.width > 4 && sr.height > 4 && sr.top > r.top && sr.top < r.bottom) {
        return { x: Math.round(sr.left + sr.width / 2), y: Math.round(sr.top + sr.height / 2) };
      }
      return { x: Math.round(r.left + 120), y: Math.round(r.top + 60) };
    })()`);
    wc.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
    wc.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
    // 点击那一帧 Univer 可能把「下一个字符」当成进入编辑的首击（T7 实测吞 1–2 个字符）。
    await new Promise((r) => setTimeout(r, 450));
    for (const ch of text) {
      wc.sendInputEvent({ type: "char", keyCode: ch });
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 250));
    pressKey(wc, "Return");
    // 3) 改动真的进了 journal：QAT 保存按钮从 disabled 变可用
    //    （`canSave={pendingEdits > 0 || unsavedNew}`，`App.tsx`）。
    const journaled = await pollUntil(async () => {
      const disabled = await js<boolean | null>(wc, saveButton);
      return disabled === false ? true : null;
    }, 12_000, 200);
    const boxNow = await js<string>(wc, `(document.querySelector('[data-u-comp="defined-name"] input')?.value) ?? ''`);
    if (journaled === true) return { ok: true, observed: { range, typed: text, landedIn: boxNow, attempt } };
    lastState = {
      attempt,
      stage: "type",
      boxValue: boxNow,
      status: await js<string>(wc, `(document.querySelector('.status-msg')?.textContent || '').slice(0, 160)`),
      // 诊断：页面上有哪些 Univer 组件、当前编辑器在不在、公式栏内容是什么。
      dom: await js<Record<string, unknown>>(wc, `(() => {
        const comps = [...document.querySelectorAll('[data-u-comp]')].map((el) => el.getAttribute('data-u-comp'));
        const bar = document.querySelector('[data-u-comp="formula-bar"]');
        const editor = bar && bar.querySelector('.univer-editor, [contenteditable="true"], textarea');
        return {
          comps: comps.slice(0, 40),
          hasEditor: !!editor,
          editorText: ((editor && (editor.innerText ?? editor.value)) || '').slice(0, 80),
          active: (document.activeElement && (document.activeElement.className || document.activeElement.tagName) || '').slice(0, 80),
        };
      })()`),
    };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, detail: `五次尝试后改动仍没有进 journal（保存按钮一直 disabled）`, observed: lastState };
}

/** slides：经页面自己的 `slidesApi.editText`（与 QAT 保存同一个桥）。
 *  `find` 是**这一轮**渲染树里还在的文本锚点：第一轮用夹具的唯一文本
 *  （`T7-…`），第一轮保存后它已被替换成 `EDITED_1`，第二轮必须按新文本找
 *  （第一版固定写 `'T7-'`，第二轮直接「渲染树里找不到节点」）。 */
async function editSlideText(rt: O2Runtime, find: string, replace: string): Promise<{ ok: boolean; detail?: string; observed?: unknown }> {
  const wc = wcOf(rt);
  if (wc === null) return { ok: false, detail: "slides 视图 webContents 不存在" };
  const result = await js<{ ok: boolean; reason?: string; target?: unknown }>(wc, `(async () => {
    try {
      const api = window.slidesApi;
      if (!api || typeof api.editText !== 'function' || typeof api.consumePendingOpen !== 'function') {
        return { ok: false, reason: 'slidesApi 缺 editText/consumePendingOpen' };
      }
      const tree = await api.consumePendingOpen(1280);
      if (!tree || !Array.isArray(tree.slides)) return { ok: false, reason: 'consumePendingOpen 没返回渲染树' };
      let target = null;
      tree.slides.forEach((slide, slideIndex) => {
        if (target) return;
        const walk = (node) => {
          if (target || !node || typeof node !== 'object') return;
          // 渲染树里的文本可能被折成多个 run（自动换行/字号适配会拆 run），
          // JSON.stringify 之后两个 run 之间夹着 JSON 语法 —— 直接 includes
          // 整句会失败（第一版用 'T7-' 前缀能过，换成完整唯一文本就找不到节点）。
          // 所以先把该节点里**所有字符串叶**拼起来再找。
          const flat = (v) => {
            if (typeof v === 'string') return v;
            if (Array.isArray(v)) return v.map(flat).join('');
            if (v && typeof v === 'object') return Object.values(v).map(flat).join('');
            return '';
          };
          const txt = flat(node.text) + '\u0000' + flat(node.children);
          if (typeof node.sourceId === 'string' && txt.includes(${JSON.stringify(find)})) {
            target = { slideIndex, sourceId: node.sourceId };
            return;
          }
          (node.children ?? []).forEach(walk);
        };
        (slide.nodes ?? []).forEach(walk);
      });
      if (!target) return { ok: false, reason: '渲染树里找不到含唯一文本的节点' };
      const updated = await api.editText({
        slideIndex: target.slideIndex,
        sourceId: target.sourceId,
        paragraphs: [{ runs: [{ text: ${JSON.stringify(replace)} }] }],
      });
      if (!updated) return { ok: false, reason: 'editText 返回 null' };
      return { ok: true, target };
    } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
  })()`);
  return result.ok === true
    ? { ok: true, observed: result }
    : { ok: false, detail: result.reason ?? "slides 编辑失败", observed: result };
}

/** html：源码模式全选替换（T7 已验证的编排；CodeMirror 在源码模式才可键入）。 */
async function editHtmlSource(rt: O2Runtime, bodyText: string): Promise<{ ok: boolean; detail?: string; observed?: unknown }> {
  const wc = wcOf(rt);
  if (wc === null) return { ok: false, detail: "html 视图 webContents 不存在" };
  const switched = await js<{ ok: boolean; reason?: string }>(wc, `(() => {
    const bs = [...document.querySelectorAll('button')];
    const src = bs.find((b) => /^(源码|Source)$/.test((b.textContent || '').trim()));
    if (!src) return { ok: false, reason: '找不到「源码」按钮' };
    src.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { ok: true };
  })()`);
  if (switched.ok !== true) return { ok: false, detail: switched.reason ?? "无法切到源码模式" };
  await new Promise((r) => setTimeout(r, 400));
  const point = await js<{ ok: boolean; x?: number; y?: number }>(wc, `(() => {
    const host = document.querySelector('.source-editor') ?? document.querySelector('.cm-editor');
    if (!host) return { ok: false };
    const r = host.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return { ok: false };
    return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 120)) };
  })()`);
  if (point.ok !== true) return { ok: false, detail: "源码面板没有可用矩形" };
  wc.sendInputEvent({ type: "mouseMove", x: point.x!, y: point.y! });
  wc.sendInputEvent({ type: "mouseDown", x: point.x!, y: point.y!, button: "left", clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x: point.x!, y: point.y!, button: "left", clickCount: 1 });
  await new Promise((r) => setTimeout(r, 200));
  const focused = await js<boolean>(wc, `(() => {
    const el = document.querySelector('.cm-content');
    return !!el && (document.activeElement === el || el.contains(document.activeElement));
  })()`);
  if (focused !== true) return { ok: false, detail: "点击源码面板后 CodeMirror 没有获得焦点" };
  pressKey(wc, "a", ["control"]);
  await new Promise((r) => setTimeout(r, 120));
  wc.insertText(`<!doctype html><html><head><meta charset="utf-8"><title>O2 HTML</title></head><body><h1>O2 HTML</h1><p>${bodyText}</p></body></html>`);
  await new Promise((r) => setTimeout(r, 400));
  const seen = await waitFor(async () => {
    const text = await js<string>(wc, `(document.querySelector('.cm-content')?.textContent) ?? ''`);
    return text.includes(bodyText) ? text : null;
  }, 10_000, 150);
  return seen === null
    ? { ok: false, detail: `10s 内源码里没有 ${bodyText}` }
    : { ok: true, observed: { domSlice: seen.slice(0, 160) } };
}

/** pdf：真 UI —— 「页面」ribbon tab →「向右旋转」（rotation 90°）。 */
async function rotatePdfPage(rt: O2Runtime): Promise<{ ok: boolean; detail?: string; observed?: unknown }> {
  const wc = wcOf(rt);
  if (wc === null) return { ok: false, detail: "pdf 视图 webContents 不存在" };
  const clicked = await js<{ ok: boolean; reason?: string }>(wc, `(() => {
    const tabs = [...document.querySelectorAll('.ribbon-tab')];
    const page = tabs.find((b) => (b.textContent || '').trim() === '页面' || (b.textContent || '').trim() === 'Pages');
    if (!page) return { ok: false, reason: '找不到「页面」tab' };
    page.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { ok: true };
  })()`);
  if (clicked.ok !== true) return { ok: false, detail: clicked.reason ?? "找不到页面 tab" };
  await new Promise((r) => setTimeout(r, 400));
  const rotated = await waitFor(async () => await js<{ ok: boolean; reason?: string }>(wc, `(() => {
    const bs = [...document.querySelectorAll('button.rb-big')];
    const right = bs.find((b) => /向右旋转|Rotate right/.test(b.textContent || ''));
    if (!right) return { ok: false, reason: '找不到「向右旋转」按钮' };
    if (right.hasAttribute('disabled')) return { ok: false, reason: '「向右旋转」按钮 disabled' };
    right.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { ok: true };
  })()`), 10_000, 300);
  return rotated !== null && rotated.ok === true
    ? { ok: true, observed: rotated }
    : { ok: false, detail: rotated?.reason ?? "旋转按钮点击失败", observed: rotated };
}

async function performEdit(rt: O2Runtime, round: 1 | 2): Promise<{ ok: boolean; detail?: string; observed?: unknown }> {
  const wc = wcOf(rt);
  if (wc === null) return { ok: false, detail: "视图 webContents 不存在" };
  const target = round === 1 ? EDITED_1 : EDITED_2;
  switch (rt.kind) {
    case "docs":
      return editProseMirror(wc, ".ProseMirror", round === 1 ? UNIQUE.docs : EDITED_1, target);
    case "markdown":
      // html/docs 的编辑器把整篇文档放在页面模型里，锚点随保存稳定；markdown 的
      // 锚点用**前缀**并在两轮之间切换：第一轮找夹具 `T7-MD-`，第二轮找第一轮
      // 写进去的 `O2-EDIT-ONE-`（第一版固定用完整夹具文本，整跑时第二轮偶尔
      // 因为自动保存/重开已经把那段文字换掉而找不到锚点）。
      return editProseMirror(wc, ".doc-editor.ProseMirror", round === 1 ? "T7-MD-" : "O2-EDIT-ONE-", target);
    case "html":
      return editHtmlSource(rt, target);
    case "pdf":
      return rotatePdfPage(rt);
    case "slides":
      // 第一轮锚点 = 夹具的唯一文本；第二轮锚点 = 第一轮写进去的文本。
      // 锚点用**前缀**（与 T7 的 `'T7-'` 同一做法）：渲染树会把文本折成多个 run
      // （自动换行/字号适配），整句 `includes` 会落空。第一轮找夹具前缀，
      // 第二轮找第一轮写进去的前缀。
      return editSlideText(rt, round === 1 ? "T7-" : "O2-", target);
    case "sheets":
      // 同一**行**内的两个格子：夹具 `blank.xlsx` 只有 1 行，惰性会话按数据范围
      // 只加载第 1 行 —— 选 `A2` 会被 Univer 夹回 `B1`（实测 `stage:"select"
      // boxValue:"B1"`，五次尝试都一样）。这是夹具的事实，不是产品缺陷。
      return editSheetCell(rt, round === 1 ? "A1" : "B1", target);
  }
}

/* ───────────────────────────── 某阶段的观察 ───────────────────────────── */

function replyIsSuccess(observation: SaveObservation | undefined): boolean {
  if (!observation || observation.record === null) return false;
  const record = observation.record;
  if (record.thrown !== null) return false;
  const reply = record.reply ?? {};
  // docs/slides/pdf/markdown/html 的成功形态是 `ok: true`。
  if (reply.ok === true) return true;
  // sheets 的成功形态是 `{ canceled: false, file: {...} }`（`workbook:save` 从
  // `sheets-main.ts` 的 handler 原样返回 `WorkbookSaveResult`，**没有 `ok` 字段**；
  // 取消是 `{ canceled: true }`，失败是 throw）。判据按真实契约写，不硬套 ok。
  if (record.channel === "workbook:save") {
    return reply.canceled === false && typeof reply.filePath === "string" && reply.filePath.length > 0;
  }
  return false;
}

/** 这次保存是否被**版本冲突**拒绝（4a 与负控共用的最小判据，只看回包/异常）。 */
function replyIsConflictRejection(rt: O2Runtime, observation: SaveObservation | undefined): boolean {
  if (!observation || observation.record === null) return false;
  const record = observation.record;
  const reply = record.reply ?? {};
  const text = `${record.thrown ?? ""} ${String(reply.error ?? "")} ${String(reply.reason ?? "")}`;
  if (reply.ok === false && reply.reason === "conflict") return true;
  if (/FILE_VERSION_CONFLICT|版本冲突/.test(text)) return true;
  if (rt.kind === "sheets" && /changed on disk after it was opened|磁盘上的改动/.test(text)) return true;
  return false;
}

/** 读 `conflict-verdicts` 步骤暂存在 runtime 上的判断（断言步骤专用）。 */
function verdictOf(
  runtime: unknown,
  key: "4a" | "4b" | "4c",
): { ok: boolean; detail?: string; diskSha?: string | null; externalSha?: string | null; notice?: { found: boolean; evidence: Record<string, unknown> } } & Record<string, unknown> {
  const verdicts = (runtime as O2Runtime).verdicts;
  if (!verdicts) {
    // 采集步骤与断言步骤之间只可能是 runner 层面的错误；显式失败，不编造。
    return { ok: false, detail: `conflict-verdicts 还没有采集（缺少 ${key} 的事实）` };
  }
  return verdicts[key] as { ok: boolean } & Record<string, unknown>;
}

function replyChannel(observation: SaveObservation | undefined): string | null {
  return observation?.record?.channel ?? null;
}

/* ───────────────────────────── 旅程工厂 ───────────────────────────── */

export function buildJourney(kind: EditorKind) {
  const expectation = EXPECTATIONS[kind];
  const steps = [
    step.run(async ({ runtime }) => {
      const rt = runtime as O2Runtime;
      return await openAndWaitReady(rt);
    }, "open-and-ready", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as O2Runtime;
      const snapshot: Snapshot = { baselineSha: sha256Of(rt.fixtures[rt.kind]), negativePreSha: "" };
      (rt as O2Runtime & { snapshot?: Snapshot }).snapshot = snapshot;
      return { ok: snapshot.baselineSha.length === 64, observed: { ...snapshot, docId: rt.docId, wcId: rt.webContentsId } };
    }, "record-baseline", { assert: true }),

    // ── 阶段 A：负控 —— 没人动过时，保存必须成功（判据 #5） ──
    step.run(async ({ runtime }) => {
      const rt = runtime as O2Runtime;
      const edit = await performEdit(rt, 1);
      return edit;
    }, "negative-edit", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as O2Runtime & { snapshot?: Snapshot };
      rt.negativePreSha = sha256Of(rt.fixtures[rt.kind]);
      // 变异 3（`O2_MUTATION=negative-conflict`）：在保存之前**故意**把盘面改掉，
      // 让负控变成一次冲突 —— 用于证明第 5 条真的会红。
      if (mutationMode() === "negative-conflict") {
        writeExternalEdit(rt, EXTERNAL_TEXT);
      }
      const outcome = await triggerAndObserve(rt, { replyTimeoutMs: 30_000, noticeWaitMs: 0, successWaitMs: 10_000 });
      if (!outcome.ok || outcome.observation === undefined) {
        return { ok: false, observed: outcome.trigger ?? null, detail: outcome.detail ?? "保存触发失败" };
      }
      rt.negative = outcome.observation;
      // 前置条件（不是判据本身）：这次保存必须真的到达了**预期的保存通道**。
      // 到不了 = 这次取证无效 —— 与「保存被拒」是两回事，必须在 4a 之前分开。
      const channel = replyChannel(outcome.observation);
      if (outcome.observation.record === null) {
        return {
          ok: false,
          observed: { channel, allRecords: outcome.observation.allRecords, allChannelsSince: outcome.observation.allChannelsSince, recorder: outcome.observation.recorder, trigger: outcome.trigger },
          detail: `负控保存 30s 内没有到达保存通道 ${expectation.expectedChannel}（触发没有到达主进程，本次取证无效）`,
        };
      }
      if (channel !== expectation.expectedChannel) {
        return {
          ok: false,
          observed: { channel, allRecords: outcome.observation.allRecords, allChannelsSince: outcome.observation.allChannelsSince, recorder: outcome.observation.recorder },
          detail: `负控命中的保存通道是 ${String(channel)}，与预期的 ${expectation.expectedChannel} 不一致（保存链路换了，判据需重核）`,
        };
      }
      return { ok: true, observed: { channel, trigger: outcome.trigger } };
    }, "negative-save-reached-channel", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as O2Runtime & { snapshot?: Snapshot };
      const observation = rt.negative!;
      const saved = replyIsSuccess(observation);
      const diskChanged = observation.diskSha !== null && observation.diskSha !== rt.negativePreSha;
      // #5 是关于**主进程与磁盘**的判据：没人动过时，保存必须被接受并真的写盘。
      // 「页面出现了『已保存』」不在这里 —— 各格式的成功反馈位不同（sheets 的状态栏
      // 被流式加载消息占用、pdf 的成功标记 2 秒后自清），把界面反馈并进 #5 会让
      // 同一条断言在不同格式上验不同的东西。界面**确实存在**由 §4c 的正控保证
      // （4c 的探针在冲突时找不到提示 → 4c 红；同一条探针在成功时找到成功标记
      // → 由 `judgeConflictReply` 的另一半记录）。这里只要求保存真的成功且落盘。
      const ok = saved && diskChanged;
      return {
        ok,
        observed: {
          reply: observation.record?.reply ?? null,
          thrown: observation.record?.thrown ?? null,
          diskChangedFrom: rt.negativePreSha,
          diskSha: observation.diskSha,
          successProbe: observation.success,
        },
        ...(ok
          ? {}
          : {
              detail: `#5 负控失败（没人动过，保存却不成功）：${
                !saved ? `主进程回包不是成功（${JSON.stringify(observation.record?.reply ?? null)}${observation.record?.thrown ? `，抛出 ${observation.record.thrown}` : ""}）` : "盘上字节没有变化"
              }`,
            }),
      };
    }, "negative-save-succeeds", { assert: true }),

    // ── 阶段 B：冲突 —— 外部进程改盘之后，保存必须被拒（4a/4b/4c） ──
    step.run(async ({ runtime }) => {
      const rt = runtime as O2Runtime;
      const edit = await performEdit(rt, 2);
      return edit;
    }, "conflict-edit", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as O2Runtime;
      const external = writeExternalEdit(rt, EXTERNAL_TEXT);
      rt.externalSha = external.sha;
      // 变异 2（`O2_MUTATION=hide-notice`）：让提示元素不可见。只影响 4c 的
      // DOM 探针 —— 4a/4b 的证据源（IPC 回包 / 磁盘）不受影响。
      const hide = mutationMode() === "hide-notice" ? await injectHideNotice(rt) : null;
      return { ok: true, observed: { externalSha: external.sha, bytes: external.bytes, marker: external.marker, hide } };
    }, "conflict-external-edit", { assert: true }),

    step.run(async ({ runtime }) => {
      const rt = runtime as O2Runtime;
      const outcome = await triggerAndObserve(rt, { replyTimeoutMs: 30_000, noticeWaitMs: 8_000 });
      if (!outcome.ok || outcome.observation === undefined) {
        return { ok: false, observed: outcome.trigger ?? null, detail: outcome.detail ?? "保存触发失败" };
      }
      rt.conflict = outcome.observation;
      if (outcome.observation.record === null) {
        return {
          ok: false,
          observed: { allRecords: outcome.observation.allRecords, allChannelsSince: outcome.observation.allChannelsSince, recorder: outcome.observation.recorder, trigger: outcome.trigger },
          detail: `冲突阶段保存 30s 内没有到达保存通道 ${expectation.expectedChannel}（本次取证无效）`,
        };
      }
      return {
        ok: true,
        observed: {
          channel: replyChannel(outcome.observation),
          reply: outcome.observation.record.reply,
          thrown: outcome.observation.record.thrown,
          diskSha: outcome.observation.diskSha,
          externalSha: rt.externalSha ?? null,
          notice: outcome.observation.notice,
          allRecords: outcome.observation.allRecords,
          allChannelsSince: outcome.observation.allChannelsSince,
          trigger: outcome.trigger,
        },
      };
    }, "conflict-save-observed", { assert: true }),

    // ── 三条判据的**事实采集**（不判对错，永远 PASS） ──
    // 为什么先采集再分别断言：runner 遇 FAIL 立即结束旅程（`runner.ts` 的
    // `if (out.status === "FAIL") … finish`）。如果 4a 的断言先跑并红，
    // 4b/4c 就**从来没执行**——四个「预期红」格式的 4b（盘上被覆盖）证据会
    // 一个都没有（变异 1 实测：docs4b=MISSING）。`failBecause` / 变异脚本 /
    // 复核者都需要**三条事实同时在场**，所以把它们一次采齐，再各写一条断言。
    step.run(async ({ runtime }) => {
      const rt = runtime as O2Runtime;
      const observation = rt.conflict!;
      const judgement = judgeConflictReply(rt, observation);
      const diskKeepsExternal = rt.externalSha !== undefined && observation.diskSha === rt.externalSha;
      rt.verdicts = {
        "4a": {
          ok: judgement.ok,
          ...(judgement.detail !== undefined ? { detail: judgement.detail } : {}),
          ...judgement.observed,
        },
        "4b": {
          ok: diskKeepsExternal,
          diskSha: observation.diskSha,
          externalSha: rt.externalSha ?? null,
        },
        "4c": {
          ok: observation.notice.found,
          notice: observation.notice,
        },
      };
      return { ok: true, observed: rt.verdicts };
    }, "conflict-verdicts", { assert: false }),

    // ── 4a/4b/4c：**一条步骤、三个独立标志** ──
    //
    // 为什么不拆成三步：runner 遇 FAIL 立即结束旅程。拆开时 4a 一红，4b/4c
    // 从来没执行 —— 于是「4a 红了，但盘上到底被覆盖了没有」这个最关键的事实
    // **没有证据**（变异 1 实测：docs4b=MISSING）。而卡 §五变异 2 要的恰恰是
    // 「删掉 DOM 后，4a/4b 仍绿、只有 4c 红」—— 那要求三条**同时**有判断。
    //
    // 所以这里一次给出三个**证据源互不相同**的 ok 标志：
    //   · 4a ← 主进程 IPC 回包（`judgeConflictReply`，与 DOM 无关）
    //   · 4b ← 磁盘 sha256（与回包、DOM 都无关）
    //   · 4c ← 页面 DOM（可见元素）
    // 步骤整体 ok = 三条都成立；`observed` 里三条各自带 ok/detail —— 哪条红、
    // 红成什么样，读证据就能分清「拦住了但没提示」与「根本没拦住」。
    step.run(async ({ runtime }) => {
      const rt = runtime as O2Runtime;
      const verdicts = rt.verdicts! as unknown as Record<"4a" | "4b" | "4c", { ok: boolean; detail?: string }>;
      const failed = (["4a", "4b", "4c"] as const).filter((k) => !verdicts[k]!.ok);
      return {
        ok: failed.length === 0,
        observed: verdicts,
        ...(failed.length === 0
          ? {}
          : {
              detail: failed
                .map((k) => `${k}: ${verdicts[k].detail ?? "判据不成立"}`)
                .join("；"),
            }),
      };
    }, "4-conflict-criteria", { assert: true }),
  ];

  return defineU1Journey({
    name: `o2-conflict-${kind}`,
    ...(expectation.expectConflict
      ? {}
      : {
          expect: "fail" as const,
          // 只有「4a 因为保存**其实成功了**而被判红」才算预期失败。
          // 保存因别的原因失败（坏档、通道消失）会让这里返回 false → unexpected failure。
          //
          // ⚠️ observed 必须取自 `conflict-save-observed` —— 那是**前置条件**步骤
          // （记录回包，不判对错）。`4a-…` 自己的 observed 是判据的证词，不是原始回包。
          failBecause: (evidence) => {
            const failed = evidence.find((e) => e.status === "FAIL");
            if (!failed || failed.step !== "4-conflict-criteria") return false;
            const verdicts = (failed.observed ?? {}) as { "4a"?: { ok?: boolean }; "4b"?: { ok?: boolean }; "4c"?: { ok?: boolean } };
            const probe = evidence.find((e) => e.step === "conflict-save-observed");
            const observed = probe?.observed as { reply?: { ok?: unknown }; thrown?: unknown } | undefined;
            // 预期失败的形态必须**恰好**是「保存其实成功了」：4a 不成立（没被拒），
            // 且回包是成功/抛出（不是「保存因坏档失败」那种别的失败）。
            const savedAnyway = observed?.reply?.ok === true || (typeof observed?.thrown === "string" && observed.thrown.length > 0);
            return verdicts["4a"]?.ok === false && savedAnyway;
          },
        }),
    launch: {
      window: false,
      size: { width: 1400, height: 950 },
      defaultTimeoutMs: 40_000,
      setup: editorSetup(kind) as never,
      assertions: { dom: true, visual: true, sideEffect: true },
    },
    steps,
  });
}

export const o2Journeys = ([
  "docs",
  "sheets",
  "slides",
  "pdf",
  "markdown",
  "html",
] as const).map((kind) => buildJourney(kind));

export type { GenofficeHarness, FixturePaths };
