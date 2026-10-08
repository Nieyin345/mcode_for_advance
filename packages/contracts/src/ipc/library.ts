/**
 * 资料库:文件导入 / 转 Markdown / 笔记 / 关联 + 根目录设置键。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。领域类型在 contracts/library.ts —
 * 这里只放跨 IPC 的校验 schema。
 */

import { z } from "zod";
/** 「回收站」那个集合的 id。
 *
 *  ⚠️ **按 id 记,不按名字找**:回收站是个**普通集合**(用户要求「只是一个叫回收站的
 *  collection」),所以他能给它改名、也能把它删掉。靠名字匹配的话,改个名字语义就废了。
 *  记 id 之后,名字随便改都不影响;集合被删了 id 就失效,下次要用时重建。 */
export const LIBRARY_TRASH_COLLECTION_SETTING_KEY = "library.trashCollectionId";

/**
 * **老的「每库回收站键」** —— 升级线索,只读。
 *
 * kind 退役前(`< bcd3a2e`),回收站是**每个库一个**,它的集合 id 存在带 kind 后缀的键上:
 *
 *     library.trashCollectionId.paper     论文库的回收站
 *     library.trashCollectionId.textbook  教材库的回收站
 *     library.trashCollectionId.note      笔记库的回收站
 *
 * 这些键在旧库里**真实存在**。回收站改成「全库共用一个」之后,新键写不带后缀的那个
 * ({@link LIBRARY_TRASH_COLLECTION_SETTING_KEY}),而这三个带后缀的降级成**只读的升级
 * 线索**:`main/library/trash.ts` 靠它们把老回收站认出来并合并(用户可能把回收站改过名,
 * 名字那条来源就认不出了,只剩这些键能救它)。
 *
 * ⚠️ **必须返回带后缀的老格式。** 这里曾被收成直接返回不带后缀的全局键 —— 于是
 * `trash.ts` 里遍历三个 kind 的那三处读的是**同一个**键,老的每库键从来没被读到,
 * 改过名的老回收站会被认成"没有回收站",`ensureTrashCollection` 再建一个空壳,老回收站
 * 里的条目就成了界面上再也够不着的僵尸(见 `trash.ts` 文件头的 warning)。
 */
export function libraryTrashSettingKey(kind: string): string {
  return `${LIBRARY_TRASH_COLLECTION_SETTING_KEY}.${kind}`;
}

/* ── 文献库:PDF 文件导入 + 转 Markdown ── */

/**
 * 库 kind 的 IPC 入参。**开放字符串**:统一资料库后 kind 的合法取值由类型注册表
 * (见 `contracts/libraryTypes.ts`)决定,而注册表在主进程的 DB 里 —— 契约层拿不到,
 * 所以这里只查"是个非空串",**注册表校验在 handler 层**做(见 main/library/kindRegistry)。
 * 传一个没注册的 kind,handler 返回一条说人话的错误,而不是 schema 的泛泛拒绝。
 */

/* ── 大类(左栏分组) ── */

/** 读大类表。返回的是**合并校验后**的(引用了已删类型的行已被过滤)。 */
export const LibraryGroupsGetSchema = z.object({});
export type LibraryGroupsGetInput = z.infer<typeof LibraryGroupsGetSchema>;

/** 整表替换大类(形状与"一个类型只属一个组"的校验在 `parseLibraryGroupsJson`)。 */
export const LibraryGroupsSaveSchema = z.object({ groups: z.unknown() });
export type LibraryGroupsSaveInput = z.infer<typeof LibraryGroupsSaveSchema>;

/* ── 屏蔽规则 ── */

/** 读屏蔽规则(哪些资料不进上下文)。同 `typesGet` / `groupsGet`:无入参。 */
export const LibrarySuppressGetSchema = z.object({});
export type LibrarySuppressGetInput = z.infer<typeof LibrarySuppressGetSchema>;

/** 整表替换屏蔽规则。形状与合法性由主进程过 `parseSuppressJson` —— 仍然是纯函数,
 *  渲染端要预检就用同一份,判据不会漂移(同注册表那两条)。 */
export const LibrarySuppressSaveSchema = z.object({ rule: z.unknown() });
export type LibrarySuppressSaveInput = z.infer<typeof LibrarySuppressSaveSchema>;

/* ── 条目关联 ── */

