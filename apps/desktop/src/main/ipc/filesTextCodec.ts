/**
 * `ipc/files.ts` 的**文本编码与路径助手**（从 `files.ts` 拆出）。
 *
 * 粘贴临时目录判定、文件系统错误描述、忽略项与二进制扩展名清单、多编码解码
 * （UTF-8 / UTF-16LE / UTF-16BE / GBK）、NUL 探测、BINARY_MIME 表。全是纯函数/常量，
 * 只吃参数与 `node:` 内建。**纯搬迁，声明逐字节一致。**
 */
import { app } from "electron";
import { basename, join } from "node:path";
import { pathWithin } from "@main/lib/pathGuard.js";
import { TextDecoder } from "node:util";

export function pasteTempDir(): string {
  return join(app.getPath("temp"), "mcode-pastes");
}

/** True if `abs` sits inside the clipboard-paste temp dir (see the
 *  `clipboard:saveFile` handler). Files there were written by THIS app from
 *  user pastes (images/files copied into the composer), so reads are allowed
 *  even though the dir sits outside every project root — the IDE editor needs
 *  it to open/preview pasted files. Writes stay guarded as before. */
export function isPasteTempPath(abs: string): boolean {
  return pathWithin(pasteTempDir(), abs);
}

/** 把 Node 的 errno 翻成一句给人看的中文 —— **别让 `EEXIST: file already exists,
 *  mkdir 'C:\Users\…\mcode-pastes'` 这种 OS 英文原文(还带着用户机器的绝对路径)
 *  漏到界面**。
 *
 *  `clipboard:saveFile` 的失败回执是 `{ ok:false, error }`,而渲染端
 *  (`ChatPane` 粘贴外部文件那段)把它原样塞进 `chat.toast.attachFailedBody: "{reason}"`
 *  —— 也就是**中文 toast 里蹦出一行英文 + 绝对路径**(实测:`mkdir` 撞到同名文件时漏出
 *  `EEXIST: …, mkdir 'C:\Users\…\AppData\Local\Temp\mcode-pastes'`)。这条通路的另外
 *  两个 errno 来源(`writeFile` 的 ENOSPC/EACCES)同理。与 `memory/store.ts` 的
 *  `describeFsError`、`lib/rgInstall.ts` 的 `describePrepErr` 同一口径:常见 errno 翻中文,
 *  其余保留原文(至少不吞)。 */
export function describeFsError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return "文件不存在或已被移走";
  if (code === "EACCES" || code === "EPERM") return "没有访问权限";
  if (code === "EISDIR") return "目标不是一个文件";
  if (code === "ENOTDIR") return "所在的位置不是一个目录";
  if (code === "EEXIST") return "同名文件或目录已存在,挡住了写入";
  if (code === "ENOSPC") return "磁盘空间不足";
  if (code === "EROFS") return "所在的位置是只读的";
  return err instanceof Error ? err.message : String(err);
}

/** Directory/file names hidden from the file tree. These are build artifacts
 *  or VCS internals the user never wants to click through. Kept as a Set for
 *  O(1) lookup during listing. Dotfiles are NOT hidden — users expect to see
 *  `.env`, `.eslintrc`, etc. The search + grep walks share this list (both
 *  runs of the keep-out list also include common virtualenv / package-cache
 *  dirs that would otherwise eat the whole traversal budget on big repos). */
export const IGNORED_ENTRIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".vercel",
  "coverage",
  ".sass-cache",
  "__pycache__",
  ".DS_Store",
  "out",
  "target",
  ".venv",
  "venv",
  ".gradle",
  ".idea",
  ".svn",
  ".hg",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".eslintcache",
  "Pods",
  ".yarn",
  ".pnpm-store",
  "__MACOSX",
]);

/** File extensions that are always binary - skipped by `file:grep` without
 *  even opening the file. Cheaper than the null-byte sniff for obvious cases.
 *  Lowercase, no leading dot. */
export const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff", "svgz",
  "zip", "gz", "tar", "rar", "7z", "bz2", "xz",
  "woff", "woff2", "ttf", "otf", "eot",
  "pdf", "exe", "dll", "so", "dylib", "class", "jar", "wasm",
  "mp3", "mp4", "webm", "avi", "mov", "ogg", "flac", "wav",
  "sqlite", "db",
]);

/** NUL-byte sniff window for text/binary discrimination. We only look at the
 *  first chunk — reading a whole large file just to reject it is wasteful.
 *  Used by `decodeTextBuffer` (below), which replaces the old plain NUL check
 *  so real UTF-16 text files (which legitimately contain NUL bytes) are no
 *  longer thrown away as binary. */
