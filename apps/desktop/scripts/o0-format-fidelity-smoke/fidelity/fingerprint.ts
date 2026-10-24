/**
 * O0 —— **保真指纹**：只改一处无关内容后，复杂部件是否还在、语义是否等价。
 *
 * ## 为什么不是截图比对（卡 §2.2 的硬要求）
 *
 * 截图像素会被字体渲染差异打红：同一份 docx 在两台机器上抗锯齿不同，同一个
 * 「没变」的部件也能报 FAIL。所以这里的指纹全部是**语义**的：
 *
 *  - OOXML 格式（DOCX/XLSX/PPTX）：解压到 XML 部件，**按 path + 文本节点 +
 *    结构元素**比对；ZIP 内文件顺序、`docProps/*` 时间戳、revision 不进指纹。
 *  - PDF：用产品自己的读取器（pdf.js）读文本层 / 书签 / 批注。
 *  - Markdown：**文本级**的结构识别（表格/代码块/图片引用/嵌套列表），不比渲染。
 *  - HTML：解析后的**结构元素**（style 内容、script 内容、SVG 元素与属性、正文文本）。
 *
 * ## 指纹的形状
 *
 * 每个格式一份 `Fingerprint`：一组**命名 evidence**。每一项都有：
 *   - `id`：稳定名字（`docx.nested-table.inner`），证据与红绿表按它定位；
 *   - `present`：部件是否存在；
 *   - `signature`：语义签名（规范化后的 XML / 文本 / 结构列表）；
 *   - `where`：`path` 或 `path#detail` —— FAIL 时要报「哪个 XML path」。
 *
 * 比对 = 对每一项 `JSON.stringify(signature)` 深比较。**不做模糊匹配**：
 * 模糊匹配会把「挪了位置」「改了一个属性」放过，那正是本卡要抓的。
 *
 * ## 哪些字段从比对里排除（卡 §2.2 的「写明排除了什么」）
 *
 *  - DOCX/XLSX/PPTX：`docProps/core.xml` 的 `dcterms:modified` / `cp:revision` /
 *    `cp:lastModifiedBy`；ZIP 条目顺序（本模块只按 path 取值，不遍历顺序）。
 *  - PPTX：`a16:creationId`（新元素出生时铸的 GUID —— 第一次保存会加上，
 *    之后稳定；它不是「语义」，但**新铸**与**原值**不同会误报）。
 *  - XLSX：`xl/calcChain.xml`（公式重算后缓存值的顺序表，不是语义）。
 *  - 全部：XML 属性顺序、引号种类、自闭合写法（解析成树后比较，不比字节）。
 *
 * ## 为什么指纹在**探针主进程**里取
 *
 * 卡 §2.2 要求「每个格式用自己的原厂读取器（就是产品里用的那个）」。探针主进程
 * 与编辑器共享同一个 `genoffice`/`node_modules`，也就能 require 到同一份
 * `pdfjs-dist`、同一个 JSZip、同一份 DOCX 解析器 —— 页面侧反而做不到（沙箱里
 * 没有 node）。
 */
import { readFileSync } from "node:fs";

/* eslint-disable @typescript-eslint/no-require-imports */

/* ─────────────────────────────── 公共类型 ─────────────────────────────── */

export interface EvidenceItem {
  /** 稳定名字，证据与红绿表按它定位（`docx.nested-table.inner`）。 */
  id: string;
  /** 部件是否存在。false 时 signature 为 null。 */
  present: boolean;
  /** 语义签名；`JSON.stringify` 后深比较。 */
  signature: unknown;
  /** 部件在包里的位置（XML path / 页面号 / DOM 概念路径）。FAIL 时原样上报。 */
  where: string;
}

export interface Fingerprint {
  format: string;
  /** 这份指纹从哪个文件取的（绝对路径）。 */
  file: string;
  sha256: string;
  items: EvidenceItem[];
  /** 排除了什么（照卡 §2.2 写进证据，不只写注释）。 */
  excluded: string[];
  /**
   * 卡 §2.1 要求该格式**必须**出现的复杂部件（item id 前缀）。基线里缺任何
   * 一条 = 样本不合法，比对无意义（`recordBaseline` 会直接红）。
   * 其它 item 允许缺席 —— 缺席本身不代表失败，但「基线没有、保存后出现」仍算 FAIL。
   */
  required: string[];
}

export interface DiffEntry {
  id: string;
  where: string;
  status: "same" | "missing" | "appeared" | "changed";
  before: unknown;
  after: unknown;
}

export interface DiffResult {
  /** 所有 item 都 same（且 item 集合一致）。 */
  ok: boolean;
  entries: DiffEntry[];
}

/* ─────────────────────────────── 差异引擎 ─────────────────────────────── */

/**
 * 对比两份指纹。
 *
 * 判定（卡 §2.3 逐条）：
 *  - 基线有、现在没有 → `missing`（部件消失）；
 *  - 基线没有、现在有 → `appeared`（编辑不该凭空生成部件）；
 *  - 都在但签名不同 → `changed`（语义变了 / 位置变了 / 样式变了）。
 *
 * 任何一条不是 `same`，`ok` 就是 false —— 这张卡的判据是**逐项**的，没有
 * 「差 1% 可以接受」。
 */
export function diffFingerprints(before: Fingerprint, after: Fingerprint): DiffResult {
  const entries: DiffEntry[] = [];
  const afterById = new Map(after.items.map((i) => [i.id, i]));
  const beforeIds = new Set(before.items.map((i) => i.id));
  for (const b of before.items) {
    const a = afterById.get(b.id);
    if (!a) {
      entries.push({ id: b.id, where: b.where, status: "missing", before: b.signature, after: null });
      continue;
    }
    const same = a.present === b.present && deepEqual(a.signature, b.signature);
    entries.push({
      id: b.id,
      where: b.where,
      status: same ? "same" : a.present === false ? "missing" : "changed",
      before: b.signature,
      after: a.signature,
    });
  }
  for (const a of after.items) {
    if (!beforeIds.has(a.id)) {
      entries.push({ id: a.id, where: a.where, status: "appeared", before: null, after: a.signature });
    }
  }
  return { ok: entries.every((e) => e.status === "same"), entries };
}

/** 结构化深比较（键序无关；数组按位置 —— 数组顺序在 OOXML 里通常是语义）。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    return a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.length !== bk.length) return false;
  return ak.every((k, i) => k === bk[i] && deepEqual(ao[k], bo[k]));
}

/* ─────────────────────────────── 共用小工具 ─────────────────────────────── */

function sha256Of(bytes: Uint8Array | Buffer): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

interface ZipLike {
  file(path: string): { async(type: "string"): Promise<string>; async(type: "uint8array"): Promise<Uint8Array> } | null;
  files: Record<string, { dir: boolean }>;
}

