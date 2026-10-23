/**
 * T7 —— 六条旅程共用的**装配与断言脚手架**。
 *
 * 每条编辑器旅程的形状都一样（任务卡判据）：
 *
 *   打开真实文件 → 断言内容出现 → 编辑一处 → 保存 → 关闭 → 重开 → 断言改动还在
 *
 * 差异只在「哪种编辑器、怎么编辑、内容长什么样」—— 放在各旅程文件里。
 * 本文件提供：
 *
 *  - `editorSetup(kind)`：装配生产 Host + 原生视图，返回 `pageFromView`；
 *  - 生产 handler 的 sender 身份调用（`invokeAs`）—— 与页面 invoke 是**同一个
 *    函数对象**（`registerDocumentViewHandlers` 注册的那一份）；
 *  - 磁盘事实（sha256 / 文本读回）与 DOM 轮询。
 *
 * ## 为什么保存/关闭走 handler 而不是页面按钮
 *
 * 打开链在**页面侧**（vendor 页调 preload → handler），本套件照真路径走；但
 * 「保存」在六个编辑器里有六种页面内入口（Ctrl+S、Ribbon 按钮、slidesApi），
 * 每种都用真鼠标去点会引入坐标/焦点噪声，而这些入口**不是本卡的判据** —— T13
 * 的判据是「保存后磁盘真的变了、重开后改动还在」。所以保存走**页面自己的
 * preload 桥**（`wc.executeJavaScript` 调 `window.desktop.saveDocx` /
 * `window.slidesApi.save` / `window.markdownApi.save` ……），它与用户点按钮
 * 是同一个桥、同一个主进程实现。**编辑**则一律在页面 DOM/编辑器模型里真改
 * （不是直接写盘），这样「保存」才有意义。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { WebContents } from "electron";

import type { U1SetupContext, U1SetupResult } from "../electron-u1/driver/index.js";
import { assembleHarness, type GenofficeHarness } from "./harness.js";
import { ensureFixtures, type FixturePaths } from "./fixtures.js";

export type EditorKind = "docs" | "sheets" | "slides" | "pdf" | "markdown" | "html";

/** 旅程的 setup 返回的运行时对象（`step.run` 的 `runtime`）。 */
export interface EditorRuntime {
  harness: GenofficeHarness;
  fixtures: FixturePaths;
  kind: EditorKind;
  /** 屏幕上的活动 docId（重开后换新 docId）。 */
  docId: string;
  /** 打开时的视图 webContents id（证据里记录，便于跨代对比）。 */
  webContentsId: number;
}

/** 用某个视图的 webContents 身份调生产 handler（与页面 invoke 同一个函数对象）。 */
export async function invokeAs(wc: WebContents, harness: GenofficeHarness, channel: string, payload: unknown): Promise<unknown> {
  const handler = harness.handlers.get(channel);
  if (handler === undefined) throw new Error(`T7: 生产 handler 未注册：${channel}`);
  return await handler({ sender: wc }, payload);
}

/* ────────────────────────────── 磁盘事实 ────────────────────────────── */

export function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/* ─────────────────────────────── 轮询 ─────────────────────────────── */

export async function waitFor<T>(
  predicate: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  intervalMs = 150,
): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let value: T | null | undefined | false = null;
    try { value = await predicate(); } catch { value = null; }
    if (value) return value as T;
    if (Date.now() > end) return null;
    await sleep(intervalMs);
  }
}

export async function waitForPageReady(wc: WebContents, timeoutMs = 30_000): Promise<boolean> {
  const ok = await waitFor(async () => {
    if (wc.isDestroyed()) return false;
    return await wc.executeJavaScript("document.readyState === 'complete'");
  }, timeoutMs, 200);
  return ok === true;
}

export async function js<T = unknown>(wc: WebContents, expression: string): Promise<T> {
  return (await wc.executeJavaScript(expression, true)) as T;
}

/* ───────────────────────── 页面 URL / 诊断 ───────────────────────── */

/**
 * 编辑器页 URL。原厂五家必须用固定身份 `genoffice-app://<kind>/index.html`
 * （生产面板与 `DocumentViewHost.open` 的硬性判据）；Docs 用生产面板同一条
 * `file://…/apps/docs/out/renderer/index.html?mode=tab`。
 */
