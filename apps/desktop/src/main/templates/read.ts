/**
 * 读一条模版里的**一个文件** —— 应用内预览的落点。
 *
 * ## 几档,按"代价"从低到高
 *
 * - **文本 / 代码**:读出字节、按 UTF-8 展示就是可以给人看的东西 —— LaTeX 源、`.cls`、
 *   `.bib`、Python / MATLAB 脚本、配置全在里头,不需要任何转换管线。
 * - **图片**:一个 data URL 而已,而模版库本来就有「图片」类目。
 * - **Word / Excel / PPT**:把**原始字节**交给渲染端,由那边的库真排出**版式**
 *   (`docx-preview` / `@js-preview/excel` / `pptx-preview`)。
 *   见 `renderer/components/templates/`。
 *
 *   ⚠️ 2026-09-16 之前这三种走的是**另一条路**:用一个自己写的 ZIP 读取器
 *   (`main/lib/officeText.ts`)把文档里的文字抠出来,当纯文本显示,并挂一个
 *   "这段文字是抽出来的"标记。那是**能用**的,但对模版几乎等于没用 —— 模版要看的
 *   就是版式(页边距、标题层级、表格、合并单元格、版面配色),一串没有格式的文字
 *   看不出这些,而用户拿它跟 Office 里真正打开的样子一比,只会以为预览漏了一大半。
 *   三种都真渲染之后,那条路就没有调用者了,连同 `officeText.ts` 一起删掉了。
 *
 * **PDF 不做**:它要一整套渲染管线(文献库那份分页查看器是给库里的 PDF 用的,接口
 * 与这里不同)。界面上如实说"这个看不了"并给「用外部程序打开」—— 假装支持比不支持更糟。
 *
 * ## 路径是不受信输入
 *
 * `relPath` 是从渲染端传回来的。两道关卡,缺一不可:
 *
 *   1. **必须是扫描时列出来的那些文件之一**(`entry.files`)—— 连拼路径的机会都不给;
 *   2. 解析出的绝对路径还要落在条目目录**内部**(防符号链接之类的绕过)。
 *
 * 少了任一道,一段构造过的请求就能把机器上任意文件读成预览内容交给渲染端。
 */
import { readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { TemplateFileContent } from "@contracts/templates";
import type { TemplateKind } from "@contracts/templates";
import { findTemplate } from "./store.js";

/**
 * 文本预览的上限。超过就只给前面一段。
 *
 * 512KB 的等宽文本已经远超"扫一眼"的需要,而一次 IPC 塞几十兆会把渲染端拖住 ——
 * 用户报过的"点开就卡住"就是这么来的(见 library/markdownPreview.ts 的同一个考虑)。
 */
const MAX_TEXT_BYTES = 512 * 1024;

/** 图片上限。base64 之后还要再涨三分之一,所以和文献库那边取同一个量级。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * 能直接在 `<img>` 里显示的扩展名。
 *
 * 与 `contracts/src/templates.ts` 的 `IMAGE_EXTS` 保持同一套 —— 那边决定"算不算配图",
 * 这边决定"能不能直接画出来"。`.tiff` 之类浏览器画不了的**不收**:收了只会得到一个
 * 破图,不如走"用外部程序打开"。
 */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
};

/**
 * **要交给渲染端真排版**的那几种:扩展名 → 哪一种。
 *
 * 加一种格式(或者发现某个后缀其实是同一个包)只改这一张表 —— 下面那条分支、
 * 上面那三种内容形态、渲染端那个 `switch` 各认自己的那一份,中间不再有第二个
 * 扩展名清单要同步。**清单分家过一次**,代价是整整一个月 Word 预览没缩放
 * (见 `DocxPreview.tsx` 文件头记的那个 bug)。
 *
 * | 收哪些 | 为什么 |
 * |---|---|
 * | `.docx` / `.dotx` | Word 的「另存为模版」和文档是**同一个 OOXML 布局**,只是 content-type 标成模版 |
 * | `.xlsx` / `.xlsm` / `.xltx` | 同理。带宏那一份的宏不在表的正文里,画出来就是一张普通的表 —— 收它不构成"执行了宏" |
 * | `.pptx` / `.potx` / `.ppsx` | 同理(模版 / 放映)。幻灯片的母版、版式、主题全在包里,渲染器读得到 |
 */
