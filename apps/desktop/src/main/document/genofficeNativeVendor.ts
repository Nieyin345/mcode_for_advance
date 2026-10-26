/**
 * GenOffice upstream view factories, bundled from the pinned source snapshot.
 * This module is build-aliased to genofficeNativeVendorStub.ts when absent.
 * Import only vendor main entry points: they own their original preload and IPC.
 */
// @ts-ignore — upstream is an optional, gitignored checkout outside our TS project.
import { configurePdfRuntime, createPdfView, requestPdfClose } from "../../../../../genoffice/apps/pdf/src/main/pdf-main.js";
// @ts-ignore — resolved by electron-vite only when the checkout is present.
import { configureMarkdownRuntime, createMarkdownView, requestMarkdownClose } from "../../../../../genoffice/apps/markdown/src/main/markdown-main.js";
// @ts-ignore — resolved by electron-vite only when the checkout is present.
import { configureHtmlRuntime, createHtmlView, requestHtmlClose } from "../../../../../genoffice/apps/html/src/main/html-main.js";
// @ts-ignore — optional upstream checkout; keep the original view entry points.
import { configureSheetsRuntime, createSheetsView, queueWorkbookForView, requestSheetsClose } from "@main/document/genofficeSheetsEntry.js";
// @ts-ignore — optional upstream checkout; the original slides main registers its own IPC.
import { configureSlidesRuntime, createSlidesView, requestSlidesClose } from "@main/document/genofficeSlidesEntry.js";
import { documentViewHost, type DocumentViewLike } from "./documentViewHost.js";
import { makeDocumentSaveGuard } from "./documentSaveGuard.js";
import { setDocumentSaveGuard } from "@genoffice/electron-utils/document-save-guard";
import { findContainingWorkspaceRoot } from "@main/lib/pathGuard.js";
import { log } from "@main/lib/logger.js";
import { BrowserWindow } from "electron";

/**
 * 【O10】装上保存守卫 —— 四个 vendor 保存调用点（html/markdown 的
 * `writeTextAtomic`、pdf 的 `savePdfToPath`、slides 的 `slides:save`）会经过它。
 *
 * 「打开时版本」直接读 `DocumentViewHost` 的打开会话表（与 docs 的
 * `saveOpenedFile` 同一份数据源，不另记一份）；没有该路径的会话时不拦
 * （独立运行 / 未知视图的行为与改动前一致）。
 *
 * 装配期调一次：换守卫会留下不一致的打开版本绑定。
 */
export function installDocumentSaveGuard(): void {
  setDocumentSaveGuard(makeDocumentSaveGuard({
    openedRevisionFor: (real) => documentViewHost.revisionForPath(real),
    recordSavedRevision: (real, revision) => documentViewHost.advanceRevisionForPath(real, revision),
  }));
  log.info("genoffice document save guard installed (html/markdown/pdf/slides)");
}

/** Authoritative owner/path checks, injected into the vendor IPC facade. */
const paneGuard = (kind: "sheets" | "slides") => ({
  ownsSender(sender: unknown): boolean {
    const id = documentViewHost.docIdForSender(sender);
    return id !== null && documentViewHost.editorOf(id) === kind;
  },
  containsPath(path: string): boolean { return findContainingWorkspaceRoot(path) !== null; },
  documentPath(sender: unknown): string | null {
    return documentViewHost.vendorAiContextForSender(sender)?.filePath ?? null;
  },
  audit(channel: string, category: "A" | "B" | "C", outcome: string): void {
    log.info(`[genoffice-pane-${kind}] ${category} ${channel}: ${outcome}`);
  },
});

export const vendorAvailable = true;
type RuntimePaths = {
  preloadPath: string;
  rendererFile: string;
  rendererUrl?: string;
  openGeneratedPath?: (path: string) => boolean;
  sidecarPath?: string;
  rendererDevUrl?: string;
  rendererFilePath?: string;
};
export function configureNativeRuntimes(roots: Record<"pdf" | "markdown" | "html" | "sheets" | "slides", RuntimePaths>): void {
  configurePdfRuntime(roots.pdf);
  configureMarkdownRuntime(roots.markdown);
  configureHtmlRuntime(roots.html);
  configureSheetsRuntime({ ...roots.sheets, sidecarPath: roots.sheets.sidecarPath, mcodePaneGuard: paneGuard("sheets") });
  configureSlidesRuntime({
    preloadPath: roots.slides.preloadPath,
    rendererDevUrl: roots.slides.rendererDevUrl,
    rendererFilePath: roots.slides.rendererFilePath ?? roots.slides.rendererFile,
    openGeneratedPath: roots.slides.openGeneratedPath,
    mcodePaneGuard: paneGuard("slides"),
  });
}
export function createNativeView(path: string | null, kind: "pdf" | "markdown" | "html" | "sheets" | "slides"): DocumentViewLike {
  switch (kind) {
    case "pdf": return createPdfView(path) as unknown as DocumentViewLike;
    case "markdown": return createMarkdownView(path) as unknown as DocumentViewLike;
    case "html": return createHtmlView(path) as unknown as DocumentViewLike;
    case "sheets": {
      const view = createSheetsView({ includeAiHandlers: false, openingWorkbook: Boolean(path) });
      if (path) queueWorkbookForView(view.webContents, path);
      return view as unknown as DocumentViewLike;
    }
    case "slides": return createSlidesView(path) as unknown as DocumentViewLike;
  }
}

/**
 * 【T29/T155】原厂五编辑器（pdf/markdown/html/sheets/slides）的**关闭守卫** —— 直接转发
 * vendor 自己的 `request*Close`，不复制它们的脏判断或保存流程。
 *
 * 未保存状态分别由各 vendor 主进程维护；尤其 Slides 的 `requestSlidesClose`
 * 使用原厂 session dirty、自动保存偏好与「保存 / 放弃 / 取消」对话框。Mcode
 * 只负责把关闭决定交给正确的原厂函数，不建立第二套保存语义（仓库硬规矩 2）。
 *
 * vendor 的 `request*Close(contents, parent?)` 不传 parent 时用无父窗口的
 * `dialog.showMessageBox(options)` —— 在 Mcode 里由 `confirmDirty` 之外的一条
 * 独立系统弹窗呈现；这是 vendor 的原始行为，不加壳。
 *
 * 返回 true = 可以关闭（干净，或用户选了保存且保存成功 / 明确放弃）；
 * false = 用户取消或保存失败。未装配的 kind 一律 false（fail-closed）。
 */
export async function requestNativeViewClose(
  kind: "pdf" | "markdown" | "html" | "sheets" | "slides",
  webContents: unknown,
): Promise<boolean> {
  // vendor 的签名是 `(contents: WebContents, parent?: BrowserWindow|null)`；
  // 宿主只保证透传它自己的 webContents，类型面由本 seam 收窄。
  const contents = webContents as Parameters<typeof requestPdfClose>[0];
  // 弹窗挂在主窗口上（与生产 `confirmDirty` 的 `dialog.showMessageBox(win, …)`
  // 同一取舍：模态归属给用户正在看的窗口）。窗口没了就退回 vendor 的无父形态。
  const parent = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
  switch (kind) {
    case "pdf": return await requestPdfClose(contents, parent);
    case "markdown": return await requestMarkdownClose(contents, parent);
    case "html": return await requestHtmlClose(contents, parent);
    case "sheets": return await requestSheetsClose(contents, parent);
    case "slides": return await requestSlidesClose(contents, parent);
  }
}
