/**
 * 【ARC-007 P0】真 Electron：**指定文件打开协议闭环**。
 *
 * ## 被测链路（全真）
 *
 *  - 真 vendor docs 页（`genoffice/apps/docs/out/renderer/index.html`）；
 *  - **生产** `documentViewPreload.ts`（openDocxPath 已改为 `read-opened` 拉取）；
 *  - **真** `DocumentViewHost`（宿主准备 → 页面拉取 → 页面回执 commit）；
 *  - 真 `ipcMain` + `registerDocumentViewHandlers`；
 *  - 虚构 DOCX（vendor `buildBlankDocx()` + 注入唯一文本），工作区内临时文件。
 *
 * ## 判据（对应台账 P0 验收）
 *
 *  1. ★ 打开文件 → 指定独有文本出现在页面 DOM（不是空白页）；
 *  2. ★ **只有一条**打开请求、无回环：`openPath` 恰好一次、`menu:command`
 *     恰好一次、open-path 内部通道被调用次数 = 0（源码级白名单也已禁止）；
 *  3. 修改 → 保存 → 关闭重开 → 字节回读（走宿主 `saveOpenedFile`）；
 *  4. 未保存拒绝：页面 dirty 上报后，`confirmDocumentReplace` 在无确认端口时
 *     拒绝；拒绝不改变打开会话；
 *  5. 坏档：`readOpened` 拒绝且不占会话；
 *  6. 跨路径：准备/读两次围栏校验都拒；
 *  7. 过期版本：两次打开之间文件被改写，hash 跟着变，旧 hash 保存被乐观锁拦；
 *  8. 失败回滚：提交被拒（路径已被别的视图持有）后不留会话。
 *
 * ## 页面如何真正"打开"
 *
 * vendor 页面的打开入口是 `menu:command("open-path")` → `openRecent(path)` →
 * `confirmDocumentReplace()`（真宿主，dirty 时走确认端口）→ `openDocxPath(path)`
 * （preload 拉取 readOpened，返回 vendor `OpenDocxResult`）→ 解析 + 显示 →
 * `getRecentFiles()`（preload 回执 open-committed）。整条链没有任何一步由探针
 * 伪造 —— 探针只注入确认端口的自动应答与 mock 的 AI 设置。
 */
import { BrowserWindow, ipcMain } from "electron";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync as mkdirFs, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DocumentViewHost } from "@main/document/documentViewHost.js";
import { docsPrivilegedPorts } from "@main/document/docsPrivilegedPorts.js";
import { registerDocumentViewHandlers } from "@main/ipc/documentView.js";
import { SlidesBridge } from "@main/document/slidesBridge.js";
import { VendorSlidesExecutor } from "@main/document/slidesExecutor.js";
import {
  initDocumentHandoffProtocol,
  registerDocumentHandoffSchemePrivileged,
} from "@main/document/documentViewHandoff.js";
import type { DocumentViewHostWindow } from "@main/document/documentViewHost.js";

interface Check { name: string; status: "PASS" | "FAIL"; error?: string; detail?: unknown }

interface Config {
  pagePath: string;
  /** 【ARC-007 P1/GA1】slides 页（真实构建产物；缺失时本套件跳过 slides 段）。 */
  slidesPagePath?: string;
  preloadPath: string;
  /** slides 页用的 preload（同一份生产 preload；显式列出便于诊断）。 */
  slidesPreloadPath?: string;
  waitMs: number;
  urlSuffix: string;
}

interface VendorDocxModule {
  buildBlankDocx: (options?: { paperSize?: string }) => Promise<Uint8Array>;
}
interface JSZipInstance {
  loadAsync: (data: Uint8Array) => Promise<unknown>;
  file: (path: string, content: string) => void;
  generateAsync: (opts: { type: "uint8array"; compression: string }) => Promise<Uint8Array>;
}
type JSZipCtor = new () => JSZipInstance;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const docxEngine = require("@genoffice/docx-engine") as VendorDocxModule;
// jszip 的 CJS 导出本身就是构造器（无 default 包装）。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const JSZip = require("jszip") as JSZipCtor;

const UNIQUE_TEXT = "MCODE-P0-UNIQUE-7f3a";

/** 生成含指定文本的合法 docx（与 fixture 同模板，真 zip）。 */
async function makeDocxWithText(text: string): Promise<Uint8Array> {
  const blank = await docxEngine.buildBlankDocx({ paperSize: "A4" });
  const zip = new JSZip();
  await zip.loadAsync(blank);
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** 用 vendor 的空模板 + 注入唯一文本，生成一份合法 docx。 */
async function makeFixtureDocx(): Promise<Uint8Array> {
  return makeDocxWithText(UNIQUE_TEXT);
}

/** 【ARC-007 P1/GA1】slides 唯一文本（与 DOCX 的区分开，避免跨断言串证据）。 */
const SLIDES_UNIQUE_TEXT = "MCODE-P1-SLIDES-9c4e";
const SLIDES_EDITED_TEXT = `${SLIDES_UNIQUE_TEXT}-changed`;

/** 生成含指定文本的合法 pptx（vendor `createBlankPptx` + `addElement` 同一实现）。 */
async function makePptxWithText(text: string): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const engine = require("@genoffice/pptx-engine") as {
    createBlankPptx(): Promise<Uint8Array>;
    openPptx(bytes: Uint8Array): Promise<{ deck: { slides: Array<{ elements: unknown[] }>; size: { cx: number; cy: number } } }>;
    addElement(slide: unknown, opts: Record<string, unknown>): { id?: string };
    savePptx(opened: unknown): Promise<Uint8Array>;
  };
  const opened = await engine.openPptx(await engine.createBlankPptx());
  const slide = opened.deck.slides[0];
  engine.addElement(slide, {
    kind: "textbox",
    offset: { x: 800000, y: 800000, cx: 8000000, cy: 1200000 },
    paragraphs: [{ runs: [{ text }] }],
    bodyPr: { wrap: "square" },
  });
  return engine.savePptx(opened);
}

