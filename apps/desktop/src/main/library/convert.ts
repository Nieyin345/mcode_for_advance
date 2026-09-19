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
 *
 * ## ⚠️ 用户**采纳**进来的那份,重转也不许覆盖
 *
 * 这一条是 2026-09-20 修的一个**覆盖用户成果**的 bug。`force` 从前是唯一的判据,而
 * 「重转」这条路**永远带 force**(设置页的「重转这篇」、条目详情页的「重新转换」、
 * AI 的 `library_convert {force:true}` 都带)。于是用户手动采纳进来、或自己改过的
 * Markdown,会被本地抽取重新生成的顶掉 —— 而本地抽取只有纯文本(见文件头),
 * 拿它去盖用户那份**是降级,不是重做**。他更满意的那份一个字都不剩。
 *
 * 判据**不新增字段**,用落点结构就够:采纳的产物落在
 * `markdown/imported/<条目 id>/`(目录形态,同级有 `images/`),机器转的落在
 * `markdown/<ab>/<cd>/<sha>.md`(平铺一个文件,内容寻址 —— 所以**没有"用户改过"
 * 这一说**,重转本来就是"同一份 PDF 再抽一遍")。`conversionReport` 早就按同一条
 * 判据分着 `imported` / `local` 两档了(见那里的 `source`),这里复用它,不发明新机制。
 *
 * 落到"不该覆盖"上时的动作是**如实跳过**,不是失败:那条命令本身没出错,只是没必要做
 * (与 `alreadyDone` 同一种语义),而结果里要能把这件事**说出来** —— 静默跳过会让模型
 * 向用户汇报一件没发生的事。
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
  | {
      ok: true;
      source: ConvertSource;
      mdRelPath: string;
      chars: number;
      alreadyDone?: boolean;
      /** 跳过的原因是"这份是用户采纳进来的" —— 与 `alreadyDone`(已经有 md 了)分开,
       *  调用方据此才能对用户说清是哪一种跳过。 */
      skipped?: boolean;
    }
  | { ok: false; error: string };

/** 同一篇正在转换时不要重复起一次(UI 可能连点,导入流程也可能并发触发)。 */
const inFlight = new Set<string>();

/**
 * 这份 Markdown 是**用户采纳进来的**(而不是本地抽取生成的)吗。
 *
 * 唯一的判据是**落点结构**:`markdown/imported/<条目 id>/xxx.md` —— 这正是
 * `conversionReport` 分 `imported` / `local` 两档用的那条(也是 `markdownArtifact`
 * 认"整包"的那条)。用字面量 `imported` 而不是正则,是为了两边描述的是同一件事。
 *
 * 为什么"路径里有没有 `/imported/`"就够,不需要记一个 adopted 标记:`imported/`
 * **是采纳那一路独占的落点**(`adoptMarkdownFile` 的 `importedDirForId` 是唯一往那里写
 * 的),而机器那一路只能落在内容寻址的 `markdown/<ab>/<cd>/<sha>.md` 上。
 */
function isAdoptedMarkdown(mdRelPath: string): boolean {
  return mdRelPath.split("/").filter(Boolean).includes("imported");
}

/**
 * 把一篇文献的 PDF 转成 Markdown。
 *
 * `force = true` 时即使已经有 md 也重转(用户手动要求)—— **但用户采纳进来的那份除外**:
 * 那种是用户自己的成果,重转只会拿纯文本把它盖掉(见文件头)。那种情况下如实跳过。
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
  /**
   * 已经有 md、还是**用户采纳**的那份 → force 也不动它。
   *
   * 两种子情况要分开说(见文件头),因为调用方要拿它给用户一句准话:
   *   - 文件在盘上 → 跳过,理由是"那是用户自己的一份";
   *   - **文件不在了**(用户删了/挪了库)→ 不能当作"跳过"混过去。那时 `md_path` 指向的
   *     是一个不存在的文件,静默跳过会让这篇永远读不到正文、而谁也不知道;顺手转一份
   *     "机器版"又是把用户那条记录改掉。所以如实说清、并指出去处 —— 至于要不要留一份
   *     机器版,由用户自己决定(重转那条路上没有"我问过用户了"这个状态可用)。
   */
  if (opts.force && item.mdPath && isAdoptedMarkdown(item.mdPath)) {
    if (existsSync(fromLibraryRelative(item.mdPath))) {
      log.info(`library: 跳过重转 ${item.id} —— 这份 Markdown 是用户采纳进来的`);
      // 两个字段都给:`alreadyDone` 是既有的"没有重转"语义(两条调用方都按它说人话),
      // `skipped` 是"为什么跳过"那一档(采纳的)。多给一层不会让现状说错话 —— 只会让
      // 将来那两处文案能说得更准(它们现在只认 alreadyDone)。
      return {
        ok: true,
        source: "pdfjs",
        mdRelPath: item.mdPath,
        chars: 0,
        alreadyDone: true,
        skipped: true,
      };
    }
    return {
      ok: false,
      error: "这份 Markdown 是用户自己挂进来的,而文件已经不在了 —— 要本地重新转一份的话,先把它挂回去一份(或者删掉这条记录上的 md)",
    };
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
