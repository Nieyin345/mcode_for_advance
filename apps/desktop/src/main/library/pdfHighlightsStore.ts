/**
 * PDF 高亮的**读、写、写回文件**（走 pdf.js 那条路）。
 *
 * ## 一条高亮存在两处，各有各的用
 *
 *  - **文件旁边的 `.<名字>.mcode-highlights.json`** —— 跟着文件走。文件被移动、
 *    复制、同步到别的机器，批注还在。这是"事实来源"。
 *  - **写回 PDF 本身**（真 `/Highlight` 批注）—— 拿出去用（发给别人、Acrobat
 *    里看）时带着。
 *
 * ## 为什么不用数据库
 *
 * `library_items` 加个 `highlights` 列要一次 schema 迁移，而且高亮会**跟着条目走、
 * 不跟着文件走** —— 用户把 PDF 移出资料库（或者项目文件里那些根本不在库里的 PDF）
 * 就丢了。存旁边没这个问题，也**不需要迁移**。
 *
 * ## 为什么写回用 pdf.js 的 `saveDocument()`
 *
 * 它自己就是 Firefox 那个 PDF 阅读器的批注实现，写出来的是**真批注**
 * （`/Subtype /Highlight` + `/Annots`）；而 `react-pdf-highlighter-plus` 的
 * `exportPdf()` 是把黄条**画进页面内容流**（`/Annots` 是空的）—— 在 Acrobat 的
 * 批注面板里看不到。用户要的是前者。而且 pdfjs-dist 已经装着，**零新依赖**。
 *
 * ⚠️ **坐标换算与批注组装不在这里** —— 在 `@contracts/pdfHighlight`。原因：渲染端
 * 也要用同一套（它不许 import 主进程），而"共享实现只有一份"是这个仓库的硬规矩。
 * 这里只管**盘上的事**（读文件、写文件）。
 */
import { randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PdfHighlight } from "@contracts/library";
import { validatePdfHighlight } from "@contracts/pdfHighlight";

/** 高亮索引文件的后缀。点开头 + 原文件名，排序时自然挨着。 */
const SIDECAR_SUFFIX = ".mcode-highlights.json";

export function highlightsPathFor(pdfPath: string): string {
  return join(dirname(pdfPath), `.${basename(pdfPath)}${SIDECAR_SUFFIX}`);
}

/**
 * **干净底稿**的路径 —— 第一次"烤进 PDF"之前，先把当时的 PDF 原样存一份在这儿。
 *
 * ## 为什么非有它不可
 *
 * 用户要的是"标注**烤进 PDF 文件**"。而烘烤是**画上去**（`exportPdf` 把黄条画进页面），
 * 不是 PDF 批注对象 —— **没法原地更新或擦掉**。
 *
 * 于是"改个颜色再烤一次"就会变成**烤两遍**（旧的黄条还在，新色叠上去）。撤销、删除
 * 标注同理 —— 烤进去的东西删不掉。
 *
 * 所以：**每次都从这份干净底稿重新烤**（底稿 + 全部标注 → 覆盖那个 PDF）。
 * 底稿只在第一次烘烤前存一次，之后不动。
 */
export function originalPathFor(pdfPath: string): string {
  return join(dirname(pdfPath), `.${basename(pdfPath)}.mcode-original.pdf`);
}

/** 有没有存过干净底稿。 */
export function hasOriginal(pdfPath: string): boolean {
  return existsSync(originalPathFor(pdfPath));
}

/**
 * 存一份干净底稿（**只在还没有的时候存**，绝不覆盖）。
 *
 * 覆盖的话，第二次烘烤就会把"已经烤过的"存成底稿 —— 从此底稿也带着旧标注，
 * 越烤越糊且再也回不去。
 */