async function openZip(bytes: Uint8Array | Buffer): Promise<{ zip: ZipLike; paths: string[] }> {
  const JSZip = require("genoffice:jszip") as { loadAsync(data: Uint8Array | Buffer): Promise<ZipLike> };
  const zip = await JSZip.loadAsync(bytes);
  const paths = Object.keys(zip.files).filter((p) => !zip.files[p]!.dir).sort();
  return { zip, paths };
}

async function readZipText(zip: ZipLike, path: string): Promise<string | null> {
  const f = zip.file(path);
  return f ? await f.async("string") : null;
}

/**
 * OOXML 部件 → **规范化结构树**。
 *
 * fast-xml-parser 的 `preserveOrder` 树保留文档序；这里把它压成
 *
 *   { tag: "w:p", attrs: {...}, text: "...", children: [...] }
 *
 *  - 属性**按名排序**（属性顺序不是语义）；
 *  - `xml:space` 保留（它决定空白折叠，是语义）；
 *  - 空白文本节点剔除（XML 缩进不是内容）；
 *  - 文本值**不 trim**（`w:t` 的尾随空格是内容）。
 */
interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  text: string | null;
  children: XmlNode[];
}

function parseXmlTree(xml: string): XmlNode | null {
  const { XMLParser } = require("genoffice:fast-xml-parser") as {
    XMLParser: new (o: Record<string, unknown>) => { parse(input: string): unknown };
  };
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    commentPropName: "#comment",
    processEntities: true,
    trimValues: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
  });
  const parsed = parser.parse(xml) as Array<Record<string, unknown>>;
  const roots = parsed
    .map((o) => xmlEntryToNode(o))
    .filter((n): n is XmlNode => n !== null);
  return roots.length === 1 ? roots[0]! : roots.length === 0 ? null : { tag: "#document", attrs: {}, text: null, children: roots };
}

function xmlEntryToNode(entry: Record<string, unknown>): XmlNode | null {
  const keys = Object.keys(entry).filter((k) => k !== ":@");
  const attrsRaw = (entry[":@"] ?? {}) as Record<string, unknown>;
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrsRaw)) {
    if (k === "#text" || k === "#comment") continue;
    attrs[k.startsWith("@_") ? k.slice(2) : k] = String(v);
  }
  for (const tag of keys) {
    if (tag === "#text") {
      const text = String(entry[tag] ?? "");
      return text.trim() === "" ? null : { tag: "#text", attrs: {}, text, children: [] };
    }
    if (tag === "#comment") return null; // 注释不是文档语义
    const children = (entry[tag] as Array<Record<string, unknown>>)
      .map((c) => xmlEntryToNode(c))
      .filter((n): n is XmlNode => n !== null);
    // 合并相邻文本
    const merged: XmlNode[] = [];
    for (const c of children) {
      const prev = merged[merged.length - 1];
      if (c.tag === "#text" && prev?.tag === "#text") prev.text = (prev.text ?? "") + (c.text ?? "");
      else merged.push(c);
    }
    const sortedAttrs: Record<string, string> = {};
    for (const k of Object.keys(attrs).sort()) sortedAttrs[k] = attrs[k]!;
    return { tag, attrs: sortedAttrs, text: null, children: merged };
  }
  return null;
}

/** 从根往下找第一种匹配 tag 的节点（先序）。 */
function findFirst(node: XmlNode, tag: string): XmlNode | null {
  if (node.tag === tag) return node;
  for (const c of node.children) {
    const hit = findFirst(c, tag);
    if (hit) return hit;
  }
  return null;
}

/** 收集所有匹配 tag 的节点（先序）。 */
function findAll(node: XmlNode, tag: string, out: XmlNode[] = []): XmlNode[] {
  if (node.tag === tag) out.push(node);
  for (const c of node.children) findAll(c, tag, out);
  return out;
}

/** 取某个元素的全部后代文本（`w:t` / `a:t` 的拼接）。 */
/**
 * 取某个元素（如 `w:p` / `p:sp` / `w:footnote`）里所有 `textTags`（如 `w:t` /
 * `a:t`）的拼接文本。
 *
 * ⚠️ 解析树里**文本是 `#text` 子节点**（`xmlEntryToNode` 把 `<w:t>abc</w:t>`
 * 展开成 `{ tag: "w:t", children: [{ tag: "#text", text: "abc" }] }`），元素
 * 节点自己的 `text` 字段永远是 null。`textOf` 因此必须递归到 `#text` 叶子——
 * 早期版本返回 `node.text ?? ""`，等于**所有**文本都取成空串（实测：脚注/备注
 * 文本比对两边都是 ""，判据看起来绿，其实什么都没比）。
 */
function textOf(node: XmlNode, textTags: readonly string[]): string {
  if (node.tag === "#text") return node.text ?? "";
  if (textTags.includes(node.tag)) {
    // 命中文本标签：收集它下面的全部 #text（含实体解码后的单节点）
    return node.children.map((c) => (c.tag === "#text" ? (c.text ?? "") : textOf(c, textTags))).join("");
  }
  return node.children.map((c) => textOf(c, textTags)).join("");
}

/** 把结构树压成「去掉噪音后的签名树」：删 tag、按属性名排序、文本拼接。 */
function stripTags(node: XmlNode, removeTags: ReadonlySet<string>): unknown {
  if (removeTags.has(node.tag)) return null;
  const kids = node.children
    .map((c) => stripTags(c, removeTags))
    .filter((v) => v !== null);
  const text = node.children.filter((c) => c.tag === "#text").map((c) => c.text ?? "").join("");
  return {
    tag: node.tag,
    ...(Object.keys(node.attrs).length ? { attrs: node.attrs } : {}),
    ...(text ? { text } : {}),
    ...(kids.length ? { children: kids } : {}),
  };
}

/* ─────────────────────────────── DOCX ─────────────────────────────── */

const DOCX_NOISE = new Set([
  // 文档出生时间 / 修订号 / 最后修改人：每次真保存都会变，与复杂部件无关
  "dcterms:modified",
  "cp:revision",
  "cp:lastModifiedBy",
]);