/** 查一条条目的关联(**双向都返回** —— 界面上「它关联了谁」与「谁关联了它」都要看)。 */
export const LibraryLinksOfSchema = z.object({ itemId: z.string().min(1) });
export type LibraryLinksOfInput = z.infer<typeof LibraryLinksOfSchema>;

/**
 * 一批条目**各自**的关联条数 —— 左栏行尾那个徽标要的数字。
 *
 * 为什么要一条批量的:左栏一屏几十上百条,`linksOf` 是**一次一条**的。
 * 逐条调就是几十次 IPC,而且每次都要把整张关联表扫一遍("指向它的"那一半要求
 * 反向查)。一条批量 RPC 把这两个开销都变成 1。
 *
 * 计数口径与 `linksOf` 一致(进/出两个方向都算):徽标说 2,点进去就该是 2 条 ——
 * 数字对不上是最容易被当成 bug 的一类。
 *
 * 上限 2000 条:左栏一次不可能要更多,而一个没有上限的 `IN (...)` 会被拼成
 * 一条巨长的 SQL。超出的**丢掉**(不报错)—— 徽标少显示几个不影响用,
 * 而报错会让整栏画不出来。
 */
export const LibraryLinkCountsSchema = z.object({
  itemIds: z.array(z.string().min(1)).max(2000),
});
export type LibraryLinkCountsInput = z.infer<typeof LibraryLinkCountsSchema>;

/**
 * 加一条关联。
 *
 * 目标两种形态**二选一**(表上有 CHECK):`targetItemId`(库里的另一条条目)、
 * `targetPath`(库外的一个绝对路径)。这里用 `refine` 把"恰好一个"写成 schema 的
 * 一部分 —— 与表上那条约束同一条规矩,免得 UI 传错时先写进库再被 SQLite 顶回来。
 */
export const LibraryLinkAddSchema = z
  .object({
    itemId: z.string().min(1),
    targetItemId: z.string().min(1).optional(),
    targetPath: z.string().min(1).optional(),
  })
  .refine((v) => (v.targetItemId === undefined) !== (v.targetPath === undefined), {
    message: "关联目标要么是库内条目、要么是库外路径,不能两个都给或都不给",
  });
export type LibraryLinkAddInput = z.infer<typeof LibraryLinkAddSchema>;

/** 解除一条关联(按关联行自己的 id)。 */
export const LibraryLinkRemoveSchema = z.object({ linkId: z.string().min(1) });
export type LibraryLinkRemoveInput = z.infer<typeof LibraryLinkRemoveSchema>;

