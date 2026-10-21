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
import type { DocumentViewLike } from "./documentViewHost.js";

export const vendorAvailable = true;
type RuntimePaths = {
  preloadPath: string;
  rendererFile: string;
  rendererUrl?: string;
  openGeneratedPath?: (path: string) => boolean;
};
export function configureNativeRuntimes(roots: Record<"pdf" | "markdown" | "html", RuntimePaths>): void {
  configurePdfRuntime(roots.pdf);
  configureMarkdownRuntime(roots.markdown);
  configureHtmlRuntime(roots.html);
}
export function createNativeView(path: string | null, kind: "pdf" | "markdown" | "html"): DocumentViewLike {
  switch (kind) {
    case "pdf": return createPdfView(path) as unknown as DocumentViewLike;
    case "markdown": return createMarkdownView(path) as unknown as DocumentViewLike;
    case "html": return createHtmlView(path) as unknown as DocumentViewLike;
  }
}
