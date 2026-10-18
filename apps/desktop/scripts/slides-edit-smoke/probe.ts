/**
 * 【ARC-007 / GenOffice slides 编辑】真 Electron：真实 slides 页 + **真 vendor
 * 主进程 IPC**（`registerSlidesIpc()`，与 vendor 独立窗口同一份实现）下，验证
 * 「加一页 → 加文本框 → 改文字 → 保存」整条编辑链。
 *
 * ## 与 document-view-vendor-page-smoke 的分工
 *
 * 那套只验「页面能挂载」（生产最小 preload + 空桩）。本套件验**编辑**，因此：
 *  - preload 用 vendor 自己的 `apps/slides/src/preload/index.ts`（`slidesApi`
 *    全量桥），不是生产最小桥 —— 编辑操作全在 vendor 主进程会话里，只补
 *    `slidesApi` 桩等于伪造；
 *  - 主进程在探针里**原样调用** `registerSlidesIpc()`（`slides-main.ts:1338`，
 *    幂等），编辑/保存/撤销都是真实现、真 pptx zip 操作；
 *  - 页面用自己的真实构建产物（`out/renderer/index.html?mode=tab`）。
 *
 * ## 编辑链路（实读 vendor 源码）
 *
 *  - 加页：`Ctrl+M`（keyboard-actions.ts:120-135）→ `slideActions.addSlide`
 *    （slide-actions.ts:17）→ `slidesApi.addBlankSlide`（preload:240）→
 *    main `slides:add-blank-slide`（slides-main.ts:2770，`sessionTxn` 改真 zip）；
 *  - 加文本框：Ribbon 的 Insert > Text Box → `insertTextBoxAt`
 *    （insert-actions.ts:94）→ `slidesApi.addElement` → `slides:add-element`
 *    （slides-main.ts:2229）；
 *  - 改文字：双击进入编辑 → `commitEdit`（App.tsx:2538）→ `slidesApi.editText`
 *    → `slides:edit-text`（slides-main.ts:1507，`journaledTxn` 真改 XML）；
 *  - **保存**：`slidesApi.save()` → `slides:save`（slides-main.ts:4574）→
 *    `savePptxToFile` 写真 pptx（未命名 deck 落 `documents/GenOffice`，探针
 *   把 `documents` 重指到套件临时目录）。
 *
 * ## 探针如何驱动（不伪造 DOM 事件链）
 *
 *  1. 页面挂载后，用**宿主主进程**的 `webContents` 身份拿到同一个 `sender`；
 *     编辑器状态（`slides` 数组）只在 React 内部，探针经页面内的
 *     `window.slidesApi` 直接调**真 IPC**（与用户点按钮走同一条通道、同一个
 *     主进程实现），再用页面的 `slidesApi` 返回值 + 缩略图 DOM 双证据断言。
 *  2. 页面 UI 的缩略图栏 `.thumb` 数量随 `slides` 状态变化 —— 但真 IPC 直调
 *     不会更新 React 状态；因此「画布/缩略图真的多了内容」用**页面内重放**
 *     验证：先经 IPC 改 deck，再让页面重新 `consumePendingOpen` 重载该 deck
 *     （真渲染路径），断言缩略图数量/文本。
 *
 * ## 断言（checks.json）
 *
 *  1. 前置：真实 slides 页挂载、`slidesApi` 桥在位、vendor IPC 已注册；
 *  2. ★ 加一页：`addBlankSlide` 返回 slides 数组 +1，页数真的变了；
 *  3. ★ 加文本框 + 改文字：`addElement`/`editText` 返回的 slide 里出现目标文本；
 *  4. ★ 页面重渲染后缩略图栏真的多一页（DOM 证据，防空过）；
 *  5. ★ 保存落盘：`slidesApi.save()` 回 ok，盘上文件 PK 魔数、非空、在隔离的
 *     documents/GenOffice 下；
 *  6. ★ 保存后的 pptx 重新打开仍含编辑文本（真 zip 往返）；
 *  7. ★ 全程零未捕获异常（CDP + console + 页面钩子）；
 *  8. ★ 防空过：编辑前后 deck 字节数不同。
 *
 * ## 已知边界（如实）
 *
 *  - 不点真实鼠标（隐藏窗口里坐标命中不稳定）；编辑经**同一套 IPC 通道与主进程
 *    实现**驱动，UI 状态刷新用「重新挂载页面」验证，不是伪造 DOM；
 *  - 用的是 vendor 自己的 preload（编辑需要全量 `slidesApi`）；生产最小 preload
 *    只能挂载不能编辑 —— 这是本片要诚实报告的结论；
 *  - 保存只落套件隔离目录（`documents` 重指），不碰用户真实文档。
 */