export function editorUrl(kind: EditorKind): string {
  if (kind !== "docs") return `genoffice-app://${kind}/index.html`;
  const repoRoot = process.env.MCODE_U1_REPO;
  if (!repoRoot) throw new Error("T7: MCODE_U1_REPO 未设置");
  const page = join(repoRoot, "genoffice", "apps", "docs", "out", "renderer", "index.html");
  const normalized = page.replace(/\\/g, "/");
  const encoded = normalized.split("/").map((part, index) =>
    index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join("/");
  const withScheme = /^[A-Za-z]:\//.test(normalized) ? `file:///${encoded}` : `file://${encoded}`;
  return `${withScheme}?mode=tab`;
}

/* ───────────────────────────── setup 工厂 ───────────────────────────── */

/**
 * 六条旅程共用的 `launch.setup`：生成夹具 → 装配生产 Host → 建编辑器视图。
 * 打开链由各旅程的**第一个 `run` 步骤**驱动（docs 要 openPath + 页面回执；
 * 原厂五家由视图工厂自己 consumePending）——这样旅程文件能分别断言打开链。
 */
export function editorSetup(kind: EditorKind): (ctx: U1SetupContext) => Promise<U1SetupResult> {
  return async (ctx: U1SetupContext): Promise<U1SetupResult> => {
    if (ctx.win === null) {
      throw new Error("T7: GenOffice 视图需要宿主窗口（launch.window 不能为 false）");
    }
    const repoRoot = process.env.MCODE_U1_REPO;
    if (!repoRoot) throw new Error("T7: MCODE_U1_REPO 未设置");
    const fixtures = await ensureFixtures(ctx.projectDir, repoRoot);
    const harness = await assembleHarness({ win: ctx.win, projectDir: ctx.projectDir });
    const status = harness.nativeStatus;
    if (kind !== "docs" && status[kind] !== true) {
      throw new Error(`T7: ${kind} 的原厂视图未装配（preload/renderer 缺失）: ${JSON.stringify(status)}`);
    }
    const target = fixtures[kind];
    const docId = `t7-${kind}-g${ctx.generation}`;
    const res = harness.host.open({
      docId,
      url: editorUrl(kind),
      bounds: { x: 0, y: 0, width: 1280, height: 900 },
      visible: true,
      // `mcodeSessionId` 是 Pane 围栏 `documentPath(sender)` 的必需项
      //（`vendorAiContextForSender` 无会话即返回 null）；生产面板总会带它
      //（`GenofficeViewHostPane` 的 `mcodeSessionId`）。缺了它，slides/sheets
      // 的保存会被 Mcode 围栏判成「路径不在已授权的工作区内」（实测）。
      mcodeSessionId: "t7-u1-session",
      ...(kind === "docs" ? {} : { editor: kind, filePath: target }),
    });
    if (!res.ok) {
      harness.dispose();
      throw new Error(`${kind} host.open 失败: ${res.reason}`);
    }
    const wc = harness.webContentsOf(docId) as unknown as WebContents | null;
    if (wc === null) {
      harness.dispose();
      throw new Error(`${kind} 视图没有 webContents`);
    }
    // 把编辑器页的 console（含 React 未捕获异常）打进宿主 stdio —— 失败时
    // `run-g*.log` 里就能看到页面为什么没继续（与 document-view-* 套件同一纪律）。
    wc.on("console-message", (_e, level, message) => {
      // T7 诊断：打印全部级别（含 console.log），失败时 run-g*.log 里能看清
      // 页面为什么停在占位符上。
      console.log(`VIEW[${kind}:${level}] ${String(message).slice(0, 1500)}`);
    });
    await waitForPageReady(wc);
    // 页面挂载 ≠ 能收 open-path：vendor App 的 `onMenuCommand` 订阅在挂载 effect 里，
    // 而宿主推送是一次性的（`documentViewHost.openPath` 只发一条 menu:command）。
    // 等首帧编辑器壳出现再交回旅程 —— 与 `document-view-open-smoke` 的 10s 等待同义，
    // 只是条件化（docs: .ProseMirror；五家：各自的首帧壳标记）。
    const READY_MARKERS: Record<Exclude<EditorKind, "docs">, string> = {
      sheets: "#univer-container",
      slides: ".app, canvas, .konvajs-content",
      pdf: ".app, .pdf-placeholder",
      markdown: ".app, .doc-editor",
      html: ".app, .cm-editor",
    };
    if (kind === "docs") {
      // Docs 的打开链在**编辑器已挂载**时才成立：`App.tsx` 的 `onMenuCommand`
      // 订阅与 `loadFile` 都要求 `ctx.editor` 非空；编辑器没挂载就收到 open-path
      // 会先消费 read-opened 再静默 `'canceled'`（实测：read-opened 来了、没有
      // open-committed）。生产用户也是看着起始屏再点文件 —— 所以等起始屏的
      // ProseMirror（空白文档）出现，与 `document-view-open-smoke` 的 10 s 同义。
      const ready = await waitFor(() => js<boolean>(wc, "!!document.querySelector('.ProseMirror')"), 30_000, 200);
      if (!ready) throw new Error("docs 起始屏 30s 内没有挂载 .ProseMirror");
    } else {
      await waitFor(() => js<boolean>(wc, `!!document.querySelector(${JSON.stringify(READY_MARKERS[kind])})`), 30_000, 250);
    }
    const runtime: EditorRuntime = { harness, fixtures, kind, docId, webContentsId: wc.id };
    return {
      pageFromView: wc,
      dispose() { harness.dispose(); },
      runtime,
    };
  };
}