export async function fingerprintDocx(file: string): Promise<Fingerprint> {
  const bytes = readFileSync(file);
  const { zip, paths } = await openZip(bytes);
  const items: EvidenceItem[] = [];

  const docXml = await readZipText(zip, "word/document.xml");
  const tree = docXml === null ? null : parseXmlTree(docXml);
  if (tree === null) {
    items.push({ id: "docx.document-part", present: false, signature: null, where: "word/document.xml" });
  } else {
    // 注意：**不**把整个 document.xml 入账 —— 本卡改的是正文第一段，它就在里面。
    // 入账的是「复杂部件自己的结构」，编辑落点不在其中任何一项。

    // 1) 嵌套表格：外层表结构 + 内层表结构；内层表签名带它所在的格坐标，
    //    「把内层表挪到别的单元格」也要红（语义位置，不只是存在性）。
    const tables = findAll(tree, "w:tbl");
    items.push({
      id: "docx.nested-table.outer",
      present: tables.length > 0,
      signature: tables.length > 0 ? stripTags(tables[0]!, DOCX_NOISE) : null,
      where: "word/document.xml → body/w:tbl[1]",
    });
    let inner: XmlNode | null = null;
    let innerAt: { row: number; cell: number } | null = null;
    if (tables[0]) {
      const rows = tables[0].children.filter((c) => c.tag === "w:tr");
      outer: for (let r = 0; r < rows.length; r++) {
        const cells = rows[r]!.children.filter((c) => c.tag === "w:tc");
        for (let c = 0; c < cells.length; c++) {
          const nested = cells[c]!.children.find((x) => x.tag === "w:tbl");
          if (nested) { inner = nested; innerAt = { row: r, cell: c }; break outer; }
        }
      }
    }
    items.push({
      id: "docx.nested-table.inner",
      present: inner !== null,
      signature: inner ? { at: innerAt, table: stripTags(inner, DOCX_NOISE) } : null,
      where: "word/document.xml → body/w:tbl[1]/w:tr[2]/w:tc[1]/w:tbl[1]",
    });

    // 2) 编号列表：w:numPr/w:numId 的段落（含层级 + **它在 body 里的位置**）。
    // 位置是 `bodyIndex`（该段落在顶层 w:p 序列中的序号）：把整段列表挪到别的
    // 地方（内容不变）也必须红 —— 卡 §4 的「换个位置放回去」。
    const bodyParas = findAll(tree, "w:p");
    const numParas: Array<{ bodyIndex: number; numId: string; ilvl: string; text: string }> = [];
    bodyParas.forEach((p, bodyIndex) => {
      const numPr = p.children.find((c) => c.tag === "w:pPr")?.children.find((c) => c.tag === "w:numPr");
      if (!numPr) return;
      const numId = numPr.children.find((c) => c.tag === "w:numId")?.attrs["w:val"] ?? "";
      const ilvl = numPr.children.find((c) => c.tag === "w:ilvl")?.attrs["w:val"] ?? "0";
      numParas.push({ bodyIndex, numId, ilvl, text: textOf(p, ["w:t"]) });
    });
    items.push({
      id: "docx.numbered-list",
      present: numParas.length > 0,
      signature: numParas,
      where: "word/document.xml → w:p/w:pPr/w:numPr（含 body 位置）",
    });

    // 3) 页眉/页脚引用：sectPr 里的 headerReference/footerReference
    const sectPr = findFirst(tree, "w:sectPr");
    const hfRefs = sectPr
      ? sectPr.children.filter((c) => c.tag === "w:headerReference" || c.tag === "w:footerReference")
          .map((c) => ({ tag: c.tag, type: c.attrs["w:type"] ?? "default", rid: c.attrs["r:id"] ?? "" }))
      : [];
    items.push({
      id: "docx.header-footer-refs",
      present: hfRefs.length > 0,
      signature: hfRefs,
      where: "word/document.xml → w:sectPr/w:{header,footer}Reference",
    });

    // 4) 脚注引用标记（正文里的 w:footnoteReference 及其 id）
    const noteRefs: Array<{ id: string; paraText: string }> = [];
    for (const ref of findAll(tree, "w:footnoteReference")) {
      const id = ref.attrs["w:id"] ?? "";
      let anchorText = "";
      for (const p of findAll(tree, "w:p")) {
        if (findFirst(p, "w:footnoteReference") === ref) { anchorText = textOf(p, ["w:t"]); break; }
      }
      noteRefs.push({ id, paraText: anchorText });
    }
    items.push({
      id: "docx.footnote-refs",
      present: noteRefs.length > 0,
      signature: noteRefs,
      where: "word/document.xml → w:p/w:r/w:footnoteReference",
    });

    // 5) 东亚字体：所有 w:rFonts 的 w:eastAsia 值 + 所在 run 的文本
    const eastAsiaRuns: Array<{ eastAsia: string; text: string }> = [];
    for (const r of findAll(tree, "w:r")) {
      const rFonts = findFirst(r, "w:rFonts");
      const ea = rFonts?.attrs["w:eastAsia"];
      if (!ea) continue;
      eastAsiaRuns.push({ eastAsia: ea, text: textOf(r, ["w:t"]) });
    }
    items.push({
      id: "docx.eastAsia-runs",
      present: eastAsiaRuns.length > 0,
      signature: eastAsiaRuns,
      where: "word/document.xml → w:r/w:rPr/w:rFonts/@w:eastAsia",
    });
  }

  // 6) 页眉/页脚部件本身：按 path 全量结构
  const hfPaths = paths.filter((p) => /^word\/(header|footer)\d*\.xml$/.test(p));
  for (const p of hfPaths) {
    const xml = await readZipText(zip, p);
    const tree = xml === null ? null : parseXmlTree(xml);
    items.push({
      id: `docx.hf-part:${p}`,
      present: tree !== null,
      signature: tree ? stripTags(tree, DOCX_NOISE) : null,
      where: p,
    });
  }

  // 7) 脚注部件：footnotes.xml 里每个 w:footnote（跳过 separator/continuationSeparator）
  const fnXml = await readZipText(zip, "word/footnotes.xml");
  if (fnXml !== null) {
    const fnTree = parseXmlTree(fnXml);
    const notes = fnTree
      ? findAll(fnTree, "w:footnote")
          .filter((n) => n.attrs["w:type"] === undefined)
          .map((n) => ({ id: n.attrs["w:id"] ?? "", text: textOf(n, ["w:t"]) }))
      : [];
    items.push({
      id: "docx.footnote-parts",
      present: notes.length > 0,
      signature: notes,
      where: "word/footnotes.xml",
    });
  } else {
    items.push({ id: "docx.footnote-parts", present: false, signature: null, where: "word/footnotes.xml" });
  }

  return {
    format: "docx",
    file,
    sha256: sha256Of(bytes),
    items,
    excluded: [
      "docProps/core.xml 的 dcterms:modified / cp:revision / cp:lastModifiedBy（每次保存必变）",
      "ZIP 条目顺序（只按 path 取值）",
      "XML 属性顺序、引号种类、自闭合写法（解析成树后比较）",
      "XML 注释（w:comment 一类不是文档语义）",
    ],
    required: [
      "docx.nested-table.inner",
      "docx.numbered-list",
      "docx.header-footer-refs",
      "docx.footnote-refs",
      "docx.eastAsia-runs",
      "docx.footnote-parts",
    ],
  };
}

/* ─────────────────────────────── XLSX ─────────────────────────────── */

