/**
 * Main-process Markdown preview. Markdown and local images are read through
 * the shared native, handle-pinned filesystem root; renderer receives bounded
 * text and data URLs and never receives a filesystem path to open itself.
 */
import { extname, join } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { LibraryRepo } from "@main/store/repositories.js";
import { libraryRoot } from "./paths.js";
import { assetRefsOf } from "@main/library/adoptMarkdown.js";
import { openNativeFsRoot, type NativeFsRoot } from "@main/lib/nativeFs.js";
import { log } from "@main/lib/logger.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES = 300;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

export interface MarkdownPreview {
  ok: boolean;
  error?: string;
  markdown: string;
  dir: string;
  fileName: string;
  images: Record<string, string>;
  skipped: string[];
}

function empty(error: string): MarkdownPreview {
  return { ok: false, error, markdown: "", dir: "", fileName: "", images: {}, skipped: [] };
}

function librarySegments(relativePath: string): string[] {
  if (!relativePath || relativePath.startsWith("/") || relativePath.startsWith("\\") ||
      /^[a-z]:[\\/]/i.test(relativePath)) {
    throw new Error("Markdown 路径不是资料库相对路径");
  }
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    throw new Error("Markdown 路径包含非法组件");
  }
  return parts;
}

function imageSegments(base: readonly string[], reference: string): string[] | null {
  let decoded = reference;
  try { decoded = decodeURIComponent(reference); } catch { /* keep the original literal */ }
  if (!decoded || decoded.startsWith("/") || decoded.startsWith("\\") ||
      /^[a-z]:[\\/]/i.test(decoded)) return null;
  const parts = decoded.replace(/\\/g, "/").split("/");
  if (parts.some((part) => part === "..")) return null;
  const safe = parts.filter((part) => part && part !== ".");
  if (!safe.length) return null;
  return [...base, ...safe];
}

async function inlineImage(root: NativeFsRoot, base: readonly string[], reference: string): Promise<string | null> {
  if (/^(https?:|data:)/i.test(reference)) return null;
  let decoded = reference;
  try { decoded = decodeURIComponent(reference); } catch { /* retain literal */ }
  const mime = IMAGE_MIME[extname(decoded).toLowerCase()];
  if (!mime) return null;
  const segments = imageSegments(base, reference);
  if (!segments) return null;
  try {
    const bytes = await root.readFile(segments, MAX_IMAGE_BYTES);
    return "data:" + mime + ";base64," + bytes.toString("base64");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EFBIG" && code !== "ELOOP" && code !== "EINVAL") {
      log.warn("library: Markdown image could not be read through the native root: " +
        reference + " — " + (error instanceof Error ? error.message : String(error)));
    }
    return null;
  }
}

export async function readMarkdownForPreview(itemId: string): Promise<MarkdownPreview> {
  const item = LibraryRepo.get(itemId);
  if (!item) return empty("找不到这篇文献");
  if (!item.mdPath) return empty("这篇还没有 Markdown 转换产物");

  let rootPath: string;
  let segments: string[];
  let rootIdentity: { dev: bigint; ino: bigint };
  try {
    const requestedRoot = libraryRoot();
    const before = await lstat(requestedRoot, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() ||
        (before.ino === 0n && before.birthtimeNs === 0n)) {
      throw new Error("资料库根目录不是可验证的普通目录");
    }
    rootPath = await realpath(requestedRoot);
    const after = await lstat(requestedRoot, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() ||
        before.dev !== after.dev || before.ino !== after.ino ||
        before.birthtimeNs !== after.birthtimeNs) {
      throw new Error("资料库根目录在打开期间已被替换");
    }
    rootIdentity = { dev: after.dev, ino: after.ino };
    segments = librarySegments(item.mdPath);
  } catch (error) {
    return empty("资料库目录不存在或 Markdown 路径不安全：" +
      (error instanceof Error ? error.message : String(error)));
  }

  let root: NativeFsRoot;
  try {
    root = openNativeFsRoot(rootPath);
  } catch (error) {
    return empty("无法安全打开资料库：" + (error instanceof Error ? error.message : String(error)));
  }

  try {
    const openedRoot = await root.stat([]);
    if (openedRoot.type !== "directory" ||
        BigInt(openedRoot.device) !== rootIdentity.dev ||
        BigInt(openedRoot.inode) !== rootIdentity.ino) {
      return empty("资料库根目录在原生句柄打开期间已被替换");
    }
    let markdown: string;
    try {
      markdown = (await root.readFile(segments, MAX_MARKDOWN_BYTES)).toString("utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return empty("文件不在了：" + item.mdPath);
      return empty("读取失败：" + (error instanceof Error ? error.message : String(error)));
    }

    const dirSegments = segments.slice(0, -1);
    const dir = join(rootPath, ...dirSegments);
    const images: Record<string, string> = {};
    const skipped: string[] = [];
    let total = 0;

    for (const reference of assetRefsOf(markdown)) {
      if (/^(https?:|data:)/i.test(reference)) continue;
      if (Object.keys(images).length >= MAX_IMAGES || total >= MAX_TOTAL_BYTES) {
        skipped.push(reference);
        continue;
      }
      const dataUrl = await inlineImage(root, dirSegments, reference);
      if (!dataUrl) {
        skipped.push(reference);
        continue;
      }
      if (total + dataUrl.length > MAX_TOTAL_BYTES) {
        skipped.push(reference);
        continue;
      }
      images[reference] = dataUrl;
      total += dataUrl.length;
    }

    return {
      ok: true,
      markdown,
      dir,
      fileName: segments[segments.length - 1] ?? "full.md",
      images,
      skipped,
    };
  } finally {
    root.close();
  }
}
