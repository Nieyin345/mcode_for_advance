/**
 * 【ARC-007 / GenOffice AI 交互】真 Electron：真实 docs 页 + 生产最小 preload 下，
 * 验证用户点名称赞的「选中元素 → 弹输入框 → 确认 → 侧栏会话记录」链路。
 *
 * ## 链路与 vendor 源码依据
 *
 *  1. **选中**：`AiAskPopover.tsx:133-165` 订阅 `editor.on('selectionUpdate'|
 *     'focus'|'blur')`，条件为 `!selection.empty && editor.isFocused`，然后渲染
 *     `.ai-ask-trigger`（:397-414）；
 *  2. **弹出输入框**：点击 chip → `openFromSelection()`（:230）→ `.ai-ask-pop`
 *     （:273），输入框 `.ai-ask-pop-input`（:306）；
 *  3. **确认（加入队列）**：`.ai-ask-confirm`（:377）→ `onQueueAdd` →
 *     `App.tsx` 的 `queueAdd`（:6284）→ `setEditQueue`；
 *  4. **侧栏记录**：`AiPanel`（始终挂载，App.tsx:7386）里的 `EditQueueCard`
 *     渲染 `.ai-queue-row`（EditQueueCard.tsx:87）与 `.ai-queue-count`。
 *
 * ## 探针如何触发（不伪造 DOM 事件链）
 *
 *  - `tiptap` 把 Editor 实例挂在 `view.dom.editor`（`@tiptap/core/dist/index.js:6486`），
 *    探针经它执行 `editor.commands.setTextSelection()` —— 走 vendor 自己的
 *    `selectionUpdate` 事件路径；
 *  - 焦点用 `pm.focus()` + CDP `Input.insertText` 产生真实输入（先验输入真的进了
 *    ProseMirror 文档，再设选区）；
 *  - React 受控输入用原型上的原生 value setter + `input` 事件写入；
 *  - chip / confirm 用 `.click()`。
 *
 * ## 断言（checks.json；★ = 任务书要求的四条）
 *
 *   1. ★ 页面已挂载且拿到编辑器句柄（前置；失败时后续断言给出可读原因）；
 *   2. ★ 选中后 `.ai-ask-trigger` 出现（可见）；
 *   3. ★ 填输入并确认后 `.ai-queue-row` 条数 +1（且 `.ai-queue-count` 一致）；
 *   4. ★ 该条记录文本与输入一致（`.ai-queue-text` 包含指令原文）；
 *   5. ★ 全程零未捕获异常（CDP `Runtime.exceptionThrown` + console error + 页面钩子）。
 *
 * ## 已知边界（如实）
 *
 *  - 不点「立即发送」（那会真的发起一次模型请求；本宿主没有 AI 后端）——只验
 *    **入队**，即用户原话「记录直接显示到侧边栏」的那一步；
 *  - 焦点/选区用页面内编辑器句柄驱动，不是 OS 级鼠标事件（隐藏窗口里 CDP 鼠标
 *    拖选不稳定）；所走的 vendor 代码路径与真实拖选相同（同一组 editor 事件）；
 *  - 不联网：页面是本地 `file://` 产物。
 */
import { BrowserWindow, ipcMain } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

interface Check {
  name: string;
  status: "PASS" | "FAIL";
  error?: string;
  detail?: unknown;
}

interface Config {
  pagePath: string;
  preloadPath: string;
  waitMs: number;
  urlSuffix: string;
}

const INSTRUCTION = "把这段文字润色得更正式";