/**
 * XLSX 指纹取两路，但**都不含「被编辑的那个格子」** —— 本卡只改一处无关内容，
 * 指纹若整表入账，那一处编辑本身就会把断言打红（假 FAIL）。
 *
 *  1. 原厂读取器（`sheet read --json`）的**公式视图**（`--where formula`）与
 *     每个 sheet 的 features（条件格式数量 / 合并 / 图表锚点）。编辑的是普通
 *     文本单元格，不会进公式视图；
 *  2. 关键 XML 部件的**子部件**：条件格式规则、合并单元格、图表部件与图表锚点
 *     （drawing XML）。worksheet 整件不入账（里面就有被编辑的格子）。
 *
 * 行意思：第 1 路回答「语义上还是不是那张表」，第 2 路回答「结构部件还在不在
 * 原处」。任一路报差异都是 FAIL。
 */
export async function fingerprintXlsx(file: string, repoRoot: string): Promise<Fingerprint> {
  const bytes = readFileSync(file);
  const { zip, paths } = await openZip(bytes);
  const items: EvidenceItem[] = [];

  const cli = await readSheetViaCli(file, repoRoot);
  items.push({
    id: "xlsx.formula-cells",
    present: cli !== null,
    signature: cli?.formulaCells ?? null,
    where: "xl/worksheets/*.xml（经 genoffice sheet read --where formula）",
  });
  items.push({
    id: "xlsx.features",
    present: cli !== null,
    signature: cli?.features ?? null,
    where: "xl/worksheets/*.xml + xl/charts/*.xml（经 genoffice sheet read --stats）",
  });

  const wbXml = await readZipText(zip, "xl/workbook.xml");
  const wbTree = wbXml === null ? null : parseXmlTree(wbXml);
  const sheetEntries = wbTree
    ? findAll(wbTree, "sheet").map((s) => ({ name: s.attrs.name ?? "", sheetId: s.attrs.sheetId ?? "", rid: s.attrs["r:id"] ?? "" }))
    : [];
  items.push({ id: "xlsx.workbook-sheets", present: sheetEntries.length > 0, signature: sheetEntries, where: "xl/workbook.xml → sheets/sheet" });

  // 每个 worksheet 只取「结构部件」：条件格式规则（含 sqref 范围）与合并单元格。
  // 逐 sheet 与跨 sheet 各一份：跨 sheet 的聚合项才是 required（部件只需在
  // **某个** sheet 上存在；逐 sheet 项缺省不红，但变了就红）。
  const wsPaths = paths.filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p));
  const cfAll: Array<{ part: string; sqref: string; rules: unknown }> = [];
  const mergesAll: Array<{ part: string; ref: string }> = [];
  for (const p of wsPaths) {
    const xml = await readZipText(zip, p);
    const tree = xml === null ? null : parseXmlTree(xml);
    const cfRules = tree
      ? findAll(tree, "conditionalFormatting").map((cf) => ({ sqref: cf.attrs.sqref ?? "", rules: stripTags(cf, new Set()) }))
      : [];
    const merges = tree ? findAll(tree, "mergeCell").map((m) => m.attrs.ref ?? "") : [];
    for (const cf of cfRules) cfAll.push({ part: p, ...cf });
    for (const ref of merges) mergesAll.push({ part: p, ref });
    items.push({
      id: `xlsx.conditional-formats:${p}`,
      present: cfRules.length > 0,
      signature: cfRules,
      where: `${p} → conditionalFormatting`,
    });
    items.push({
      id: `xlsx.merges:${p}`,
      present: merges.length > 0,
      signature: merges,
      where: `${p} → mergeCells/mergeCell`,
    });
  }
  items.push({
    id: "xlsx.conditional-formats-any",
    present: cfAll.length > 0,
    signature: cfAll,
    where: "xl/worksheets/*.xml 的 conditionalFormatting（跨 sheet 汇总）",
  });
  items.push({
    id: "xlsx.merges-any",
    present: mergesAll.length > 0,
    signature: mergesAll,
    where: "xl/worksheets/*.xml 的 mergeCell（跨 sheet 汇总）",
  });

  // 图表部件：整件结构（图片、系列、标题、数据引用）
  const chartPaths = paths.filter((p) => /^xl\/charts\/chart\d+\.xml$/.test(p));
  for (const p of chartPaths) {
    const xml = await readZipText(zip, p);
    const tree = xml === null ? null : parseXmlTree(xml);
    items.push({
      id: `xlsx.chart:${p}`,
      present: tree !== null,
      signature: tree ? stripTags(tree, new Set()) : null,
      where: p,
    });
  }
  // 图表锚点：drawing XML 里的 twoCellAnchor/oneCellAnchor（挪了单元格就是 FAIL）
  const drawPaths = paths.filter((p) => /^xl\/drawings\/drawing\d+\.xml$/.test(p));
  for (const p of drawPaths) {
    const xml = await readZipText(zip, p);
    const tree = xml === null ? null : parseXmlTree(xml);
    items.push({
      id: `xlsx.drawing:${p}`,
      present: tree !== null,
      signature: tree ? stripTags(tree, new Set()) : null,
      where: p,
    });
  }

  return {
    format: "xlsx",
    file,
    sha256: sha256Of(bytes),
    items,
    excluded: [
      "被编辑的普通文本单元格（本卡只改一处无关内容；整表值视图会把这次编辑本身打成 FAIL）",
      "xl/calcChain.xml（重算后的缓存值顺序表，不是工作簿语义）",
      "docProps/core.xml 的 modified / lastModifiedBy",
      "ZIP 条目顺序",
      "XML 属性顺序 / 引号 / 自闭合写法",
      "style 索引的数值本身（样式编号重排但语义等价时不算失败 —— 由 features 的语义视图判断）",
    ],
    required: [
      "xlsx.formula-cells",
      "xlsx.conditional-formats-any",
      "xlsx.merges-any",
      "xlsx.chart:xl/charts/chart1.xml",
      "xlsx.drawing:xl/drawings/drawing1.xml",
    ],
  };
}

interface XlsxCliView {
  formulaCells: unknown;
  features: unknown;
}

