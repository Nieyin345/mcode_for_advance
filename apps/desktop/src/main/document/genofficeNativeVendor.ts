/**
 * GenOffice upstream view factories, bundled from the pinned source snapshot.
 * This module is build-aliased to genofficeNativeVendorStub.ts when absent.
 * Import only vendor main entry points: they own their original preload and IPC.
 */
// @ts-ignore — upstream is an optional, gitignored checkout outside our TS project.
import { configurePdfRuntime, createPdfView } from "../../../../../genoffice/apps/pdf/src/main/pdf-main.js";
// @ts-ignore — resolved by electron-vite only when the checkout is present.
import { configureMarkdownRuntime, createMarkdownView } from "../../../../../genoffice/apps/markdown/src/main/markdown-main.js";
// @ts-ignore — resolved by electron-vite only when the checkout is present.
import { configureHtmlRuntime, createHtmlView } from "../../../../../genoffice/apps/html/src/main/html-main.js";
// @ts-ignore — optional upstream checkout; keep the original view entry points.
import { configureSheetsRuntime, createSheetsView, queueWorkbookForView } from "@main/document/genofficeSheetsEntry.js";
// @ts-ignore — optional upstream checkout; the original slides main registers its own IPC.
import { configureSlidesRuntime, createSlidesView } from "@main/document/genofficeSlidesEntry.js";
import { documentViewHost, type DocumentViewLike } from "./documentViewHost.js";
import { findContainingWorkspaceRoot } from "@main/lib/pathGuard.js";
import { log } from "@main/lib/logger.js";

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
