/** Build-only fallback when gitignored GenOffice source is unavailable. */
import type { DocumentViewLike } from "./documentViewHost.js";
export const vendorAvailable = false;
type RuntimePaths = { preloadPath: string; rendererFile: string; rendererUrl?: string; openGeneratedPath?: (path: string) => boolean };
export function configureNativeRuntimes(_roots: Record<"pdf" | "markdown" | "html", RuntimePaths>): void {
  throw new Error("GenOffice vendor snapshot is not installed");
}
export function createNativeView(_path: string | null, _kind: "pdf" | "markdown" | "html"): DocumentViewLike {
  throw new Error("GenOffice vendor snapshot is not installed");
}
