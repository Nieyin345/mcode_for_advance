/**
 * 把库里的 PDF 转成 Markdown,写进 `library_items.md_path`。
 *
 * ## 只有一条来源:pdf.js 本地抽取
 *
 * 它**零上传、零外部依赖**,但只有纯文本 —— 排版、公式、表格都不保留。
 *
 * 想要高质量的转录(公式、多栏、表格),**不在这条路上做**:Mcode 不再内置任何
 * 转录服务(从前的那份 MinerU 客户端已经删掉)。做法是让 AI 在对话/工作流里用
 * **code 节点调你自己装的工具**(`mineru` CLI、`pip install` 的库、什么都行),
 * 转出 `full.md` 之后再走 `library_adopt_markdown` 挂回库里 ——
 * 挂载那一步是 `adoptMarkdownFile`(`library/adoptMarkdown.ts`),界面上的
 * 「用本地 Markdown…」走的是同一个函数。
 *
 * 这条分工是有意的:**Mcode 只管「文件在哪」和「怎么挂回库」,不管「谁转的」。**
 *
 * ## 为什么要落 md_path
 *
 * 右栏的全文检索是 ripgrep 扫 `markdown/**.md`。在这一版之前
 * `LibraryRepo.setMarkdown` **从来没有任何调用方** —— 所以那一列恒为 NULL,
 * 检索永远返回空。转换落地之后它才真的能用。
 *
 * ## 失败不阻断
 *
 * 转换失败只返回人话错误,不动 PDF、不动条目 —— 「转换没成」和「文献没入库」
 * 是两件事,不该互相牵连。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LibraryConversionRow, LibraryItem } from "@contracts/library";
import { markdownPathForHash, fromLibraryRelative, toLibraryRelative } from "@main/library/paths.js";
import { hashFile } from "@main/library/downloader.js";
import { extractPdfText } from "@main/library/pdfText.js";
import { LibraryRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

export type ConvertSource = "pdfjs";

export type ConvertOutcome =
  | { ok: true; source: ConvertSource; mdRelPath: string; chars: number; alreadyDone?: boolean }
  | { ok: false; error: string };

/** 同一篇正在转换时不要重复起一次(UI 可能连点,导入流程也可能并发触发)。 */
const inFlight = new Set<string>();

/**
 * 把一篇文献的 PDF 转成 Markdown。
 *
 * `force = true` 时即使已经有 md 也重转(用户手动要求)。
 */
export async function convertItemToMarkdown(
  item: LibraryItem,
  opts: { force?: boolean } = {},
): Promise<ConvertOutcome> {
  if (!item.pdfPath) return { ok: false, error: "这篇还没有 PDF,先下载或导入一份" };
  // 已经有转换结果就不重做 —— 转换是分钟级的,不该被 UI 的重复点击浪费
  if (!opts.force && item.mdPath && existsSync(fromLibraryRelative(item.mdPath))) {
    return { ok: true, source: "pdfjs", mdRelPath: item.mdPath, chars: 0, alreadyDone: true };
  }
  if (inFlight.has(item.id)) {
    return { ok: false, error: "这篇正在转换中" };
  }
  inFlight.add(item.id);
  try {
    const abs = fromLibraryRelative(item.pdfPath);
    if (!existsSync(abs)) return { ok: false, error: `PDF 文件不在了:${item.pdfPath}` };

    // 内容寻址需要一个 sha。下载来的条目本来就带;没有就现算(也顺手补上)。
    const sha = item.pdfSha256 ?? hashFile(abs);

    const local = await extractPdfText(abs);
    if (!local.ok) {
      return { ok: false, error: local.error };
    }
    if (!local.text.trim()) {
      // 扫描件:解析"成功"但没文本层。这是**一类结果**,不是错误 —— 如实说明,
      // 别让用户以为是软件坏了。顺带指出那条出路:外部工具(OCR)转好之后可以
      // 挂进来(见文件头)。
      return {
        ok: false,
        error: "这个 PDF 没有文本层(扫描件?),本地抽取拿不到正文 —— 要用 OCR 的话,拿外部工具转好 Markdown 再挂进来",
      };
    }
    const mdAbs = markdownPathForHash(sha);
    mkdirSync(dirname(mdAbs), { recursive: true });
    writeFileSync(mdAbs, renderLocalMarkdown(item, local.text), "utf8");

    LibraryRepo.setMarkdown(item.id, toLibraryRelative(mdAbs));
    const chars = statSync(mdAbs).size;
    log.info(`library: converted ${item.id} via pdfjs (${chars}B)`);
    return { ok: true, source: "pdfjs", mdRelPath: toLibraryRelative(mdAbs), chars };
  } catch (err) {
    return { ok: false, error: `转换出错:${(err as Error).message}` };
  } finally {
    inFlight.delete(item.id);
  }
}