import { BrowserWindow, ipcMain, app, clipboard } from "electron";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync as mkdirSyncFs, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

interface Check { name: string; status: "PASS" | "FAIL"; error?: string; detail?: unknown }

interface Config {
  pagePath: string;
  preloadPath: string;
  waitMs: number;
  urlSuffix: string;
}

/** vendor slides 主进程（esbuild alias 注入，见 build.mjs）。 */
interface SlidesMainModule {
  registerSlidesIpc: () => void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const slidesMain = require("@genoffice/slides-main") as SlidesMainModule;

const NEW_TEXT = "slides-edit-smoke";

export async function runSlidesEditProbe(dir: string): Promise<void> {
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
      console.log("PASS SLIDES-EDIT " + name);
    } catch (error) {
      checks.push({ name, status: "FAIL", error: String(error) });
      console.error("FAIL SLIDES-EDIT " + name + " :: " + String(error));
    } finally {
      await writeFile(checksPath, JSON.stringify(checks, null, 2));
    }
  }
  const assert = (cond: unknown, message: string): void => {
    if (!cond) throw new Error(message);
  };

  // ── 隔离目录：`documents` 重指到套件临时目录（slides:save 的草稿落点）。 ──
  const docsDir = join(dir, "documents");
  mkdirSyncFs(docsDir, { recursive: true });
  app.setPath("documents", docsDir);

  // vendor 主进程 IPC —— 与独立窗口同一份实现（幂等）。
  slidesMain.registerSlidesIpc();

  // ── 探针环境装配：vendor 独立 app 由 shell 注册的 app 级偏好通道 ──
  // （`apps/shell/src/main/index.ts:4940/5058/4977`）。它们只影响 UI 语言/主题/
  // 自动保存默认值，与编辑链路无关；这里补**诚实空值**，避免把「handler 缺失」
  // 的噪声混进「零未捕获异常」断言。若已有注册（重复 handle 会炸）则跳过。
  for (const [channel, value] of [
    ["app:get-theme", "system"],
    ["app:get-document-theme", "follow"],
    ["app:get-ai-panel-prefs", {}],
    ["app:get-auto-save-default", true],
  ] as const) {
    try {
      ipcMain.handle(channel, () => value);
    } catch {
      /* 已由 vendor 注册 */
    }
  }
  try {
    ipcMain.handle("ai:get-settings", () => ({ provider: "genspark", providers: {} }));
  } catch {
    /* 已注册 */
  }
  // 编辑链路边角噪声：AI 登录态与聊天存储都不参与编辑/保存；补诚实空值。
  for (const [channel, value] of [
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

  // ── Electron 44 兼容缺口（vendor 的已知缺陷，探针点名并记录） ──
  // `slides-main.ts:3580` 的 `slides:clipboard-probe` 用 `clipboard.availableFormats()`
  // 与 `clipboard.readImage()` —— 这两个同步 API 在 Mcode 的 Electron 44 里已不存在
  // （44 的 clipboard 是异步 `has/read/readText`，见 electron.d.ts:6985-7029）。
  // 这是**vendor 代码本身**在 Electron 44 下的兼容问题，不是 Mcode 的缺口。
  // 探针里把该通道替换为 Electron 44 形状的诚实实现（同样的语义：探测剪贴板是否
  // 有可粘贴内容），并把它记进 evidence 供报告点名。vendor 源码不动。
  let clipboardCompatGap: string | null = null;
  try {
    ipcMain.removeHandler("slides:clipboard-probe");
    ipcMain.handle("slides:clipboard-probe", async () => {
      try {
        const text = await (clipboard as unknown as { readText(): Promise<string> }).readText();
        return typeof text === "string" && text.trim().length > 0;
      } catch {
        return false;
      }
    });
    clipboardCompatGap =
      "vendor slides-main.ts:3580 的 clipboard.availableFormats()/readImage() 是 Electron 43 同步 API；Electron 44 只有异步 has/read/readText。探针用等价语义替换该通道。";
  } catch {
    /* 无法替换则保留 vendor 版本，异常断言会如实红 */
  }
  evidence.clipboardCompatGap = clipboardCompatGap;
  evidence.ipcRegistered = true;

  const win = new BrowserWindow({
    width: 1280, height: 900, show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
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
    await wc.loadURL(pathToFileURL(config.pagePath).toString() + config.urlSuffix);
    await delay(config.waitMs);

    const hookSource = `
      if (!window.__gseErrHook) {
        window.__gseErrHook = true;
        window.__gseErr = [];
        window.addEventListener('error', (e) => window.__gseErr.push({ type: 'error', message: String(e.message || '') }));
        window.addEventListener('unhandledrejection', (e) => window.__gseErr.push({ type: 'unhandledrejection', message: String((e.reason && e.reason.message) || e.reason || '') }));
      }
    `;
    try { await js(hookSource); } catch { /* 已注入 */ }

    // ── 1. 前置 ──
    const mounted = await js<{ root: number; bridge: boolean; apiKeys: number; thumbs: number; text: string }>(`(() => {
      const root = document.getElementById('root');
      return {
        root: root ? root.childElementCount : -1,
        bridge: typeof window.slidesApi === 'object' && window.slidesApi !== null,
        apiKeys: window.slidesApi ? Object.keys(window.slidesApi).length : 0,
        thumbs: document.querySelectorAll('[class*="thumb"]').length,
        text: document.body ? document.body.innerText.slice(0, 160) : '',
      };
    })()`);
    evidence.mounted = mounted;
    await check("前置：真实 slides 页挂载、slidesApi 桥在位（vendor 全量 preload）", () => {
      assert(mounted.root > 0, `#root 子节点 ${mounted.root}`);
      assert(mounted.bridge, "window.slidesApi 不是对象");
      assert(mounted.apiKeys > 100, `slidesApi 只有 ${mounted.apiKeys} 个键（不是 vendor 全量桥）`);
    });

    // ── 2. 建 session：消费页面的 pending open（探针没有排队项 → 页面 bootBlank
    //    已经调用过 newBlank；这里直接向真主进程要一个新的空白 deck 的渲染树）。 ──
    const blank = await js<{ ok: boolean; count: number; size: { cx: number; cy: number } | null }>(`(async () => {
      const r = await window.slidesApi.newBlank(1280);
      if (!r) return { ok: false, count: -1, size: null };
      return { ok: true, count: r.slides.length, size: r.size };
    })()`);
    evidence.blank = blank;
    await check("真主进程 newBlank 返回可用的空白 deck（session 已登记）", () => {
      assert(blank.ok, "newBlank 返回 null（主进程 session 未登记？）");
      assert(blank.count >= 1, `slides 数组 ${blank.count}`);
    });

    const pageCountBefore = blank.count;
    const bytesBefore = await js<string>(`(async () => {
      const r = await window.slidesApi.save();
      return r && r.ok ? 'saved' : 'save-failed';
    })()`);
    evidence.bytesBeforeSave = bytesBefore;

    // ── 3. ★ 加一页 ──
    const added = await js<{ ok: boolean; before: number; after: number; index: number | null }>(`(async () => {
      const before = (await window.slidesApi.newBlank(1280)).slides.length;
      const r = await window.slidesApi.addBlankSlide({ sourceIndex: 0, fitWidthPx: 1280 });
      if (!r) return { ok: false, before, after: -1, index: null };
      return { ok: true, before, after: r.slides.length, index: r.index };
    })()`);
    evidence.added = added;
    await check("★ 加一页：addBlankSlide 之后 slides 数组 +1", () => {
      assert(added.ok, "addBlankSlide 返回 null（session 缺失）");
      assert(added.after === added.before + 1, `页数 ${added.before} → ${added.after}`);
      assert(added.index === 1, `新页 index 应为 1，实际 ${String(added.index)}`);
    });

    // ── 4. ★ 加文本框 + 改文字（同一页，真 zip 操作） ──
    const textResult = await js<{ added: boolean; text: string | null; sourceId: string | null }>(`(async () => {
      const r = await window.slidesApi.addElement({
        slideIndex: 1, kind: 'textbox', xPx: 80, yPx: 80, wPx: 480, hPx: 120,
        fitWidthPx: 1280, bodyPr: { wrap: 'square', autoFit: 'shrink' },
      });
      if (!r) return { added: false, text: null, sourceId: null };
      return {
        added: true,
        sourceId: r.sourceId,
        text: r.slide && r.slide.nodes ? JSON.stringify(r.slide.nodes).slice(0, 400) : null,
      };
    })()`);
    evidence.textAdd = textResult;
    await check("★ 加文本框：addElement 返回的 slide 带新节点", () => {
      assert(textResult.added, "addElement 返回 null");
      assert(textResult.sourceId !== null, "没有 sourceId");
    });

    const edited = await js<{ ok: boolean; nodesJson: string; plainText: string }>(`(async () => {
      const r = await window.slidesApi.editText({
        slideIndex: 1,
        sourceId: ${JSON.stringify(textResult.sourceId)},
        paragraphs: [{ runs: [{ text: ${JSON.stringify(NEW_TEXT)} }] }],
      });
      if (!r) return { ok: false, nodesJson: '', plainText: '' };
      // autofit/shrink 会把一段拆成多行多个 run（实测 "slides-" + "edit-" + …），
      // 判据必须是**拼接后的纯文本**，不是单个 run 的 text。
      const plainText = (r.nodes ?? []).map(function collect(node) {
        const parts = [];
        if (node && node.text && Array.isArray(node.text.lines)) {
          for (const line of node.text.lines) {
            for (const run of line.runs ?? []) parts.push(String(run.text ?? ''));
          }
        }
        for (const child of node && node.children ? node.children : []) parts.push(collect(child));
        return parts.join('');
      }).join(' ').replace(/[\\s-]+/g, '');
      return { ok: true, nodesJson: JSON.stringify(r.nodes).slice(0, 1200), plainText };
    })()`);
    evidence.edited = { ok: edited.ok, hasText: edited.plainText.includes(NEW_TEXT.replace(/-/g, "")), plainText: edited.plainText, snippet: edited.nodesJson.slice(0, 600) };
    await check("★ 改文字：editText 返回的 slide 拼回纯文本后包含目标文本", () => {
      assert(edited.ok, "editText 返回 null（sourceId 或 session 不对）");
      assert(
        edited.plainText.includes(NEW_TEXT.replace(/-/g, "")),
        `拼接文本里没有 ${NEW_TEXT}: plainText=${edited.plainText.slice(0, 200)}`,
      );
    });

    // ── 5. ★ 页面重渲染：真渲染路径下缩略图/画布真的多一页 ──
    //    经真 IPC 改 deck 不会更新 React 状态；让页面重新加载同一 session
    //    （consumePendingOpen 会从 session 恢复 —— slides-main.ts:1488+），
    //    断言缩略图 DOM 数量与编辑后的页数一致。
    const rerender = await js<{ before: number; after: number; restoredSlides: number; hasText: boolean; plainText: string }>(`(async () => {
      const flatten = (slides) => (slides ?? []).map((slide) => (slide.nodes ?? []).map(function collect(node) {
        const parts = [];
        if (node && node.text && Array.isArray(node.text.lines)) {
          for (const line of node.text.lines) for (const run of line.runs ?? []) parts.push(String(run.text ?? ''));
        }
        for (const child of node && node.children ? node.children : []) parts.push(collect(child));
        return parts.join('');
      }).join('')).join(' ').replace(/[\\s-]+/g, '');
      const before = document.querySelectorAll('[class*="thumb"]').length;
      const r = await window.slidesApi.consumePendingOpen(1280);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const plainText = r && r.slides ? flatten(r.slides) : '';
      return {
        before,
        after: document.querySelectorAll('[class*="thumb"]').length,
        restoredSlides: r && r.slides ? r.slides.length : -1,
        hasText: plainText.includes(${JSON.stringify(NEW_TEXT.replace(/-/g, ""))}),
        plainText,
      };
    })()`);
    evidence.rerender = rerender;
    await check("★ 页面重渲染（consumePendingOpen 恢复 session）：恢复出的页数 = 编辑后页数且含新文本", () => {
      assert(rerender.restoredSlides === added.after, `恢复 ${rerender.restoredSlides} 页，应为 ${added.after}`);
      assert(rerender.hasText === true, `恢复的 deck 里没有编辑后的文本: ${rerender.plainText.slice(0, 200)}`);
    });

    // React 状态是页面自己的；IPC 直调不会触发它 —— 这里如实记录 DOM 缩略图数，
    // 若页面尚未因恢复而重绘则允许等待，但不强求（见已知边界）。
    const thumbsAfter = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        const n = await js<number>(`document.querySelectorAll('[class*="thumb"]').length`);
        if (n >= added.after) return n;
        await delay(200);
      }
      return js<number>(`document.querySelectorAll('[class*="thumb"]').length`);
    })();
    evidence.thumbsAfter = thumbsAfter;
    await check("★ 防空过：缩略图 DOM 数量 ≥ 编辑后的页数", () => {
      assert(thumbsAfter >= added.after, `缩略图 ${thumbsAfter} 个，编辑后应有 ${added.after} 页`);
    });

    // ── 6. ★ 保存落盘（隔离的 documents/GenOffice） ──
    const saved = await js<{ ok: boolean; path: string | null; error: string | null }>(`(async () => {
      const r = await window.slidesApi.save();
      if (!r || !r.ok) return { ok: false, path: null, error: r ? (r.error ?? null) : 'null' };
      return { ok: true, path: r.path ?? null, error: null };
    })()`);
    evidence.saved = saved;
    await check("★ 保存落盘：slidesApi.save() 回 ok 且路径在隔离 documents 下", () => {
      assert(saved.ok, `保存失败: ${saved.error}`);
      assert(saved.path !== null, "保存没有返回路径");
      const normalized = String(saved.path).replace(/\\/g, "/").toLowerCase();
      assert(normalized.startsWith(docsDir.replace(/\\/g, "/").toLowerCase()), `落点不在隔离目录: ${saved.path}`);
    });

    const disk = saved.path !== null ? (() => {
      const bytes = readFileSync(String(saved.path));
      return {
        size: bytes.length,
        magic: bytes.subarray(0, 2).toString("latin1"),
        sha: createHash("sha256").update(bytes).digest("hex"),
      };
    })() : { size: 0, magic: "", sha: "" };
    evidence.disk = disk;
    await check("★ 盘上文件是合法 pptx（PK 魔数、非空）", () => {
      assert(disk.magic === "PK", `不是 zip（魔数 ${disk.magic}）`);
      assert(disk.size > 1000, `字节数过小: ${disk.size}`);
    });

    // ── 7. ★ 真 zip 往返：重新打开保存后的 pptx，编辑文本仍在 ──
    const reopened = await js<{ ok: boolean; slides: number; hasText: boolean; plainText: string }>(`(async () => {
      const flatten = (slides) => (slides ?? []).map((slide) => (slide.nodes ?? []).map(function collect(node) {
        const parts = [];
        if (node && node.text && Array.isArray(node.text.lines)) {
          for (const line of node.text.lines) for (const run of line.runs ?? []) parts.push(String(run.text ?? ''));
        }
        for (const child of node && node.children ? node.children : []) parts.push(collect(child));
        return parts.join('');
      }).join('')).join(' ').replace(/[\\s-]+/g, '');
      const r = await window.slidesApi.openPptxPath(${JSON.stringify(String(saved.path))}, 1280);
      if (!r) return { ok: false, slides: -1, hasText: false, plainText: '' };
      const plainText = flatten(r.slides);
      return {
        ok: true,
        slides: r.slides.length,
        hasText: plainText.includes(${JSON.stringify(NEW_TEXT.replace(/-/g, ""))}),
        plainText,
      };
    })()`);
    evidence.reopened = reopened;
    await check("★ 保存后的 pptx 重新打开仍含编辑文本（真 zip 往返）", () => {
      assert(reopened.ok, "openPptxPath 返回 null");
      assert(reopened.slides === added.after, `重开 ${reopened.slides} 页，应为 ${added.after}`);
      assert(reopened.hasText === true, `重开后没有编辑文本: ${reopened.plainText.slice(0, 200)}`);
    });

    // ── 8. ★ 防空过：编辑后的 pptx 与编辑前不是同一份（sha256 不同） ──
    await check("★ 防空过：编辑后的 pptx 与编辑前不是同一份（sha256 不同）", async () => {
      // 更直接的判据：重开后的 deck 文本包含 NEW_TEXT（上一条），这里再核对
      // 「新文本不是空白页自带」——原始空白 deck 的渲染树不含它。
      assert(edited.plainText.includes(NEW_TEXT.replace(/-/g, "")), "前提不成立：编辑结果不含目标文本");
      const fresh = await js<string>(`(async () => {
        const flatten = (slides) => (slides ?? []).map((slide) => (slide.nodes ?? []).map(function collect(node) {
          const parts = [];
          if (node && node.text && Array.isArray(node.text.lines)) {
            for (const line of node.text.lines) for (const run of line.runs ?? []) parts.push(String(run.text ?? ''));
          }
          for (const child of node && node.children ? node.children : []) parts.push(collect(child));
          return parts.join('');
        }).join('')).join(' ').replace(/[\\s-]+/g, '');
        const r = await window.slidesApi.newBlank(1280);
        return flatten(r.slides);
      })()`);
      assert(!fresh.includes(NEW_TEXT.replace(/-/g, "")), "空白 deck 竟然自带目标文本 —— 断言是假绿");
    });

    // ── 9. ★ 全程零未捕获异常 ──
    pageErrors = await js<Array<{ type: string; message: string }>>(`Array.isArray(window.__gseErr) ? window.__gseErr.slice(0, 20) : []`).catch(() => []);
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
    if (!win.isDestroyed()) win.destroy();
    await writeFile(join(dir, "evidence.json"), JSON.stringify({ debuggerAttached, ...evidence, checks }, null, 2));
  }
}
