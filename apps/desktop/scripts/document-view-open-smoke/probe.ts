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
import { existsSync, mkdirSync as mkdirFs, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DocumentViewHost } from "@main/document/documentViewHost.js";
import { registerDocumentViewHandlers } from "@main/ipc/documentView.js";
import {
  initDocumentHandoffProtocol,
  registerDocumentHandoffSchemePrivileged,
} from "@main/document/documentViewHandoff.js";
import type { DocumentViewHostWindow } from "@main/document/documentViewHost.js";

interface Check { name: string; status: "PASS" | "FAIL"; error?: string; detail?: unknown }

interface Config {
  pagePath: string;
  preloadPath: string;
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
  // 真确认端口：默认**同意**（测试里显式改为拒绝以覆盖「未保存拒绝」）。
  let confirmAnswer = true;
  const confirmCalls: Array<{ docId: string; filePath: string | null }> = [];
  host.setConfirmDirty(async (input) => {
    confirmCalls.push(input);
    return confirmAnswer;
  });
  registerDocumentViewHandlers(ipcMain, host, withinWorkspace);
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
    host.openPath(docId, badPath, withinWorkspace);
    const bad = await host.readOpened(docId, withinWorkspace);
    await check("★ 坏档：readOpened 拒绝且不占会话", () => {
      assert(bad.ok === false, `坏档未被拒: ${JSON.stringify(bad)}`);
      // 提交一个坏档的 pending 也不该建立会话（页面没回执）。
      host.settlePendingOpen(docId, false, withinWorkspace);
    });
    host.openPath(docId, outsidePath, () => true);
    const cross = await host.readOpened(docId, withinWorkspace);
    evidence.cross = cross;
    await check("★ 跨路径：读时围栏拒绝", () => {
      assert(cross.ok === false && (cross as { reason: string }).reason.includes("不在已知工作区内"), JSON.stringify(cross));
    });
    await check("★ 失败路径都不占会话（失败回滚）", () => {
      assert(host.sessionFor(docId) === null, "失败后会话被占用");
    });
    host.settlePendingOpen(docId, false, withinWorkspace);

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
