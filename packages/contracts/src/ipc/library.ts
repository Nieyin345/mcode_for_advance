/**
 * 文献库:PDF 导入 / 转 Markdown / 笔记 / 引用导出 + 根目录设置键。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。领域类型在 contracts/library.ts —
 * 这里只放跨 IPC 的校验 schema。
 */

import { z } from "zod";
import { LIBRARY_KINDS } from "../library.js";
import type { LibraryKind, DownloadStatus } from "../library.js";
import { TemplateKindSchema } from "./templates.js";

/** 文献库根目录。缺失 → 默认 `<userData>/library`。
 *  库内所有相对路径(pdfPath / mdPath)都相对它。用户可在界面上改位置 ——
 *  改完只改指向、不搬文件(搬文件由用户自己决定,避免大批量 IO 中途失败)。 */
export const LIBRARY_ROOT_SETTING_KEY = "library.root";

/** 下载并发上限。缺失 → 默认 2。走内嵌浏览器下载,并发过高会与用户的手动浏览
 *  抢同一个 WebContentsView,反而更慢。 */
export const LIBRARY_DOWNLOAD_CONCURRENCY_SETTING_KEY = "library.downloadConcurrency";

/** 「回收站」那个集合的 id。
 *
 *  ⚠️ **按 id 记,不按名字找**:回收站是个**普通集合**(用户要求「只是一个叫回收站的
 *  collection」),所以他能给它改名、也能把它删掉。靠名字匹配的话,改个名字语义就废了。
 *  记 id 之后,名字随便改都不影响;集合被删了 id 就失效,下次要用时重建。 */
export const LIBRARY_TRASH_COLLECTION_SETTING_KEY = "library.trashCollectionId";

/**
 * 回收站的设置键 —— **每个库一个**(论文的回收站和笔记的回收站是两回事)。
 *
 * 不带库的旧键仍然保留:`library.trashCollectionId` 是老数据里那个全局回收站的
 * 位置(它建在论文库下),论文库会回退去读它,不然改完键就不认那个集合了。
 */
export function libraryTrashSettingKey(kind: LibraryKind): string {
  return `${LIBRARY_TRASH_COLLECTION_SETTING_KEY}.${kind}`;
}

/* ── 文献库:PDF 文件导入 + 转 Markdown ── */

/** 三个平级的库(值域与 `contracts/library.ts` 的 `LIBRARY_KINDS` 一致)。 */
export const LibraryKindSchema = z.enum(LIBRARY_KINDS);
export type LibraryKindInput = z.infer<typeof LibraryKindSchema>;

export const LibraryImportFilesSchema = z.object({
  /** 用户从文件选择框里挑出来的绝对路径。上限 200 —— 再多就该分批了。 */
  paths: z.array(z.string().min(1)).min(1).max(200),
  /** 导入的文献归入哪些库(null/省略 = 只进总库)。 */
  collectionIds: z.array(z.string()).optional(),
  /** 入库后是否接着转 Markdown(默认转 —— 用户要的就是「导入即可被 AI 读」)。 */
  convert: z.boolean().optional(),
  /** 导入到哪个库。省略 = 论文库。 */
  kind: LibraryKindSchema.optional(),
});
export type LibraryImportFilesInput = z.infer<typeof LibraryImportFilesSchema>;

/**
 * 导入笔记:直接收 **Markdown 文件**。
 *
 * 与 `importFiles`(PDF)分开是因为两件事的后续完全不同:PDF 要抓元数据、要排队下载、
 * 要转 Markdown;笔记本身就是 Markdown,入库即完成 —— 没有元数据可抓,也不需要转录。
 * 硬塞进一条 RPC 只会让两边都长出一串 `if (kind === "note")`。
 */
export const LibraryImportNotesSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(200),
  collectionIds: z.array(z.string()).optional(),
});
export type LibraryImportNotesInput = z.infer<typeof LibraryImportNotesSchema>;

export const LibraryConvertSchema = z.object({
  /** 要转的条目;省略则转整个库(或某个集合)。 */
  ids: z.array(z.string()).optional(),
  collectionId: z.string().optional(),
  /** 已经有 md 也重转。 */
  force: z.boolean().optional(),
});
export type LibraryConvertInput = z.infer<typeof LibraryConvertSchema>;

