/**
 * O4 —— 真 Electron 装配层：**照生产 `ipc/index.ts:209` 那一条装配**建 docs 视图。
 *
 * ## 为什么本套必须走生产装配
 *
 * O3 的报告写得很清楚：`t7-genoffice-u1` 没抓到这个缺陷，**因为它的 harness 用裸
 * `ipcMain` 做 recordingIpc** —— 裸 `ipcMain` 自带 `.on`，缺陷被掩盖。本套的
 * 装配与生产逐项同源：
 *
 *  - `const ipc = createDbGuardedIpc(ipcMain)`（生产传的就是它）；
 *  - `registerDocumentViewHandlers(ipc, documentViewHost, …, slidesBridge, authorizeOpen)`
 *    的参数顺序与生产一致；
 *  - 打开/打开文件/关闭三条都经**同一份生产 handler**（`rpcHandlerFor` 取到的就是
 *    包装层登记进 registry、同时装进 `ipcMain.handle` 的那个函数对象）。
 *
 * 探针只补生产在别处补的东西：`setMainWindowForU1`（`@main/window.js` 的替身，
 * 与 T7 同一取舍）、`setConfirmDirty`（真人确认端口，测试里自动同意）、
 * `initDocumentHandoffProtocol`（生产在 `whenReady` 里调）。
 *
 * ## 诊断监听器（不是产品接线）
 *
 * setup 在**裸 `ipcMain`** 上额外挂一条 `close-check-result` 计数监听器。它只做一
 * 件事：证明**页面真的回了**（O3 用页面侧计数器实测 `checkEvents: 1`；这里从主
 * 进程侧再证一次）。产品侧的监听器由 `registerDocumentViewHandlers` 注册 —— 两者
 * 互不影响（Electron 同一通道多个监听器都收）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { U1SetupContext, U1SetupResult } from "../electron-u1/driver/index.js";
import { O4_UNIQUE, docsPageUrl, genofficeCliPath } from "./constants.js";

/* eslint-disable @typescript-eslint/no-require-imports */
const docxEngine = require("genoffice:docx-engine") as T7DocxEngine;
const JSZip = require("genoffice:jszip") as T7JSZipCtor;
/* eslint-enable @typescript-eslint/no-require-imports */

export interface O4Runtime {
  host: typeof import("@main/document/documentViewHost.js").documentViewHost;
  docId: string;
  fixturePath: string;
  /** 页面侧回答 close-check 的次数（裸 ipcMain 上的诊断监听器）。 */
  counts: { closeCheckResult: number };
  /** 生产包装层有没有 on（只取证、不断言 —— 主判据必须红在「关闭」那一步）。 */
  wrappedHasOn: boolean;
}

/** 生成一份合法 docx（vendor `buildBlankDocx()` + 注入唯一文本，与 T7 同一模板）。 */
async function writeFixture(path: string): Promise<void> {
  if (existsSync(path) && readFileSync(path).length > 0) return;
  const blank = await docxEngine.buildBlankDocx({ paperSize: "A4" });
  const zip = new JSZip();
  await zip.loadAsync(blank);
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${O4_UNIQUE}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  );
  writeFileSync(path, Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })));
}

