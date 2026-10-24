/**
 * 【T109】页面适配检查 —— 生成的文档有没有**超出可打印区**。
 *
 * ## 为什么这条必须存在
 *
 * 2026-10-24 第一次**真的看了一眼**生成的 docx（把 `render` 出的 PNG 读进来看），
 * 发现表格右边框几乎贴到页面边缘。解 zip 一查：
 *
 * ```
 * <w:pgSz w:w="11906"/>                          ← A4 宽
 * <w:pgMar w:left="1440" w:right="1440"/>        ← 可用宽 11906-2880 = 9026
 * <w:tblW w:w="9360" w:type="dxa"/>              ← 表格宽 9360
 * ```
 *
 * **超出 334 twips（约 0.23 英寸）。** 渲染图上 `同比` 那列的数字贴着边框。
 *
 * ## 根因是上游写死的常量，不是这份样本特殊
 *
 * `genoffice/packages/docx-engine/src/generate.ts:2497`：
 *
 * ```ts
 * const totalWidth = 9360 // 6.5in content width on US Letter
 * ```
 *
 * **它按 US Letter 的内容宽算表格，而 `create` 默认产出 A4 页面。** 我造了一份
 * 只有 3 列的表做对照 —— **仍然 9360**，跟列数无关。所以这是**系统性**的，
 * 不是"表格太宽才超"。
 *
 * ## 为什么放在 Mcode 侧而不是改 vendor
 *
 * `genoffice/` 是只读 vendor（硬规矩：L1 复用，不 fork）。而且 `docs check` 的
 * 10 条检查里**没有一条查页面适配** —— 它会对这份超宽的文档报
 * `no issues found (10 checks)`。**那是假门禁**：用户会以为文档没问题。
 *
 * ## 这一层只做判定，不做修复
 *
 * 报出「哪张表、超多少」，**不改宽度、不阻断生成**。理由与 T106 给 severity 语义时
 * 相同：判据本身可能有意外的误报，让它阻断会把「判据有点毛病」升级成「产品卡住」。
 * 改宽度是另一个决定（是缩到可用宽、还是把页面改成 Letter），留给调用方与用户。
 */

import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

/** 一个文档里被查出来的一处页面适配问题。 */
export interface PageFitIssue {
  /** 固定前缀，让它在 `issues` 里认得出来。 */
  rule: "layout.table-overflow";
  level: "error";
  /** 人话位置：第几张表（1-based）+ 它在页面上的序号。 */
  where: string;
  message: string;
  /** 结构化数字 —— 调用方要据它判断严重程度，不要把上面那句人话再解析一遍。 */
  detail: {
    tableIndex: number;
    tableWidthTwips: number;
    /** 可用宽；读不到页面设置时为 null（此时不报，见下）。 */
    availableWidthTwips: number | null;
    overflowTwips: number;
  };
}

/** `w:pgSz` / `w:pgMar` 里我们要的那几个数。 */
export interface PageSetup {
  /** 页面宽（twips）。 */
  widthTwips: number;
  marginLeftTwips: number;
  marginRightTwips: number;
}

/**
 * 从 `document.xml` 里读第一个 `<w:sectPr>` 的页面尺寸与左右边距。
 *
 * **读不到就返回 null，而不是猜一个默认值。** 猜会让「不知道」变成「没问题」——
 * 那正是本文件开头说的假门禁。
 */
export function readPageSetup(documentXml: string): PageSetup | null {
  const widthMatch = /<w:pgSz\b[^>]*\bw:w="(\d+)"/.exec(documentXml);
  if (!widthMatch) return null;
  const marginMatch = /<w:pgMar\b[^>]*>/.exec(documentXml);
  if (!marginMatch) return null;
  const marginTag = marginMatch[0];
  const leftMatch = /\bw:left="(\d+)"/.exec(marginTag);
  const rightMatch = /\bw:right="(\d+)"/.exec(marginTag);
  // 左右边距缺一个就不算——只减一边会把「可用宽」算大，于是超宽反而报不出来。
  if (!leftMatch || !rightMatch) return null;
  return {
    widthTwips: Number(widthMatch[1]),
    marginLeftTwips: Number(leftMatch[1]),
    marginRightTwips: Number(rightMatch[1]),
  };
}

/**
 * 从 `document.xml` 里读每一张**顶层**表格的 `w:tblW`。
 *
 * ## 为什么只认顶层
 *
 * 嵌套表的可用宽是**外层单元格的宽**，不是页面宽。把嵌套表按页面宽判会把
 * 正常的嵌套表报成超宽。这里的取舍是**宁可漏报嵌套表**（它们少见，且外层已经
 * 被查过了），不要误报。
 *
 * ## 为什么要配平 `<w:tbl>` / `</w:tbl>`
 *
 * 一个正则 `/<w:tbl>.*?<w:tblW[^/]*\/>/s` 在有多张表时会拿错（跨表匹配）。
 * 这里走一遍字节流，按开闭标签维护深度，只在深度 0→1 那一层取 `tblW`。
 */