async function readSheetViaCli(file: string, repoRoot: string): Promise<XlsxCliView | null> {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const cli = `${repoRoot}/genoffice/packages/cli/dist/genoffice.cjs`;
  // `ELECTRON_RUN_AS_NODE=1`：本函数在探针主进程（Electron）里跑，不带它子进程会
  // 被当成 Electron app 启动（生产 `genofficeCli.ts` 的 invoke() 给同一组环境）。
  const cliEnv = { ELECTRON_RUN_AS_NODE: "1", ...(process.env.PATH ? { PATH: process.env.PATH } : {}) };
  const read = (args: string[]): unknown => {
    const r = spawnSync(process.execPath, [cli, "sheet", "read", file, ...args, "--json"], { encoding: "utf8", timeout: 120_000, env: cliEnv });
    if (r.status !== 0) return null;
    try { return (JSON.parse(r.stdout) as { detail?: unknown }).detail ?? null; } catch { return null; }
  };
  const stats = read(["--stats"]) as { stats?: { sheets?: Array<{ name: string }> }; features?: unknown } | null;
  if (stats === null) return null;
  const sheetNames = (stats.stats?.sheets ?? []).map((s) => s.name);
  const formulaCells: Record<string, unknown> = {};
  const features: Record<string, unknown> = {};
  for (const name of sheetNames) {
    // 只取 `cells`（ref/value/formula 三元组），**不取** range/rowsShown —— 后者是
    // 「本次读到的矩形」这类读取元数据：新写一个格子会让它从 A1:D4 变成 A1:D6，
    // 而公式一个没变。拿它入账 = 把「我读了多大范围」当成工作簿语义（实测假 FAIL）。
    const read_ = read(["--sheet", name, "--where", "formula"]) as { cells?: unknown } | null;
    formulaCells[name] = read_?.cells ?? null;
    const sheetStats = read(["--sheet", name, "--stats"]) as { features?: unknown } | null;
    features[name] = sheetStats?.features ?? null;
  }
  return { formulaCells, features };
}

/* ─────────────────────────────── PPTX ─────────────────────────────── */

const PPTX_NOISE = new Set(["a16:creationId", "p14:creationId"]);

export async function fingerprintPptx(
  file: string,
  repoRoot: string,
  opts?: FingerprintOptions,
): Promise<Fingerprint> {
  const bytes = readFileSync(file);
  const { zip, paths } = await openZip(bytes);
  const items: EvidenceItem[] = [];

  const presXml = await readZipText(zip, "ppt/presentation.xml");
  const presTree = presXml === null ? null : parseXmlTree(presXml);
  const sldIds = presTree ? findAll(presTree, "p:sldId").map((s) => ({ id: s.attrs.id ?? "", rid: s.attrs["r:id"] ?? "" })) : [];
  const sldSz = presTree ? findFirst(presTree, "p:sldSz")?.attrs ?? null : null;
  items.push({ id: "pptx.presentation", present: presTree !== null, signature: { sldIds, sldSz }, where: "ppt/presentation.xml" });

  const slidePaths = paths.filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
  items.push({ id: "pptx.slide-count", present: slidePaths.length > 0, signature: slidePaths.length, where: "ppt/slides/" });
  const animAll: Array<{ part: string; timing: unknown }> = [];

  // 每页只取两类**复杂部件**的签名（不含被编辑的文本框正文本身）：
  //  - 元素清单：每个元素的类型/名字/占位符/几何 —— 「挪了位置/样式变了」也红；
  //  - 动画（p:timing）结构。
  /**
   * 放宽的 box 只针对**指定的 (slidePath, name)**；`slidePath: "auto"` 仅用于
   * 「所有页同名元素」这种显式声明。名字单独不够 —— 引擎给每页的文本框都起名
   * "TextBox 2"，按名字全局放宽会顺带放开另外两页的几何（实测）。
   */
  const autofitFor = (slidePath: string, name: string): boolean =>
    (opts?.pptxAutofitBox ?? []).some((t) => t.name === name && (t.slidePath === "auto" || t.slidePath === slidePath));
  for (const p of slidePaths) {
    const xml = await readZipText(zip, p);
    const tree = xml === null ? null : parseXmlTree(xml);
    const spTree = tree ? findFirst(tree, "p:spTree") : null;
    const elementList = spTree
      ? spTree.children
          .filter((c) => /^p:(sp|pic|graphicFrame|grpSp|cxnSp)$/.test(c.tag))
          .map((c) => {
            const spPr = findFirst(c, "p:spPr") ?? findFirst(c, "p:grpSpPr");
            const xfrm = spPr ? findFirst(spPr, "a:xfrm") : null;
            const off = xfrm ? findFirst(xfrm, "a:off") : null;
            const ext = xfrm ? findFirst(xfrm, "a:ext") : null;
            const nv = findFirst(c, "p:cNvPr");
            const ph = findFirst(c, "p:ph");
            const name = nv?.attrs.name ?? "";
            return {
              tag: c.tag,
              name,
              id: nv?.attrs.id ?? "",
              ...(ph ? { placeholder: ph.attrs.type ?? "body", idx: ph.attrs.idx ?? "" } : {}),
              // 被编辑目标的 box 允许变（autofit resize，见 FingerprintOptions 的注释）；
              // 占位符标记 `boxExcluded` 让证据读得懂「这里为什么没有 box」。
              ...(autofitFor(p, name)
                ? { boxExcluded: "autofit-allowed" as const }
                : { box: off && ext ? { x: off.attrs.x ?? "", y: off.attrs.y ?? "", cx: ext.attrs.cx ?? "", cy: ext.attrs.cy ?? "" } : null }),
            };
          })
      : [];
    items.push({
      id: `pptx.elements:${p}`,
      present: tree !== null,
      signature: elementList,
      where: `${p} → p:spTree 的元素清单（类型/名字/占位符/几何）`,
    });
    const timing = tree ? findFirst(tree, "p:timing") : null;
    items.push({
      id: `pptx.animations:${p}`,
      present: timing !== null,
      signature: timing ? stripTags(timing, PPTX_NOISE) : null,
      where: `${p} → p:sld/p:timing`,
    });
    if (timing) animAll.push({ part: p, timing: stripTags(timing, PPTX_NOISE) });
  }
  // 跨页汇总：动画是**复杂部件**（卡 §2.1），只要某一页有就必须逐页保留；
  // 逐页项缺省不红（其余页本来就没动画），汇总项才是 required。
  items.push({
    id: "pptx.animations-any",
    present: animAll.length > 0,
    signature: animAll,
    where: "ppt/slides/*.xml 的 p:timing（跨页汇总）",
  });

  // 母版占位符（layout/master 的占位符清单）：多页/版式的骨架。
  // 逐 part 一项；跨 part 汇总一项作为 required —— 部件只需在某一条 layout
  // 或 master 里存在。O0 样本基于 vendor 的 blank 模板（其 layout 是 type="blank"、
  // 不带 p:ph），所以这里如实记「blank 模板没有占位符」；卡 §2.1 的「母版占位符」
  // 由旅程里另一条断言（真实模板 deck 读回 layout 列表）覆盖 —— 见回写区「未验证」。
  const layoutPaths = paths.filter((p) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(p));
  const phAll: Array<{ part: string; placeholders: Array<{ type: string; idx: string }> }> = [];
  for (const p of layoutPaths) {
    const xml = await readZipText(zip, p);
    const tree = xml === null ? null : parseXmlTree(xml);
    const phs = tree
      ? findAll(tree, "p:ph").map((ph) => ({ type: ph.attrs.type ?? "body", idx: ph.attrs.idx ?? "" }))
      : [];
    if (phs.length > 0) phAll.push({ part: p, placeholders: phs });
    items.push({
      id: `pptx.layout-placeholders:${p}`,
      present: phs.length > 0,
      signature: phs,
      where: `${p} → p:ph`,
    });
  }
  const masterPaths = paths.filter((p) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(p));
  for (const p of masterPaths) {
    const xml = await readZipText(zip, p);
    const tree = xml === null ? null : parseXmlTree(xml);
    const phs = tree
      ? findAll(tree, "p:ph").map((ph) => ({ type: ph.attrs.type ?? "body", idx: ph.attrs.idx ?? "" }))
      : [];
    if (phs.length > 0) phAll.push({ part: p, placeholders: phs });
    items.push({
      id: `pptx.master-placeholders:${p}`,
      present: phs.length > 0,
      signature: phs,
      where: `${p} → p:ph`,
    });
  }
  items.push({
    id: "pptx.placeholders-any",
    present: phAll.length > 0,
    signature: phAll,
    where: "ppt/slideLayouts + ppt/slideMasters 的 p:ph（跨 part 汇总）",
  });

  // 备注：每页的 notesSlide 部件，取备注页里的正文段落文本
  const notesPaths = paths.filter((p) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p));
  for (const p of notesPaths) {
    const xml = await readZipText(zip, p);
    const tree = xml === null ? null : parseXmlTree(xml);
    // 备注正文 = 那个 ph type="body" 的**顶层** `p:sp` 里的 a:t。
    // ⚠️ 不能 `findFirst(sp, "p:ph")`：`p:sp` 子树里还有嵌套元素（如 sldImg
    // 占位符的兄弟……更常见的是本页第一个 p:ph 是 `sldImg`），findFirst 会先撞上
    // 它而不是本 sp 自己的占位符。所以先取 sp 自己的 `p:nvSpPr/p:nvPr/p:ph`
    // 这一条路径（逐层按 tag 名找，不走全子树搜索）。
    const sps = tree ? findAll(tree, "p:sp") : [];
    const ownPlaceholderType = (sp: XmlNode): string | undefined => {
      const nvSpPr = sp.children.find((c) => c.tag === "p:nvSpPr");
      const nvPr = nvSpPr?.children.find((c) => c.tag === "p:nvPr");
      const ph = nvPr?.children.find((c) => c.tag === "p:ph");
      return ph?.attrs.type ?? (ph ? "body" : undefined);
    };
    const body = sps.find((sp) => ownPlaceholderType(sp) === "body");
    const text = body ? textOf(body, ["a:t"]) : tree ? textOf(tree, ["a:t"]) : "";
    items.push({
      id: `pptx.notes:${p}`,
      present: tree !== null,
      signature: text,
      where: p,
    });
  }

  // 媒体部件：按 path + 字节哈希（图片被换掉是 FAIL，图片字节挪了位置也是 FAIL）
  const mediaPaths = paths.filter((p) => /^ppt\/media\//.test(p));
  for (const p of mediaPaths) {
    const f = zip.file(p);
    const data = f ? await f.async("uint8array") : null;
    items.push({
      id: `pptx.media:${p}`,
      present: data !== null,
      signature: data ? sha256Of(data) : null,
      where: p,
    });
  }

  return {
    format: "pptx",
    file,
    sha256: sha256Of(bytes),
    items,
    excluded: [
      "被编辑的文本框正文逐字（本卡只改一处无关内容；整页结构入账会把这次编辑本身打成 FAIL —— 正文以外的元素清单与几何仍入账）",
      "a16:creationId（新元素出生时铸的 GUID；第一次保存会加上）",
      "docProps/core.xml 的 modified / revision",
      "ZIP 条目顺序",
      "XML 属性顺序 / 引号 / 自闭合写法",
    ],
    required: [
      "pptx.presentation",
      "pptx.slide-count",
      "pptx.elements:ppt/slides/slide1.xml",
      "pptx.elements:ppt/slides/slide2.xml",
      "pptx.elements:ppt/slides/slide3.xml",
      "pptx.animations-any",
      "pptx.placeholders-any",
      "pptx.notes:ppt/notesSlides/notesSlide1.xml",
      "pptx.media:ppt/media/image1.png",
    ],
  };
}

