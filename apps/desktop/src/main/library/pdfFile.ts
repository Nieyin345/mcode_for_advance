/**
 * 本地 PDF 文件的两个小工具:内容哈希、以及"这真的是 PDF 吗"。
 *
 * 原先住在 `downloader.ts` 里(2026-09-27 随学术那一套一起退役);本地导入
 * (`pdfImport.ts`)还要用它们,所以单独留下这一小份。
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

/** 文件内容的 sha256(十六进制)。库里 PDF 按它内容寻址,天然去重。 */
export function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 校验一份文件是不是能用的 PDF。通过返回 `null`,否则返回一句给用户看的原因。
 *
 * 只看两样:非空、以及 `%PDF-` 魔数(允许前面有少量 BOM / 空白 —— 有些生成器会
 * 这么干)。不解析结构:真坏掉的文件在预览时自然会报错,这里只挡明显的"不是 PDF"。
 */
export function verifyPdf(path: string): string | null {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return "文件不存在";
  }
  if (size === 0) return "文件是空的";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(1024, size));
    readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString("latin1");
    if (!head.includes("%PDF-")) {
      return /<html|<!doctype html/i.test(head) ? "这不是 PDF(内容看起来是网页)" : "这不是 PDF 文件";
    }
    return null;
  } finally {
    closeSync(fd);
  }
}
