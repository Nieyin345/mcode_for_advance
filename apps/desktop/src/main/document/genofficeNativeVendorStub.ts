/** Build-only fallback when gitignored GenOffice source is unavailable. */
import type { DocumentViewLike } from "./documentViewHost.js";
export const vendorAvailable = false;
type RuntimePaths = { preloadPath: string; rendererFile: string; rendererUrl?: string; openGeneratedPath?: (path: string) => boolean; sidecarPath?: string; rendererDevUrl?: string; rendererFilePath?: string };
export function configureNativeRuntimes(_roots: Record<"pdf" | "markdown" | "html" | "sheets" | "slides", RuntimePaths>): void {
  throw new Error("GenOffice vendor snapshot is not installed");
}
export function createNativeView(_path: string | null, _kind: "pdf" | "markdown" | "html" | "sheets" | "slides"): DocumentViewLike {
  throw new Error("GenOffice vendor snapshot is not installed");
}
/** T29: no vendor snapshot = no close guard; the Host fails closed on close. */
export async function requestNativeViewClose(
  _kind: "pdf" | "markdown" | "html" | "sheets",
  _webContents: unknown,
): Promise<boolean> {
  return false;
}

/** O10: no vendor snapshot = no save seam to install; nothing to guard. */
export function installDocumentSaveGuard(): void {
  /* 没有 vendor 源码 = 没有接缝可装；独立运行行为不受影响。 */
}