export function readTableWidths(documentXml: string): number[] {
  const out: number[] = [];
  const tagRe = /<w:tbl>|<\/w:tbl>|<w:tblW\b[^/]*\/>/g;
  let depth = 0;
  /** 当前顶层表是否还没读到它的 tblW。 */
  let pendingTopTable = false;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(documentXml)) !== null) {
    const tag = m[0];
    if (tag === "<w:tbl>") {
      depth++;
      if (depth === 1) pendingTopTable = true;
      continue;
    }
    if (tag === "</w:tbl>") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) pendingTopTable = false;
      continue;
    }
    // tblW：只在顶层、且这张表还没记过时取（一张表只有一个 tblW，取第一个）。
    if (depth === 1 && pendingTopTable) {
      const w = /\bw:w="(\d+)"/.exec(tag);
      if (w) {
        out.push(Number(w[1]));
        pendingTopTable = false;
      }
    }
  }
  return out;
}

/**
 * 判据本体：给定页面设置与各表宽度，报出超宽的表。
 *
 * **可用宽 <= 0 时一律返回空** —— 那是页面设置读坏了，不该拿它判超宽。
 */
export function findTableOverflows(args: {
  page: PageSetup | null;
  tableWidthsTwips: readonly number[];
}): PageFitIssue[] {
  const { page, tableWidthsTwips } = args;
  if (page === null) return [];
  const available = page.widthTwips - page.marginLeftTwips - page.marginRightTwips;
  if (available <= 0) return [];
  const issues: PageFitIssue[] = [];
  for (let i = 0; i < tableWidthsTwips.length; i++) {
    const width = tableWidthsTwips[i]!;
    if (width <= available) continue;
    const overflow = width - available;
    issues.push({
      rule: "layout.table-overflow",
      level: "error",
      where: `第 ${i + 1} 张表`,
      message:
        `表格宽 ${width} twips，可打印区只有 ${available} twips` +
        `（页面 ${page.widthTwips} − 左边距 ${page.marginLeftTwips} − 右边距 ${page.marginRightTwips}），` +
        `右侧超出 ${overflow} twips（约 ${(overflow / 1440).toFixed(2)} 英寸）。` +
        `表会压到右边距里，最右一列可能被裁掉。`,
      detail: {
        tableIndex: i + 1,
        tableWidthTwips: width,
        availableWidthTwips: available,
        overflowTwips: overflow,
      },
    });
  }
  return issues;
}

/**
 * 一步到位：从 `word/document.xml` 的原文得到问题清单。
 *
 * 调用方只需要一个已经解开的 `document.xml` 字符串（见下面 `checkDocxPageFit`）。
 * **本函数不碰文件系统** —— 判据可单测、可 import 真身。
 */
export function checkPageFit(documentXml: string): PageFitIssue[] {
  return findTableOverflows({
    page: readPageSetup(documentXml),
    tableWidthsTwips: readTableWidths(documentXml),
  });
}

/* ─────────────────── 从 .docx 文件里取 document.xml ─────────────────── */

/**
 * 从一个 zip 缓冲里取出某个条目的**解压后**内容。
 *
 * ## 为什么自己写这一个
 *
 * 主进程里没有 zip 依赖（`apps/desktop/package.json` 里没有 jszip/adm-zip/yauzl），
 * 而为了读一个 XML 引一个新包不值得 —— **`node:zlib` 的 `inflateRawSync` 就是
 * deflate 的主体**，缺的只是把中央目录走一遍。
 *
 * ## 它只做这一件事
 *
 * 不解析目录树、不处理加密、不支持 zip64。**遇到这些情况返回 null**，让调用方
 * 明确知道「读不到」，而不是猜。
 *
 * 遍历走**中央目录**（EOCD → 每条的 header），不是顺序扫本地头 —— 本地头可能带
 * data descriptor（大小在那儿的头里是 0），而中央目录里一定是真实值。
 */
export function readZipEntry(buf: Buffer, wantName: string): Buffer | null {
  // EOCD 在文件尾部，可能跟一段最长 65535 的注释。从后往前找签名。
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (name === wantName) {
      if (localOff + 30 > buf.length) return null;
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      // method 0 = stored，8 = deflate。别的（含加密 99）一律不认。
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/**
 * 对一份 `.docx` 文件做页面适配检查。
 *
 * **任何读不到的情况都返回空数组**（文件不是 zip、没有 `word/document.xml`、
 * 解压失败）。**这是「不报」而不是「没问题」** —— 调用方若要区分，看返回值
 * 之外的信号（本函数不提供），因为**这条检查的职责是「发现问题时说出来」，
 * 不是「证明文档没问题」**。理由：页面适配读不到不代表文档坏了，把它报成
 * 门禁失败会让正常的非 docx 路径跟着红。
 */
export function checkDocxPageFit(filePath: string): PageFitIssue[] {
  try {
    const buf = readFileSync(filePath);
    const xml = readZipEntry(buf, "word/document.xml");
    if (xml === null) return [];
    return checkPageFit(xml.toString("utf8"));
  } catch {
    return [];
  }
}