/* ─────────────────────────────── PDF ─────────────────────────────── */

/**
 * PDF 指纹：**产品自己的读取器** —— pdf.js（`genoffice/apps/pdf` 的依赖，
 * 版本与 vendor 一致）。取三样：
 *  - 每页文本层（pdf.js `getTextContent`）；
 *  - 书签（`getOutline`，标题 + 层级）；
 *  - 批注（`getAnnotations`，Subtype + Contents + Rect）。
 *
 * pdf-lib 只用于**生成**样本（vendor `save-pdf.ts` 的依赖），读取走 pdfium/pdf.js
 * 这条**独立实现** —— 卡 §2.2 说的「不要另写一个解析器」在这里恰好反过来：
 * 生成与读取不是同一份代码，所以互相作证是有效的。
 */
export async function fingerprintPdf(file: string, repoRoot: string): Promise<Fingerprint> {
  const bytes = readFileSync(file);
  const items: EvidenceItem[] = [];
  const pdfjs = (await import(pathToFileUrl(`${repoRoot}/genoffice/node_modules/pdfjs-dist/legacy/build/pdf.mjs`))) as PdfjsShape;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false, disableFontFace: true }).promise;
  items.push({ id: "pdf.page-count", present: true, signature: doc.numPages, where: "PDF /Type /Pages" });

  const pageTexts: Array<{ page: number; text: string }> = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items.map((it) => ("str" in it ? it.str : "")).join("");
    pageTexts.push({ page: i, text });
  }
  items.push({ id: "pdf.text-layer", present: true, signature: pageTexts, where: "每页 content stream（pdf.js getTextContent）" });

  const outline = (await doc.getOutline()) as Array<{ title: string; dest?: unknown; items?: unknown[] }> | null;
  // 书签签名带**目的地**：把书签挪到别的页（标题不变）也要红 —— 卡 §4 的
  // 「换个位置放回去」。dest 是 pdf.js 的解析产物（数组形式 [ref, name] 或字符串），
  // 统一转成 JSON 形状即可（不需要解析成页码；变化本身就是要证明的东西）。
  const flattenOutline = (
    nodes: Array<{ title: string; dest?: unknown; items?: unknown[] }>,
    depth = 0,
  ): Array<{ title: string; depth: number; dest: unknown }> =>
    nodes.flatMap((n) => [
      { title: n.title, depth, dest: n.dest === undefined ? null : n.dest },
      ...flattenOutline((n.items ?? []) as Array<{ title: string; dest?: unknown; items?: unknown[] }>, depth + 1),
    ]);
  items.push({
    id: "pdf.outline",
    present: outline !== null && outline.length > 0,
    signature: outline === null ? null : flattenOutline(outline),
    where: "PDF /Outlines（标题 + 层级 + 目的地）",
  });

  const annots: Array<{ page: number; subtype: string; contents: string; rect: number[] }> = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const list = (await page.getAnnotations()) as Array<{ subtype?: string; contentsObj?: { str?: string }; rect?: number[] }>;
    for (const a of list) {
      // 只看「注释类」批注（Text/Highlight/...）；链接不算复杂部件
      if (!a.subtype || a.subtype === "Link" || a.subtype === "Widget") continue;
      annots.push({ page: i, subtype: a.subtype, contents: a.contentsObj?.str ?? "", rect: (a.rect ?? []).map((n) => Math.round(n)) });
    }
  }
  items.push({
    id: "pdf.annotations",
    present: annots.length > 0,
    signature: annots,
    where: "每页 /Annots（pdf.js getAnnotations，排除 Link/Widget）",
  });

  return {
    format: "pdf",
    file,
    sha256: sha256Of(bytes),
    items,
    excluded: [
      "PDF 对象顺序与交叉引用表布局（pdf-lib 每次 save 都会重排）",
      "文档 Info 字典的 ModDate / Producer",
      "页面 /Contents 流的编码（压缩方式不同不影响语义）",
    ],
    required: ["pdf.text-layer", "pdf.outline", "pdf.annotations"],
  };
}