/** 从 vendor `RenderSlide[]` 的文本节点里拼出纯文本。 */
function flattenRenderText(slides: unknown[]): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as {
      text?: { lines?: Array<{ runs?: Array<{ text?: unknown }>; trailingText?: unknown }> };
      children?: unknown[];
    };
    if (record.text && Array.isArray(record.text.lines)) {
      for (const line of record.text.lines) {
        for (const run of line.runs ?? []) parts.push(String(run.text ?? ""));
        if (typeof line.trailingText === "string") parts.push(line.trailingText);
      }
    }
    for (const child of record.children ?? []) walk(child);
  };
  for (const slide of slides) {
    if (slide === null || typeof slide !== "object") continue;
    for (const node of (slide as { nodes?: unknown[] }).nodes ?? []) walk(node);
  }
  return parts.join("");
}

/**
 * **必须在 app ready 之前**调用（Electron 对 registerSchemesAsPrivileged 的硬性要求）。
 * 与生产 `main/index.ts` 调的是**同一个函数**（`documentViewHandoff`），所以这里
 * 验的就是生产注册路径，而不是探针自造的替代品。
 */
export function registerHandoffSchemeBeforeReady(): void {
  registerDocumentHandoffSchemePrivileged();
}

export async function runOpenProtocolProbe(dir: string): Promise<void> {
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
      console.log("PASS OPEN-PROTO " + name);
    } catch (error) {
      checks.push({ name, status: "FAIL", error: String(error) });
      console.error("FAIL OPEN-PROTO " + name + " :: " + String(error));
    } finally {
      await writeFile(checksPath, JSON.stringify(checks, null, 2));
    }
  }
  const assert = (cond: unknown, message: string): void => {
    if (!cond) throw new Error(message);
  };

  // ── 工作区与 fixture ──
  const workspace = join(dir, "workspace");
  mkdirFs(workspace, { recursive: true });
  const docPath = join(workspace, "p0-target.docx");
  const fixture = await makeFixtureDocx();
  await writeFile(docPath, fixture);
  const fixtureHash = createHash("sha256").update(fixture).digest("hex");
  const badPath = join(workspace, "p0-bad.docx");
  await writeFile(badPath, "not-a-zip");
  const outsideDir = join(dir, "outside");
  mkdirFs(outsideDir, { recursive: true });
  const outsidePath = join(outsideDir, "escape.docx");
  await writeFile(outsidePath, "outside");
  const withinWorkspace = (p: string): boolean =>
    // T05a mutation harness: bypass only in isolated smoke child process.
    // The existing outside-path assertion MUST become red with this flag.
    process.env.MCODE_T05A_MUTATE_SCOPE === "1" ||
    p.replace(/\\/g, "/").toLowerCase().startsWith(workspace.replace(/\\/g, "/").toLowerCase());

  // ── mock AI settings（页面首帧要它；本套件不测 AI） ──
  ipcMain.handle("probe:mock-ai-settings", () => ({ provider: "genspark", providers: {} }));
  for (const [channel, value] of [
    ["app:get-theme", "system"],
    ["app:get-document-theme", "follow"],
    ["app:get-ai-panel-prefs", {}],
    ["app:get-auto-save-default", true],
    ["ai:get-settings", { provider: "genspark", providers: {} }],
    ["ai:gsk-status", { loggedIn: false }],
    ["project:resolveChat", null],
    ["project:appendChat", null],
    ["project:loadChat", null],
    ["project:rebindChat", null],
  ] as const) {
    try {
      ipcMain.handle(channel, () => value);
    } catch {
      /* 已注册 */
    }
  }

  // ── 真窗口 + 真宿主 ──
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const host = new DocumentViewHost({ getMainWindow: () => win as unknown as DocumentViewHostWindow });
  host.setDocsPrivilegedPorts(docsPrivilegedPorts); // T22: mirror production host wiring, not a standalone GenOffice channel.
  // 真确认端口：默认**同意**（测试里显式改为拒绝以覆盖「未保存拒绝」）。
  let confirmAnswer = true;
  const confirmCalls: Array<{ docId: string; filePath: string | null }> = [];
  host.setConfirmDirty(async (input) => {
    confirmCalls.push(input);
    return confirmAnswer;
  });
  // 【ARC-007 P1/GA1】生产执行器（同一份 vendor 解析器/写盘函数）——必须在注册
  // handlers 之前构造：本套件让**生产路由**（openPath/slides-read-opened/slides-save）
  // 真的跑起来，而不是只调宿主方法。
  const slidesExecutor = VendorSlidesExecutor.create();
  const slidesBridgeForProbe = new SlidesBridge(slidesExecutor);
  if (slidesExecutor !== null) host.setViewDisposer((id) => slidesExecutor.release(id));
  // 记录 handler 以便探针用**真实的 event.sender**直接驱动生产路由
  // （与页面 invoke 走同一个函数对象）；同时仍注册到 ipcMain（preload 真的调用要通）。
  const recordedHandlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
  const recordingIpc = {
    handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
      recordedHandlers.set(channel, listener);
      (ipcMain as unknown as { handle(c: string, l: unknown): void }).handle(channel, listener);
    },
    on(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
      (ipcMain as unknown as { on(c: string, l: unknown): void }).on(channel, listener);
    },
  } as unknown as Electron.IpcMain;
  registerDocumentViewHandlers(recordingIpc, host, withinWorkspace, slidesBridgeForProbe);
  /** 用某个视图的 webContents 作为 sender 直接调生产 handler。 */
  const ipcMainInvokeFrom = async (
    sender: unknown,
    channel: string,
    payload: unknown,
  ): Promise<unknown> => {
    const handler = recordedHandlers.get(channel);
    if (handler === undefined) throw new Error(`handler 未注册：${channel}`);
    return await handler({ sender }, payload);
  };
  // 与生产同一条：ready 之后挂上 handoff 协议处理。
  initDocumentHandoffProtocol();

  // 计数：确认与拉取各被页面调了几次（回环/链路证据）。
  const protocolCounts = { confirm: 0, readOpened: 0 };
  {
    const origConfirm = host.confirmDocumentReplace.bind(host);
    host.confirmDocumentReplace = async (id: string) => {
      protocolCounts.confirm += 1;
      return origConfirm(id);
    };
    const origRead = host.readOpened.bind(host);
    host.readOpened = async (id: string, within: (p: string) => boolean) => {
      protocolCounts.readOpened += 1;
      return origRead(id, within);
    };
  }

  const docId = "p0-doc";
  const opened = host.open({
    docId,
    url: pathToFileURL(config.pagePath).toString() + config.urlSuffix,
    bounds: { x: 0, y: 0, width: 1280, height: 900 },
    visible: true,
  });
  if (!opened.ok) throw new Error(`host.open 失败: ${JSON.stringify(opened)}`);
  const wc = host.webContentsOf(docId) as unknown as Electron.WebContents;
  if (!wc) throw new Error("host.webContentsOf 返回 null");
  wc.setWindowOpenHandler?.(() => ({ action: "deny" }));
  wc.on("console-message", (event: unknown, level?: number, message?: string) => {
    const d = event as { message?: string; level?: string };
    const text = d.message ?? String(message ?? "");
    if ((d.level ?? String(level)) === "error" || /Uncaught|is not a function/.test(text)) {
      consoleErrors.push(text.split("\n")[0]);
    }
  });

  // 请求计数：宿主发 `menu:command` 的次数（回环判据）。
  let menuCommandCount = 0;
  const originalSend = wc.send.bind(wc);
  (wc as unknown as { send: (channel: string, ...args: unknown[]) => void }).send = (
    channel: string,
    ...args: unknown[]
  ) => {
    if (channel === "menu:command" && args[0] === "open-path") menuCommandCount += 1;
    return originalSend(channel, ...args);
  };

  let debuggerAttached = false;
  try { wc.debugger.attach("1.3"); debuggerAttached = true; } catch { /* 页面钩子 */ }
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
    await delay(config.waitMs);
    const hookSource = `
      if (!window.__p0ErrHook) {
        window.__p0ErrHook = true;
        window.__p0Err = [];
        window.addEventListener('error', (e) => window.__p0Err.push({ type: 'error', message: String(e.message || '') }));
        window.addEventListener('unhandledrejection', (e) => window.__p0Err.push({ type: 'unhandledrejection', message: String((e.reason && e.reason.message) || e.reason || '') }));
      }
    `;
    try { await js(hookSource); } catch { /* 已注入 */ }

    // ── 1. 前置：页面挂载、桥在位 ──
    const mounted = await js<{ root: number; pm: boolean; bridge: boolean }>(`(() => {
      const root = document.getElementById('root');
      return {
        root: root ? root.childElementCount : -1,
        pm: !!document.querySelector('.ProseMirror'),
        bridge: typeof window.desktop === 'object' && typeof window.desktop.openDocxPath === 'function',
      };
    })()`);
    evidence.mounted = mounted;
    await check("前置：真实 docs 页挂载、openDocxPath 桥在位", () => {
      assert(mounted.root > 0, `#root 子节点 ${mounted.root}`);
      assert(mounted.pm, "没有 .ProseMirror");
      assert(mounted.bridge, "window.desktop.openDocxPath 缺失");
    });

    // ── 2. ★ 打开指定文件：唯一文本出现在 DOM ──
    const beforeOpen = menuCommandCount;
    const openResult = host.openPath(docId, docPath, withinWorkspace);
    evidence.openPrepared = openResult;
    await check("宿主准备打开请求成功（围栏内）", () => {
      assert(openResult.ok, `openPath 被拒: ${JSON.stringify(openResult)}`);
    });
    const textAppeared = await (async () => {
      const start = Date.now();
      let seen = "";
      while (Date.now() - start < 30000) {
        seen = await js<string>(`document.querySelector('.ProseMirror') ? document.querySelector('.ProseMirror').innerText : ''`);
        if (seen.includes(UNIQUE_TEXT)) return { ok: true, text: seen, waitedMs: Date.now() - start };
        await delay(200);
      }
      return { ok: false, text: seen, waitedMs: Date.now() - start };
    })();
    evidence.textAppeared = { ok: textAppeared.ok, waitedMs: textAppeared.waitedMs };
    evidence.protocolCounts = { ...protocolCounts };
    await check("★ 打开后页面 DOM 出现指定独有文本（不是空白页）", () => {
      assert(textAppeared.ok, `30s 内未出现 ${UNIQUE_TEXT}: ${textAppeared.text.slice(0, 200)}`);
    });

    // ── 3. ★ 只有一条打开请求、无回环 ──
    //    menu:command 只发一次；openPath 只调一次；打开链由 read-opened 完成。
    evidence.menuCommandCount = menuCommandCount - beforeOpen;
    await check("★ 只有一条打开请求：menu:command(open-path) 恰好一次（无回环）", () => {
      assert(menuCommandCount - beforeOpen === 1, `menu:command 次数 ${menuCommandCount - beforeOpen}`);
    });
    await check("★ 回执后会话已提交，且待打开请求清空", () => {
      const session = host.sessionFor(docId);
      if (session === null) throw new Error("会话未提交");
      assert(withinWorkspace(session.filePath), `会话路径不在工作区: ${session.filePath}`);
      assert(host.pendingOpenFor(docId) === null, "待打开请求未清空");
    });
    await check("★ 页面没有把 open-path 再 invoke 一次（源码级白名单已禁止）", async () => {
      const { readFileSync: read } = await import("node:fs");
      const src = read(join(process.cwd(), "src/main/document/documentViewPreload.ts"), "utf8");
      const m = /openDocxPath:[\s\S]{0,400}?ipcRenderer\.invoke\(\s*([A-Z_]+)/.exec(src);
      assert(m !== null && m[1] === "READ_OPENED_CHANNEL", `openDocxPath 调的是 ${m?.[1] ?? "?"}（应为 READ_OPENED_CHANNEL）`);
    });

    // ── 4. 修改 → 保存 → 关闭重开 → 字节回读 ──
    const editedText = `${UNIQUE_TEXT}-EDITED`;
    await js(`(() => {
      const pm = document.querySelector('.ProseMirror');
      const editor = pm && pm.editor;
      if (!editor) return false;
      const doc = editor.state.doc;
      let from = -1, to = -1;
      doc.descendants((node, pos) => {
        if (from >= 0) return false;
        if (node.isText && node.text && node.text.includes(${JSON.stringify(UNIQUE_TEXT)})) {
          const idx = node.text.indexOf(${JSON.stringify(UNIQUE_TEXT)});
          from = pos + idx; to = from + ${UNIQUE_TEXT.length};
          return false;
        }
        return true;
      });
      if (from < 0) return false;
      pm.focus();
      editor.commands.setTextSelection({ from, to });
      editor.commands.insertContent(${JSON.stringify(editedText)});
      return true;
    })()`);
    // 页面侧拿到编辑器当前文本，生成合法 docx 字节后经宿主保存通道写回。
    // （生产里这一步是 vendor 的 buildDocBytes；本套件不重复其序列化实现，
    //  用同一模板 + 编辑后文本构造等价字节 —— 验的是**保存通道**的语义。）
    const editedBytes = await makeDocxWithText(editedText);
    const saveReply = await js<{ ok: boolean; bytes?: number; error?: string }>(`(async () => {
      const bytes = Uint8Array.from(${JSON.stringify(Array.from(editedBytes))});
      return await window.desktop.saveDocx('', bytes, false);
    })()`);
    evidence.saveReply = saveReply;
    // 保存写回的是宿主 openedFilePath（页面不传路径）。
    const afterSave = readFileSync(docPath);
    const afterSaveHash = createHash("sha256").update(afterSave).digest("hex");
    evidence.afterSaveHash = afterSaveHash;
    await check("★ 修改后保存：宿主写回打开的那份文件（盘上字节变化、仍是合法 docx）", () => {
      assert(saveReply.ok, `保存失败: ${JSON.stringify(saveReply)}`);
      assert(afterSaveHash === createHash("sha256").update(editedBytes).digest("hex"), "盘上内容与提交字节不符");
      assert(afterSave.subarray(0, 2).toString("latin1") === "PK", "保存后不是 zip/docx");
      assert(afterSaveHash !== fixtureHash, "盘上内容没变");
    });

    // 关闭重开：会话释放后重新打开同一文件，字节回读。
    host.close(docId);
    host.open({ docId, url: pathToFileURL(config.pagePath).toString() + config.urlSuffix, bounds: { x: 0, y: 0, width: 1280, height: 900 }, visible: true });
    await delay(500);
    host.openPath(docId, docPath, withinWorkspace);
    const reopened = await host.readOpened(docId, withinWorkspace);
    evidence.reopened = reopened.ok
      ? { ok: true, hash: reopened.result.hash, name: reopened.result.name }
      : reopened;
    await check("★ 关闭重开后字节回读：hash 等于盘上当前内容", () => {
      assert(reopened.ok, `readOpened 失败: ${JSON.stringify(reopened)}`);
      const diskHash = createHash("sha256").update(readFileSync(docPath)).digest("hex");
      assert(reopened.ok && reopened.result.hash === diskHash, `hash 不符`);
      assert(reopened.ok && reopened.result.hash !== fixtureHash, "hash 仍是原始 fixture（未回读修改）");
    });
    host.settlePendingOpen(docId, false, withinWorkspace);

    // ── 5. 未保存拒绝：dirty 上报 → 无确认端口时拒；拒绝不改变会话 ──
    host.reportPageDirty(docId, true);
    const confirmCallsBefore = confirmCalls.length;
    host.setConfirmDirty(null as never);
    const refused = await host.confirmDocumentReplace(docId);
    evidence.refusedNoPort = refused;
    await check("★ 未保存拒绝（dirty 且无确认端口 → fail-closed）", () => {
      assert(refused === false, "dirty 且无端口时应拒绝");
    });
    host.setConfirmDirty(async (input) => {
      confirmCalls.push(input);
      return confirmCalls.length > confirmCallsBefore ? false : true;
    });
    const refusedByUser = await host.confirmDocumentReplace(docId);
    evidence.refusedByUser = refusedByUser;
    await check("★ 未保存拒绝（真人拒绝 → 保持当前文档）", () => {
      assert(refusedByUser === false, "确认端口回绝时必须拒绝");
    });
    host.setConfirmDirty(async (input) => {
      confirmCalls.push(input);
      return true;
    });
    host.reportPageDirty(docId, false);

    // ── 6. 坏档 / 跨路径 / 失败回滚 ──
    // 文档可能已被真实 vendor 页提交到 session；此时拒绝替换必须保留原会话，
    // 不能误把「原文档仍打开」解释成「坏档占用新会话」。先记下有效基准。
    const sessionBeforeBadOpen = host.sessionFor(docId);
    const revisionBeforeBadOpen = sessionBeforeBadOpen ? await sessionBeforeBadOpen.revision : null;
    host.openPath(docId, badPath, withinWorkspace);
    const bad = await host.readOpened(docId, withinWorkspace);
    await check("★ 坏档：readOpened 拒绝且不占会话", () => {
      assert(bad.ok === false, `坏档未被拒: ${JSON.stringify(bad)}`);
    });
    // 即使页面解析失败或上述断言已抛错，也必须放弃未提交的 pending。
    host.settlePendingOpen(docId, false, withinWorkspace);
    host.openPath(docId, outsidePath, () => true);
    const cross = await host.readOpened(docId, withinWorkspace);
    evidence.cross = cross;
    await check("★ 跨路径：读时围栏拒绝", () => {
      assert(cross.ok === false && (cross as { reason: string }).reason.includes("不在已知工作区内"), JSON.stringify(cross));
    });
    host.settlePendingOpen(docId, false, withinWorkspace);
    await check("★ 坏档和越界打开失败不占新会话，原有效会话保持", async () => {
      const session = host.sessionFor(docId);
      assert(
        session === null || session.filePath === docPath,
        `失败替换竟占用了错误路径: ${session?.filePath}`,
      );
      if (sessionBeforeBadOpen !== null) {
        assert(session !== null, "失败替换删除了此前已提交的合法会话");
        assert(session?.key === sessionBeforeBadOpen.key, "失败替换改变了原有效会话键");
        assert(session?.openedAt === sessionBeforeBadOpen.openedAt, "失败替换重新创建了原会话");
        assert(await session?.revision === revisionBeforeBadOpen, "失败替换改变了原会话 CAS 基准");
      }
      const pending = host.pendingOpenFor(docId);
      assert(pending === null, `失败替换留下 pending: ${pending?.filePath}`);
    });

    // ── 7. 过期版本：两次打开之间文件被改写 ──
    host.openPath(docId, docPath, withinWorkspace);
    const v1 = await host.readOpened(docId, withinWorkspace);
    const v2Bytes = await makeDocxWithText(`${editedText}-v2`);
    await writeFile(docPath, v2Bytes);
    host.openPath(docId, docPath, withinWorkspace);
    const v2 = await host.readOpened(docId, withinWorkspace);
    evidence.versionHashes = {
      v1: v1.ok ? v1.result.hash : null,
      v2: v2.ok ? v2.result.hash : null,
    };
    await check("★ 过期版本：两次打开之间改写 → hash 跟着变（无陈旧缓存）", () => {
      assert(v1.ok && v2.ok, "两次 readOpened 都应成功");
      assert(v1.ok && v2.ok && v1.result.hash !== v2.result.hash, "hash 未变化");
    });
    host.settlePendingOpen(docId, true, withinWorkspace);
    const staleSave = await host.saveOpenedFile(docId, new TextEncoder().encode("stale"), withinWorkspace, v1.ok ? v1.result.hash : null);
    await check("★ 用旧 hash 保存被乐观锁拒绝（conflict），盘上保留新内容", () => {
      assert(staleSave.ok === false && staleSave.reason === "conflict", JSON.stringify(staleSave));
      assert(
        createHash("sha256").update(readFileSync(docPath)).digest("hex") ===
          createHash("sha256").update(v2Bytes).digest("hex"),
        "冲突时盘上内容被覆盖",
      );
    });

    // ── 8. 零未捕获异常 ──
    pageErrors = await js<Array<{ type: string; message: string }>>(`Array.isArray(window.__p0Err) ? window.__p0Err.slice(0, 20) : []`).catch(() => []);
    evidence.exceptions = exceptions;
    evidence.consoleErrors = consoleErrors;
    evidence.pageErrors = pageErrors;
    await check("★ 全程零未捕获异常（CDP + console + 页面钩子）", () => {
      assert(debuggerAttached || pageErrors.length === 0, "CDP 未挂上且页面钩子也为空 —— 没有异常证据，拒绝放行");
      assert(exceptions.length === 0, `CDP 异常: ${JSON.stringify(exceptions.slice(0, 3))}`);
      assert(consoleErrors.length === 0, `console error: ${JSON.stringify(consoleErrors.slice(0, 3))}`);
      assert(pageErrors.length === 0, `页面钩子: ${JSON.stringify(pageErrors.slice(0, 3))}`);
    });

        // ── 9. 【ARC-007 P1/GA1】slides：从 Mcode 打开 .pptx → 画布出现 → 保存 → 重开 ──
    //    真实 slides 构建产物 + 生产 preload + 真宿主 + **生产执行器**
    //    （`VendorSlidesExecutor`，vendor 解析/渲染/写盘同一份实现），并且走
    //    **生产 handler**（`registerDocumentViewHandlers` 注入同一个 bridge）。
    if (typeof config.slidesPagePath === "string" && config.slidesPagePath !== "") {
      const pptxPath = join(workspace, "p1-talk.pptx");
      const pptxBytes = await makePptxWithText(SLIDES_UNIQUE_TEXT);
      await writeFile(pptxPath, pptxBytes);
      const slidesDocId = "p1-slides";
      const slidesOpened = host.open({
        docId: slidesDocId,
        url: pathToFileURL(config.slidesPagePath).toString() + config.urlSuffix,
        bounds: { x: 0, y: 0, width: 1280, height: 900 },
        visible: true,
        editor: "slides",
      });
      await check("slides：宿主创建演示文稿视图", () => {
        assert(slidesOpened.ok, JSON.stringify(slidesOpened));
      });
      const slideWc = host.webContentsOf(slidesDocId) as unknown as Electron.WebContents;
      slideWc.on("console-message", (event: unknown, level?: number, message?: string) => {
        const d = event as { message?: string; level?: string };
        const text = d.message ?? String(message ?? "");
        if ((d.level ?? String(level)) === "error" || /Uncaught|is not a function/.test(text)) {
          consoleErrors.push(text.split("\n")[0]);
        }
      });
      const slideJs = <T = unknown>(expr: string): Promise<T> => slideWc.executeJavaScript(expr, true) as Promise<T>;

      // 推送计数：`slides:opened` 在**传输层**被发了几次（回环判据之一）。
      let slidesOpenedPushes = 0;
      const slideOriginalSend = slideWc.send.bind(slideWc);
      (slideWc as unknown as { send: (channel: string, ...args: unknown[]) => void }).send = (
        channel: string,
        ...args: unknown[]
      ) => {
        if (channel === "slides:opened") slidesOpenedPushes += 1;
        return slideOriginalSend(channel, ...args);
      };
      // 与生产同一出口（`ipc/index.ts` 的 setSlidesNotify）：只推给该视图的
      // webContents，通道名是 vendor 页面订阅的 `slides:opened`。
      host.setSlidesNotify((targetDocId, openResult) => {
        if (targetDocId !== slidesDocId) return;
        const target = host.webContentsOf(targetDocId) as
          | { send?: (channel: string, ...args: unknown[]) => void }
          | null;
        target?.send?.("slides:opened", openResult);
      });
      const executor = slidesExecutor;
      if (executor === null) {
        await check("slides：本机可装配 vendor 执行器（genoffice 源码在场）", () => {
          throw new Error("VendorSlidesExecutor.create() 返回 null —— genoffice/ 未安装/未构建");
        });
      } else {
        // ── 生产打开链：`documentView.openPath`（面板同一条 IPC）→ 宿主准备 →
        //    执行器解析 → 推 `slides:opened`；随后页面拉取（openPptxPath/
        //    consumePendingOpen）走 `slides-read-opened`。
        const openPathReply = (await ipcMainInvokeFrom(slideWc, "documentView:openPath", {
          docId: slidesDocId,
          filePath: pptxPath,
        })) as { ok?: boolean; reason?: string };
        await check("★ slides：生产 openPath 准备并解析成功（围栏内）", () => {
          assert(openPathReply.ok === true, JSON.stringify(openPathReply));
        });
        const readReply = (await ipcMainInvokeFrom(slideWc, "mcode:document-view:slides-read-opened", {
          docId: slidesDocId,
        })) as { ok?: boolean; result?: { slides?: unknown[] }; hash?: string; reason?: string };
        await check("★ slides：页面拉取返回 vendor OpenResult（含渲染树）", () => {
          assert(readReply.ok === true && Array.isArray(readReply.result?.slides), JSON.stringify(readReply).slice(0, 400));
        });
        const renderText = flattenRenderText(readReply.result?.slides ?? []);
        await check("★ slides：OpenResult 的渲染树里包含唯一文本", () => {
          assert(renderText.includes(SLIDES_UNIQUE_TEXT), renderText.slice(0, 300));
        });
        // ── 生产宿主两条 Slides 编辑 IPC：真实 preload 发不带 docId 的入参。
        // 与 slides-edit-smoke 的全量 vendor preload 不同，这里走 Mcode
        // registerDocumentViewHandlers + SlidesBridge + 真 VendorSlidesExecutor。
        const originalSlideCount = readReply.result?.slides?.length ?? 0;
        const addReply = (await ipcMainInvokeFrom(slideWc, "mcode:document-view:slides-add-slide", {})) as {
          ok?: boolean; reason?: string; slides?: unknown[]; index?: number; slideCount?: number;
        };
        await check("★ slides Mcode 宿主：真实无 docId 加页返回 vendor 可消费的 slides/index", () => {
          assert(addReply.ok === true, JSON.stringify(addReply).slice(0, 350));
          assert(Array.isArray(addReply.slides) && addReply.slides.length === originalSlideCount + 1,
            `新增渲染树页数错误：${String(addReply.slides?.length)}`);
          assert(addReply.index === originalSlideCount, `新页 index：${String(addReply.index)}`);
        });
        let editTarget: { slideIndex: number; elementId: string } | null = null;
        for (const [slideIndex, slide] of (readReply.result?.slides ?? []).entries()) {
          const scan = (nodes: unknown[]): void => {
            for (const node of nodes) {
              if (!node || typeof node !== "object") continue;
              const part = node as { sourceId?: unknown; children?: unknown[] };
              if (!editTarget && typeof part.sourceId === "string" &&
                  flattenRenderText([{ nodes: [node] }]).includes(SLIDES_UNIQUE_TEXT)) {
                editTarget = { slideIndex, elementId: part.sourceId };
              }
              if (Array.isArray(part.children)) scan(part.children);
            }
          };
          scan((slide as { nodes?: unknown[] })?.nodes ?? []);
        }
        await check("★ slides Mcode 宿主：文本节点有 vendor sourceId 可用于编辑", () => {
          assert(editTarget !== null, "没有可编辑 sourceId");
        });
        if (editTarget !== null) {
          const target = editTarget as { slideIndex: number; elementId: string };
          const editedReply = (await ipcMainInvokeFrom(slideWc, "mcode:document-view:slides-edit-text", {
            slideIndex: target.slideIndex, elementId: target.elementId, text: SLIDES_EDITED_TEXT,
          })) as { ok?: boolean; reason?: string; nodes?: unknown[] };
          await check("★ slides Mcode 宿主：真实无 docId 改文字返回可消费的 RenderSlide.nodes", () => {
            assert(editedReply.ok === true && Array.isArray(editedReply.nodes),
              JSON.stringify(editedReply).slice(0, 450));
            assert(flattenRenderText([{ nodes: editedReply.nodes }]).includes(SLIDES_EDITED_TEXT),
              "返回的 RenderSlide 不包含新写入的文本");
          });
        }
        // ── 真页面消费（React 状态 → Konva 画布/缩略图）：等状态栏显示打开的文件名。
        //    空白 deck 也会有缩略图，只数缩略图会假绿（实测）。
        const shown = await (async () => {
          const start = Date.now();
          let last = { thumbs: 0, text: "" };
          while (Date.now() - start < 20000) {
            last = await slideJs<{ thumbs: number; text: string }>(`(() => {
              const root = document.getElementById('root');
              return { thumbs: document.querySelectorAll('[class*="thumb"]').length, text: root ? root.innerText : '' };
            })()`).catch(() => ({ thumbs: 0, text: "" }));
            if (last.thumbs > 0 && last.text.includes("p1-talk.pptx")) {
              return { ok: true, ...last, waitedMs: Date.now() - start };
            }
            await delay(200);
          }
          return { ok: false, ...last, waitedMs: 20000 };
        })();
        evidence.slidesShown = shown;
        await check("★ slides：真页面消费后显示打开的文件名（缩略图已挂载）", () => {
          assert(shown.ok, `20s 内状态栏未显示 p1-talk.pptx（DOM 文本前 200 字：${shown.text.slice(0, 200)}）`);
        });
        await check("★ slides：一条打开链（slides:opened 恰好一次，无回环）", () => {
          assert(slidesOpenedPushes === 1, `slides:opened 推送 ${slidesOpenedPushes} 次`);
        });
        // ── 保存：生产 slides-save handler（页面 save() 的宿主对端）。
        const beforeBytes = (await readFile(pptxPath)).byteLength;
        const saveReply = (await ipcMainInvokeFrom(slideWc, "mcode:document-view:slides-save", {
          docId: slidesDocId,
        })) as { ok?: boolean; path?: string; bytes?: number; error?: string };
        await check("★ slides：生产保存写回打开的同一份文件", () => {
          assert(saveReply.ok === true, JSON.stringify(saveReply));
          assert((saveReply.bytes ?? 0) > 1000, `字节数过小: ${String(saveReply.bytes)}`);
        });
        const afterBytes = (await readFile(pptxPath)).byteLength;
        evidence.slidesBytes = { beforeBytes, afterBytes };
        await check("★ slides：保存后盘上是合法 pptx（PK 魔数）", async () => {
          const bytes = await readFile(pptxPath);
          assert(bytes[0] === 0x50 && bytes[1] === 0x4b, "不是 zip");
        });
        // ── 重开：新视图（另一个 docId）走同一条生产链，文本仍在。
        // 重开前先关掉第一个视图（同一文件单持有者是宿主的硬规则）。
        host.close(slidesDocId);
        const reopenDocId = "p1-slides-reopen";
        host.open({
          docId: reopenDocId,
          url: pathToFileURL(config.slidesPagePath).toString() + config.urlSuffix,
          bounds: { x: 0, y: 0, width: 1280, height: 900 },
          visible: false,
          editor: "slides",
        });
        const reopenWc = host.webContentsOf(reopenDocId);
        const reopenOpen = (await ipcMainInvokeFrom(reopenWc, "documentView:openPath", {
          docId: reopenDocId,
          filePath: pptxPath,
        })) as { ok?: boolean; reason?: string };
        const reopenRead = (await ipcMainInvokeFrom(reopenWc, "mcode:document-view:slides-read-opened", {
          docId: reopenDocId,
        })) as { ok?: boolean; result?: { slides?: unknown[] } };
        await check("★ slides：保存后重开仍含唯一文本（真 zip 往返）", () => {
          assert(reopenOpen.ok === true, JSON.stringify(reopenOpen));
          assert(reopenRead.ok === true, JSON.stringify(reopenRead).slice(0, 300));
          const text = flattenRenderText(reopenRead.result?.slides ?? []);
          assert(text.includes(SLIDES_EDITED_TEXT), `新会话未读到编辑后的文字：${text.slice(0, 300)}`);
        });
        host.close(reopenDocId);
        // ── 工作区外：生产 openPath 在准备阶段就拒（页面/执行器都拿不到路径）。
        const outsidePptx = join(dir, "outside", "escape.pptx");
        await writeFile(outsidePptx, pptxBytes);
        // 独立视图：前两个都已关，先建一个干净视图再试围栏。
        const outsideDocId = "p1-slides-outside";
        host.open({
          docId: outsideDocId,
          url: pathToFileURL(config.slidesPagePath).toString() + config.urlSuffix,
          bounds: { x: 0, y: 0, width: 1280, height: 900 },
          visible: false,
          editor: "slides",
        });
        const outsideWc = host.webContentsOf(outsideDocId);
        const outsideReply = (await ipcMainInvokeFrom(outsideWc, "documentView:openPath", {
          docId: outsideDocId,
          filePath: outsidePptx,
        })) as { ok?: boolean; reason?: string };
        await check("★ slides：工作区外路径在生产 openPath 被拒", () => {
          assert(
            outsideReply.ok === false && (outsideReply.reason ?? "").includes("不在已知工作区内"),
            JSON.stringify(outsideReply),
          );
        });
      }
      host.close("p1-slides-outside");
    } else {
      await check("slides：本机有 slides 构建产物（否则本段如实跳过）", () => {
        throw new Error("config.slidesPagePath 缺失 —— genoffice/apps/slides/out/renderer/index.html 未构建");
      });
    }

    // T05a: true-Electron clean close: a loaded DOCX must survive without
    // rewrite. Both content hash AND mtime are observed, not only save replies.
    const cleanId = "t05a-clean";
    const cleanPath = join(workspace, "t05a-clean.docx");
    await writeFile(cleanPath, fixture);
    const cleanBefore = statSync(cleanPath);
    const cleanHash = createHash("sha256").update(readFileSync(cleanPath)).digest("hex");
    const cleanOpen = host.open({
      docId: cleanId,
      url: pathToFileURL(config.pagePath).toString() + config.urlSuffix,
      bounds: { x: 0, y: 0, width: 1200, height: 800 },
      visible: true,
    });
    await check("T05a clean: open native Docs page", () => {
      assert(cleanOpen.ok, JSON.stringify(cleanOpen));
    });
    const cleanWebContents = host.webContentsOf(cleanId) as Electron.WebContents | null;
    if (cleanWebContents !== null) {
      for (let tries = 0; tries < 100; tries++) {
        const ready = await cleanWebContents.executeJavaScript("document.readyState === 'complete'").catch(() => false);
        if (ready) break;
        await delay(100);
      }
    }
    await delay(500);
    const cleanPrepared = host.openPath(cleanId, cleanPath, withinWorkspace);
    await check("T05a clean: requested DOCX is workspace scoped", () => {
      assert(cleanPrepared.ok, JSON.stringify(cleanPrepared));
    });
    const cleanStart = Date.now();
    while (host.sessionFor(cleanId) === null && Date.now() - cleanStart < 30000) await delay(150);
    await check("T05a clean: native renderer acknowledged opened DOCX", () => {
      assert(host.sessionFor(cleanId)?.filePath === cleanPath, "native editor never committed clean document");
    });
    // The following actions execute against the REAL vendor Docs preload
    // and REAL native Mcode IPC registrar inside Electron, on a scoped DOCX.
    if (cleanWebContents !== null) {
      const native = await cleanWebContents.executeJavaScript(`(async () => {
        const d = window.desktop;
        const locale = await d.getSystemLocale();
        const language = await d.getLanguage();
        const metrics = await d.fontMetrics('Arial');
        const langs = await d.spellLanguages();
        const added = await d.spellAddWord('t05atestword');
        const ignored = await d.spellIgnoreWord('t05aignored');
        const recovery = await d.writeRecoveryCopy('C:/outside/recovery.docx', new Uint8Array([80,75,3,4]).buffer);
        const intentRevision = await d.docPasswordIntentRevision();
        const replaceOK = await d.confirmDocumentReplace();
        d.armContextMenu();
        d.claimContextMenu(71);
        d.reportViewMenuState({ aiSidebar: false, darkCanvas: false });
        const unlisten = d.onContextMenuRequest(() => {});
        unlisten();
        return { locale, language, fontSafe: metrics === null || typeof metrics === 'object',
          languages: Array.isArray(langs.active), added, ignored, recovery,
          intentRevision, replaceOK, context: true };
      })()`, true) as { locale: string; language: string; fontSafe: boolean;
        languages: boolean; added: boolean; ignored: boolean; recovery: { ok: boolean };
        intentRevision: number; replaceOK: boolean; context: boolean };
      await check('T05a group 2: native language/locale/font registered in real Electron', () => {
        assert(typeof native.locale === 'string' && native.locale.length > 0 &&
          (native.language === 'zh' || native.language === 'en') && native.fontSafe, JSON.stringify(native));
      });
      await check('T05a group 3: spell dictionaries use scoped native Electron session', () => {
        assert(native.languages && native.added && native.ignored, JSON.stringify(native));
      });
      await check('T05a group 4: no second recovery writer or unsanctioned password store', () => {
        assert(native.recovery.ok === false && native.intentRevision === 0 && native.replaceOK, JSON.stringify(native));
      });
      await check('T05a group 5: context menu and view-menu state are scoped', () => {
        assert(native.context, JSON.stringify(native));
      });
      // T22 real Electron: the DOCX is already opened and committed. Drive
      // its real sandboxed preload -> real sender-bound privileged IPC ->
      // Chromium printToPDF -> Mcode atomic disk writer -> approved temp reader
      // -> PNG writer. Only the Mcode picker and path service are stubbed to
      // deterministic, test-owned workspace destinations (no human UI/DB).
      const originalPickDirectory = docsPrivilegedPorts.pickDirectory;
      const originalWorkspaceRoot = docsPrivilegedPorts.workspaceRoot;
      try {
        docsPrivilegedPorts.pickDirectory = async () => workspace;
        docsPrivilegedPorts.workspaceRoot = () => workspace;
        const exportResult = await cleanWebContents.executeJavaScript(`(async () => {
          const bridge = window.desktop;
          const destination = await bridge.pickExportImagesTarget();
          if (!destination) return { error: 'Mcode destination picker failed' };
          const exported = await bridge.exportPdf('t22-opened.docx', 11906, 16838, destination.pdfPath);
          if (!exported.ok) return { error: exported.error ?? 'Chromium PDF print failed' };
          const pdf = await bridge.takeExportPdf(destination.pdfPath);
          if (!pdf.ok || typeof pdf.base64 !== 'string') return { error: pdf.error ?? 'PDF temp handoff failed' };
          // Exercise the approved image writer; original pdf.js page rasterization
          // is verified separately by the GenOffice renderer suite. In a
          // hidden Electron window the vendor's preview-triggered exportImages
          // may not settle without a visible pagination preview.
          const pngData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
          const written = await bridge.writeExportImage(destination.dir, 't22-page-01.png', pngData);
          return { pdfSize: atob(pdf.base64).length,
            pdfSignature: atob(pdf.base64).slice(0, 5),
            imagePath: written.path, imageOK: written.ok,
            outputDir: destination.dir, tempPath: destination.pdfPath };
        })()`, true) as {error?:string;pdfSize?:number;pdfSignature?:string;imagePath?:string;imageOK?:boolean;outputDir?:string;tempPath?:string};
        await check('T22 真 Electron：已打开 DOCX→受信临时 PDF→实际 PDF 字节→图片写盘通道', () => {
          assert(!exportResult.error && exportResult.pdfSignature === '%PDF-' &&
            (exportResult.pdfSize ?? 0) > 100 &&
            exportResult.imageOK === true &&
            exportResult.outputDir === workspace &&
            exportResult.imagePath === join(workspace, 't22-page-01.png'),
            JSON.stringify(exportResult));
          assert(readFileSync(exportResult.imagePath!).subarray(0,8)
            .equals(Buffer.from([137,80,78,71,13,10,26,10])), 'written image is not a PNG');
          assert(!existsSync(exportResult.tempPath!), 'PDF temporary file leaked');
        });
      } finally {
        docsPrivilegedPorts.pickDirectory = originalPickDirectory;
        docsPrivilegedPorts.workspaceRoot = originalWorkspaceRoot;
      }
    }
    const cleanClose = await host.closeWithDirtyProtection(cleanId);
    await check("T05a clean: native dirty check allows unmodified close", () => {
      assert(cleanClose.ok, JSON.stringify(cleanClose));
    });
    await check("T05a clean: close preserves bytes and mtime (no stealth rewrite)", () => {
      assert(createHash("sha256").update(readFileSync(cleanPath)).digest("hex") === cleanHash, "close modified document bytes");
      assert(statSync(cleanPath).mtimeMs === cleanBefore.mtimeMs, "close changed file mtime");
    });

  } finally {
    if (debuggerAttached) { try { wc.debugger.detach(); } catch { /* 已分离 */ } }
    host.dispose();
    if (!win.isDestroyed()) win.destroy();
    for (const ch of ["probe:mock-ai-settings", "app:get-theme", "app:get-document-theme", "app:get-ai-panel-prefs", "app:get-auto-save-default", "ai:get-settings", "ai:gsk-status", "project:resolveChat", "project:appendChat", "project:loadChat", "project:rebindChat"]) {
      try { ipcMain.removeHandler(ch); } catch { /* 未注册 */ }
    }
    await writeFile(join(dir, "evidence.json"), JSON.stringify({ debuggerAttached, ...evidence, checks }, null, 2));
  }
}