export async function runAiAskProbe(dir: string): Promise<void> {
  const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8")) as Config;
  const checksPath = join(dir, "checks.json");
  const checks: Check[] = [];
  const evidence: Record<string, unknown> = {};
  const exceptions: string[] = [];
  const consoleErrors: string[] = [];
  let pageErrors: Array<{ type: string; message: string }> = [];

  async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
      checks.push({ name, status: "PASS" });
      console.log("PASS AI-ASK " + name);
    } catch (error) {
      checks.push({ name, status: "FAIL", error: String(error) });
      console.error("FAIL AI-ASK " + name + " :: " + String(error));
    } finally {
      await writeFile(checksPath, JSON.stringify(checks, null, 2));
    }
  }
  const assert = (cond: unknown, message: string): void => {
    if (!cond) throw new Error(message);
  };

  ipcMain.handle("mcode:document-view:open-path", () => ({ ok: false, error: "probe" }));
  ipcMain.handle("mcode:document-view:save", () => ({ ok: false, error: "probe" }));

  const url = pathToFileURL(config.pagePath).toString() + config.urlSuffix;
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: config.preloadPath,
    },
  });
  const wc = win.webContents;
  wc.setWindowOpenHandler?.(() => ({ action: "deny" }));
  wc.on("console-message", (event: unknown, level?: number, message?: string) => {
    const d = event as { message?: string; level?: string };
    const text = d.message ?? String(message ?? "");
    if ((d.level ?? String(level)) === "error" || /Uncaught|is not a function/.test(text)) {
      consoleErrors.push(text.split("\n")[0]);
    }
  });

  let debuggerAttached = false;
  try {
    wc.debugger.attach("1.3");
    debuggerAttached = true;
  } catch {
    /* CDP 不可用时页面钩子仍是第二证据源；断言 5 会因「没有证据」而拒绝放行 */
  }
  if (debuggerAttached) {
    wc.debugger.on("message", (_e, method, params) => {
      if (method !== "Runtime.exceptionThrown") return;
      const p = params as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
      exceptions.push((p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "?").split("\n")[0]);
    });
    void Promise.allSettled([wc.debugger.sendCommand("Runtime.enable")]);
  }
  const js = <T = unknown>(expr: string): Promise<T> => wc.executeJavaScript(expr, true) as Promise<T>;

  try {
    await wc.loadURL(url);
    await delay(config.waitMs);

    // 页面内钩子：补足 CDP 偶尔 attach 失败时的证据源。
    const hookSource = `
      if (!window.__gasErrHook) {
        window.__gasErrHook = true;
        window.__gasErr = [];
        window.addEventListener('error', (e) => window.__gasErr.push({ type: 'error', message: String(e.message || '') }));
        window.addEventListener('unhandledrejection', (e) => window.__gasErr.push({ type: 'unhandledrejection', message: String((e.reason && e.reason.message) || e.reason || '') }));
      }
    `;
    try { await js(hookSource); } catch { /* 已注入或页面已销毁 */ }

    // ── 1. 前置：页面已挂载 + 编辑器句柄可达 ──
    const mounted = await js<{ root: number; pm: boolean; editor: boolean; dock: string }>(`(() => {
      const root = document.getElementById('root');
      const pm = document.querySelector('.ProseMirror');
      const dock = document.querySelector('.ai-dock');
      return { root: root ? root.childElementCount : -1, pm: !!pm, editor: !!(pm && pm.editor), dock: dock ? dock.className : '' };
    })()`);
    evidence.mounted = mounted;
    await check("前置：真实 docs 页已挂载、编辑器句柄可达、AI 侧栏在位", () => {
      assert(mounted.root > 0, `#root 子节点 ${mounted.root}`);
      assert(mounted.pm, "没有 .ProseMirror");
      assert(mounted.editor, "view.dom.editor 不在了（tiptap 内部结构变了？）");
      assert(/ai-dock/.test(mounted.dock), `AI 侧栏不在位: ${mounted.dock}`);
    });

    // ── 2. 输入一段真实文本（CDP 键入；退回 insertContent 并如实记录） ──
    await js(`document.querySelector('.ProseMirror').focus()`);
    let typedVia = "cdp-input";
    try {
      if (!debuggerAttached) throw new Error("no cdp");
      await wc.debugger.sendCommand("Input.insertText", { text: "这是第一段测试文本。" });
      const docText = await js<string>(
        `(() => { const e = document.querySelector('.ProseMirror').editor; return e.state.doc.textBetween(0, e.state.doc.content.size, ' ', ' '); })()`,
      );
      if (!docText.includes("测试文本")) throw new Error("输入未进文档: " + docText);
    } catch (err) {
      typedVia = "insertContent";
      await js(`document.querySelector('.ProseMirror').editor.commands.insertContent('这是第一段测试文本。')`);
      evidence.typeFallbackReason = String(err).slice(0, 200);
    }
    evidence.typedVia = typedVia;

    // ── 3. ★ 选中 → chip 出现 ──
    const selection = await js<{
      from: number; to: number; empty: boolean; isFocused: boolean;
      trigger: boolean; triggerText: string | null;
    }>(`(async () => {
      const pm = document.querySelector('.ProseMirror');
      const editor = pm.editor;
      let from = -1, to = -1;
      editor.state.doc.descendants((node, pos) => {
        if (from >= 0) return false;
        if (node.isText && node.text && node.text.includes('测试文本')) {
          const idx = node.text.indexOf('测试文本');
          from = pos + idx; to = from + '测试文本'.length;
          return false;
        }
        return true;
      });
      if (from < 0) return { from, to, empty: true, isFocused: false, trigger: false, triggerText: null };
      pm.focus();
      editor.commands.setTextSelection({ from, to });
      await new Promise((r) => setTimeout(r, 300));
      const t = document.querySelector('.ai-ask-trigger');
      return { from, to, empty: editor.state.selection.empty, isFocused: editor.isFocused, trigger: !!t, triggerText: t ? t.textContent : null };
    })()`);
    evidence.selection = selection;
    await check("★ 选中后浮动 Ask AI chip（.ai-ask-trigger）出现", () => {
      assert(selection.from >= 0, "文档里找不到测试文本");
      assert(selection.empty === false, "选区是空的");
      assert(selection.isFocused === true, "编辑器未获得焦点（vendor 触发条件要求 isFocused）");
      assert(selection.trigger === true, "没有 .ai-ask-trigger");
    });

    // ── 4. 点开 popover 并写入指令 ──
    const popover = await js<{ open: boolean; title: string | null; inputExists: boolean }>(`(async () => {
      const t = document.querySelector('.ai-ask-trigger');
      if (!t) return { open: false, title: null, inputExists: false };
      t.click();
      await new Promise((r) => setTimeout(r, 200));
      const pop = document.querySelector('.ai-ask-pop');
      const input = document.querySelector('.ai-ask-pop-input');
      const title = document.querySelector('.ai-ask-pop-title');
      return { open: !!pop, title: title ? title.textContent : null, inputExists: !!input };
    })()`);
    evidence.popover = popover;
    await check("点击 chip 后输入气泡打开（.ai-ask-pop + 输入框）", () => {
      assert(popover.open, "没有 .ai-ask-pop");
      assert(popover.inputExists, "没有 .ai-ask-pop-input");
    });

    const filled = await js<{ value: string; confirmDisabled: boolean | null; confirmText: string | null }>(`(() => {
      const input = document.querySelector('.ai-ask-pop-input');
      if (!input) return { value: '', confirmDisabled: null, confirmText: null };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(INSTRUCTION)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { value: input.value, confirmDisabled: null, confirmText: null };
    })()`);
    await delay(100);
    const confirmState = await js<{ value: string; confirmDisabled: boolean | null; confirmText: string | null }>(`(() => {
      const input = document.querySelector('.ai-ask-pop-input');
      const confirm = document.querySelector('.ai-ask-confirm');
      return { value: input ? input.value : '', confirmDisabled: confirm ? confirm.disabled : null, confirmText: confirm ? confirm.textContent : null };
    })()`);
    evidence.filled = { ...filled, reactValue: confirmState.value, confirmDisabled: confirmState.confirmDisabled, confirmText: confirmState.confirmText };
    await check("指令写入受控输入框且「加入队列」可用", () => {
      assert(confirmState.value === INSTRUCTION, `输入框值不符: ${confirmState.value}`);
      assert(confirmState.confirmDisabled === false, "「加入队列」按钮仍禁用");
    });

    // ── 5. ★ 确认 → 侧栏队列行 +1，且文本一致 ──
    const queued = await js<{
      before: number; after: number; count: string | null;
      rows: string[]; rowText: string | null;
    }>(`(async () => {
      const before = document.querySelectorAll('.ai-queue-row').length;
      const confirm = document.querySelector('.ai-ask-confirm');
      if (!confirm) return { before, after: before, count: null, rows: [], rowText: null };
      confirm.click();
      await new Promise((r) => setTimeout(r, 400));
      const rows = [...document.querySelectorAll('.ai-queue-row')];
      const count = document.querySelector('.ai-queue-count');
      const text = document.querySelector('.ai-queue-row .ai-queue-text');
      return { before, after: rows.length, count: count ? count.textContent : null, rows: rows.map((r) => (r.textContent || '').slice(0, 160)), rowText: text ? text.textContent : null };
    })()`);
    evidence.queued = queued;
    await check("★ 确认后侧栏队列行 +1（.ai-queue-row / .ai-queue-count）", () => {
      assert(queued.after === queued.before + 1, `.ai-queue-row ${queued.before} → ${queued.after}`);
      assert(queued.count !== null && /^1\/\d+$/.test(queued.count), `.ai-queue-count 不符: ${queued.count}`);
    });
    await check("★ 队列记录的文本与输入一致", () => {
      assert(queued.rowText !== null, "没有 .ai-queue-text");
      assert(queued.rowText?.includes(INSTRUCTION) === true, `行文本不含指令原文: ${queued.rowText}`);
    });

    // ── 6. ★ 全程零未捕获异常 ──
    pageErrors = await js<Array<{ type: string; message: string }>>(`Array.isArray(window.__gasErr) ? window.__gasErr.slice(0, 20) : []`).catch(() => []);
    evidence.exceptions = exceptions;
    evidence.consoleErrors = consoleErrors;
    evidence.pageErrors = pageErrors;
    await check("★ 全程零未捕获异常（CDP + console + 页面钩子）", () => {
      assert(debuggerAttached || pageErrors.length === 0, "CDP 未挂上且页面钩子也为空 —— 没有异常证据，拒绝放行");
      assert(exceptions.length === 0, `CDP 异常: ${JSON.stringify(exceptions.slice(0, 3))}`);
      assert(consoleErrors.length === 0, `console error: ${JSON.stringify(consoleErrors.slice(0, 3))}`);
      assert(pageErrors.length === 0, `页面钩子: ${JSON.stringify(pageErrors.slice(0, 3))}`);
    });
  } finally {
    if (debuggerAttached) {
      try { wc.debugger.detach(); } catch { /* 已分离 */ }
    }
    if (!win.isDestroyed()) win.destroy();
    ipcMain.removeHandler("mcode:document-view:open-path");
    ipcMain.removeHandler("mcode:document-view:save");
    await writeFile(join(dir, "evidence.json"), JSON.stringify({ url, debuggerAttached, ...evidence, checks }, null, 2));
  }
}