export const LibraryImportFilesSchema = z.object({
  /** 用户从文件选择框里挑出来的绝对路径。上限 200 —— 再多就该分批了。 */
  paths: z.array(z.string().min(1)).min(1).max(200),
  /** 导入的文献归入哪些库(null/省略 = 只进总库)。 */
  collectionIds: z.array(z.string()).optional(),
  /** 入库后是否接着转 Markdown(默认转 —— 用户要的就是「导入即可被 AI 读」)。 */
  /** @deprecated Accepted for compatibility only; imports never directly transcribe. */
  convert: z.boolean().optional(),
  /**
   * 导入模式：`"files"` = 逐个文件导入（默认）；`"folder"` = 把目录作为**一个**
   * linked 条目收进来（不拆开，可展开浏览）；`"explode"` = 批量 —— 把目录里的
   * 文件拆开逐个导成独立条目。
   */
  mode: z.enum(["files", "folder", "explode"]).optional(),
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
  /** 按小类清理失联/多余产物并修复该小类；必须显式提供 collectionId。 */
  repair: z.boolean().optional(),
}).refine((value) => !value.repair || Boolean(value.collectionId), {
  message: "修复只能指定一个文档小类，不能对全库执行",
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
 * **条目 → 磁盘绝对路径**（2026-09-21）。
 *
 * ## 它为什么存在
 *
 * 用户在中间栏**编辑**一个文件时走的是 `FileEditor`，而它全程按**绝对路径**读写
 * （`file:readFile` / `file:writeFile`）。资料库的条目只能给 **id** —— 渲染端
 * 既不知道文件在哪、也不该知道（路径由主进程按 `entry_mode` 拼，见
 * `entryRootAbsPath`）。
 *
 * 所以中间加这一跳：**拿 id 换路径**，再把那个路径交给 `FileEditor`。
 *
 * ## 和 `revealFile` / `openFile` 的区别
 *
 * 那两条是"**让系统去开**"（文件管理器 / 默认程序），返回 `{ ok }` 就完了 ——
 * 路径从头到尾不出主进程。这一条**把路径交给渲染端**，因为它要拿去喂编辑器。
 *
 * ⚠️ **这不构成"渲染端能读任意文件"**：路径是主进程按库里的记录算出来的，
 * 渲染端只能请求**某个条目**的路径，请求不了别的。而那个路径能不能真被读写，
 * 还要再过一道 `pathGuard` 的围栏（文献库根是合法工作区根之一，
 * 见 `main/lib/pathGuard.ts`）。
 *
 * `which` 同 `revealFile`：省略 = 本体（通用条目给文件本身、论文给 PDF）。
 */
export const LibraryEntryPathSchema = LibraryRevealFileSchema;
export type LibraryEntryPathInput = z.infer<typeof LibraryEntryPathSchema>;

/** 算不出来时**逐条说清是哪一种**（没文件 / 被移走了），不合并成一句"失败"。 */
export interface LibraryEntryPathResult {
  /** 绝对路径；没有就是 null，此时 `error` 一定有话说。 */
  path: string | null;
  error?: string;
  /** 这一条**是不是目录** —— 目录在编辑器里打不开（它是"往下翻"那一层），
   *  调用方据此退回预览而不是把目录丢给 Monaco。 */
  isDir?: boolean;
}

/* ── PDF 高亮 ── */

/**
 * 读某篇 PDF 的全部高亮。
 *
 * 高亮**不存在数据库里**，存在 PDF **旁边**的 `.<名字>.mcode-highlights.json`
 * （见 `main/library/pdfHighlightsStore.ts`）：那样文件被移动/复制/同步到别的机器
 * 时批注跟着走，而项目目录里那些**根本不在资料库里**的 PDF 也能有高亮。
 * 所以这里必须按**路径**问，不能按条目 id。
 */
export const PdfHighlightsReadSchema = z.object({
  /** PDF 的绝对路径。必须落在已知工作区根内（pathGuard）。 */
  pdfPath: z.string().min(1),
});
export type PdfHighlightsReadInput = z.infer<typeof PdfHighlightsReadSchema>;

/**
 * **只写高亮索引**（PDF 旁边那份 JSON），不动 PDF 本身。
 *
 * ## 为什么和"写回文件"分成两条
 *
 * 用户定的用法是**划一下先存、写回延后**：
 *
 *  - 划一笔 → 走**这一条**。只写一个小 JSON，几毫秒，不会坏任何东西。
 *  - 攒够了 / 用户点"写回文件" → 走 `PdfHighlightsWriteBackSchema`，
 *    那一步要整个重写 PDF。
 *
 * 合成一条的话，每划一笔都要重写整篇 PDF（论文十几 MB），又慢又危险。
 */
export const PdfHighlightsSaveSchema = z.object({
  pdfPath: z.string().min(1),
  highlights: z.array(z.unknown()),
});
export type PdfHighlightsSaveInput = z.infer<typeof PdfHighlightsSaveSchema>;

/**
 * 把高亮**写回 PDF 文件本身**（真 `/Highlight` 批注，Acrobat 批注面板里看得到）。
 *
 * ## 为什么字节走 base64
 *
 * `file:writeFile` 只收 utf-8 字符串，而 PDF 是二进制。base64 是这个仓库里已有的
 * 二进制传输姿势（见 `ClipboardSaveFileSchema` 的说明）。论文常有十几 MB，
 * base64 会涨 1/3 —— 可接受：写回是**用户主动点的**低频动作，不是热路径。
 *
 * 主进程收到字节后**原子替换**（临时文件 + rename），中途崩了原文件不动。
 * 顺带把索引也更新了 —— 分两次调用会留下"文件写了、索引没写"的不一致窗口。
 */
export const PdfHighlightsWriteBackSchema = z.object({
  pdfPath: z.string().min(1),
  /** 改好的 PDF，base64（不带 `data:` 前缀）。 */
  bytesBase64: z.string().min(1),
  highlights: z.array(z.unknown()).optional(),
});
export type PdfHighlightsWriteBackInput = z.infer<typeof PdfHighlightsWriteBackSchema>;

/** 写回结果。**跳过的条目要报出来**，不能静默丢（这个仓库的硬规矩）。 */
export interface PdfHighlightsWriteResult {
  ok: boolean;
  error?: string;
  /** 写进去几条。 */
  written?: number;
  /** 被跳过的（附原因）。 */
  skipped?: Array<{ id: string; reason: string }>;
}

/**
 * 读一篇文献的 Markdown 正文(应用内预览用)。
 *
 * 为什么必须走 IPC:渲染进程**读不了本地文件**(沙箱里没有 fs)。而且 md 里的图片是
 * 相对路径 `images/xxx.jpg`(带图产物的常态),渲染端连它的父目录都不知道,只有主进程
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
 * 读**通用文件条目**的内容(统一资料库)。
 *
 * 条目是目录时:返回目录列表(`files`),`relPath` 指向目录内的某个文件再读一次。
 * 条目是文件时按扩展名分型:文本类给 `text`;图片/二进制(docx/pptx/xlsx/pdf …)
 * 给 `mime` + base64(渲染端读不了本地文件,只有主进程拿得到字节;二进制走 base64
 * 是因为这条 RPC 与逐字节大文件无关,预览的体积上限在主进程挡住)。
 */
export const LibraryReadFileSchema = z.object({
  id: z.string().min(1),
  /** 目录条目内要读的文件(相对该目录)。省略 = 读条目本体 / 列目录。 */
  relPath: z.string().optional(),
  /**
   * 读**哪一份**（2026-09-21）。
   *
   * 论文那一类记录手上不止一个文件:`pdf_path` 是原件、`md_path` 是转录。从前这里
   * 没有这一格,而主进程又只认 `file_path`,于是论文预览恒报「这条资料没有关联文件」;
   * 中间栏那条路后来接上了 `md_path`,导致点的明明是 PDF 却弹出转录。
   *
   * 省略 = **看本体**(通用条目给文件本身、论文给 PDF)。`"md"` 才是"我要看转录",
   * 由左栏右键那一项指名 —— 用户要的正是"点击和双击都显示 PDF 本身,转录另外看"。
   */
  which: z.enum(["pdf", "md"]).optional(),
});
export type LibraryReadFileInput = z.infer<typeof LibraryReadFileSchema>;

export type LibraryFileContent =
  | { type: "dir"; files: Array<{ name: string; isDir: boolean }> }
  | { type: "text"; text: string }
  | { type: "binary"; mime: string; base64: string }
  | { type: "unsupported"; error: string };

/* ── 通用文件条目(统一资料库) ── */

/** 任意文件/目录导入为库条目。mode 见 `LibraryItem.entryMode`。 */
export const LibraryImportGenericSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(200),
  mode: z.enum(["linked", "attached"]).optional(),
  collectionIds: z.array(z.string()).optional(),
});
export type LibraryImportGenericInput = z.infer<typeof LibraryImportGenericSchema>;
/**
 * 采纳一份**用户手上的** Markdown 作为这篇的转录产物。
 *
 * 为什么不复用 convert:重转一遍既费时间又未必更好,而且用户手上那份可能本就更好 ——
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

/* ── 资料库(library) ────────────────────────────────────────────────────
   领域类型见 `library.ts`;这里只放跨 IPC 的校验 schema。
   约定与既有分区一致:每个 schema 同时导出 `...Input` 类型。 */