export const LibraryRevealFileSchema = z.object({
  id: z.string().min(1),
  /** 定位哪一个:PDF 还是转换出的 Markdown。默认 PDF。 */
  which: z.enum(["pdf", "md"]).optional(),
});
export type LibraryRevealFileInput = z.infer<typeof LibraryRevealFileSchema>;

/** 与 revealFile 同形:**入参只有条目 id**,路径由主进程从库里取。 */
export const LibraryOpenFileSchema = LibraryRevealFileSchema;
export type LibraryOpenFileInput = z.infer<typeof LibraryOpenFileSchema>;

/**
 * 读一篇文献的 Markdown 正文(应用内预览用)。
 *
 * 为什么必须走 IPC:渲染进程**读不了本地文件**(沙箱里没有 fs)。而且 md 里的图片是
 * 相对路径 `images/xxx.jpg`(MinerU 的产物),渲染端连它的父目录都不知道,只有主进程
 * 能把相对引用解析成真实字节。所以主进程一次把正文和**被引用到的图片**(base64
 * data URL)一起交出来,渲染端不需要二次往返。
 */
export const LibraryReadMarkdownSchema = z.object({ id: z.string().min(1) });
export type LibraryReadMarkdownInput = z.infer<typeof LibraryReadMarkdownSchema>;

/**
 * 读一篇文献的 PDF 字节(应用内 PDF 阅读器用)。
 *
 * 与 `readMarkdown` 同一个理由:渲染进程读不了本地文件。但这里**不走 base64** ——
 * Electron 的 IPC 用结构化克隆,`Uint8Array` 可以原样过去;base64 会让体积涨三分之一,
 * 而论文 PDF 常有十几 MB。pdf.js 的 `getDocument({ data })` 正好收 Uint8Array。
 */
/**
 * 采纳一份**用户手上的** Markdown 作为这篇的转录产物。
 *
 * 为什么不复用 convert:转录要花 MinerU 额度,而且用户手上那份可能本就更好 ——
 * 他要的是"挂上去",不是"再转一遍"(重转还会覆盖掉他更满意的那份)。
 */
/** 新建一篇笔记(笔记库里在应用内写的那种)。标题会写进正文的第一行。 */
export const LibraryCreateNoteSchema = z.object({
  title: z.string().min(1),
  collectionIds: z.array(z.string()).optional(),
});
export type LibraryCreateNoteInput = z.infer<typeof LibraryCreateNoteSchema>;

/**
 * 把编辑器的内容写回笔记文件。
 *
 * 只对**笔记**开放(主进程会校验 kind):论文/教材的 md 是转录产物,让应用内的
 * 编辑器直接覆盖它,"转录结果"和"用户改动"就再也分不清了。
 */
export const LibraryWriteNoteSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
});
export type LibraryWriteNoteInput = z.infer<typeof LibraryWriteNoteSchema>;

/** 列某个条目下的笔记。 */
/** 给**单独一篇**生成一份清单(标题/作者/该读哪个文件/我的笔记)。 */
/**
 * 整个库的清单(「全部文献」那一行)—— 只要 kind。
 *
 * 与 `library.manifest`(一个分类)是同一件事的两个粒度:分类是用户分出来的组,
 * 「全部<库>」是"这个库里的所有东西"。用户要求「和文档一样要有全部内容」,而那一行
 * 也得能挂进对话,否则它就是个只能看不能用的摆设。
 */
export const LibraryKindManifestSchema = z.object({ kind: LibraryKindSchema });
export type LibraryKindManifestInput = z.infer<typeof LibraryKindManifestSchema>;

/** 整个模版类目的清单(「全部 LaTeX 模版」那一行)。 */
export const TemplateKindManifestSchema = z.object({ kind: TemplateKindSchema });
export type TemplateKindManifestInput = z.infer<typeof TemplateKindManifestSchema>;

export const LibraryItemManifestSchema = z.object({ id: z.string().min(1) });
export type LibraryItemManifestInput = z.infer<typeof LibraryItemManifestSchema>;

export const LibraryNotesListSchema = z.object({ itemId: z.string().min(1) });
export type LibraryNotesListInput = z.infer<typeof LibraryNotesListSchema>;

