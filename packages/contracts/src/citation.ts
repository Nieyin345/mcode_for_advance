/**
 * 引用格式:GB/T 7714-2015(顺序编码制)、APA 第 7 版、BibTeX。
 *
 * 放在 contracts 而不是主进程或渲染端:同一份实现要同时给**三处**用 ——
 * 详情面板显示、导出 `.bib` 文件、以及给 AI 读的清单(见 `main/ipc/library.ts`
 * 的 `library.manifest`)。三处各写一遍必然漂移,而引用格式漂移的后果是用户把错的
 * 东西粘进论文里,自己还看不出来。
 *
 * ## 为什么不用 CSL(和 Zotero 一样的做法)
 *
 * Zotero 的引用输出走 citeproc + CSL 样式文件,那是**几百 KB 的样式 XML 加一个
 * 处理器**,而且样式文件要随版本更新。用户要的三种格式里,GB/T 7714 和 APA 的
 * 期刊/会议条目规则都很短,值得手写;引入 CSL 会让这个功能变成依赖一个外部样式库
 * 的长期维护负担。
 *
 * **所以这是简化实现,不是出版级排版**:准确覆盖期刊论文、会议论文、图书、学位
 * 论文、预印本这几类的主干格式;`note`/`edition`/`translator` 这类次要字段没有。
 * 缺字段时**省略整段,而不是留一对空括号** —— 半个空模板比短一点的模板更糟,
 * 用户会以为是自己填错了。
 *
 * ## 作者名的处理
 *
 * 存储层用 CSL 风格的对象(`family`/`given`/`literal`,理由见 `library.ts` 顶部),
 * 三种格式各自的规则都在下面:
 *   - GB/T 7714:西文 **姓全大写 + 名缩写**(`SMITH J`);中文整体用之(`张三`)。
 *   - APA:西文 `Family, F. M.`;`literal` 原样(切不开的名字强行切只会切错)。
 *   - BibTeX:`Family, Given`。
 */

import type { LibraryAuthor, LibraryItem, LibraryItemType } from "./library.js";

/** 支持的引用格式。用户选定清单:GB/T 7714 + APA + BibTeX。 */
export const CITATION_STYLES = ["gb7714", "apa", "bibtex"] as const;
export type CitationStyle = (typeof CITATION_STYLES)[number];

/** 参与引用格式的字段子集 —— 不要求调用方凑齐整个 `LibraryItem`。 */
export type CitableItem = Pick<
  LibraryItem,
  | "title"
  | "authors"
  | "year"
  | "venue"
  | "volume"
  | "issue"
  | "page"
  | "publisher"
  | "doi"
  | "arxivId"
  | "url"
  | "type"
>;

/* ─────────────────────────── 作者名 ─────────────────────────── */

/** 名的首字母:`John A.` → `JA`;`John` → `J`。 */
function initials(given: string | undefined): string {
  if (!given) return "";
  return given
    .split(/[\s.-]+/)
    .map((w) => w.charAt(0).toUpperCase())
    .filter(Boolean)
    .join("");
}

/** GB/T 7714 的作者名:西文「姓全大写 + 名缩写」,中日韩等整体用之。 */
function gbAuthor(a: LibraryAuthor): string {
  if (a.literal) return a.literal;
  const ini = initials(a.given);
  const family = (a.family ?? "").toUpperCase();
  return [family, ini].filter(Boolean).join(" ");
}

/** APA 的作者名:西文 `Family, F. M.`;`literal` 原样。 */
function apaAuthor(a: LibraryAuthor): string {
  if (a.literal) return a.literal;
  const ini = initialsWithDots(a.given);
  return [a.family ?? "", ini].filter(Boolean).join(", ");
}

/** `John Alan` → `J. A.`(APA 要求缩写带点且空格分隔)。 */
function initialsWithDots(given: string | undefined): string {
  if (!given) return "";
  return given
    .split(/[\s.-]+/)
    .map((w) => w.charAt(0).toUpperCase())
    .filter(Boolean)
    .map((c) => `${c}.`)
    .join(" ");
}