/** 入库一条条目。`id` 由主进程生成 —— 渲染端/AI 只给标题与说明。 */
export const LibraryItemInputSchema = z.object({
  title: z.string().min(1),
  abstract: z.string().optional(),
  language: z.string().optional(),
  url: z.string().optional(),
  /** 一并归入的集合;省略则不归任何集合。 */
  collectionIds: z.array(z.string()).optional(),
});
export type LibraryItemInput = z.infer<typeof LibraryItemInputSchema>;

export const LibraryAddItemsSchema = z.object({
  items: z.array(LibraryItemInputSchema).min(1),
});
export type LibraryAddItemsInput = z.infer<typeof LibraryAddItemsSchema>;

/** 列表筛选。`collectionId` 为 null 表示全部;`collectionId` 为字符串时只列该集合。 */
export const LibraryListSchema = z.object({
  collectionId: z.string().nullable().optional(),
  /** 搜索关键词(标题/摘要/文件路径),大小写不敏感。 */
  query: z.string().optional(),
  /** 只看有 / 没有文件的条目。 */
  hasFile: z.boolean().optional(),
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
  /**
   * 用户**勾了"这个也一起删"**的那些关联目标 —— 传 `library.deletePreview` 给出的
   * `targetItemId`。
   *
   * ## 语义是「**连它一起删**」,不是「保留关联行」
   *
   * 两件事要分清,因为**只有前者做得到**:
   *
   *  - 「把这一条关联留着」 —— **做不到**。`library_item_links` 的两列都带
   *    `ON DELETE CASCADE`(见 `store/db.ts` 的建表),删掉一头那条关联行就被数据库
   *    自动带走了。而且一张只剩一头的关联本来也没有意义。
   *  - 「把**被链接的那条**也一起删掉」 —— 这才是用户要的。他的原话:「会把**你选择的
   *    文件所链接的文件**一并展示出来,由用户选择**是否连带链接文件也一起删掉**」。
   *
   * 所以这个字段是**"顺带把对面那条也删了"的名单**,而不是"保留"的名单。
   *
   * ## 为什么只收 `targetItemId`(库内),不收路径
   *
   * 库外路径的关联删掉**只是断一条记录**,用户磁盘上的文件一个字节都不动(见
   * `LibraryDeletePreviewLink` 的 `path` 那一档)。既然没有"那个文件要不要删"这个
   * 问题,它就不该出现在这份名单里 —— 界面上那一档**不给勾**。
   *
   * ⚠️ **转录产物(`form: "transcript"`)不在这里** —— 它有自己的开关
   * `keepTranscripts`(2026-09-28 起可选,见下)。
   */
  cascadeLinks: z.array(z.string().min(1)).optional(),
  /**
   * **保留转录产物**的条目名单(2026-09-28,用户:「删除不是把所有的链路上面的
   * 文件都默认删除,弹出的窗口要可以选择的」)。名单里的条目删除时**跳过**它的
   * Markdown 产物与图床(文件留在盘上,记录照删 —— 留下的是用户点名要留的文件)。
   *
   * 不传 / 空 = 旧行为(转录随条目一起删),所有既有调用方零改动。
   * 方向与 `cascadeLinks` 相反(那边是「勾了要多删的」,这边是「勾掉要保留的」):
   * 两边的**默认**都是主用例 —— 关联默认不删、转录默认删,名单只装例外。
   */
  keepTranscripts: z.array(z.string().min(1)).optional(),
});
export type LibraryDeleteItemsInput = z.infer<typeof LibraryDeleteItemsSchema>;

