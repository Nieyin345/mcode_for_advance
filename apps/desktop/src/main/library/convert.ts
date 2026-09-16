/**
 * 把库里的 PDF 转成 Markdown,写进 `library_items.md_path`。
 *
 * ## 两级来源
 *
 *   1. **MinerU**(设置里配了密钥且启用)—— 排版、公式、表格、多栏都能保留,
 *      是主力。代价是**要把 PDF 上传到 mineru.net**。
 *   2. **pdf.js 本地抽取**(没配密钥,或 MinerU 失败)—— 只有纯文本,但**零上传、
 *      零额度**,而且足够让全文检索用起来。不想外传的文献就走它。
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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LibraryConversionRow, LibraryItem } from "@contracts/library";
import {
  markdownPathForHash,
  markdownDirForHash,
  fromLibraryRelative,
  toLibraryRelative,
} from "@main/library/paths.js";
import { hashFile } from "@main/library/downloader.js";
import { extractPdfText } from "@main/library/pdfText.js";
import { mineruConvert } from "@main/integrations/mineru.js";
import { IntegrationStore } from "@main/integrations/store.js";
import { LibraryRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

export type ConvertSource = "mineru" | "pdfjs";

export type ConvertOutcome =
  | { ok: true; source: ConvertSource; mdRelPath: string; chars: number; alreadyDone?: boolean }
  | { ok: false; error: string; /** 没配 MinerU 密钥 —— 调用方可以据此提示去设置里配 */ needsKey?: boolean };

/** 同一篇正在转换时不要重复起一次(UI 可能连点,导入流程也可能并发触发)。 */
const inFlight = new Set<string>();

/**
 * 把一篇文献的 PDF 转成 Markdown。
 *
 * `force = true` 时即使已经有 md 也重转(MinerU 升级、或用户手动要求)。
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

    const cfg = IntegrationStore.resolve("mineru");
    const useMineru = cfg.enabled && cfg.key.length > 0;

    /** 最终那份 .md 的绝对路径 —— 由哪条路成功决定。 */
    let mdAbs: string | null = null;
    let source: ConvertSource = "pdfjs";
    let mineruError: string | null = null;

    if (useMineru) {
      // MinerU 的产物是**一个目录**(full.md + images/),不是单个文件 ——
      // 正文里几十处 ![](images/…),只捞 full.md 会让图全部断链。
      const destDir = markdownDirForHash(sha);
      const res = await mineruConvert({ key: cfg.key, baseUrl: cfg.baseUrl }, abs, destDir);
      if (res.ok) {
        source = "mineru";
        mdAbs = res.markdownPath;
        // MinerU 的包里附带一份**原始 PDF 的副本**(`*_origin.pdf`)—— 我们库里
        // 已经按内容哈希存过一份了,再留一份等于每篇白占几 MB。删掉。
        // (其余 json 保留:`*_content_list.json` / `*_model.json` 体积小,以后做
        //  版面相关的功能可能用得上。)
        pruneRedundantOriginPdf(destDir);
        // 上一次本地兜底留下的平铺 <sha>.md 现在是孤儿(两者路径不同),清掉,
        // 否则 markdown/ 下会同时躺着两份同一篇的转换结果。
        try {
          rmSync(markdownPathForHash(sha), { force: true });
        } catch {
          /* 清不掉不影响结果 */
        }
      } else {
        mineruError = res.error;
        log.warn(`mineru convert failed for ${item.id}, falling back to pdf.js: ${res.error}`);
      }
    }

    if (mdAbs === null) {
      const local = await extractPdfText(abs);
      if (!local.ok) {
        return {
          ok: false,
          error: mineruError ? `MinerU 失败(${mineruError});本地抽取也失败(${local.error})` : local.error,
        };
      }
      if (!local.text.trim()) {
        // 扫描件:解析"成功"但没文本层。这是**一类结果**,不是错误 —— 如实说明,
        // 别让用户以为是软件坏了。
        return { ok: false, error: "这个 PDF 没有文本层(扫描件?),需要 OCR —— 当前不做" };
      }
      mdAbs = markdownPathForHash(sha);
      mkdirSync(dirname(mdAbs), { recursive: true });
      writeFileSync(mdAbs, renderLocalMarkdown(item, local.text), "utf8");
    }

    LibraryRepo.setMarkdown(item.id, toLibraryRelative(mdAbs));
    const chars = statSync(mdAbs).size;
    log.info(`library: converted ${item.id} via ${source} (${chars}B)`);
    return { ok: true, source, mdRelPath: toLibraryRelative(mdAbs), chars };
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

    // 产物形态:MinerU 落的是目录里的 `full.md`,本地兜底是平铺的 `<sha>.md`
    const source: "mineru" | "pdfjs" | "none" = !hasMd
      ? "none"
      : item.mdPath!.endsWith("/full.md")
        ? "mineru"
        : "pdfjs";

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

/** 没配 MinerU 时有没有本地兜底可用 —— 给 UI 决定要不要提示「去配密钥」。 */
export function hasMineruConfigured(): boolean {
  const cfg = IntegrationStore.resolve("mineru");
  return cfg.enabled && cfg.key.length > 0;
}

/**
 * 删掉 MinerU 附带的那份 `*_origin.pdf`。
 *
 * 它是**我们已经存过的 PDF 的重复副本** —— 库里那份在 `papers/<ab>/<cd>/<sha>.pdf`,
 * 内容寻址、天然去重;MinerU 再塞一份进来只是让每篇多占几 MB(实测一篇 3.4MB)。
 * 删失败也只是多占点空间,不该让整次转换失败。
 */
function pruneRedundantOriginPdf(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      if (/_origin\.pdf$/i.test(name)) rmSync(join(dir, name), { force: true });
    }
  } catch {
    /* 尽力而为 */
  }
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