export async function o4DocsSetup(ctx: U1SetupContext): Promise<U1SetupResult> {
  if (ctx.win === null) throw new Error("O4: docs 视图需要宿主窗口（launch.window 不能为 false）");
  const repoRoot = process.env.MCODE_U1_REPO;
  if (!repoRoot) throw new Error("O4 setup: MCODE_U1_REPO 未设置");

  const { ipcMain } = await import("electron");
  const { setMainWindowForU1 } = await import("../t7-genoffice-u1/window-holder.js");
  const { js, waitFor } = await import("../t7-genoffice-u1/editor-flow.js");
  const { documentViewHost } = await import("@main/document/documentViewHost.js");
  const { registerDocumentViewHandlers, isApprovedDocumentViewOpen } = await import("@main/ipc/documentView.js");
  const { createDbGuardedIpc } = await import("@main/ipc/dbGuardedIpc.js");
  const { docsPrivilegedPorts } = await import("@main/document/docsPrivilegedPorts.js");
  const { slidesBridge } = await import("@main/document/slidesBridge.js");
  const { findContainingWorkspaceRoot } = await import("@main/lib/pathGuard.js");
  const { initDb } = await import("@main/store/db.js");
  const { ProjectRepo } = await import("@main/store/repositories.js");
  const { initDocumentHandoffProtocol } = await import("@main/document/documentViewHandoff.js");
  const { IPC } = await import("@contracts/ipc");
  const { rpcHandlerFor } = await import("@main/appControl/registry.js");

  // ── 0a. 本 bundle 自己的真数据库（与 T7 harness 同一条理由）──
  // `electron-u1` 的 runner 与旅程注册表是**两份独立 bundle**，各有一份
  // `@main/store/db.js` 模块实例。runner 的 `useRealDb` 只初始化它自己那份
  // （并把 `proj_u1_fixture` 行落盘）;本 bundle 的 `findContainingWorkspaceRoot`
  // 读的是本 bundle 的 ProjectRepo —— 不在这里 initDb 就会在围栏处抛
  // `getDb() called before initDb()`（装配缺项，不是被测缺陷）。runner 已把项目行
  // 落盘，这里读到的就是同一份文件；行缺失时补建（防御，与 T7 harness 同形）。
  await initDb();
  if (!ProjectRepo.get("proj_u1_fixture")) {
    const now = Date.now();
    ProjectRepo.create({
      id: "proj_u1_fixture",
      name: "O4 docs close 夹具项目",
      path: ctx.projectDir,
      archived: false,
      pinnedAt: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  // ── 0. 诊断监听器：页面回了 close-check 几次（裸 ipcMain，产品接线之外）。 ──
  const counts = { closeCheckResult: 0 };
  ipcMain.on("mcode:document-view:close-check-result", () => {
    counts.closeCheckResult += 1;
  });

  // ── 1. 生产宿主单例 + 生产装配同一条端口 ──
  setMainWindowForU1(ctx.win);
  const host = documentViewHost;
  host.setDocsPrivilegedPorts(docsPrivilegedPorts);
  host.setConfirmDirty(async () => true); // 关闭检查里「脏时确认」——本旅程文档干净，不会被问
  initDocumentHandoffProtocol();

  // ── 2. **生产包装层**（这是本卡的被测对象）：`ipc/index.ts:209` 的同一行。 ──
  const wrapped = createDbGuardedIpc(ipcMain);
  const wrappedHasOn = typeof (wrapped as unknown as { on?: unknown }).on === "function";
  registerDocumentViewHandlers(
    wrapped,
    host,
    (p) => findContainingWorkspaceRoot(p) !== null,
    slidesBridge,
    (input) => isApprovedDocumentViewOpen(input, genofficeCliPath()),
  );

  // ── 3. 夹具（工作区内；runner 已建项目行，围栏认它） ──
  const fixturePath = join(ctx.projectDir, "o4-docs.docx");
  await writeFixture(fixturePath);

  // ── 4. 经**生产 handler** 打开 docs 视图（与渲染端 `window.api.documentView.open` 同一函数） ──
  const docId = `o4-docs-g${ctx.generation}`;
  const openFn = rpcHandlerFor(IPC.DOCUMENT_VIEW_OPEN);
  if (!openFn) throw new Error("O4 setup: documentView:open 没有登记进 registry（装配断了）");
  const opened = (await openFn(null, {
    docId,
    url: docsPageUrl(),
    bounds: { x: 0, y: 0, width: 1200, height: 800 },
    visible: true,
  })) as { ok?: boolean; reason?: string };
  if (opened?.ok !== true) {
    host.dispose();
    throw new Error(`O4 setup: docs 视图打开失败：${opened?.reason ?? "无原因"}`);
  }
  const wc = host.webContentsOf(docId);
  if (wc === null) {
    host.dispose();
    throw new Error("O4 setup: docs 视图没有 webContents");
  }
  const asWc = wc as unknown as import("electron").WebContents;
  asWc.on("console-message", (_e, level, message) => {
    console.log(`VIEW[docs:${level}] ${String(message).slice(0, 1500)}`);
  });
  // docs 起始屏：页面挂载后才有 .ProseMirror（生产用户也是看着起始屏再点文件）。
  const ready = await waitFor(
    () => js<boolean>(asWc, "!!document.querySelector('.ProseMirror')"),
    45_000,
    200,
  );
  if (!ready) {
    host.dispose();
    throw new Error("O4 setup: docs 起始屏 45s 内没有挂载 .ProseMirror");
  }

  const runtime: O4Runtime = {
    host,
    docId,
    fixturePath,
    counts,
    wrappedHasOn,
  };
  return {
    pageFromView: asWc,
    runtime,
    dispose() {
      try {
        host.closeAll();
      } catch {
        /* 已释放 */
      }
    },
  };
}