/** BibTeX 的作者名:`Family, Given`,多名用 ` and ` 连接(这是 BibTeX 的语法)。 */
function bibAuthor(a: LibraryAuthor): string {
  if (a.literal) return a.literal;
  return [a.family, a.given].filter(Boolean).join(", ");
}

/**
 * GB/T 7714 的主要责任者串:3 名以内全部列出,超过 3 名列前 3 名加「等」。
 * (这是 GB/T 7714-2015 的规则,不是随便定的阈值。)
 */
function gbAuthors(authors: LibraryAuthor[]): string {
  if (authors.length === 0) return "";
  const names = authors.map(gbAuthor);
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")}, 等`;
}

/**
 * APA 的责任者串:西方惯例在最后一名前加 `&`,并按人数上限截断。
 *
 * 上限取 20 —— APA 7 规定 20 名以内全列、超过则列前 19 名 + `…` + 末名。
 * 这里简化成「超过 20 列前 19 + 最后一名」,不引入省略号(纯文本里它会和
 * 真实字符混淆)。
 */
function apaAuthors(authors: LibraryAuthor[]): string {
  if (authors.length === 0) return "";
  const names = authors.map(apaAuthor);
  if (names.length === 1) return names[0]!;
  const shown = names.length > 20 ? [...names.slice(0, 19), names[names.length - 1]!] : names;
  return `${shown.slice(0, -1).join(", ")}, & ${shown[shown.length - 1]}`;
}

/* ─────────────────────────── 类型标记 ─────────────────────────── */

/** GB/T 7714 的文献类型标志码。`other` 归入 `[Z]`(其他)。 */
function gbTypeMark(type: LibraryItemType): string {
  switch (type) {
    case "article":
      return "[J]";
    case "inproceedings":
      return "[C]";
    case "book":
      return "[M]";
    case "thesis":
      return "[D]";
    case "report":
      return "[R]";
    case "preprint":
    case "other":
    default:
      return "[Z]";
  }
}