/** 写一条笔记:带 id 是改,不带是新建。 */
export const LibraryNoteSaveSchema = z.object({
  id: z.string().min(1).optional(),
  itemId: z.string().min(1),
  content: z.string().min(1),
});
export type LibraryNoteSaveInput = z.infer<typeof LibraryNoteSaveSchema>;

/**
 * 改条目的显示标题。文献 / 教材 / 笔记都用它。
 *
 * **只改标题,不动磁盘上的文件**:文件名(尤其是笔记的)按条目 id 命名,跟着标题变
 * 会让库内所有引用一起漂。用户看到的名字变了就够了。
 */
export const LibraryRenameItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
});
export type LibraryRenameItemInput = z.infer<typeof LibraryRenameItemSchema>;

export const LibraryNoteDeleteSchema = z.object({ id: z.string().min(1) });
export type LibraryNoteDeleteInput = z.infer<typeof LibraryNoteDeleteSchema>;

export const LibraryAdoptMarkdownSchema = z.object({
  id: z.string().min(1),
  /** 用户选中的 md 文件绝对路径。同级若有 `images/` 会一起搬。 */
  path: z.string().min(1),
});
export type LibraryAdoptMarkdownInput = z.infer<typeof LibraryAdoptMarkdownSchema>;

export const LibraryReadPdfSchema = z.object({ id: z.string().min(1) });
export type LibraryReadPdfInput = z.infer<typeof LibraryReadPdfSchema>;

/** 导出的引用格式 —— 与 `citation.ts` 的 `CITATION_STYLES` 一一对应。 */
export const CitationStyleSchema = z.enum(["gb7714", "apa", "bibtex"]);

export const LibraryExportSchema = z.object({
  /** 只导出某个集合;省略则导出整个库。 */
  collectionId: z.string().optional(),
  style: CitationStyleSchema,
  /** 导出后顺便打开所在文件夹。**由主进程自己拼路径** —— 渲染端始终拿不到
   *  「打开任意路径」的能力(与 revealFile 同一条安全约定)。 */
  reveal: z.boolean().optional(),
});
export type LibraryExportInput = z.infer<typeof LibraryExportSchema>;

/* ── 文献库(library) ────────────────────────────────────────────────────
   领域类型见 `library.ts`;这里只放跨 IPC 的校验 schema。
   约定与既有分区一致:每个 schema 同时导出 `...Input` 类型。 */

/** 作者。三选一:西文给 family/given,中日韩等给 literal(不做姓/名切分)。 */
export const LibraryAuthorSchema = z.object({
  family: z.string().optional(),
  given: z.string().optional(),
  literal: z.string().optional(),
});

export const LibraryItemTypeSchema = z.enum([
  "article",
  "inproceedings",
  "book",
  "thesis",
  "preprint",
  "report",
  "other",
]);

/** 入库一条文献。`id` 由主进程生成 —— 渲染端/AI 只给标识符与元数据。
 *  `doi`/`arxivId` 至少给一个,否则无法查重也无法定位 PDF。 */
export const LibraryItemInputSchema = z
  .object({
    doi: z.string().optional(),
    arxivId: z.string().optional(),
    title: z.string().optional(),
    authors: z.array(LibraryAuthorSchema).optional(),
    year: z.number().int().optional(),
    venue: z.string().optional(),
    /** 卷 / 期 / 页码 / 出版商 —— 引用格式(GB/T 7714、APA、BibTeX)要用,
     *  缺了就整段省略。全部按字符串收:页码有 `1234-1240`、`e0123456` 等形态。 */
    volume: z.string().optional(),
    issue: z.string().optional(),
    page: z.string().optional(),
    publisher: z.string().optional(),
    abstract: z.string().optional(),
    type: LibraryItemTypeSchema.optional(),
    language: z.string().optional(),
    url: z.string().optional(),
    source: z.string().optional(),
    license: z.string().optional(),
    /** 归到哪个库。省略 = 论文库。 */
    kind: LibraryKindSchema.optional(),
    /** 一并归入的集合;省略则不归任何集合。 */
    collectionIds: z.array(z.string()).optional(),
    /** 入库后是否立刻排入下载队列。默认 true。 */
    queueDownload: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.doi?.trim() || v.arxivId?.trim() || v.title?.trim()), {
    message: "至少需要 doi / arxivId / title 之一",
  });