/**
 * 从回收站里**还原**这几条 —— 放回最后删除的那个分类(判据见
 * `main/library/trash.ts` 的 `restoredTargetOf`)。
 *
 * 单独一条 RPC 而不是复用 `assignCollection`:还原是**两个动作的合体**(放进目标分类
 * + 从回收站摘掉),少了后半步那些条目会被 `sweepToTrash` 立刻收回去,用户看到的是
 * "点了还原什么都没发生"。把那两步留给渲染端拼,迟早有人只拼一半。
 */
export const LibraryRestoreItemsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});
export type LibraryRestoreItemsInput = z.infer<typeof LibraryRestoreItemsSchema>;

/** 删除前**看一眼会带走什么** —— 与 `deleteItems` 同一批 id。 */
export const LibraryDeletePreviewSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});
export type LibraryDeletePreviewInput = z.infer<typeof LibraryDeletePreviewSchema>;

/**
 * 会**跟着一起没**的一项。
 *
 * 三档形态,因为它们"是什么"和"删掉的后果"都不同:
 *
 *   `item`       库里另一条条目(关联表里的目标)。删了它,那条记录就没了。
 *   `path`       库外的绝对路径。删掉的只是那条关联记录(库不碰用户自己的文件)。
 *   `transcript` 这条文献**自己的 Markdown 转录产物**。它和它那一包图床是**一个整体**
 *                —— md 里的 `![](images/…)` 全部指向它,只删正文会把图永远留在盘上。
 *                所以界面上它是**一个勾**,选它就是两样一起收。
 */
export interface LibraryDeletePreviewLink {
  form: "item" | "path" | "transcript";
  /** 库内条目的 id(`form: "item"`)。 */
  targetItemId?: string;
  /** 库外绝对路径(`form: "path"`)。 */
  targetPath?: string;
  /** 显示名。库内是标题、库外是文件名、转录是那份 md 的文件名。 */
  title: string;
  /** 转录那一档:这一包里**几张图**(数出来给用户看"图床"的规模)。 */
  imageCount?: number;
}