/** BibTeX 条目类型。预印本走 `@misc` + `eprint` 字段(arXiv 的通行做法)。 */
function bibtexType(type: LibraryItemType): string {
  switch (type) {
    case "article":
      return "article";
    case "inproceedings":
      return "inproceedings";
    case "book":
      return "book";
    case "thesis":
      return "phdthesis";
    case "report":
      return "techreport";
    case "preprint":
    case "other":
    default:
      return "misc";
  }
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

/** 把 `a, b, c` 里为空的项去掉并连接 —— 用来拼「半年份卷期页码」这种片段。 */
function joinParts(sep: string, parts: Array<string | undefined>): string {
  return parts.filter((p) => p && p.trim()).join(sep);
}

/** 年份段:`2025`;没有年份就是空串(调用方负责省略整段)。 */
function yearOf(item: CitableItem): string {
  return item.year ? String(item.year) : "";
}

/** 卷(期)片段:`12(3)` / `12` / `(3)` / 空。 */
function volumeIssue(item: CitableItem): string {
  const vol = item.volume?.trim() ?? "";
  const iss = item.issue?.trim() ?? "";
  if (vol && iss) return `${vol}(${iss})`;
  if (vol) return vol;
  if (iss) return `(${iss})`;
  return "";
}

/** BibTeX 值里的特殊字符转义。`{}` 与 `\` 在 LaTeX 里都有语法含义。 */
function bibEscape(value: string): string {
  return value.replace(/\\/g, "\\textbackslash{}").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

/* ─────────────────────────── BibTeX ─────────────────────────── */

/**
 * BibTeX 的引用键:`姓 + 年 + 标题首个实词`,如 `he2016deep`。
 *
 * `disambiguator` 用于同作者同年份时的区分 —— 导出整库时调用方负责数重名,传 1、2…
 * 会得到 `he2016deepb` 这样的后缀(BibTeX 的惯例是加字母,不是数字)。
 *
 * ## 为什么只留 ASCII、还要截断
 *
 * 第一版把标题里第一个长度 >3 的"词"原样塞进键里 —— 中文标题**没有空格**,于是
 * 一整句都成了那个"词",生成出 `@article{张三2023基于深度学习的图像超分辨率重建综述,`
 * 这种键。它既长又只在 biblatex/bibtex8 下才可靠(classic bibtex 处理非 ASCII 键
 * 会出问题)。所以:姓名与标题词一律只保留 ASCII 字母数字,键再截到 40 字符。
 *
 * 纯中文文献因此会得到 `2023` 这样的短键 —— 这不理想,但**合法且不会撞车**
 * (同年的会在导出时拿到 `2023b`、`2023c` 后缀)。相比之下,一个几十字符的 CJK 键
 * 在别人的 LaTeX 工程里更容易直接编译失败。
 */
export function citationKey(item: CitableItem, disambiguator?: number): string {
  const first = item.authors[0];
  const family = asciiToken(first?.family ?? first?.literal ?? "");
  const titleWord = item.title.split(/\s+/).map(asciiToken).find((w) => w.length > 3) ?? "";
  const base = `${family}${item.year ?? ""}${titleWord}`.toLowerCase();
  const cleaned = (base || "ref").slice(0, 40);
  if (!disambiguator || disambiguator <= 0) return cleaned;
  // 1 → b, 2 → c …(第一个不带上标,冲突的从 b 开始)
  return cleaned + String.fromCharCode(97 + Math.min(disambiguator, 25));
}

/** 只保留 ASCII 字母数字 —— 供引用键用,理由见 `citationKey`。 */
function asciiToken(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "");
}

/** 生成一条 BibTeX 记录。字段顺序固定,便于人眼比对与 diff。 */
export function formatBibtex(item: CitableItem, disambiguator?: number): string {
  const fields: Array<[string, string | undefined]> = [];
  fields.push(["title", item.title]);
  if (item.authors.length > 0) fields.push(["author", item.authors.map(bibAuthor).join(" and ")]);
  if (item.venue) {
    // 期刊用 journal、会议用 booktitle —— BibTeX 的样式文件靠这两个名字去查
    fields.push([item.type === "inproceedings" ? "booktitle" : "journal", item.venue]);
  }
  if (item.year) fields.push(["year", String(item.year)]);
  if (item.volume) fields.push(["volume", item.volume]);
  if (item.issue) fields.push(["number", item.issue]);
  if (item.page) fields.push(["pages", item.page.replace(/\s*[-–]\s*/, "--")]);
  if (item.publisher) fields.push(["publisher", item.publisher]);
  if (item.doi) fields.push(["doi", item.doi]);
  if (item.arxivId) {
    fields.push(["eprint", item.arxivId]);
    fields.push(["archivePrefix", "arXiv"]);
  }
  if (item.url) fields.push(["url", item.url]);

  const body = fields
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `  ${key} = {${bibEscape(value!)}},`)
    .join("\n");
  return `@${bibtexType(item.type)}{${citationKey(item, disambiguator)},\n${body}\n}`;
}

/* ─────────────────────────── GB/T 7714 ─────────────────────────── */

/**
 * GB/T 7714-2015 顺序编码制。
 *
 * 期刊:`作者. 题名[J]. 刊名, 年, 卷(期): 页码.`
 * 会议:`作者. 题名[C]//会议名. 年: 页码.`
 * 图书:`作者. 题名[M]. 出版者, 年.`
 * 学位论文:`作者. 题名[D]. 出版者, 年.`
 * 预印本:`作者. 题名[Z]. 年. arXiv: …`
 *
 * 不输出 `[序号]` —— 序号取决于它在用户自己那篇稿子里的位置,库这边无从知道。
 *
 * ⚠️ 会议那条的 `//` 必须**紧贴** `[C]`,中间不能插句点:`…[C]//论文集名.`
 * 第一版按「先拼作者+题名再补句点」的写法得到了 `…[C]. //论文集名`,是错的。
 * 所以下面按文献类型分别拼,而不是把各段统一 join 起来。
 */
