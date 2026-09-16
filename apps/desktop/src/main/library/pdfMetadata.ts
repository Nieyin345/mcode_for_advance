/**
 * 从一份 PDF 里自动采集元数据 —— 照 Zotero 的分层回退。
 *
 * Zotero 的公开做法是「把前几页交给识别服务,服务端用多种提取算法 + Crossref 已知
 * 元数据;客户端另做 DOI/ISBN 直查」。剥掉服务端,逻辑就是**先找标识符、找不到再
 * 拿文本特征去 Crossref 做书目检索**。这里在本地把同样的分层实现一遍:
 *
 *   1. **内嵌元数据** —— XMP 的 `prism:doi` / `dc:identifier` / `dc:title` /
 *      `dc:creator`,以及 `/Info` 的 Title/Author。实测命中率比预期高(IEEE、
 *      Springer 的 PDF 都直接带 DOI)。
 *   2. **文件名** —— `10.1109_TII.2020.1234567.pdf`、`2005.11401.pdf` 这类极常见。
 *   3. **首页正文** —— DOI / arXiv 正则。
 *   4. 拿到标识符 → **直接复用既有的 `fetchByDoi` / `fetchByArxivId`**(Crossref /
 *      arXiv,已经写好且带代理处理)→ 标题作者年份期刊摘要全齐。
 *   5. 没标识符 → 从首页文本猜标题,拿 **既有的 `searchExternal`** 做 Crossref
 *      书目检索;**只有标题相似度过关才采纳** —— 引错文献比不引更糟。
 *   6. 都不行 → 用文件名当标题,标 `filename-only`,界面上显示「元数据待补全」。
 *
 * 每一层都记进 `source`,这样「为什么这篇没抓到作者」是可查的,而不是猜。
 */
import { basename, extname } from "node:path";
import type { LibraryAuthor } from "@contracts/library";
import { parseIdentifierLine } from "@main/library/importer.js";
import { fetchByArxivId, fetchByDoi, searchExternal } from "@main/library/metadata.js";
import { probePdf } from "@main/library/pdfText.js";

/** 标题相似度门槛。低于它就宁可留空 —— 错误的元数据比缺失的元数据危害大得多。 */
const TITLE_MATCH_MIN = 0.8;

export interface ExtractedMetadata {
  doi?: string;
  arxivId?: string;
  title?: string;
  authors?: LibraryAuthor[];
  year?: number;
  venue?: string;
  /** 卷 / 期 / 页码 / 出版商 —— 引用格式要用,只有 Crossref 给得到。 */
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  abstract?: string;
  /** 这份元数据最终是从哪一层来的。 */
  source: "api" | "embedded" | "filename" | "page-text" | "filename-only";
  /** 标识符是哪一层找到的(诊断「为什么没查到」用)。 */
  identifierFrom?: "embedded" | "filename" | "page-text";
}

/* ── 标题相似度 ── */

const PUNCT_RE = /[^\p{L}\p{N}\s]/gu;

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(PUNCT_RE, " ").replace(/\s+/g, " ").trim();
}

/** 归一化后的词集合重合率。用作「这两个标题是不是同一篇」的判据。 */
function titleOverlap(a: string, b: string): number {
  const sa = new Set(normalizeTitle(a).split(" ").filter((w) => w.length > 2));
  const sb = new Set(normalizeTitle(b).split(" ").filter((w) => w.length > 2));
  if (sa.size === 0 || sb.size === 0) return 0;
  let hit = 0;
  for (const w of sa) if (sb.has(w)) hit += 1;
  return hit / Math.max(sa.size, sb.size);
}

/* ── 从文本里猜标题 ── */

/**
 * 从首页文本里猜标题。
 *
 * 实用做法:取前面若干行里**最长且像标题的那一行**。排除掉邮箱、URL、纯数字、
 * 过短的片段 —— 首页上这些噪音很多(作者单位、邮箱、arXiv 页眉)。
 * 猜错也没关系:下一步的相似度门槛会把它挡掉。
 */
function guessTitle(text: string): string | undefined {
  const lines = text
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 20 && l.length <= 200);
  let best: string | undefined;
  for (const line of lines.slice(0, 25)) {
    if (/[@]|https?:\/\//i.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (!best || line.length > best.length) best = line;
  }
  return best;
}

/** XMP 的 `dc:creator` 可能是 `A; B` 或单个作者串。粗分成 CSL 作者。
 *  分不干净没关系 —— 一旦查到权威库,作者会被 Crossref 的结果整组替换。 */
