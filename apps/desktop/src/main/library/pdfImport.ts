/**
 * 从本地 PDF 文件导入文献。
 *
 * ## 顺序是有讲究的
 *
 *   1. **校验**(PDF 魔数 + 大小)—— 最快,也最该先挡掉
 *   2. **按 sha256 查重** —— 同内容已经在库里就不重复入库
 *   3. **复制进库** —— 复制不是移动:源文件是用户的,不能动
 *   4. **抽元数据** —— 要读整份文件、还可能联网查 Crossref,放在最后才不会白干
 *
 * 一份失败不影响其他:整个函数逐份处理,把每份的结果(成功/已在库/失败原因)都
 * 带回去,而不是遇到第一个问题就整体抛错 —— 用户一次拖三十篇进来,"有两篇认不出"
 * 不该让另外二十八篇也不入库。
 *
 * ## 去重为什么不能只靠 DOI
 *
 * 本地 PDF 常常**没有** DOI/arXiv 号可匹配(所以 `findExisting` 会返回 null),
 * 但同一份文件导两次完全可能。内容寻址让它们落进同一个 `papers/<ab>/<cd>/<sha>.pdf`,
 * 再加一道 `findByPdfSha`,就不会多出重复条目。
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import type { LibraryItem, LibraryKind } from "@contracts/library";
import { hashFile, verifyPdf } from "@main/library/downloader.js";
import { extractPdfMetadata } from "@main/library/pdfMetadata.js";
import { pdfPathForHash, toLibraryRelative } from "@main/library/paths.js";
import { LibraryRepo } from "@main/store/repositories.js";
import { emitItemImported } from "./broadcast.js";
import { log } from "@main/lib/logger.js";

export interface ImportedFile {
  /** 原始路径(回报给用户看)。 */
  path: string;
  item?: LibraryItem;
  /** 同一份内容已经在库里了 —— 不算失败。 */
  alreadyPresent?: boolean;
  error?: string;
}

export async function importPdfFiles(input: {
  paths: string[];
  collectionIds?: string[];
  /** 收进哪个库(论文 / 教材)。省略 = 论文库。 */
  kind?: LibraryKind;
}): Promise<ImportedFile[]> {
  const out: ImportedFile[] = [];
  for (const rawPath of input.paths) {
    out.push(await importOne(rawPath, input.kind));
  }
  return out;
}

async function importOne(rawPath: string, kind: LibraryKind = "paper"): Promise<ImportedFile> {
  try {
    if (!existsSync(rawPath)) return { path: rawPath, error: "文件不存在" };

    // 1. 校验。verifyPdf 的措辞是给「下载」写的,这里补一句面向本地文件的
    const bad = verifyPdf(rawPath);
    if (bad) {
      return {
        path: rawPath,
        error: bad.status === "needs_login" ? "这不是 PDF(内容看起来是网页)" : bad.error,
      };
    }

    // 2 + 3. 按内容查重,并把字节收进库
    const sha = hashFile(rawPath);
    const dest = pdfPathForHash(sha);
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) copyFileSync(rawPath, dest);
    const rel = toLibraryRelative(dest);

    const dup = LibraryRepo.findByPdfSha(sha);
    if (dup) {
      // 条目在、文件没记上(理论上不该发生)—— 补上,不然它会被当成"没 PDF"
      if (!dup.pdfPath) LibraryRepo.setPdf(dup.id, rel, sha);
      return { path: rawPath, item: { ...dup, pdfPath: dup.pdfPath ?? rel }, alreadyPresent: true };
    }

    // 4. 元数据(分层回退,见 pdfMetadata.ts)
    const meta = await extractPdfMetadata(rawPath);
    const item = LibraryRepo.upsert({
      kind,
      doi: meta.doi ?? null,
      arxivId: meta.arxivId ?? null,
      // upsert 要求 doi || arxivId || title 至少有一个;标题兜底到文件名
      title: meta.title?.trim() || basename(rawPath, extname(rawPath)),
      authors: meta.authors,
      year: meta.year,
      venue: meta.venue,
      volume: meta.volume,
      issue: meta.issue,
      page: meta.page,
      publisher: meta.publisher,
      abstract: meta.abstract,
      source: "pdf",
    });
    LibraryRepo.setPdf(item.id, rel, sha);
    log.info(`library: imported PDF ${basename(rawPath)} as ${item.id} (${meta.source})`);
    // 成功点在这里:条目建好、PDF 也记上了。alreadyPresent 的不算 —— 那条本来就在库里,
    // 之前入库时已经发过事件,再发一次会让自动下载重复排队。
    emitItemImported(item);
    return { path: rawPath, item: { ...item, pdfPath: rel, pdfSha256: sha } };
  } catch (err) {
    return { path: rawPath, error: (err as Error).message };
  }
}
