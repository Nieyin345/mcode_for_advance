/**
 * 模版库的领域类型。
 *
 * ## 为什么**没有**数据库表 —— 文件系统就是事实源
 *
 * 文献库那张表是必要的:条目要按 DOI/arXiv 号去重、要挂下载任务、要存摘要。
 * 模版不一样:它就是一包文件,而且用户**一定会在资源管理器里直接动它们**
 * (拖一个 LaTeX 模版进去、改个名字、删掉一整套)。
 *
 * 一旦做成 DB 表,磁盘和数据库立刻会漂移 —— 用户在文件夹里删了东西,列表还显示着;
 * 反之亦然。所以这里**直接扫目录**:`<库根>/<类目>/<条目名>/` 就是一条模版,
 * 目录名就是显示名。没有同步问题,不需要迁移,用户在外面怎么整都算数。
 *
 * 代价是没有地方存备注之类的东西 —— 真需要的时候再谈,现在不值得为它引入漂移。
 */

/** 五个类目。用户给的清单:PPT / 论文 LaTeX / Word / 代码 / 图片。 */
export const TEMPLATE_KINDS = ["ppt", "latex", "word", "code", "image"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** 按扩展名把文件归类。图片类目的「图 ↔ 代码」对应关系就靠它 —— 一个条目是
 *  一组图片 + 一个代码文件,不必再存一份对应表。 */
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"];
const CODE_EXTS = [
  ".py", ".m", ".r", ".jl", ".ipynb", ".js", ".ts", ".c", ".cpp", ".h", ".java",
  ".tex", ".bib", ".cls", ".sty", ".do", ".sas", ".sql", ".sh",
];

export type TemplateFileRole = "image" | "code" | "other";

/**
 * 应用内预览一个模版文件的结果。
 *
 * 五种形态,对应界面上的五种呈现:
 *   - `text`        —— 等宽显示正文。**代码、LaTeX 源、配置都在这一类里**,也就是
 *                      用户说的"比较简单的那些" —— 它不需要任何转换管线,读出字节
 *                      就是可以给人看的东西。
 *   - `image`       —— data URL,直接 `<img>`。模版库有一个「图片」类目,这里必须认。
 *   - `docx`        —— **原始字节**,由渲染端的 `docx-preview` 真渲染成版式(见
 *                      `renderer/components/templates/DocxPreview.tsx`)。
 *   - `xlsx`        —— **原始字节**,由渲染端的 `@js-preview/excel` 真排出表格
 *                      (`renderer/components/templates/XlsxPreview.tsx`)。
 *   - `pptx`        —— **原始字节**,由渲染端的 `pptx-preview` 真排出幻灯片
 *                      (`renderer/components/templates/PptxPreview.tsx`)。
 *   - `unsupported` —— 二进制 / 太大。**这不是"失败"**:PDF 本来就该用别的程序看,
 *                      所以如实说明原因,让用户走外部打开那条路。
 *
 * `truncated` 只在 `text` 上有:`true` 表示只给了前面一段(界面必须说出来,否则用户
 * 会以为这份文件就这么短)。
 *
 * ⚠️ **三种 Office 文档 2026-09-16 全都改成真渲染了。** 在那之前它们走的是
 * `text` + 一个"这段文字是抽出来的"标记(排版、表格线、图片、页眉页脚都不在里面)——
 * 而模版**要看的就是版式**:Word 的页边距和标题层级、Excel 的列宽和合并单元格、
 * PPT 的版面和配色。只给一串文字等于没预览,用户拿它跟 Office 里打开的样子一比,
 * 会以为预览漏了一大半。那个标记连同抽文字那条路本身都删掉了(见 `read.ts`)。
 */
export type TemplateFileContent =
  | { kind: "text"; text: string; size: number; truncated: boolean }
  | { kind: "image"; dataUrl: string; size: number }
  | { kind: "docx"; data: Uint8Array; size: number }
  | { kind: "xlsx"; data: Uint8Array; size: number }
  | { kind: "pptx"; data: Uint8Array; size: number }
  | { kind: "unsupported"; reason: "binary" | "tooLarge"; size: number };

export function classifyTemplateFile(name: string): TemplateFileRole {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (CODE_EXTS.includes(ext)) return "code";
  return "other";
}

export interface TemplateFile {
  /** 相对**条目目录**的路径(可能带子目录)。 */
  relPath: string;
  size: number;
  role: TemplateFileRole;
}

export interface TemplateEntry {
  kind: TemplateKind;
  /** 目录名 —— 既是磁盘上的名字,也是显示名。 */
  dirName: string;
  /** 绝对路径。给「在文件夹中显示」和给 AI 的清单用。 */
  path: string;
  files: TemplateFile[];
  /** 图片类目用:这一组图有几张、代码是哪几份。 */
  imageCount: number;
  codeFiles: string[];
  /** 目录的 mtime —— 用来排序(最近动过的排前面)。 */
  updatedAt: number;
}

/** 目录名净化:去掉各平台非法的文件名字符。
 *
 *  用户输入的名字会直接变成文件夹名 —— 不净化的话带 `/` 或 `:` 的名字在 Windows
 *  上会直接创建失败,而且失败信息很难懂。 */
export function sanitizeTemplateName(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80);
}

/** 一个字符串是不是合法的类目名 —— 解析附件键、或者接不可信输入时要判它。 */
export function isTemplateKind(value: string): value is TemplateKind {
  return (TEMPLATE_KINDS as readonly string[]).includes(value);
}

/* ────────────────────── 附件键(挂进对话时的身份) ────────────────────── */

/** 模版附件键的前缀。见 {@link templateAttachKey}。 */
export const TEMPLATE_KEY_PREFIX = "t:";

/**
 * 模版附件的键 —— **整个模版库只有这一个定义**。
 *
 *   templateAttachKey("latex", "某模板") → "t:latex/某模板"   一条模版
 *   templateAttachKey("latex")            → "t:latex"          整个类目
 *
 * ## 为什么住在 contracts
 *
 * 这个字符串要在**四个地方**算出来,而且必须一模一样:
 *   - 主进程 `templates/store.ts` 的 `attachTemplateToChat`(决定 chip 里放什么);
 *   - 渲染端的 `contentTag.ts`(落成 chip 时写进 `templateKey`);
 *   - 「+ → 模版」选择器 `TemplatePicker`(用它排除已添加的);
 *   - 左栏右键「添加到当前对话」(见 `lib/attachToChat.ts`)。
 *
 * 算出来不一样的话,同一份东西会以两个身份各挂一次,去重直接失效。早先主进程和
 * 渲染端各有一份实现,靠注释里互相提醒"必须算出同一个字符串" —— 那种约定迟早会被
 * 改坏。放在 contracts 里,两边 import 同一个函数,分叉在物理上就不可能。
 *
 * ## 为什么带 `t:` 前缀
 *
 * 键的词汇表里有两个粒度(整个类目 / 一条模版)。没有前缀的话 `latex/某模板` 和
 * "类目叫 `latex/某模板`"没法区分,而两种粒度的键会一起进同一个去重集合。`t:` 让它
 * 与文献库那三个前缀(`c:` / `i:` / `k:`)排成同一套写法。
 *
 * `dirName` 省略 = **整个类目**(左栏「全部 LaTeX 模版」那一行)。
 */
export function templateAttachKey(kind: TemplateKind, dirName?: string): string {
  return dirName ? `${TEMPLATE_KEY_PREFIX}${kind}/${dirName}` : `${TEMPLATE_KEY_PREFIX}${kind}`;
}