interface PdfjsShape {
  getDocument(o: Record<string, unknown>): { promise: Promise<PdfDocProxyShape> };
}
interface PdfDocProxyShape {
  numPages: number;
  getPage(n: number): Promise<{
    getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
    getAnnotations(): Promise<unknown[]>;
  }>;
  getOutline(): Promise<unknown | null>;
}

function pathToFileUrl(p: string): string {
  const { pathToFileURL } = require("node:url") as typeof import("node:url");
  return pathToFileURL(p).href;
}

/* ─────────────────────────────── Markdown ─────────────────────────────── */

/**
 * Markdown 指纹：文本级结构识别（不依赖渲染）。四类部件：
 *
 *  - **表格**：连续的 `|` 行（分隔行 + 数据行）；
 *  - **代码块**：围栏块（```lang … ```）；
 *  - **图片引用**：`![alt](src)` 的 alt 与 src；
 *  - **嵌套列表**：按缩进分层的列表项（`-` / `*` / `1.`）。
 *
 * 这四类各自的签名都**保留内容**，所以改了标题文字不会直接打红 —— 除非
 * 那行文字在某个部件里。
 */
export function fingerprintMarkdown(file: string): Fingerprint {
  const raw = readFileSync(file, "utf8");
  const items: EvidenceItem[] = [];

  const lines = raw.split(/\r?\n/);
  const tables: Array<{ header: string[]; rows: string[][] }> = [];
  const codeBlocks: Array<{ lang: string; body: string }> = [];
  const images: Array<{ alt: string; src: string }> = [];
  const nested: Array<{ depth: number; marker: string; text: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^(\s*)(```|~~~)\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[i]!); i++) body.push(lines[i]!);
      codeBlocks.push({ lang: fence[3] ?? "", body: body.join("\n") });
      continue;
    }
    const tableLine = /^\s*\|(.+)\|\s*$/.exec(line);
    if (tableLine) {
      const cells = tableLine[1]!.split("|").map((c) => c.trim());
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) {
        // separator row: 只证明「那是一张表」，不参与内容签名
        if (tables.length === 0) tables.push({ header: [], rows: [] });
        continue;
      }
      const last = tables[tables.length - 1];
      if (last && last.rows.length === 0 && last.header.length === 0 && i > 0) {
        last.header = cells;
      } else if (last) {
        last.rows.push(cells);
      } else {
        tables.push({ header: cells, rows: [] });
      }
      continue;
    }
    for (const m of line.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)) images.push({ alt: m[1] ?? "", src: m[2] ?? "" });
    const lm = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (lm) {
      const indent = (lm[1] ?? "").replace(/\t/g, "  ").length;
      nested.push({ depth: Math.floor(indent / 2), marker: /\d/.test(lm[2]!) ? "ordered" : "bullet", text: lm[3] ?? "" });
    }
  }

  // 部件之间的**先后顺序**：把部件挪到别处（内容不变）也要红 —— 卡 §4 的
  // 「换个位置放回去」在 markdown 上就是这一条。只记部件种类序列，不记字节
  // 偏移（偏移会随任意文字编辑漂移，那不是语义）。
  const order: string[] = [];
  {
    let inFence = false;
    for (const line of lines) {
      if (/^\s*(```|~~~)/.test(line)) {
        if (!inFence) order.push("code-block");
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      if (/^\s*\|/.test(line)) {
        if (order[order.length - 1] !== "table") order.push("table");
        continue;
      }
      if (/!\[[^\]]*\]\([^)]*\)/.test(line)) order.push("image");
      else if (/^(\s*)([-*+]|\d+\.)\s+/.test(line) && order[order.length - 1] !== "list") order.push("list");
    }
  }
  items.push({
    id: "md.part-order",
    present: order.length > 0,
    signature: order,
    where: "Markdown 部件的先后顺序（表格/代码块/图片/列表）",
  });

  items.push({ id: "md.tables", present: tables.length > 0, signature: tables, where: "Markdown `|` 表格块" });
  items.push({ id: "md.code-blocks", present: codeBlocks.length > 0, signature: codeBlocks, where: "Markdown 围栏代码块" });
  items.push({ id: "md.image-refs", present: images.length > 0, signature: images, where: "Markdown `![alt](src)`" });
  items.push({ id: "md.nested-list", present: nested.length > 0, signature: nested, where: "Markdown 缩进列表" });

  return {
    format: "markdown",
    file,
    sha256: sha256Of(Buffer.from(raw, "utf8")),
    items,
    excluded: [
      "被编辑的正文纯文本（本卡只改一处无关内容；整篇正文入账会把这次编辑本身打成 FAIL）",
      "行尾空白",
      "行尾 EOL 种类（\\n vs \\r\\n —— 由另外的字节断言覆盖）",
    ],
    required: ["md.tables", "md.code-blocks", "md.image-refs", "md.nested-list", "md.part-order"],
  };
}

/* ─────────────────────────────── HTML ─────────────────────────────── */