function authorsFromString(s: string): LibraryAuthor[] | undefined {
  const parts = s
    .split(/[;；]|\band\b|、/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.map((p) => {
    // 含中日韩字符的整名不拆 —— 拆了反而错(与 importer.ts 的判据一致)
    if (/[㐀-鿿぀-ヿ가-힯]/.test(p)) return { literal: p };
    const m = p.match(/^([^,]+),\s*(.+)$/);
    return m ? { family: m[1].trim(), given: m[2].trim() } : { literal: p };
  });
}

/* ── 主流程 ── */

export async function extractPdfMetadata(absPath: string): Promise<ExtractedMetadata> {
  const probe = await probePdf(absPath);

  // 1 + 3.内嵌元数据 / 首页正文里的标识符
  let doi = probe.meta.doi;
  let arxivId: string | undefined;
  let identifierFrom: ExtractedMetadata["identifierFrom"] = doi ? "embedded" : undefined;

  if (!doi && probe.text) {
    for (const line of probe.text.split(/\n+/)) {
      const hit = parseIdentifierLine(line);
      if (hit?.doi) {
        doi = hit.doi;
        identifierFrom = "page-text";
        break;
      }
      if (hit?.arxivId && !arxivId) {
        arxivId = hit.arxivId;
        identifierFrom = "page-text";
      }
    }
  }

  // 2.文件名 —— 下载来的 PDF 常按标识符命名,这一步经常一击命中
  if (!doi && !arxivId) {
    const stem = basename(absPath, extname(absPath)).replace(/_/g, "/");
    const hit = parseIdentifierLine(stem) ?? parseIdentifierLine(basename(absPath));
    if (hit?.doi) {
      doi = hit.doi;
      identifierFrom = "filename";
    } else if (hit?.arxivId) {
      arxivId = hit.arxivId;
      identifierFrom = "filename";
    }
  }

  // 4.有标识符 → 查权威库(复用既有实现,自带代理处理)
  if (doi) {
    const meta = await fetchByDoi(doi);
    if (meta) {
      return {
        doi: meta.doi ?? doi,
        title: meta.title,
        authors: meta.authors,
        year: meta.year,
        venue: meta.venue,
        volume: meta.volume,
        issue: meta.issue,
        page: meta.page,
        publisher: meta.publisher,
        abstract: meta.abstract,
        source: "api",
        identifierFrom,
      };
    }
  }
  if (arxivId) {
    const meta = await fetchByArxivId(arxivId);
    if (meta) {
      return {
        arxivId: meta.arxivId ?? arxivId,
        title: meta.title,
        authors: meta.authors,
        year: meta.year,
        abstract: meta.abstract,
        source: "api",
        identifierFrom,
      };
    }
  }

  // 5.没标识符(或查不到)→ 用内嵌标题 + 书目检索
  const embeddedTitle = probe.meta.title?.trim();
  const guessed = embeddedTitle || guessTitle(probe.text);
  if (guessed) {
    const found = await searchByTitle(guessed);
    if (found) return found;
  }

  // 6.兜底:内嵌元数据能用多少用多少,标题退到文件名
  const fallbackTitle = embeddedTitle || basename(absPath, extname(absPath));
  return {
    doi,
    arxivId,
    title: fallbackTitle,
    authors: probe.meta.author ? authorsFromString(probe.meta.author) : undefined,
    source: embeddedTitle ? "embedded" : identifierFrom ? "page-text" : "filename-only",
    identifierFrom,
  };
}

/**
 * 拿一个标题去 Crossref 做书目检索,**相似度过关才采纳**。
 *
 * 这一步是「猜」,所以门槛必须硬:Crossref 的书目检索对任何输入都会返回点什么,
 * 不设门槛就会把完全不相干的论文的元数据贴到用户手上 —— 那比留空糟得多。
 */
async function searchByTitle(title: string): Promise<ExtractedMetadata | null> {
  try {
    const results = await searchExternal({ query: title, sources: ["crossref"], limit: 5 });
    for (const r of results) {
      if (!r.title) continue;
      if (titleOverlap(title, r.title) < TITLE_MATCH_MIN) continue;
      return {
        doi: r.doi,
        arxivId: r.arxivId,
        title: r.title,
        authors: r.authors,
        year: r.year,
        venue: r.venue,
        volume: r.volume,
        issue: r.issue,
        page: r.page,
        publisher: r.publisher,
        source: "api",
        identifierFrom: "page-text",
      };
    }
  } catch {
    // 检索失败不致命 —— 退回去用内嵌元数据/文件名
  }
  return null;
}