export function formatGb7714(item: CitableItem): string {
  const authors = gbAuthors(item.authors);
  const title = `${item.title}${gbTypeMark(item.type)}`;
  const ids = joinParts(" ", [
    item.doi ? `DOI: ${item.doi}.` : undefined,
    !item.doi && item.arxivId ? `arXiv: ${item.arxivId}.` : undefined,
  ]);

  let body: string;
  if (item.type === "inproceedings") {
    // `//` 直接跟在 [C] 后面;年份与页码构成 `年: 页码`
    const tail = `${yearOf(item)}${item.page ? `: ${item.page}` : ""}`;
    body = joinParts(" ", [
      authors ? `${authors}.` : "",
      `${title}${item.venue ? `//${item.venue}` : ""}.`,
      tail ? `${tail}.` : "",
    ]);
  } else if (item.type === "book" || item.type === "thesis" || item.type === "report") {
    const pub = joinParts(", ", [item.publisher, yearOf(item)]);
    body = joinParts(" ", [
      authors ? `${authors}.` : "",
      `${title}.`,
      pub ? `${pub}.` : "",
    ]);
  } else {
    // 期刊与预印本等:`刊名, 年, 卷(期): 页码.`
    const yearBits = joinParts(", ", [yearOf(item), volumeIssue(item)]);
    const tail = joinParts(": ", [yearBits || undefined, item.page]);
    body = joinParts(" ", [
      authors ? `${authors}.` : "",
      `${title}.`,
      item.venue ? `${item.venue},` : "",
      tail ? `${tail}.` : "",
    ]);
  }

  return joinParts(" ", [body.trim(), ids]).trim();
}

/* ─────────────────────────── APA 7 ─────────────────────────── */

/**
 * APA 第 7 版。
 *
 * 期刊:`作者 (年). 题名. 刊名, 卷(期), 页码. https://doi.org/…`
 * 会议:`作者 (年). 题名. In 会议名 (pp. 页码). 出版者.`
 * 图书:`作者 (年). 题名. 出版者.`
 * 预印本:`作者 (年). 题名. arXiv. https://arxiv.org/abs/…`
 *
 * 纯文本里做不了斜体(APA 要求刊名与卷号斜体),这一点在界面上由复制按钮旁边的
 * 说明交代 —— 不在这里假装做到了。
 */
export function formatApa(item: CitableItem): string {
  const authorYear = joinParts(" ", [
    item.authors.length > 0 ? apaAuthors(item.authors) : undefined,
    item.year ? `(${item.year}).` : "(n.d.).",
  ]);

  const parts: string[] = [authorYear, `${item.title}.`].filter(Boolean);

  if (item.type === "inproceedings") {
    parts.push(
      joinParts(" ", [
        item.venue ? `In ${item.venue}` : undefined,
        item.page ? `(pp. ${item.page}).` : item.venue ? "." : undefined,
        item.publisher ? `${item.publisher}.` : undefined,
      ]),
    );
  } else if (item.type === "book" || item.type === "report") {
    if (item.publisher) parts.push(`${item.publisher}.`);
  } else {
    // 期刊:刊名, 卷(期), 页码
    const volIss = volumeIssue(item);
    const line = joinParts(", ", [item.venue, volIss, item.page]);
    if (line) parts.push(`${line}.`);
  }

  if (item.doi) parts.push(`https://doi.org/${item.doi}`);
  else if (item.arxivId) parts.push(`https://arxiv.org/abs/${item.arxivId}`);
  else if (item.url) parts.push(item.url);

  return joinParts(" ", parts).replace(/\.\s+https:\/\/doi\.org\//, ". https://doi.org/");
}

/* ─────────────────────────── 入口 ─────────────────────────── */

/** 按格式渲染一条引用。 */
export function formatCitation(item: CitableItem, style: CitationStyle): string {
  switch (style) {
    case "bibtex":
      return formatBibtex(item);
    case "apa":
      return formatApa(item);
    case "gb7714":
    default:
      return formatGb7714(item);
  }
}

/**
 * 把一组文献导出成一份完整的 `.bib`。
 *
 * 重名的引用键在这里统一加后缀 —— 只有拿到**整批**才知道谁和谁重名,单条渲染时
 * 无从判断(所以 `citationKey` 的第二个参数留给了这个调用方)。
 */
export function formatBibtexLibrary(items: CitableItem[]): string {
  const used = new Map<string, number>();
  const entries = items.map((item) => {
    const base = citationKey(item);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return formatBibtex(item, seen);
  });
  return `${entries.join("\n\n")}\n`;
}