const RENDER_EXTS: Record<string, "docx" | "xlsx" | "pptx"> = {
  ".docx": "docx",
  ".dotx": "docx",
  ".xlsx": "xlsx",
  ".xlsm": "xlsx",
  ".xltx": "xlsx",
  ".pptx": "pptx",
  ".potx": "pptx",
  ".ppsx": "pptx",
};

/**
 * 上面那几种统一的大小上限。
 *
 * **比 PDF 那个(64MB)小一半**,理由是渲染方式不同:pdf.js 一页一页虚拟化地画,
 * 而这几个库都是**把整篇一次性铺成 DOM** —— 一次几万个节点的大文档会把渲染进程卡住,
 * 而"点开就卡住"正是用户报过的那类问题。
 *
 * 超了就走 `unsupported: "tooLarge"`,界面照旧如实说并给「用外部程序打开」。
 */
const MAX_RENDER_BYTES = 32 * 1024 * 1024;

/** 看起来是二进制吗 —— 只看开头 4KB 有没有 NUL 字节(与 store.ts 同一个判据)。 */
function looksBinary(buf: Buffer): boolean {
  for (let i = 0; i < Math.min(buf.length, 4096); i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * 把一个 `relPath` 解析成安全的绝对路径。**两道关卡都在这一个函数里**,所以"读它"
 * 与"用外部程序打开它"用的是同一套围栏 —— 分头写迟早有一边漏掉。
 *
 * @throws 模版不存在 / 文件不在这个模版里 / 路径越界
 */
export function resolveTemplateFilePath(
  kind: TemplateKind,
  dirName: string,
  relPath: string,
): string {
  const entry = findTemplate(kind, dirName);
  if (!entry) throw new Error(`模版不存在:${kind}/${dirName}`);

  // ① 只能碰扫描时列出来的文件
  if (!entry.files.some((f) => f.relPath === relPath)) {
    throw new Error(`这个模版里没有 ${relPath}`);
  }
  // ② 解析结果必须还在条目目录里(两道关卡都要)
  const abs = resolve(entry.path, ...relPath.split("/"));
  if (!abs.startsWith(entry.path + sep)) throw new Error("路径越界");
  return abs;
}

export function readTemplateFile(
  kind: TemplateKind,
  dirName: string,
  relPath: string,
): TemplateFileContent {
  const abs = resolveTemplateFilePath(kind, dirName, relPath);
  const size = statSync(abs).size;
  const ext = extname(abs).toLowerCase();

  const mime = IMAGE_MIME[ext];
  if (mime) {
    if (size > MAX_IMAGE_BYTES) return { kind: "unsupported", reason: "tooLarge", size };
    const buf = readFileSync(abs);
    return { kind: "image", dataUrl: `data:${mime};base64,${buf.toString("base64")}`, size };
  }

  // **Office 三种:给原始字节,不在这一头解析。** 真渲染要 DOM,而主进程没有;
  // 那几个库都在渲染端。与 `library.readPdf` 同一个做法 —— 走结构化克隆,Uint8Array
  // 能原样过去,不做 base64(那会让体积涨三分之一)。
  //
  // ⚠️ 放在 `looksBinary` **之前**:这三种都是 ZIP,开头就有 NUL,必然被判成二进制。
  const renderKind = RENDER_EXTS[ext];
  if (renderKind) {
    if (size > MAX_RENDER_BYTES) return { kind: "unsupported", reason: "tooLarge", size };
    const data = new Uint8Array(readFileSync(abs));
    // ⚠️ 三个分支分开写,而不是"算一个 kind 变量塞进同一个对象里"。那样得到的类型是
    // `{ kind: "docx" | "xlsx" | "pptx" }`,而**并集的外层**不是外层三个成员的并集 ——
    // 编译器认不出来,渲染端那个 `switch (content.kind)` 也就跟着不成立。
    if (renderKind === "docx") return { kind: "docx", data, size };
    if (renderKind === "xlsx") return { kind: "xlsx", data, size };
    return { kind: "pptx", data, size };
  }

  const buf = readFileSync(abs);
  if (looksBinary(buf)) return { kind: "unsupported", reason: "binary", size };
  const truncated = buf.length > MAX_TEXT_BYTES;
  return {
    kind: "text",
    text: buf.subarray(0, MAX_TEXT_BYTES).toString("utf8"),
    size,
    truncated,
  };
}