export interface LibraryDeletePreviewEntry {
  id: string;
  title: string;
  /** 除了它自己之外,会跟着没的东西(没有就是空数组,不是 undefined)。 */
  links: LibraryDeletePreviewLink[];
}

export interface LibraryDeletePreviewResult {
  entries: LibraryDeletePreviewEntry[];
}

/**
 * 一条**没能删掉**的库内文件。`library.deleteItems` 的返回里带上它。
 *
 * ## 为什么非有不可
 *
 * 那个 handler 原来返回 `{ items }`,而文件删除的失败被 `dropAbs` 里一个 try/catch
 * 吞掉了 —— catch 只有 `log.warn`,写的是 `<userData>/logs/main.log`。**用户界面上
 * 什么都看不到**:记录从列表里消失了,`<库根>/files/xxx.pptx` 却还躺在盘上,而用户
 * 再也没有任何入口能把它删掉(记录没了就够不着了)。这是库里唯一不可逆的操作,
 * 结果它同时是最不可见的那一个。
 *
 * 形状刻意与 `library.convert` 的 `failed: Array<{ id, error }>` 对齐 —— 同一个
 * 「这一次有几个没成、各自为什么」的表达,渲染端不用为它长第二套解析。
 */
export interface LibraryDeleteFailure {
  /** 哪个条目。记录是否仍在库中由 `recordRetained` 明确给出。 */
  id: string;
  /** 哪一份文件:`pdf` / `markdown` / `file`。`file` 是通用条目的 `filePath`
   *  (attached 复制进 `<库根>/files/` 的那一份;`linked` 条目也可能是它,那种情况
   *  下面 `error` 会说明那是用户自己的文件、库没动)。 */
  kind: "pdf" | "markdown" | "file";
  /** 删不掉的那个路径。落点在库里时是**绝对路径**(可以直接展示给用户看);
   *  `linked` 条目越界那一档给的是**用户自己那个绝对路径**。 */
  path: string;
  /** 原因。系统给的原因(errno 文案)或者一句说人话的"这个路径不在库里"。 */
  error: string;
  /** 文件未删后，这条记录是否仍保留在库中；UI 只能对仍保留的记录提供重试。 */
  recordRetained: boolean;
}

/**
 * 彻底删除的结果。
 *
 * ## ⚠️ `failed` 的语义是「哪一份文件没被删掉」,**不是**「哪一条没删成功」
 *
 * 这一点调用方必须知道,因为两档的记录去留不同:
 *
 *  - **文件在库里却删不掉**(`rmSync` 抛了;典型是那个位置上蹲着一个目录,Windows 上
 *    `rmSync` 不递归就直接 `EISDIR` 失败)→ **记录留着**。删掉记录却删不掉文件,用户
 *    就**再也够不着**那个文件了(界面上没有任何入口指向它)。留下记录 = 用户还能看着
 *    提示自己处理(去文件管理器里删掉,或者关掉「同时删除文件」)再试一次。
 *  - **`linked` 条目指向库外**(用户自己那个文件/目录,库只记了个路径)→ **记录照删**,
 *    而那条 `filePath` 一个字节都不动(它不归库管)。留住记录只会造成"永远删不掉的一条"。
 *    这一档报出来是**必须的**:用户点了「同时删除文件」,而文件没被删,不报就成了
 *    静默的假成功。
 *  - **坏数据**(`entryMode: "attached"` 的路径却指到库外)→ 报出来**而且记录留着**:
 *    那是记录被写坏了,证据不能连记录一起删掉。
 *
 * 所以渲染端那句提示要按语义写("有 N 个文件没能删掉"),不能写成"有 N 条没删掉" ——
 * 库外的 `linked` 那几条**记录是真的删掉了**。
 * 每个失败项都带 `recordRetained`,调用方据此刷新已完成项,并只对仍保留的记录提供重试。
 *
 * 同一次调用里**成功的那几条照样成功**,不是整批回滚:一条卡的目录不该把另外九十九条
 * 正常的删除一起拖住。
 */
