/**
 * 沙箱化 Webview 的本地资源端点。
 *
 * ## 它解决什么
 *
 * VS Code 扩展的 Webview 用 `webview.asWebviewUri(...)` 引本地 CSS/图片/脚本。
 * 那些 URI 必须由一个**受控的**协议端点服务，而不是让 Webview 直接 `file://` ——
 * 后者等于给任意网页读盘的能力。
 *
 * ## 安全模型
 *
 * 每个 Webview 面板在注册 `localResourceRoots` 时拿到一个**不可猜的** scope
 * （宿主生成的 UUID）+ 它自己的 handle。请求 URL 里带 scope + handle，端点据此
 * 查出这个面板**被允许**读哪几个目录，然后：
 *
 *   1. `realpath` 解析真实路径（挡符号链接逃逸）；
 *   2. 必须落在某个已登记 root 内；
 *   3. 必须是普通文件、≤32 MiB。
 *
 * 任一不满足 → 404（**不告诉调用方是哪一条不满足** —— 那会变成探测工具）。
 *
 * ## ⚠️ 本文件不 import electron
 *
 * `host.ts` 静态引用这里的根表函数，而 host.ts 被多个无头 smoke 打包。
 * 顶层 `import { protocol } from "electron"` 会把 electron 的 CJS 入口拉进
 * ESM bundle，抛 `ERR_AMBIGUOUS_MODULE_SYNTAX` —— 整套在跑第一行断言之前就崩。
 * 所以 `protocol` 只在 {@link installTheiaWebviewResourceProtocol} 里延迟取；
 * 那个函数由 `index.ts` 在 `app.whenReady()` 之后调用。
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Protocol } from "electron";

export const THEIA_WEBVIEW_RESOURCE_SCHEME = "mcode-webview-resource";
const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;

/** scope → handle → 允许的根目录。 */
const rootsByScope = new Map<string, Map<string, string[]>>();

const UUID = /^[a-f0-9-]{36}$/i;

export function setTheiaWebviewResourceRoots(scope: string, handle: string, roots: string[]): void {
  if (!UUID.test(scope) || !UUID.test(handle)) return;
  let panels = rootsByScope.get(scope);
  if (!panels) {
    panels = new Map();
    rootsByScope.set(scope, panels);
  }
  panels.set(handle, roots.filter(root => typeof root === "string" && path.isAbsolute(root)).slice(0, 64));
}

export function deleteTheiaWebviewResourceRoots(scope: string, handle: string): void {
  const panels = rootsByScope.get(scope);
  if (!panels) return;
  panels.delete(handle);
  if (!panels.size) rootsByScope.delete(scope);
}

export function deleteTheiaWebviewResourceScope(scope: string): void {
  rootsByScope.delete(scope);
}

/** URL → { scope, handle, 文件路径 }。形状不对返回 `undefined`（→ 404）。 */
function decodeTarget(url: URL): { scope: string; handle: string; file: string } | undefined {
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { return undefined; }
  const firstSlash = pathname.indexOf("/", 1);
  if (firstSlash < 2) return undefined;
  const handle = pathname.slice(1, firstSlash);
  const rest = pathname.slice(firstSlash + 1);
  const schemeEnd = rest.indexOf("/");
  if (!handle || handle.length > 256 || schemeEnd < 1) return undefined;
  if (rest.slice(0, schemeEnd) !== "file") return undefined;
  const tail = rest.slice(schemeEnd + 1);
  let file: string;
  if (tail.startsWith("//")) {
    const resourcePath = tail.slice(2);
    if (!resourcePath) return undefined;
    if (process.platform === "win32") {
      const windowsPath = resourcePath.replace(/^\/+(?=[a-z]:[\\/])/i, "").replace(/\//g, "\\");
      if (!/^[a-z]:\\/i.test(windowsPath)) return undefined;
      file = path.resolve(windowsPath);
    } else {
      file = path.resolve(path.sep, resourcePath);
    }
  } else if (tail.startsWith("/")) {
    const authorityEnd = tail.indexOf("/", 1);
    if (authorityEnd < 2) return undefined;
    const authority = tail.slice(1, authorityEnd);
    const resourcePath = tail.slice(authorityEnd + 1);
    if (!authority || !resourcePath) return undefined;
    file = process.platform === "win32"
      ? path.resolve("\\\\" + authority + "\\" + resourcePath.replace(/[\\/]+/g, "\\"))
      : path.resolve("//" + authority + "/" + resourcePath);
  } else {
    return undefined;
  }
  return { scope: url.hostname, handle, file };
}

const containedBy = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
};

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".wasm": "application/wasm", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm",
};

export function installTheiaWebviewResourceProtocol(): void {
  // 延迟取 electron（见文件头）：本函数只在 app ready 之后的真实主进程里被调用。
  const { protocol } = require("electron") as { protocol: Protocol };
  protocol.handle(THEIA_WEBVIEW_RESOURCE_SCHEME, async request => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    }
    let url: URL;
    try { url = new URL(request.url); } catch { return new Response(null, { status: 404 }); }
    if (url.protocol !== THEIA_WEBVIEW_RESOURCE_SCHEME + ":") return new Response(null, { status: 404 });
    const decoded = decodeTarget(url);
    if (!decoded) return new Response(null, { status: 404 });
    const roots = rootsByScope.get(decoded.scope)?.get(decoded.handle);
    if (!roots?.length) return new Response(null, { status: 404 });
    try {
      const target = await realpath(decoded.file);
      const targetStat = await stat(target);
      if (!targetStat.isFile() || targetStat.size > MAX_RESOURCE_BYTES) {
        return new Response(null, { status: targetStat.size > MAX_RESOURCE_BYTES ? 413 : 404 });
      }
      let allowed = false;
      for (const candidate of roots) {
        try {
          const canonicalRoot = await realpath(candidate);
          if ((await stat(canonicalRoot)).isDirectory() && containedBy(canonicalRoot, target)) {
            allowed = true;
            break;
          }
        } catch { /* 根不存在 → fail closed */ }
      }
      if (!allowed) return new Response(null, { status: 404 });
      const bytes = await readFile(target);
      return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), {
        status: 200,
        headers: {
          "content-type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
          "content-length": String(bytes.byteLength),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "access-control-allow-origin": "*",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