export type LibraryItemInput = z.infer<typeof LibraryItemInputSchema>;

export const LibraryAddItemsSchema = z.object({
  items: z.array(LibraryItemInputSchema).min(1),
});
export type LibraryAddItemsInput = z.infer<typeof LibraryAddItemsSchema>;

/** 列表筛选。`collectionId` 为 null 表示全部;`collectionId` 为字符串时只列该集合。 */
export const LibraryListSchema = z.object({
  collectionId: z.string().nullable().optional(),
  /** 只看某个库。省略 = 不限库(全部)。 */
  kind: LibraryKindSchema.optional(),
  /** 搜索关键词(标题/作者/摘要/venue),大小写不敏感。 */
  query: z.string().optional(),
  /** 只列某种 PDF 状态(如 "none" 用于找缺 PDF 的)。 */
  pdfState: z.enum(["none", "queued", "downloading", "ready", "needs_login", "failed"]).optional(),
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type LibraryListInput = z.infer<typeof LibraryListSchema>;

export const LibraryItemIdSchema = z.object({ id: z.string().min(1) });
export type LibraryItemIdInput = z.infer<typeof LibraryItemIdSchema>;

export const LibraryDeleteItemsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  /** 是否连同磁盘上的 PDF/MD 一起删除。默认 false(只从库里移除记录)。 */
  deleteFiles: z.boolean().optional(),
});
export type LibraryDeleteItemsInput = z.infer<typeof LibraryDeleteItemsSchema>;

/** 集合:新建。`parentId` 为 null 表示顶层。 */
export const CollectionCreateSchema = z.object({
  name: z.string().min(1),
  parentId: z.string().nullable().optional(),
  /** 建在哪个库里。省略 = 论文库。 */
  kind: LibraryKindSchema.optional(),
});
export type CollectionCreateInput = z.infer<typeof CollectionCreateSchema>;

export const CollectionRenameSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type CollectionRenameInput = z.infer<typeof CollectionRenameSchema>;

export const CollectionDeleteSchema = z.object({ id: z.string().min(1) });
export type CollectionDeleteInput = z.infer<typeof CollectionDeleteSchema>;

/** 把文献加入/移出集合。一次可操作多条。 */
export const CollectionAssignSchema = z.object({
  collectionId: z.string().min(1),
  itemIds: z.array(z.string().min(1)).min(1),
  /** true = 加入,false = 移出。 */
  add: z.boolean(),
});
export type CollectionAssignInput = z.infer<typeof CollectionAssignSchema>;

/** 机构认证档案。⚠️ 不含任何凭据 —— 登录态在浏览器分区里,见 library.ts 的说明。 */
export const InstitutionSaveSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  loginUrl: z.string().optional(),
  domains: z.array(z.string()).optional(),
  proxyPrefix: z.string().optional(),
  notes: z.string().optional(),
});
export type InstitutionSaveInput = z.infer<typeof InstitutionSaveSchema>;

export const InstitutionDeleteSchema = z.object({ id: z.string().min(1) });
export type InstitutionDeleteInput = z.infer<typeof InstitutionDeleteSchema>;

/** 查询已登录站点。按域名聚合当前浏览器分区里的 cookie。 */
export const InstitutionAuthStatusSchema = z.object({
  /** 只看这些域名;省略则返回全部有 cookie 的域名。 */
  domains: z.array(z.string()).optional(),
});
export type InstitutionAuthStatusInput = z.infer<typeof InstitutionAuthStatusSchema>;

export const InstitutionClearCookiesSchema = z.object({
  /** 要清除的域名。省略则清空整个浏览器分区(危险,UI 需二次确认)。 */
  domains: z.array(z.string()).optional(),
});
export type InstitutionClearCookiesInput = z.infer<typeof InstitutionClearCookiesSchema>;

/** 把文献排入下载队列。 */
export const LibraryDownloadSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  /** 已有 PDF 的是否强制重下。默认 false。 */
  force: z.boolean().optional(),
});
export type LibraryDownloadInput = z.infer<typeof LibraryDownloadSchema>;

