/**
 * T7 —— GenOffice 六编辑器的**真 Electron 装配层**（跑在探针主进程里）。
 *
 * ## 为什么需要这一层
 *
 * 六个编辑器都不是"一个页面"，而是 `WebContentsView`：页面的打开/保存/关闭由
 * **Mcode 的 `DocumentViewHost`** 与 **vendor 主进程**（`genoffice/apps/<kind>/src/main`）
 * 协作完成。T16 的 runner 只驱动 BrowserWindow 页面，所以 T7 的旅程用它的
 * `launch.setup` 钩子装配这一整套，并返回 `pageFromView` 让后续 `step.*` 的
 * 截图/DOM 断言落在**真实编辑器页**上。
 *
 * ## 装配的是生产代码，不是仿制品
 *
 *  - `DocumentViewHost`：生产类（`apps/desktop/src/main/document/documentViewHost.ts`）；
 *  - `registerDocumentViewHandlers`：生产 IPC 注册器（`ipc/documentView.ts`）；
 *  - `registerDocsIpc`：vendor 的 Docs 受限注册器（`mcode-ipc.ts`，生产同一份）；
 *  - `createPdfView` 等五个：vendor 主进程的原厂视图工厂（生产同一份）；
 *  - `registerSlidesIpc` / `registerSheetsIpc`：由原厂工厂内部调用（同一份）。
 *
 * 探针只补两类东西：
 *  1. **确定性端口**：确认对话框（dirty 时自动同意「放弃」）、打印确认；
 *  2. **测试目录**：`app.setPath("documents")` 与 sidecar 路径（隔离 tmp）。
 *
 * ## 工作区围栏
 *
 * 生产的 `findContainingWorkspaceRoot` 依赖 SQL 项目表；本套件用**同一张真表**：
 * `initDb()` 指向启动器 mktemp 的数据根，`ProjectRepo.create` 建一个指向
 * `@projectDir` 的项目 —— 与 T16 journey-2 同一条做法。所以 `withinWorkspace`
 * 用的是真 `pathGuard`，不是自己重写的字符串比较。
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow, IpcMain, WebContents } from "electron";
import { app, ipcMain } from "electron";

import { documentViewHost } from "@main/document/documentViewHost.js";
import { setMainWindowForU1 } from "./window-holder.js";
import { registerDocumentViewHandlers } from "@main/ipc/documentView.js";
import { VendorSlidesExecutor } from "@main/document/slidesExecutor.js";
import { SlidesBridge } from "@main/document/slidesBridge.js";
import { docsPrivilegedPorts } from "@main/document/docsPrivilegedPorts.js";
import { initDb } from "@main/store/db.js";
import { ProjectRepo } from "@main/store/repositories.js";
import { findContainingWorkspaceRoot } from "@main/lib/pathGuard.js";
import { initDocumentHandoffProtocol } from "@main/document/documentViewHandoff.js";
import { configureGenofficeNativeViews, makeGenofficeNativeView, nativeHostStatus } from "@main/document/genofficeViewFactories.js";
import { registerGenofficeViewAiIpc } from "@main/document/genofficeViewAiVendor.js";

/** 本套件在真机上的宿主句柄（旅程的 `run` 步骤用它驱动生产 API）。 */
export interface GenofficeHarness {
  host: typeof import("@main/document/documentViewHost.js").documentViewHost;
  win: BrowserWindow;
  projectDir: string;
  /** 生产能力报告（`status[kind]` 驱动面板的打开入口）。 */
  nativeStatus: ReturnType<typeof nativeHostStatus>;
  /** `registerDocumentViewHandlers` 记录的生产 handler（通道名 → 同一函数对象）。 */
  handlers: Map<string, (event: unknown, raw: unknown) => unknown>;
  /** 当前打开的每个视图的 webContents（docId → wc）。 */
  webContentsOf(docId: string): WebContents | null;
  /** 关闭全部视图 + 释放数据库（旅程结束/重开前）。 */
  dispose(): void;
}

