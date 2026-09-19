/**
 * 把库里(或某个集合里)的文献导出成一份引用文件。
 *
 * ## 落在库根的 `exports/` 下,而不是弹「另存为」
 *
 * 两个理由:少一次交互(用户点「导出」就是想拿到文件,不是想先逛一遍文件系统);
 * 而且它和 PDF、Markdown 放在同一个根下 —— 备份或迁移数据根时它跟着一起走,不会
 * 出现"文献都在、引用文件落在下载文件夹里找不着"这种事。
 *
 * 文件名的库名部分要净化:集合名是用户起的,可能带 `/`、`:` 这类在 Windows 上
 * 建不出文件的字符(见 `sanitizeSegment`)。
 *
 * ## 三种格式的排法不一样,这是格式本身规定的
 *
 *   - BibTeX:一条一个 `@type{...}` 块,块之间空行 —— 这是 `.bib` 的语法要求。
 *   - APA:**按第一作者姓氏字母序**排列。APA 的参考文献表就是字母序,不是引用顺序。
 *   - GB/T 7714 顺序编码制:带 `[1] [2]` 序号。序号在正文里对应引用位置,这里没有
 *     正文可依据,所以沿用库里「最近加入在前」的顺序并如实编号 —— 用户自己排序比
 *     我们替他猜一个更靠谱。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatApa, formatBibtexLibrary, formatGb7714, type CitationStyle } from "@contracts/citation";
import type { LibraryItem } from "@contracts/library";
import { CollectionRepo, LibraryRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import { exportsDir, ensureLibraryDirs } from "./paths.js";

export interface ExportResult {
  ok: boolean;
  error?: string;
  path: string;
  count: number;
}

/** 文件名里不能出现的字符(Windows 上真建不出来,不是洁癖)。 */
function sanitizeSegment(raw: string): string {
  return raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 60) || "library";
}

/** `20260914` —— 导出文件名里的日期戳,便于同一天多次导出时区分。 */
function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** APA 按第一作者姓氏(没有姓氏就用整体名)的字母序。 */
function apaSorted(items: LibraryItem[]): LibraryItem[] {
  const keyOf = (i: LibraryItem): string => (i.authors[0]?.family ?? i.authors[0]?.literal ?? "").toLowerCase();
  return [...items].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

export function exportCitations(input: {
  style: CitationStyle;
  collectionId?: string;
}): ExportResult {
  const collection = input.collectionId
    ? CollectionRepo.list().find((c) => c.id === input.collectionId) ?? null
    : null;
  // 指定了集合、但库里查不到它(典型:集合刚在别处被删掉,或者调用方拿的是几分钟前
  // 的一份列表快照)—— 这要与"集合是空的"**分开报**。两者都会落到下面
  // `items.length === 0` 那一句上,但原因完全不同:一个是"你还没往里放东西",
  // 一个是"这个集合已经没了"。混成一句话的后果是:用户对着一个已删的集合反复去
  // 建条目,而提示始终在说"这个范围里还没有文献",永远查不出真正的原因。
  if (input.collectionId && !collection) {
    return { ok: false, error: "这个集合已经不存在了", path: "", count: 0 };
  }
  // limit 给足:导出是"整库"语义,不设上限会和列表分页的默认 200 撞车 —— 用户会
  // 得到一份"只有 200 条"的 bib,而且看不出来被截断了。
  const items = input.collectionId
    ? LibraryRepo.listByCollection(input.collectionId)
    : LibraryRepo.list({ limit: 100000 }).items;

  if (items.length === 0) {
    return { ok: false, error: "这个范围里还没有文献", path: "", count: 0 };
  }

  let body: string;
  let ext: string;
  switch (input.style) {
    case "bibtex":
      body = formatBibtexLibrary(items);
      ext = "bib";
      break;
    case "apa":
      body = `${apaSorted(items).map(formatApa).join("\n\n")}\n`;
      ext = "txt";
      break;
    case "gb7714":
    default:
      body = `${items.map((item, i) => `[${i + 1}] ${formatGb7714(item)}`).join("\n")}\n`;
      ext = "txt";
      break;
  }

  try {
    ensureLibraryDirs();
    const dir = exportsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const name = `${sanitizeSegment(collection?.name ?? "全部文献")}-${input.style}-${stamp()}.${ext}`;
    const path = join(dir, name);
    writeFileSync(path, body, "utf8");
    log.info(`library: exported ${items.length} citations (${input.style}) -> ${path}`);
    return { ok: true, path, count: items.length };
  } catch (err) {
    return { ok: false, error: `写入失败:${(err as Error).message}`, path: "", count: 0 };
  }
}
