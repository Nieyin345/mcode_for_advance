/**
 * T28: original PDF/Markdown/HTML view factories. No alternate editor runtime.
 * The single resource resolver accepts only the same two CLI layouts as
 * editorPageUrl / resolveGenofficeCliPath, never guesses an arbitrary folder.
 */
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { net, protocol } from "electron";
import { pathToFileURL } from "node:url";
import { createNativeView, configureNativeRuntimes, vendorAvailable } from "@main/document/genofficeNativeVendor.js";
import { DOCUMENT_HANDOFF_SCHEME } from "./documentViewHandoff.js";
import { PANEL_SCHEME } from "@contracts/customUiPanel";
import type { DocumentViewLike } from "./documentViewHost.js";
import { resolveSafeGenofficeAsset } from "./genofficeAssetPath.js";

export type NativeKind = "pdf" | "markdown" | "html" | "sheets" | "slides";
export type NativeHostStatus = Record<NativeKind, boolean>;
const kinds: readonly NativeKind[] = ["pdf", "markdown", "html", "sheets", "slides"];
const unavailable = (): NativeHostStatus => ({ pdf: false, markdown: false, html: false, sheets: false, slides: false });
let status: NativeHostStatus = unavailable();
let roots: Record<NativeKind, string> | null = null;

export function nativeHostStatus(): NativeHostStatus { return { ...status }; }

/** Worktree or release-resource path only. A CLI path from another root is refused. */
export function nativeViewsRoot(cliPath: string | null): string | null {
  if (!cliPath) return null;
  const path = cliPath.replace(/\\/g, "/");
  if (path.endsWith("/genoffice/packages/cli/dist/genoffice.cjs"))
    return resolve(dirname(cliPath), "../../..", "apps");
  if (path.endsWith("/genoffice/cli/genoffice.cjs"))
    return resolve(dirname(cliPath), "..", "apps");
  return null;
}

function regularFile(file: string): boolean {
  try { const s = lstatSync(file); return s.isFile() && !s.isSymbolicLink(); }
  catch { return false; }
}

export function configureGenofficeNativeViews(cliPath: string | null): NativeHostStatus {
  status = unavailable();
  roots = null;
  const base = nativeViewsRoot(cliPath);
  if (!vendorAvailable || !base) return nativeHostStatus();
  const dirs = Object.fromEntries(kinds.map(kind => [kind, join(base, kind, "out")])) as Record<NativeKind, string>;
  // Same upstream layout as shell/index.ts. Never guess another Rust executable.
  const sidecarExe = process.platform === "win32" ? "xlsx-sidecar.exe" : "xlsx-sidecar";
  const isRelease = cliPath!.replace(/\\/g, "/").endsWith("/genoffice/cli/genoffice.cjs");
  const sidecarPath = isRelease
    ? join(dirname(base), "native", sidecarExe)
    : join(base, "sheets", "native", "xlsx-engine", "target", "release", sidecarExe);
  const configured = Object.fromEntries(kinds.map(kind => [kind, {
    preloadPath: join(dirs[kind], "preload", "index.js"),
    rendererFile: join(dirs[kind], "renderer", "index.html"),
    rendererUrl: undefined,
    ...(kind === "slides" ? { rendererFilePath: join(dirs[kind], "renderer", "index.html") } : {}),
    ...(kind === "sheets" ? { sidecarPath } : {}),
    // Cross-pane opening must first pass Mcode's workspace authorization.
    openGeneratedPath: (_path: string) => false,
  }])) as Record<NativeKind, { preloadPath: string; rendererFile: string; rendererUrl?: string; rendererFilePath?: string; sidecarPath?: string; openGeneratedPath: (path: string) => boolean }>;
  for (const kind of kinds) status[kind] = regularFile(configured[kind].preloadPath) && regularFile(configured[kind].rendererFile);
  status.sheets = status.sheets && regularFile(sidecarPath);
  if (kinds.some(kind => status[kind])) {
    try {
      configureNativeRuntimes(configured);
      roots = Object.fromEntries(kinds.filter(kind => status[kind]).map(kind => [kind, join(dirs[kind], "renderer")])) as Record<NativeKind, string>;
    } catch {
      status = unavailable();
      roots = null;
    }
  }
  return nativeHostStatus();
}

export function makeGenofficeNativeView(openPath: string | null, kind: NativeKind): DocumentViewLike {
  if (!status[kind]) throw new Error(kind + " 原厂 renderer/preload 缺失或未装配");
  return createNativeView(openPath, kind);
}

/** Electron allows a single privileged scheme registration before app.ready.
 * Mcode previously registered panel/handoff in separate calls; consolidate
 * their exact existing privileges with the original vendor renderer scheme. */
export function registerGenofficeNativeScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: PANEL_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: DOCUMENT_HANDOFF_SCHEME, privileges: {
      standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
    } },
    { scheme: "genoffice-app", privileges: {
      standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true,
    } },
  ]);
}

/** One bounded, asynchronous scheme endpoint for the five renderer bundles.
 *  Every chunk/font request used to block Electron's main thread on several
 *  synchronous filesystem operations. Never cache a symlink decision: roots
 *  and targets must still pass the same physical containment gate per request. */
export function installGenofficeNativeProtocol(): void {
  protocol.handle("genoffice-app", async (request) => {
    let url: URL;
    try { url = new URL(request.url); } catch { return new Response(null, { status: 404 }); }
    if (url.protocol !== "genoffice-app:" || !kinds.includes(url.hostname as NativeKind)) return new Response(null, { status: 404 });
    const root = roots?.[url.hostname as NativeKind];
    if (!root) return new Response(null, { status: 404 });
    const file = await resolveSafeGenofficeAsset(root, url.pathname);
    if (!file) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(file).href).catch(() => new Response(null, { status: 404 }));
  });
}
