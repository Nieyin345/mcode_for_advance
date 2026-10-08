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
 * 一段文件头里有没有 PDF 魔数 `%PDF-`。**这是"这是不是 PDF"这条规则的唯一实现** ——
 * 导入的关卡({@link verifyPdf})与读取那一路(`pdfText.readPdfBytes`)都调它,免得两份
 * 判据漂移:关卡放行的文件,读取时又说不认识。
 *
 * 用 `includes` 而不是"第 0 字节等于 `%PDF-`":有些生成器会在正文前带一段 UTF-8 BOM
 * 或几行空白(见 {@link verifyPdf} 的文件头),那种文件的魔数不在偏移 0。pdf.js 自己也能
 * 解开这种(实测),所以关卡与读取这一侧都不该因一个 BOM 把它判成"不是 PDF"。
 */
export function hasPdfMagic(head: string): boolean {
  return head.includes("%PDF-");
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
    if (!hasPdfMagic(head)) {
      return /<html|<!doctype html/i.test(head) ? "这不是 PDF(内容看起来是网页)" : "这不是 PDF 文件";
    }
    return null;
  } finally {
    closeSync(fd);
  }
}