/**
 * HTML 指纹：解析后取结构部件（不靠渲染）：
 *
 *  - `<style>` 元素内容（每个一个签名项）；
 *  - `<script>` 元素内容；
 *  - `<svg>` 元素：标签 + 属性 + 文本（title 标记）；
 *  - 正文可见文本（按元素顺序）。
 *
 * 用 fast-xml-parser 的 HTML 兼容模式解析：HTML 允许 void 元素与无引号属性，
 * 严格 XML 解析会在真实页面上失败。这里只取上面四类稳定部件，不追求 DOM 级保真
 *（那需要 jsdom，而 vendor 与 desktop 都没装它 —— 若要更严的语义比对，另开卡）。
 */
export function fingerprintHtml(file: string): Fingerprint {
  const raw = readFileSync(file, "utf8");
  const items: EvidenceItem[] = [];

  const decode = (s: string): string =>
    s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

  const styles = [...raw.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => normalizeCss(m[1] ?? ""));
  items.push({
    id: "html.style-blocks",
    present: styles.length > 0,
    signature: styles,
    where: "<style> 元素（内联样式表）",
  });

  const scripts = [...raw.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/\bsrc\s*=/.test(m[1] ?? "")) // 外链脚本不算内联部件
    .map((m) => normalizeJs(decode(m[2] ?? "")));
  items.push({
    id: "html.script-blocks",
    present: scripts.length > 0,
    signature: scripts,
    where: "内联 <script> 元素",
  });

  // SVG：按标签 + 属性 + 文本节点压成签名（不做 SVG 语义解析 —— 结构不变就够了）
  const svgs = [...raw.matchAll(/<svg\b[^>]*>([\s\S]*?)<\/svg>/gi)];
  items.push({
    id: "html.inline-svg",
    present: svgs.length > 0,
    signature: svgs.map((m) => svgSignature(m[0]!)),
    where: "内联 <svg> 元素",
  });

  // 正文里**被样式表/脚本引用的元素**（class 属性清单）与 **`<img>` 引用**：
  // 编辑落点是正文第一段的一句纯文本，不在其中任何一项。
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(raw);
  const bodyHtml = bodyMatch?.[1] ?? raw;
  const classAttrs = [...bodyHtml.matchAll(/\bclass\s*=\s*("([^"]*)"|'([^']*)')/g)]
    .map((m) => (m[2] ?? m[3] ?? "").split(/\s+/).filter(Boolean).join(" "))
    .filter(Boolean);
  items.push({
    id: "html.body-classes",
    present: classAttrs.length > 0,
    signature: classAttrs,
    where: "<body> 里元素的 class 属性（样式表的挂钩点）",
  });
  const imgRefs = [...bodyHtml.matchAll(/<img\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')/gi)].map((m) => m[2] ?? m[3] ?? "");
  items.push({
    id: "html.image-refs",
    present: imgRefs.length > 0,
    signature: imgRefs,
    where: "<body> 里 <img> 的 src",
  });

  // 内联复杂部件之间的**先后顺序**（style → svg → script）。把 SVG 挪到
  // script 之后（内容不变）也要红 —— 卡 §4 的「换个位置放回去」。
  const partOrder = [...raw.matchAll(/<(style|script|svg)\b/gi)].map((m) => (m[1] ?? "").toLowerCase());
  items.push({
    id: "html.part-order",
    present: partOrder.length > 0,
    signature: partOrder,
    where: "内联 <style>/<script>/<svg> 的先后顺序",
  });

  return {
    format: "html",
    file,
    sha256: sha256Of(Buffer.from(raw, "utf8")),
    items,
    excluded: [
      "被编辑的正文纯文本（本卡只改一处无关内容；整页可见文本入账会把这次编辑本身打成 FAIL）",
      "标签大小写 / 属性顺序 / 引号种类（CSS/JS 各自规范化后比较）",
      "空白与换行（CSS/JS 压成记号流）",
      "注释",
    ],
    required: ["html.style-blocks", "html.script-blocks", "html.inline-svg", "html.body-classes", "html.part-order"],
  };
}

function normalizeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,])\s*/g, "$1")
    .trim();
}

function normalizeJs(js: string): string {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}();,:=+\-<>])\s*/g, "$1")
    .trim();
}

function svgSignature(svg: string): unknown {
  const tags: Array<{ tag: string; attrs: Record<string, string>; text: string }> = [];
  for (const m of svg.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*?)(\/?)>([^<]*)/g)) {
    const tag = m[1]!.toLowerCase();
    const attrText = m[2] ?? "";
    const attrs: Record<string, string> = {};
    for (const a of attrText.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      attrs[a[1]!] = a[3] ?? a[4] ?? "";
    }
    const sorted: Record<string, string> = {};
    for (const k of Object.keys(attrs).sort()) sorted[k] = attrs[k]!;
    tags.push({ tag, attrs: sorted, text: (m[4] ?? "").trim() });
  }
  return tags;
}

/* ─────────────────────────────── 汇总入口 ─────────────────────────────── */

export type FormatKind = "docx" | "xlsx" | "pptx" | "pdf" | "markdown" | "html";

/**
 * 指纹的**声明式放宽**（只对卡允许的「编辑本身带来的变化」）。
 *
 * 每一条都必须由旅程显式给出，并在证据里写明理由；默认不放宽任何东西。
 */
export interface FingerprintOptions {
  /**
   * PPTX：这些元素（按页 + 名字）的**几何**（box）允许变化。
   *
   * 为什么需要：`slides:edit-text` 在 vendor 主进程里会跑 `applyAutofitResize`
   *（`slides-main.ts` 的 handler），`spAutoFit` 文本框改文字后**按新内容高度
   * 收缩** —— 那是编辑本身的 vendor 语义，不是部件损坏。被测元素是「被编辑的
   * 那个文本框」，不是本卡要保的复杂部件；它的**存在性、名字、类型、所在页**
   * 仍逐项比对（挪页/消失照红），只放开 box 一项。
   *
   * 代价（如实记下）：若一个 bug 把被编辑文本框的尺寸改错（例如改成 0），这条
   * 指纹不会红。编辑是否真的落盘由旅程里独立的 `pp-disk-has-edit-and-notes`
   * 断言覆盖。
   */
  pptxAutofitBox?: Array<{ slidePath: string; name: string }>;
}

export async function fingerprint(
  kind: FormatKind,
  file: string,
  repoRoot: string,
  opts?: FingerprintOptions,
): Promise<Fingerprint> {
  switch (kind) {
    case "docx": return fingerprintDocx(file);
    case "xlsx": return fingerprintXlsx(file, repoRoot);
    case "pptx": return fingerprintPptx(file, repoRoot, opts);
    case "pdf": return fingerprintPdf(file, repoRoot);
    case "markdown": return fingerprintMarkdown(file);
    case "html": return fingerprintHtml(file);
  }
}

/* eslint-enable @typescript-eslint/no-require-imports */
