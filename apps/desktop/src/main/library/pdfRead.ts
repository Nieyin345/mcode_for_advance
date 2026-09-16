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
import { existsSync, readFileSync, statSync } from "node:fs";
import { LibraryRepo } from "@main/store/repositories.js";
import { fromLibraryRelative } from "./paths.js";
import { log } from "@main/lib/logger.js";

/** 单份 PDF 的上限。比这个大的多半是扫描版整本书,该走外部程序看。 */
const MAX_PDF_BYTES = 64 * 1024 * 1024;

export interface PdfBytesResult {
  ok: boolean;
  error?: string;
  bytes: Uint8Array | null;
}

export function readPdfBytes(itemId: string): PdfBytesResult {
  const fail = (error: string): PdfBytesResult => ({ ok: false, error, bytes: null });

  const item = LibraryRepo.get(itemId);
  if (!item) return fail("找不到这篇文献");
  if (!item.pdfPath) return fail("这篇还没有 PDF");

  const abs = fromLibraryRelative(item.pdfPath);
  if (!existsSync(abs)) return fail(`文件不在了:${item.pdfPath}`);

  try {
    const size = statSync(abs).size;
    if (size > MAX_PDF_BYTES) {
      return fail(
        `文件太大(${Math.round(size / 1024 / 1024)}MB,上限 ${MAX_PDF_BYTES / 1024 / 1024}MB)——请用外部程序打开`,
      );
    }
    const buf = readFileSync(abs);
    // Buffer 是 Uint8Array 的子类,但送过 IPC 时明确转一次,免得渲染端拿到带 Node
    // 特有方法的对象(structured clone 认 Uint8Array,不认 Buffer 的那些方法)
    return { ok: true, bytes: new Uint8Array(buf) };
  } catch (err) {
    log.error(`library: read pdf failed for ${itemId}: ${(err as Error).message}`);
    return fail(`读取失败:${(err as Error).message}`);
  }
}
