/**
 * 把库里一篇文献的 PDF 字节读出来,交给渲染端的 pdf.js 阅读器。
 *
 * ## 为什么不能只给一个路径
 *
 * 渲染进程在沙箱里没有 fs,而且它也不该拿到"读任意路径"的能力 —— 所以这里和
 * `revealFile` / `readMarkdown` 一样:**入参只有条目 id**,路径由主进程从数据库里取。
 *
 * ## 为什么不做 base64
 *
 * Electron 的 IPC 走结构化克隆,`Uint8Array` 能原样过去。base64 会让体积涨三分之一
 * (论文常有十几 MB),再在渲染端解码一次,纯属自找。pdf.js 的 `getDocument({ data })`
 * 正是收 Uint8Array。
 *
 * ## 体积上限
 *
 * 整份文件要一次性进内存、过一次 IPC、再被 pdf.js 解析。给一个上限(64MB)并在超限时
 * **说清楚原因** —— 静默失败或让 Electron 抛一个难懂的序列化错误都比这糟。
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { LibraryRepo } from "@main/store/repositories.js";
import { fromLibraryRelative, isInsideLibrary } from "./paths.js";
import { log } from "@main/lib/logger.js";

/** 单份 PDF 的上限。比这个大的多半是扫描版整本书,该走外部程序看。 */
const MAX_PDF_BYTES = 64 * 1024 * 1024;

export interface PdfBytesResult {
  ok: boolean;
  error?: string;
  bytes: Uint8Array | null;
}

/**
 * A single, bounded PDF disk-read boundary shared by the library item ID
 * reader and the original-PDF IPC. Path authorization is caller-specific,
 * but file type / size / race checks must never diverge.
 *
 * Original backups are not independent grants: reject extra hardlinks to
 * other users' files, symlinks, and inode replacement between lstat/open.
 */
export function readPdfFileBounded(
  abs: string,
  options: { rejectHardlinks?: boolean } = {},
): PdfBytesResult {
  const fail = (error: string): PdfBytesResult => ({ ok: false, error, bytes: null });
  let fd: number | null = null;
  try {
    const pathStat = lstatSync(abs);
    if (!pathStat.isFile() || pathStat.isSymbolicLink())
      return fail("PDF 目标不是普通文件，不能读取目录或符号链接");
    if (options.rejectHardlinks && pathStat.nlink > 1)
      return fail("PDF 原稿备份存在额外硬链接，已拒绝读取非独占文件");

    fd = openSync(abs, "r");
    const stat = fstatSync(fd);
    // Reject a retargeted symlink/junction / rename between path validation
    // and the opened descriptor, instead of trusting a stale lstat.
    if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino)
      return fail("PDF 文件身份在打开过程中发生变化，请重试");
    if (options.rejectHardlinks && stat.nlink > 1)
      return fail("PDF 原稿备份硬链接数量异常，已拒绝读取");
    if (stat.size > MAX_PDF_BYTES)
      return fail(`文件太大(${Math.round(stat.size / 1024 / 1024)}MB,上限 ${MAX_PDF_BYTES / 1024 / 1024}MB)——请用外部程序打开`);

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, MAX_PDF_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_PDF_BYTES)
        return fail("PDF 在读取期间超过 64MB 上限，未发送给界面");
      chunks.push(chunk.subarray(0, count));
    }
    if (total !== stat.size) return fail("PDF 在读取期间大小发生变化，请重试");
    return { ok: true, bytes: new Uint8Array(Buffer.concat(chunks, total)) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return fail("PDF 文件不在了或已被移走");
    if (code === "EACCES" || code === "EPERM") return fail("没有读取 PDF 的权限");
    if (code === "EISDIR") return fail("这不是普通 PDF 文件（目录不能作为 PDF）");
    log.error(`library: bounded PDF read failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(`PDF 读取失败（${typeof code === "string" ? code : "I/O"}），请重试`);
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* cleanup cannot mask result */ }
    }
  }
}

export function readPdfBytes(itemId: string): PdfBytesResult {
  const fail = (error: string): PdfBytesResult => ({ ok: false, error, bytes: null });

  const item = LibraryRepo.get(itemId);
  if (!item) return fail("找不到这篇文献");
  if (!item.pdfPath) return fail("这篇还没有 PDF");

  const abs = fromLibraryRelative(item.pdfPath);
  // DB rows can be damaged, imported, or manually edited. Do not turn a
  // corrupted relative path (including symlink/junction aliases) into an
  // arbitrary filesystem read across the renderer IPC trust boundary.
  if (!isInsideLibrary(abs)) return fail("PDF 路径不在资料库内或文件位置不安全");

  return readPdfFileBounded(abs);
}