export function ensureOriginal(pdfPath: string, bytes: Uint8Array): void {
  const target = originalPathFor(pdfPath);
  if (existsSync(target)) return;
  const tmp = `${target}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 尽力而为 */
    }
    throw err;
  }
}

/**
 * 读某一篇 PDF 的全部高亮。没有索引文件就是空数组（**不是**错误 —— 第一次打开
 * 一篇没划过的论文是常态）。
 */
export function readHighlights(pdfPath: string): PdfHighlight[] {
  const p = highlightsPathFor(pdfPath);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { highlights?: PdfHighlight[] };
    const list = Array.isArray(raw?.highlights) ? raw.highlights : [];
    // 坏数据**在这里就滤掉**，别让它流到写回那一层（那里会算出一堆 NaN 坐标）
    return list.filter((h) => validatePdfHighlight(h) === null);
  } catch {
    // 索引文件本身坏了（手改坏了 / 半截写入）—— 当没有处理，但**不覆盖它**：
    // 用户还有机会从里面捞回内容。
    return [];
  }
}

/**
 * 全量覆盖写索引文件。原子替换（临时文件 + rename）—— 中途崩了原文件一个字节不动。
 * 旧索引若读不出/含坏记录，先留一份不覆盖的备份，避免下一次保存抹掉可恢复内容。
 */
export function writeHighlights(pdfPath: string, highlights: PdfHighlight[]): void {
  const target = highlightsPathFor(pdfPath);
  const tmp = `${target}.${Date.now().toString(36)}.tmp`;
  try {
    if (existsSync(target)) {
      let valid = false;
      try {
        const old = JSON.parse(readFileSync(target, "utf8")) as
          | { version?: number; highlights?: PdfHighlight[] }
          | null;
        valid = old?.version === 1 && Array.isArray(old.highlights) &&
          old.highlights.every((h) => validatePdfHighlight(h) === null);
      } catch {
        // 读不到或 JSON 不完整也算坏；备份失败时直接报错，绝不先覆盖原件。
      }
      if (!valid) {
        copyFileSync(target, `${target}.corrupt-${randomUUID()}`, constants.COPYFILE_EXCL);
      }
    }
    writeFileSync(
      tmp,
      JSON.stringify({ version: 1, pdf: basename(pdfPath), highlights }, null, 2),
      "utf8",
    );
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 尽力而为 */
    }
    throw err;
  }
}

/** 写回结果，给界面报"写了几条、跳过几条"。 */
export interface WriteBackResult {
  written: number;
  skipped: Array<{ id: string; reason: string }>;
  bytes?: number;
}

/**
 * 把高亮写回 PDF 文件本身。**原子替换**：先写同目录临时文件再 rename —— pdf.js
 * 是**整个文件重写**，中途崩了不能毁掉用户那篇论文。
 *
 * `save` 由调用方给（渲染端是 `pdfDoc.saveDocument()`），这样这个模块不必知道
 * pdf.js 的存在，无头测试也能塞一个假的进去。
 */
export async function writeBackToFile(
  pdfPath: string,
  highlights: PdfHighlight[],
  save: (usable: PdfHighlight[]) => Promise<Uint8Array>,
): Promise<WriteBackResult> {
  const skipped: Array<{ id: string; reason: string }> = [];
  const usable: PdfHighlight[] = [];
  for (const h of highlights) {
    const bad = validatePdfHighlight(h);
    if (bad) skipped.push({ id: h?.id ?? "(无 id)", reason: bad });
    else usable.push(h);
  }

  if (!existsSync(pdfPath)) return { written: 0, skipped };

  const out = await save(usable);
  const tmp = join(
    dirname(pdfPath),
    `.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp.pdf`,
  );
  try {
    writeFileSync(tmp, out);
    // ⚠️ 同目录 rename 才是原子的。跨盘的 rename 在 Windows 上会抛 EXDEV ——
    //    所以临时文件必须落在**原文件的目录**里，不能放系统 temp。
    renameSync(tmp, pdfPath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 尽力而为 */
    }
    throw err;
  }
  return { written: usable.length, skipped, bytes: statSync(pdfPath).size };
}