export const SNIFF_BYTES = 8192;

/** Upper bound for a single file scanned by `file:grep`. Larger files are
 *  skipped (with a WARN) — decoding + line-splitting a multi-GB dump would
 *  stall the main process. 32MB covers every realistic source/log file. */
export const MAX_GREP_FILE_BYTES = 32 * 1024 * 1024;

/** Decoders for `file:grep`. UTF-8 variants are the common case; the BOM
 *  variant strips the BOM so the first line doesn't start with U+FEFF. The
 *  GBK fallback is what makes CJK search work on the Windows ANSI files a
 *  Chinese dev machine accumulates (see `decodeTextBuffer`). */
export const UTF8_DECODER = new TextDecoder("utf-8");
export const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });
export const UTF16LE = new TextDecoder("utf-16le");
export const UTF16BE = new TextDecoder("utf-16be");
let GBK: TextDecoder | null | undefined;

export function gbkDecoder(): TextDecoder | null {
  if (GBK !== undefined) return GBK;
  try {
    GBK = new TextDecoder("gbk");
  } catch {
    // Not all ICU builds ship GBK; search degrades to UTF-8 in that case.
    GBK = null;
  }
  return GBK;
}

/** True if any of the first `SNIFF_BYTES` bytes of `buf` is NUL. */
export function hasNulByte(buf: Buffer): boolean {
  const len = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** UTF-16 LE/BE detection for BOM-less files. Real "Unicode" text files
 *  mostly contain ASCII (structural chars, spacing) whose UTF-16 encoding
 *  puts a NUL in every other byte — that pattern is what we exploit. A
 *  BOM-less all-CJK UTF-16 file has no NULs at all and stays undetected
 *  (it would need a language model to guess); those are extremely rare. */
export function looksUtf16Le(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096) & ~1;
  if (n < 4) return false;
  let pairs = 0;
  let nulOdd = 0;
  for (let i = 0; i < n; i += 2) {
    pairs += 1;
    if (buf[i + 1] === 0) nulOdd += 1;
  }
  return nulOdd >= pairs * 0.6;
}

export function looksUtf16Be(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096) & ~1;
  if (n < 4) return false;
  let pairs = 0;
  let nulEven = 0;
  for (let i = 0; i < n; i += 2) {
    pairs += 1;
    if (buf[i] === 0) nulEven += 1;
  }
  return nulEven >= pairs * 0.6;
}

/**
 * Decode a raw file buffer for content search; null means "binary, skip".
 * The old path (`buf.toString("utf-8")` after a raw NUL sniff) had two blind
 * spots that made real files unfindable:
 *  - UTF-16 text (Windows Notepad "Unicode") contains NUL bytes, so the
 *    sniff classified it as binary and skipped it entirely;
 *  - GBK/GB2312 ANSI files (the default encoding for CJK on older Windows
 *    tools) are byte-invalid UTF-8, so the lossy decode produced mojibake and
 *    every non-ASCII query missed.
 * Order is: BOM → UTF-16 NUL pattern → strict UTF-8 → GBK. Only bytes that
 * fail all of these (and aren't NUL-pattern UTF-16) are treated as binary.
 */
export function decodeTextBuffer(buf: Buffer): string | null {
  if (buf.length === 0) return "";
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return UTF8_DECODER.decode(buf.subarray(3));
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return UTF16LE.decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return UTF16BE.decode(buf.subarray(2));
  }
  if (hasNulByte(buf)) {
    if (looksUtf16Le(buf)) return UTF16LE.decode(buf);
    if (looksUtf16Be(buf)) return UTF16BE.decode(buf);
    return null;
  }
  try {
    return UTF8_STRICT.decode(buf);
  } catch {
    const gbk = gbkDecoder();
    if (gbk) return gbk.decode(buf);
    // ICUI-less build: fall back to the old lossy decode rather than skipping.
    return UTF8_DECODER.decode(buf);
  }
}

/** Extract the lowercase extension (no dot) from a filename, or "" if none. */
export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return "";
  return name.slice(i + 1).toLowerCase();
}

/** MIME types for the binary/image extensions we expect to serve as data
 *  URLs. Unknown extensions fall back to application/octet-stream (the <img>
 *  will fail to render and the pane shows its error state - intended). */
export const BINARY_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  webp: "image/webp",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  avif: "image/avif",
};