/**
 * 逐篇的转换完整度 —— 设置页「转录检测」列表用。
 *
 * **完整 = 有 md,且 md 里引用到的图都在盘上。** 没有图片引用的 md(纯文本兜底、
 * 或本来无图的论文)也算完整 —— 否则那些文献永远显示"未完成",这个标志就废了。
 */
export function conversionReport(): LibraryConversionRow[] {
  const items = LibraryRepo.list({ limit: 100_000 }).items;
  return items.map((item) => {
    const hasPdf = Boolean(item.pdfPath) && existsSync(fromLibraryRelative(item.pdfPath!));
    const mdAbs = item.mdPath ? fromLibraryRelative(item.mdPath) : null;
    const hasMd = Boolean(mdAbs) && existsSync(mdAbs!);

    let imageRefs = 0;
    let assetsOk = true;
    if (hasMd && mdAbs) {
      try {
        const md = readFileSync(mdAbs, "utf8");
        const dir = dirname(mdAbs);
        // 只认相对引用 —— http(s): 和 data: 是外链,不在我们的库里
        for (const m of md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
          const ref = m[1].trim();
          if (/^(https?:|data:)/i.test(ref)) continue;
          imageRefs += 1;
          // 图片路径可能带 %20 之类,解码后再查
          const rel = decodeURIComponent(ref.split(/[?#]/)[0]);
          if (!existsSync(join(dir, ...rel.split("/")))) assetsOk = false;
        }
      } catch {
        // 读不了就当资源不齐 —— 这正是需要用户重转的情况
        assetsOk = false;
      }
    }

    // 产物形态:本地抽取落的是平铺的 `<sha>.md`;而在 `markdown/imported/<id>/`
    // 下面那种(外部工具转好之后挂进来的)是**目录**形态。两者都算已转。
    const source: "local" | "imported" | "none" = !hasMd
      ? "none"
      : item.mdPath!.includes("/imported/")
        ? "imported"
        : "local";

    return {
      id: item.id,
      title: item.title,
      hasPdf,
      hasMd,
      assetsOk,
      imageRefs,
      complete: hasMd && assetsOk,
      source,
    };
  });
}

/**
 * 本地抽取的产物包成一份最小 Markdown。
 *
 * 加标题行是有用的:全文检索命中时,ripgrep 给的是文件里的行号,而 md 文件自己
 * 得能一眼看出是哪一篇 —— 否则一堆哈希名的文件根本分不清。
 */
function renderLocalMarkdown(item: LibraryItem, text: string): string {
  const head = [
    `# ${item.title}`,
    "",
    item.authors?.length ? `${item.authors.map((a) => a.literal ?? [a.given, a.family].filter(Boolean).join(" ")).join(", ")}` : "",
    [item.venue, item.year].filter(Boolean).join(" · "),
    item.doi ? `DOI: ${item.doi}` : "",
    "",
    "---",
    "",
    "> 本文由本地 PDF 抽取生成(pdf.js),只保留纯文本,不含排版与公式还原。",
    "",
  ].filter((l) => l !== "");
  return `${head.join("\n")}\n${text}\n`;
}