/** 外部检索:AI 主导的关键词检索,走确定性 API。 */
export const LibrarySearchSchema = z.object({
  query: z.string().min(1),
  sources: z
    .array(z.enum(["arxiv", "crossref", "openalex", "europepmc"]))
    .optional(),
  limit: z.number().int().positive().max(100).optional(),
  yearFrom: z.number().int().optional(),
  yearTo: z.number().int().optional(),
});
export type LibrarySearchInput = z.infer<typeof LibrarySearchSchema>;

/** 导入通道:DOI / arXiv ID / BibTeX 文本,批量解析入库。不用 AI 也能走的确定路径。 */
export const LibraryImportSchema = z.object({
  /** 原始文本,每行一个 DOI / arXiv ID,或一整段 BibTeX。格式由主进程嗅探。 */
  text: z.string().min(1),
  collectionIds: z.array(z.string()).optional(),
  queueDownload: z.boolean().optional(),
});
export type LibraryImportInput = z.infer<typeof LibraryImportSchema>;

/** 设置库根目录(用户要求「UI 上可以设置文献的位置」)。 */
export const LibrarySetRootSchema = z.object({ path: z.string().min(1) });
export type LibrarySetRootInput = z.infer<typeof LibrarySetRootSchema>;

/**
 * 为一个文献库生成/刷新清单文件,返回其绝对路径。
 *
 * 为什么需要它:把库加进对话上下文的方式**刻意与「添加上下文文件」完全一致** ——
 * 提示词里只放一行 `@路径`,内容由 agent 用 Read 工具自己读,不预先内联。
 * 所以库需要一个可读的文件来承载"这个库里有哪些文献、各自的 PDF 在哪"。
 */
export const LibraryManifestSchema = z.object({ collectionId: z.string().min(1) });
export type LibraryManifestInput = z.infer<typeof LibraryManifestSchema>;

/** 把一条附件挂到某个会话的**输入框**上(左栏右键「添加到当前对话」)。
 *
 *  `key` 就是附件键,与「+」菜单选择器、以及 AI 的 `library_attach_to_chat`
 * 用的是**同一个**东西:
 *   `c:<分类 id>` —— 挂一个分类(整库清单)
 *   `i:<条目 id>` —— 挂单独一篇(单条清单)
 *
 *  为什么走主进程而不是渲染端直接改 store:消息要发给**指定会话**的输入框,而左栏
 *  与那个输入框不是同一棵组件树。主进程生成清单后再用既有的 `composer:attach`
 *  广播回去,该会话的 ChatPane 自己认领 —— 与 AI 挂库走的是同一条路,所以两边
 *  效果必然一致(用户的要求)。 */
export const LibraryAttachToChatSchema = z.object({
  sessionId: z.string().min(1),
  key: z.string().min(1),
});
export type LibraryAttachToChatInput = z.infer<typeof LibraryAttachToChatSchema>;