export interface LibraryDeleteItemsResult {
  /** 删完之后**完整**的列表 —— 与别的变更类 handler 同一条约定。 */
  items: import("../library.js").LibraryItem[];
  /** 有哪几条的文件没删掉。全部成功时是空数组 —— **不是 undefined**,免得调用方写 `?.`。 */
  failed: LibraryDeleteFailure[];
}

/** 集合:新建。`parentId` 为 null 表示顶层。 */
export const CollectionCreateSchema = z.object({
  name: z.string().min(1),
  parentId: z.string().nullable().optional(),
  /** 建在哪个大类下。省略 = 第一个大类。 */
  groupId: z.string().optional(),
  /** 这个分类的「给 AI 的说明」。省略 = 不写。 */
  prompt: z.string().optional(),
});
export type CollectionCreateInput = z.infer<typeof CollectionCreateSchema>;

/**
 * 编辑一个分类的**属性** —— 名字与「给 AI 的说明」。至少给一样。
 *
 * 「改名」的老语义原样保留(name 传了就改);`prompt` 是统一资料库加的第二层注入
 * (类型说明之外、用户按集合写的那份)。都不传没意义,直接拒绝。
 */
export const CollectionRenameSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    /** 传空串 = 清空说明(清单里不再注入这一层)。 */
    prompt: z.string().optional(),
  })
  .refine((v) => v.name !== undefined || v.prompt !== undefined, {
    message: "名字和说明至少要改一样",
  });
export type CollectionRenameInput = z.infer<typeof CollectionRenameSchema>;

export const CollectionDeleteSchema = z.object({ id: z.string().min(1) });
export type CollectionDeleteInput = z.infer<typeof CollectionDeleteSchema>;

/**
 * 把一个集合**移到另一个父下面**(改父级)。
 *
 * ## 为什么和 `CollectionRenameSchema` 分开
 *
 * 改名改的是**属性**,移动改的是**在树里的位置** —— 两者的校验完全不是一回事:
 * 改名只要判重名,移动要判**环**。合成一条的话,只想改名的人被迫走一遍环校验,
 * 而环校验要读整张父链表,代价不该花在那条路上。
 *
 * ## `parentId` 为什么必须有三种含义,不能只用一个 string|null
 *
 * 这是本 schema 唯一别扭的地方,但少了它界面就没法表达"移到最外层":
 *
 *   - **不传**(undefined)—— 父级不动(目前界面用不到,留给将来的同级拖动);
 *   - **传 null** —— 移到**最外层**(成为根集合);
 *   - **传 id** —— 移到那个集合下面。
 *
 * 用 `optional().nullable()` 而不是给个 `null` 就够,是因为 `z.string().nullable()`
 * 会逼着"父级不动"也传一个值 —— 而那时调用方手上根本没有它想表达的那个值。
 *
 * ## 为什么**没有** `index`(同级落点)
 *
 * 第一版有一个 `index`,写完发现它的语义是个陷阱:下标算的是"**除自己之外**的兄弟
 * 列表里的位置"。跨父移动时它通顺,而在**同一层内**挪次序时,把某一条算进去/算出来
 * 的下标会差一位 —— 参数照字面实现对不上界面意图,而这种错**不报错**,只是东西落错
 * 地方。既然界面现在并不需要它(树上的"移"是跨父的),就砍掉,而不是留一个半对的旋钮。
 * 将来做同级拖动时再加,那时**它要带上"包不包括自己"的明确说法**。
 *
 * 环的判定在**主进程**(要读库里那张父链表,见 `CollectionRepo.move`);契约这一层
 * 只保证形状 —— 这里查不了环,它没有 DB。
 */
export const CollectionMoveSchema = z.object({
  id: z.string().min(1),
  /** 新的父集合。不传 = 父级不动;null = 移到最外层。 */
  parentId: z.string().min(1).nullable().optional(),
});
export type CollectionMoveInput = z.infer<typeof CollectionMoveSchema>;

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
  /** 这条附件是哪个库的。独立模版库退役(2026-09-27)后只剩 `library` 一种 ——
   *  字段留着是为了消息形状稳定(渲染端按它分发)。 */
  kind: "library";
  /** 附件键,与用户自己挂的同一套:`c:<分类 id>` / `i:<条目 id>` / `k:<库>`(整个库)。 */
  key: string;
  /** chip 上显示的短名。 */
  name: string;
  /** 主进程生成的清单绝对路径;渲染端把它包成 `@<路径>` 作为 tag 的 content。 */
  manifestPath: string;
}