const PROJECT_ID = "proj_t7_fixture";

/**
 * 装配一次。**可重入**：relaunch 之后新进程会再次调用（新 DB 指针、同一个项目目录）。
 * `beforeReady` / `afterReady` 的协议注册在注册表层完成（本函数只要求已 ready）。
 */
export async function assembleHarness(options: {
  win: BrowserWindow;
  projectDir: string;
}): Promise<GenofficeHarness> {
  const { win, projectDir } = options;

  // ── 1. 真数据库 + 真项目行（围栏与 file:* 守卫的共同事实源）──
  await initDb();
  if (!ProjectRepo.get(PROJECT_ID)) {
    const now = Date.now();
    ProjectRepo.create({
      id: PROJECT_ID,
      name: "T7 GenOffice 夹具项目",
      path: projectDir,
      archived: false,
      pinnedAt: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  // ── 2. vendor 产物 → 生产装配器（preload/renderer 都在磁盘上才算 available）──
  const repoRoot = process.env.MCODE_U1_REPO;
  if (!repoRoot) throw new Error("T7 harness: MCODE_U1_REPO 未设置");
  const cli = join(repoRoot, "genoffice", "packages", "cli", "dist", "genoffice.cjs");
  if (!existsSync(cli)) throw new Error(`T7 harness: vendor CLI missing (${cli})`);
  const nativeStatus = configureGenofficeNativeViews(cli);
  // `genoffice-app://` 的协议处理器由注册表的 `afterReady()` 安装（每进程一次；
  // 生产函数没有幂等守卫，见 `genofficeViewFactories.ts:96`）。这里**不再**调。
  // 但**一次性字节 handoff**（`genoffice-docx-media://handoff/<token>`）的
  // 协议处理必须在这里接上 —— 生产 `main/index.ts` 在 ready 后调
  // `initDocumentHandoffProtocol()`，否则 docs 页 `fetchDocBytes(dataUrl)` 会
  // 直接 `TypeError: Failed to fetch`（实测：页面打开失败、DOM 里没有夹具文本）。
  initDocumentHandoffProtocol();

  // ── 3. slides 编辑器需要的辅助目录（未命名 deck 的草稿落点）──
  const documentsDir = join(app.getPath("userData"), "documents");
  mkdirSync(documentsDir, { recursive: true });
  app.setPath("documents", documentsDir);

  // ── 4. **生产宿主单例** + 确定性端口 ──
  // 不能用 `new DocumentViewHost(...)`：sheets/slides 的 Pane 围栏
  // （`genofficeNativeVendor.ts` 的 `paneGuard`）闭包引用的是这个单例
  // （`documentViewHost.docIdForSender`）。另建实例会让围栏把探针的视图判成
  // 「未授权的文档视图」（实测：`sheets:has-queued-workbook` 被拒）。
  // 单例的 `getMainWindow` 来自 `@main/window.js` —— 本套件把它别名到
  // `window-holder.ts`，由下面一行注入探针窗口。
  setMainWindowForU1(win);
  const host = documentViewHost;
  host.setDocsPrivilegedPorts(docsPrivilegedPorts);
  // dirty 时的替换确认：本套件显式「放弃修改」（测试里我们总是先保存再关闭；
  // 这一口只兜住 vendor 页在关闭路径上的脏上报）。
  host.setConfirmDirty(async () => true);

  const recorder = new Map<string, (event: unknown, raw: unknown) => unknown>();
  const recordingIpc = {
    handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
      recorder.set(channel, listener);
      (ipcMain as unknown as IpcMain).handle(channel, (event, raw) => {
        if (process.env.MCODE_U1_TRACE_IPC === "1" && /document-view|docs:recent/.test(channel)) {
          const id = (event as { sender?: { id?: unknown } }).sender?.id;
          console.log(`IPC ${channel} sender=${String(id)} payload=${JSON.stringify(raw).slice(0, 120)}`);
        }
        return listener(event, raw);
      });
    },
    on(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
      (ipcMain as unknown as IpcMain).on(channel, listener as never);
    },
    removeHandler(channel: string): void {
      recorder.delete(channel);
      ipcMain.removeHandler(channel);
    },
  } as unknown as IpcMain;

  // slides 的双路线：生产装配（`ipc/index.ts:188-212`）同一条。
  const executor = VendorSlidesExecutor.create();
  const slidesBridge = new SlidesBridge(executor);
  if (executor !== null) {
    host.setViewDisposer((id) => executor.release(id));
    host.setSlidesNotify((docId, openResult) => {
      const wc = host.webContentsOf(docId) as { send?: (c: string, ...a: unknown[]) => void } | null;
      wc?.send?.("slides:opened", openResult);
    });
  }
  registerDocumentViewHandlers(
    recordingIpc,
    host,
    (p) => findContainingWorkspaceRoot(p) !== null,
    slidesBridge,
    () => true, // 探针只打开本套件自己的夹具；围栏由 Host 的 filePath 检查覆盖
  );
  host.setVendorViewFactory(makeGenofficeNativeView, (p) => findContainingWorkspaceRoot(p) !== null);

  // ── 4b. 共享视图 AI 桥（生产 `ipc/index.ts:155-162` 同一条）──
  // 页面挂载时会调 `ai:get-settings` 等通道；没有对端就是 unhandled rejection
  // （`document-view-vendor-page-smoke` 记录过这条）。生产在任一 native host 就绪时
  // 注册；本套件照做，并用**诚实拒绝**的端口（AI 不在 T7 判据内）。
  if (Object.values(nativeStatus).some(Boolean)) {
    const rejectPorts = {
      describe: () => ({ ok: false as const, error: "T7 不测 AI" }),
      confirm: async () => false,
      run: async () => { throw new Error("T7 不测 AI"); },
    };
    try {
      registerGenofficeViewAiIpc(recordingIpc, (sender: unknown) => {
        const context = host.vendorAiContextForSender(sender);
        return context ? { context, ports: rejectPorts as never } : null;
      });
    } catch (e) {
      console.warn("T7 harness: view AI bridge registration failed:", e);
    }
  }
  // 页面挂载期的 app 级偏好通道（生产由 shell 注册；这里给诚实空值）。
  for (const [channel, value] of [
    ["app:get-theme", "light"],
    ["app:get-document-theme", "follow"],
    ["app:get-ai-panel-prefs", {}],
    ["app:get-auto-save-default", true],
    ["app:language-changed", "zh"],
  ] as const) {
    try { ipcMain.handle(channel, () => value); } catch { /* 已注册 */ }
  }
  try { ipcMain.handle("app:set-ai-panel-prefs", () => undefined); } catch { /* 已注册 */ }
  try { ipcMain.handle("home:open-path", () => undefined); } catch { /* 已注册 */ }
  for (const channel of ["project:resolveChat", "project:appendChat", "project:loadChat", "project:rebindChat"]) {
    try { ipcMain.handle(channel, () => null); } catch { /* 已注册 */ }
  }

  // ── 5. 可消费的空白 / 已排队的 workbook 与文档打开链（页面首帧会轮询）──
  // `createSheetsView` 通过 `queueWorkbookForView` 在视图创建时拿到路径；本套件
  // 直接走 `host.open({editor:"sheets", filePath})`，与生产面板同一条。

  let disposed = false;
  return {
    host,
    win,
    projectDir,
    nativeStatus,
    handlers: recorder,
    webContentsOf(docId) {
      const wc = host.webContentsOf(docId) as unknown as WebContents | null;
      return wc && !wc.isDestroyed() ? wc : null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { host.dispose(); } catch { /* 已释放 */ }
    },
  };
}