/** 全文检索(走 ripgrep,非 SQLite —— sql.js 不含 FTS5)。 */
export const LibraryFullTextSearchSchema = z.object({
  query: z.string().min(1),
  /** 限定在哪些集合内搜;省略则全库。 */
  collectionIds: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export type LibraryFullTextSearchInput = z.infer<typeof LibraryFullTextSearchSchema>;

/** 主进程 → 渲染端:某条文献的下载任务状态变了。
 *  界面据此刷新进度条,并在变成 `needs_login` 时提示用户去重新登录。 */
export interface LibraryJobChangedMessage {
  channel: "library:jobChanged";
  itemId: string;
  status: DownloadStatus;
  error?: string;
}

/**
 * 库的内容变了(新建/改名/删除分类、条目进出、改标题、写笔记…)—— 由主进程在任何
 * 一处改动之后广播,渲染端收到就整体重载。
 *
 * ## 为什么非有不可
 *
 * 界面上的库是渲染端自己缓存的一份(`libraryStore`),不是每次渲染都去问主进程。
 * 以前只有**用户自己在界面上操作**会改这份数据,所以缓存永远是对的。现在 AI 也能
 * 改(见 `mcp/libraryServer.ts` 的那套工具)—— 它改的是主进程里那份真相,渲染端的
 * 缓存不会自己知道。少了这条广播,AI 建好的分类在左栏里根本不出现,用户会以为它
 * 没干活。
 *
 * 用户的要求原话:「他对文件系统的操作要和用户在 ui 的操作一样」。
 *
 * 故意做得很粗:只报"变了",不报"变了什么"。细粒度的增量同步要维护两边的状态机,
 * 而重载一次分类树加条目列表是毫秒级的 —— 这里不值得为性能引入出错的可能。
 */
export interface LibraryChangedMessage {
  channel: "library:changed";
  /** 变了什么。只用于日志与排查,渲染端一律整体重载。 */
  reason: string;
}

/**
 * 模版库变了(增 / 删)。
 *
 * 与 `library:changed` 同一个用途、同一个理由:模版有两个入口 —— 左栏那一段和
 * 设置 → 数据位置 → 模版库。用户在后一个入口里加了一条,前一个的缓存不会自己知道
 * (模版库是文件系统,没有 DB 层替它们对账)。少了这条广播,用户会觉得"加了没反应"。
 *
 * 同样故意做得很粗:只报"变了",渲染端整体重扫一遍。
 */
export interface TemplatesChangedMessage {
  channel: "templates:changed";
  /** 变了什么。只用于日志与排查,渲染端一律整体重载。 */
  reason: string;
}

/**
 * 工作流 / 自动化 / 代理档案 / 节点类型变了 —— 由主进程在任何一处改动之后广播,
 * 渲染端收到就重拉列表。
 *
 * 与 `library:changed` 同一个理由:设置里那个工作流库是渲染端自己缓存的一份列表,
 * 以前只有**用户自己在界面上操作**会改它,所以缓存永远是对的。现在 AI 也能改
 * (见 `mcp/mcodeServer.ts` 的那套工具)—— 它改的是数据根里那份真相,渲染端的缓存
 * 不会自己知道。少了这条广播,AI 建好的工作流要等用户关掉设置页再打开才出现,
 * 而用户的原话是「他对文件系统的操作要和用户在 ui 的操作一样」。
 *
 * ⚠️ **渲染端只重拉列表,不重载正在编辑的那一份文档。** 画布上的改动有它自己的保存
 * 时机(拖动后落盘、切走前 flush),被一条外部广播冲掉的话,用户刚拖的那一下会凭空
 * 回去。正在编辑的那份由 `workflow:get` 决定何时读 —— 那是用户的动作,不是广播的。
 */
export interface WorkflowChangedMessage {
  channel: "workflow:changed";
  /** 变了什么。只用于日志与排查,渲染端一律重拉列表。 */
  reason: string;
}

/**
 * 往某次对话的输入框里挂一个附件(文献库分类 / 单篇,或模版库的一条模版)。
 *
 * 两个发起方:AI(走 MCP 工具的 `library_attach_to_chat`)和**用户自己**(左栏
 * 右键「添加到当前对话」)。渲染端收到后按 `makeLibraryTag` / `makeTemplateTag`
 * 造一个同款的 chip 加进输入框的标签区 —— 效果要和用户自己点「+ → 添加到上下文」
 * **逐字一样**:同样能删、同样参与去重、同样随下一条消息作为 `@清单路径` 发出去。
 *
 * 为什么要绕这一圈,而不是让 AI 直接用工具读库:用户要看见。挂上来的东西必须和
 * 他自己挂的长得一样、摆在同一处,否则"AI 到底读了什么"就成了只有 AI 知道的事。
 */
export interface ComposerAttachMessage {
  channel: "composer:attach";
  /** 只挂到发起这次工具调用的那个会话上 —— 别的会话不该凭空多一个附件。 */
  sessionId: string;
  /** 这条附件是哪个库的。渲染端据此选 `appendUniqueLibraryTags` 还是
   *  `appendUniqueTemplateTags` 落成 chip —— 两种 chip 长得不一样、去重键也不同
   *  (文献库是 `c:`/`i:`/`k:` 前缀,模版是 `t:` 前缀),所以不能只靠 key 猜。 */
  kind: "library" | "template";
  /** 附件键,与用户自己挂的同一套:文献库 `c:<分类 id>` / `i:<条目 id>` /
   *  `k:<库>`(整个库),模版 `t:<类目>`(整个类目)/ `t:<类目>/<目录名>`。 */
  key: string;
  /** chip 上显示的短名。 */
  name: string;
  /** 主进程生成的清单绝对路径;渲染端把它包成 `@<路径>` 作为 tag 的 content。 */
  manifestPath: string;
}

