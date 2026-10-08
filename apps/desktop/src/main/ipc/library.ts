/**
 * 文献库 IPC。
 *
 * 职责:把契约层收到的请求翻译成仓储 / 检索 / 下载管道的调用。业务逻辑都在
 * `main/library/` 下,这里只做参数校验、编排与结果整形。
 *
 * 两条既定约定:
 *   - 每个入参都走 `Schema.parse`(契约即安全边界);
 *   - **变更类 handler 返回新的完整列表**,渲染端整体替换缓存。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { shell, type IpcMain } from "electron";
import {
  IPC,
  LibraryAddItemsSchema,
  LibraryDeleteItemsSchema,
  LibraryDeletePreviewSchema,
  LibraryRestoreItemsSchema,
  LibraryFullTextSearchSchema,
  LibraryImportFilesSchema,
  LibraryImportNotesSchema,
  LibraryConvertSchema,
  LibraryRevealFileSchema,
  LibraryOpenFileSchema,
  LibraryEntryPathSchema,
  PdfHighlightsReadSchema,
  PdfHighlightsSaveSchema,
  PdfHighlightsWriteBackSchema,
  LibraryReadMarkdownSchema,
  LibraryReadPdfSchema,
  LibraryAdoptMarkdownSchema,
  LibraryCreateNoteSchema,
  LibraryWriteNoteSchema,
  LibraryNotesListSchema,
  LibraryNoteSaveSchema,
  LibraryNoteDeleteSchema,
  LibraryRenameItemSchema,
  LibraryItemIdSchema,
  LibraryListSchema,
  LibraryAttachToChatSchema,
  LibraryGroupsGetSchema,
  LibraryGroupsSaveSchema,
  LibrarySuppressGetSchema,
  LibrarySuppressSaveSchema,
  LibraryLinksOfSchema,
  LibraryLinkCountsSchema,
  LibraryLinkAddSchema,
  LibraryLinkRemoveSchema,
  LibraryImportGenericSchema,
  LibraryReadFileSchema,
  LibraryManifestSchema,
  LibraryItemManifestSchema,
  CollectionAssignSchema,
  CollectionCreateSchema,
  CollectionDeleteSchema,
  CollectionMoveSchema,
  CollectionRenameSchema,
} from "@contracts/ipc";
import type { FullTextMatch, LibraryCollection, LibraryItem, PdfHighlight } from "@contracts/library";
// 删除的失败清单 —— 类型与它的上游 schema 住在同一处(`@contracts/ipc/library.ts`)。
import type {
  LibraryDeleteFailure,
  LibraryDeleteItemsResult,
  LibraryDeletePreviewEntry,
  LibraryDeletePreviewLink,
  LibraryDeletePreviewResult,
} from "@contracts/ipc";
import { LibraryRepo, CollectionRepo, LibraryLinkRepo, NoteRepo } from "@main/store/repositories.js";
import { awaitDb } from "@main/store/db.js";
import { rgGrep } from "@main/lib/rgSearch.js";
import { log } from "@main/lib/logger.js";
import { createNote, importNoteFiles, writeNote } from "@main/library/notesImport.js";
import { convertItemToMarkdown, conversionReport, repairCollectionMarkdown } from "@main/library/convert.js";
import { readMarkdownForPreview } from "@main/library/markdownPreview.js";
import { readPdfBytes } from "@main/library/pdfRead.js";
import { adoptMarkdownFile } from "@main/library/adoptMarkdown.js";
import { openDirectory } from "@main/lib/reveal.js";
import {
  sweepToTrash,
  shouldSweepAfterRemoval,
  ensureTrashCollection,
  markTrashCollections,
  restoredTargetOf,
  restoreItemsFromTrash,
} from "@main/library/trash.js";
import { notifyLibraryChanged, emitItemImported } from "@main/library/broadcast.js";
import { loadLibraryGroups, saveLibraryGroups } from "@main/library/groupRegistry.js";
import { loadSuppress, saveSuppress, suppressionReasonOfItem } from "@main/library/suppress.js";
import { entryRootAbsPath, importGenericFiles, readEntryFile } from "@main/library/fileImport.js";
import { importAnyFiles } from "@main/library/importDispatch.js";
import {
  ensureOriginal,
  hasOriginal,
  highlightsPathFor,
  originalPathFor,
  readHighlights,
  writeHighlights,
} from "@main/library/pdfHighlightsStore.js";
import { findContainingWorkspaceRoot } from "@main/lib/pathGuard.js";
import { assignToCollection, assignImportedToCollections } from "@main/library/operations.js";
import {
  attachToChat,
  writeCollectionManifest,
  writeItemManifest,
} from "@main/library/manifest.js";
import { ensureLibraryDirs, libraryRoot, fromLibraryRelative, toLibraryRelative, isInsideLibrary, markdownArtifact, markdownArtifactsOfItem, countImageFiles } from "@main/library/paths.js";
import { ensureWorkflows } from "@main/workflows/seed.js";

/**
 * 返回给渲染端的分类列表 —— **必须走这里**,不要直接 `CollectionRepo.list()`。
 *
 * 「谁是回收站」不由数据库列决定(用户自己建一个叫「回收站」的分类,它就是回收站),
 * 所以要在这一层标上。漏标的话界面上的 `isTrash` 永远是 false,而回收站里的
 * 「从当前文献库移除」会退回成原来那个行为:把条目摘出回收站、却没删掉它 ——
 * 条目从此既不在回收站里、也没被删,变成界面上找不回来的僵尸记录。
 */
function collectionsForRenderer(): LibraryCollection[] {
  return markTrashCollections(CollectionRepo.list());
}

/** 记录当前正在进行的全文检索,避免用户狂敲输入框时打出并发风暴。 */
let fullTextSearchSeq = 0;

export function registerLibraryHandlers(ipcMain: IpcMain): void {
  // 启动时就把库的骨架目录建出来(papers / markdown / notes / collections /
  // exports / tmp)。**设置页会把它们画成一棵树**,用户照着去找却扑空的话,会以为
  // 坏了 —— 模版库当初就是这么踩的(见 templates/store.ts 的 ensureTemplateDirs)。
  // 这里不碰数据库,只是 mkdir,所以放在注册阶段是安全的。
  ensureLibraryDirs();

  // 工作模式用的流程脚本(<数据根>/workflows/scripts/)同样在启动时落地。
  // 系统提示词里会把这些脚本的**绝对路径**告诉模型,所以它们必须在模型第一次需要
  // 之前就存在 —— 放在这里和库骨架一起建,是最早的、且一定能跑到的时机。
  ensureWorkflows();

  // 「回收站」分类也在启动时建好 —— **全库共用一个**(2026-09-20 改;原来是三个库
  // 各一个)。用户的要求是「共用一个,放在最下面固定住」,所以它是整片资料库区域的
  // 一个,而不是每段的尾巴。
  //
  // 用户能看到它随时在、也能自己往里拖东西:回收站原本是"第一次有东西掉进去"时
  // 才懒创建的,所以新装的库里根本看不到它。
  //
  // `ensureTrashCollection` 顺手把老数据里那几个(每库一个)合并过来 —— 不合并的话
  // 界面上只画一个,另一个里面的东西就再也够不着了(见那个函数的注释)。
  //
  // 走 awaitDb():这个函数在数据库就绪**之前**就会跑(handler 注册阶段),直接读库
  // 会抛。所以挂到 ready promise 上,失败也不阻断启动 —— 回收站晚一点建出来不是大事。
  void awaitDb()
    .then(() => {
      ensureTrashCollection();
    })
    .catch((err: unknown) => log.warn(`trash: ensure failed: ${(err as Error).message}`));

  /* ─────────────────────────── 条目 ─────────────────────────── */

  ipcMain.handle(IPC.LIBRARY_LIST, async (_evt, raw) => {
    const input = LibraryListSchema.parse(raw ?? {});
    return LibraryRepo.list({
      collectionId: input.collectionId ?? undefined,
      query: input.query,
      hasFile: input.hasFile,
      limit: input.limit,
      offset: input.offset,
    });
  });

  ipcMain.handle(IPC.LIBRARY_GET, async (_evt, raw) => {
    const input = LibraryItemIdSchema.parse(raw);
    return { item: LibraryRepo.get(input.id) };
  });

  /**
   * 入库(只建记录,不带文件)。给 AI / 界面一个"先记一条、文件以后再挂"的口子。
   *
   * 每一条都发 `library.item.imported` 事件 —— 它是无人值守那条链的起点
   * (自动化的「事件发生时」触发器),和本地文件导入那条路(`pdfImport.ts`)同一个信号。
   */
  ipcMain.handle(IPC.LIBRARY_ADD_ITEMS, async (_evt, raw) => {
    const input = LibraryAddItemsSchema.parse(raw);
    const items: LibraryItem[] = [];
    for (const entry of input.items) {
      const item = LibraryRepo.upsert({
        title: entry.title,
        abstract: entry.abstract,
        language: entry.language,
        url: entry.url,
      });
      // 归属走导入统一的那道门:失效的分类 id **跳过**而不是抛。裸调
      // `CollectionRepo.assign` 会撞外键(FOREIGN KEY constraint failed)直接把
      // handler 炸掉 —— 而此刻条目已经 upsert 进库,调用方收到的是报错、库里却
      // 多了半截条目。顺带获得与文件导入一致的"归类时从回收站摘出来"语义。
      assignImportedToCollections(item.id, entry.collectionIds);
      items.push(item);
      emitItemImported(item);
    }
    // 用户自己加完也要广播:右栏那一屏是它自己的 state,不重拉就一直停在旧列表上
    // (与 AI 走 MCP 工具加的那条路共用同一条广播,见 library/broadcast.ts)
    notifyLibraryChanged(`add:${items.length}`);
    return { items };
  });

  /** 编排在下面 `deleteItemsCore`(那段有三块长说明,放这儿会把注册段撑散)。 */
  ipcMain.handle(IPC.LIBRARY_DELETE_ITEMS, async (_evt, raw) => {
    const input = LibraryDeleteItemsSchema.parse(raw);
    return deleteItemsCore(input.ids, !!input.deleteFiles, input.cascadeLinks, input.keepTranscripts);
  });

  /**
   * 从回收站里**还原** —— 放回最后删除的那个分类。
   *
   * 与 `deleteItems` 是一对,但语义完全相反:那条把东西真的抹掉,这条把它们捞回来。
   * 走 `restoreItemsFromTrash`(放回目标分类 + 从回收站摘掉,两件事必须一起做,
   * 否则它们会被 `sweepToTrash` 立刻收回去 —— 用户看到的是"点了还原什么都没发生")。
   */
  ipcMain.handle(IPC.LIBRARY_RESTORE_ITEMS, async (_evt, raw) => {
    const input = LibraryRestoreItemsSchema.parse(raw);
    const moved = restoreItemsFromTrash(input.ids);
    if (moved.length > 0) notifyLibraryChanged(`restore:${moved.length}`);
    // **全量,不是 `list({})`。** 那个有 200 条的默认上限 —— 大库上"完整列表"会被
    // 静默截断成 200 条,渲染端拿它直接替换本地列表,于是超过 200 条的那些从界面上
    // **凭空消失**(而库里一条没少)。`listAllItems` 正是为这种"必须是全量"的场合留的。
    return { items: LibraryRepo.listAllItems() };
  });

  /** 预览的编排在下面 `deletePreviewCore`。 */
  ipcMain.handle(IPC.LIBRARY_DELETE_PREVIEW, async (_evt, raw) => {
    const input = LibraryDeletePreviewSchema.parse(raw);
    return deletePreviewCore(input.ids);
  });

  /**
   * **彻底删除**:数据库行 + 磁盘上的 PDF / Markdown / 通用文件副本。
   *
   * 这是库里唯一不可逆的操作(回收站只是"不属于任何分类",记录和文件都还在)。
   *
   * ## 文件删除为什么要在这里手写
   *
   * `LibraryRepo.delete` 刻意不碰文件系统(见它的注释),所以编排落在这一层。而且
   * 有三件事非处理不可 —— 它们都是"界面上删干净了、磁盘上却留着垃圾"的来源:
   *
   * ① **同一个文件可能被别的条目指着。** PDF 按内容哈希寻址,同一篇先用 DOI 导、
   *    又用 arXiv ID 导了一次,就是两条记录指向同一个路径。删之前先看还有没有幸存
   *    者指着它,有就一个字节都不动。
   * ② **带图的产物是一整个目录**(`full.md` 加 `images/`)。只删 `full.md` 会把
   *    几十张配图整包留在磁盘上,而且再也认不出是谁的。所以 md 落在
   *    `markdown/<2>/<2>/<sha>/` 或 `markdown/imported/<id>/` 里时,删的是那个目录。
   *    (软件自己只产平的那种;这两种目录形态分别来自遗留数据和外部工具转完挂回来的。)
   * ③ **通用条目的 `filePath`**(2026-09-20 补上的一支)。attached 的副本落在
   *    `<库根>/files/<条目 id>-<原名>`,而这一支早先**整个漏掉了** —— 删一条只有
   *    `filePath` 的条目(ppt / word / 随便什么文件)时下面那个 `if (!mdRel …) continue`
   *    直接跳过,数据库行没了、文件永远躺在盘上。
   *
   * ## `filePath` 与另外两列的**两处不同**,都不是细节
   *
   * 1. **它可能是库外的路径。** `linked` 条目的语义就是"只记路径、文件原地不动,
   *    而且可以是目录"(用户自己那套模版)。那些**一个字都不该动** —— 所以
   *    `isInsideLibrary` 这道守卫在这一支上是救命的,不是防御性代码。库外的路径
   *    会走成一条 **失败**(见下),而不是静默略过:静默略过正是这个套件要根治的形状。
   * 2. **它永远不递归删。** attached 的副本按构造就是一个**平文件**(`copyFileSync`
   *    进扁平 + 条目 id 前缀的 `files/`),所以"不递归"是对的。反过来说,**绝不能
   *    默认递归**:记录里的路径是可以被写坏的,`file_path = "files"` 那样一条脏数据
   *    配上一个"是目录就递归"的判据,就会把整个 `files/` 目录端掉 —— 那是所有附件
   *    副本。宁可删不掉、如实报出来。这一条与 `markdownArtifact` 里"认不出来只删
   *    文件"是同一条原则(猜错的两种后果不对称)。
   *
   * ## 删不掉的时候:如实报出来 —— 记录留不留,按记录本身该不该留来分
   *
   * `failed` 的语义是**"哪一份文件没被删掉"**,不是"哪一条没删成功"。所以**大多数**
   * 失败里那条记录会**整条回滚**:删掉记录却删不掉文件,用户就**再也够不着**那个文件
   * 了 —— 界面上没有任何入口指向它。记录留着、文件留着,用户看着提示自己处理(去文件
   * 管理器里删掉,或者关掉「同时删除文件」)再试一次。
   *
   * 唯一**不留记录**的是库外的 `linked` 条目:它本来就是"文件在库外、库只记了个路径",
   * 用户点「彻底删除」要的就是把记录清掉,而那份原件一个字节都不该动(它也不归库管)
   * —— 留住记录只会造成"永远删不掉的一条"。对应的坏数据(`attached` 的路径指到库外)
   * 反过来**要留**:那是记录被写坏了,证据不能连记录一起删掉。
   *
   * 同一次调用里**成功的那几条照样成功** —— 一条卡的目录不该把另外九十九条拖住。
   */
function deleteItemsCore(
  ids: string[],
  deleteFiles: boolean,
  /** 用户勾了「**这个也一起删**」的那些（`library.deletePreview` 给出的
   *  `targetItemId`）。它们并进这一批，走同一套文件清理与失败回报。
   *  见下面那一段 —— 语义是"连对面那条也删"，不是"保留关联行"。 */
  cascadeLinks?: string[],
  /** 名单里的条目**保留**转录产物(md + 图床留盘,记录照删)。见契约注释。 */
  keepTranscripts?: string[],
): LibraryDeleteItemsResult {
    /**
     * **用户勾了「这个也一起删」的那些**，并进这一批。
     *
     * ## 语义（别和"保留关联"搞混）
     *
     * 用户的原话：「如果删 A 的话会有一个列表显示当前 A 链接的文件，**可以选择性的
     * 删或者不删**」。勾 = **把被链接的那条也删掉**。
     *
     * ⚠️ 「**保留**某条关联」这件事**做不到**，所以别往那个方向改：
     * `library_item_links` 的两列都带 `ON DELETE CASCADE`（见 `store/db.ts` 建表），
     * 删掉一头那条关联行就被数据库自动带走了，只剩一头的关联也没有意义。
     * 一开始我按"保留"写，测试红了才发现方向反了。
     *
     * ## 为什么在这里就并进来
     *
     * 下面**三处**都按同一个名单跑：文件清理（`pathRefCounts` 的引用计数 + 逐个
     * `dropAbs`）、记录删除、失败回报。只在最后一步并的话，勾了的那条**记录没了、
     * 磁盘文件还在** —— 一条断言就是这么红的。
     */
    const cascade = (cascadeLinks ?? []).filter((x): x is string => typeof x === "string" && x.length > 0);
    const keepTranscript = new Set((keepTranscripts ?? []).filter((x) => typeof x === "string" && x.length > 0));
    /** 这一批真正要动的（用户点名的 + 他勾了要一起删的）。 */
    const allIds = [...new Set([...ids, ...cascade])];

    /**
     * 没能删掉的那些:条目 id → 失败详情。既用来回给调用方,也用来决定**哪几条记录
     * 不许删**(下面 `LibraryRepo.delete` 拿的是过滤后的名单)。
     */
    const failures: LibraryDeleteFailure[] = [];
    /** 这一批里**不许删记录**的 id(文件没删掉的那几条)。 */
    const keepIds = new Set<string>();

    if (deleteFiles) {
      // 先删文件再删记录:反过来的话拿不到路径了
      /**
       * 库内每个路径被多少条记录引用着(pdf / md / 通用文件三列都算)。
       * **不能拿 `LibraryRepo.list({})` 来数** —— 那个有 200 条的默认上限,大库上会
       * 漏判,而漏判的后果是删掉另一条记录的 PDF。
       */
      const refs = LibraryRepo.pathRefCounts();
      /** 这几条**自己**占的引用数。减掉它剩下的才是"别人还在用"。 */
      const own = new Map<string, number>();
      const bumpOwn = (p: string | undefined) => {
        if (p) own.set(p, (own.get(p) ?? 0) + 1);
      };
      for (const id of allIds) {
        const it = LibraryRepo.get(id);
        if (!it) continue;
        bumpOwn(it.pdfPath);
        bumpOwn(it.mdPath);
        // ⚠️ 通用文件那一列也进引用表。少了它,两条记录指着同一份副本时删除方会以为
        // 自己是唯一引用者,把文件端走 —— 而另一条记录还在库里,从此指向一个不存在的
        // 文件。(`linked` 的库外路径同样要进:那种一个字节都不该动,理由见下。)
        bumpOwn(it.filePath);
      }
      /** 还有别的记录指着它 → 一个字节都不许动。 */
      const sharedWithSurvivor = (p: string) =>
        (refs.get(p) ?? 0) - (own.get(p) ?? 0) > 0;

      /**
       * 记一条失败。
       *
       * `keepRecord` 决定这条记录**要不要留下** —— 它不是"严不严重",而是
       * "记录本身是不是该留着"的依据,两档的语义不同:
       *
       *  - **文件在库里却删不掉**(`rmSync` 抛了)→ 留下记录。删掉记录却删不掉文件,
       *    用户就再也够不着那个文件了(界面上没有任何入口指向它);
       *  - **`linked` 条目指向库外** → 记录照删。那种条目的语义本来就是"文件在库外、
       *    库只记了个路径",用户点「彻底删除」要的就是把这条记录清掉,而那份原件
       *    一个字节都不该动(它本来也不归库管)—— 记录留着反而删不掉了。
       *
       * 唯一"不值得客气"的一档是**坏数据**:`attached` 的路径指到了库外。那种连
       * `linked` 都算不上的记录留着没有意义,而且它就是库该清掉的东西。
       */
      const recordFailure = (
        id: string,
        kind: LibraryDeleteFailure["kind"],
        path: string,
        error: string,
        keepRecord: boolean,
      ): void => {
        failures.push({ id, kind, path, error, recordRetained: keepRecord });
        if (keepRecord) keepIds.add(id);
      };

      /**
       * 删一个库内路径。**删掉了 / 本来就不在** → true;删不掉 → 记一条失败并给 false。
       *
       * **只删库内路径** —— 记录万一被写入过外来路径(或者 `linked` 条目本来就是指着
       * 用户自己文件的),这里会把它挡掉,而不是照着删用户别处的文件。`recursive` 给
       * "整包是一个目录"的 md 产物用(见 {@link markdownArtifact});通用文件那一支
       * 一律不走它,理由见 handler 的头注释。
       *
       * 判据是 {@link isInsideLibrary},**不是** `toLibraryRelative(abs).startsWith("..")`
       * —— 那个条件恒假,一次都没拦住过(见 `paths.ts` 里 `toLibraryRelative` 的注释)。
       *
       * ⚠️ **失败不许静默跳过。** 原来整个函数包在 try/catch 里、catch 只 `log.warn`
       * (那写的是 `<userData>/logs/main.log`),而 `!isInsideLibrary` 那一档直接
       * return —— 用户在界面上什么都看不到,却有文件永远赖在盘上。现在两档都进
       * `failures`,由 handler 回给调用方。
       */
      const dropAbs = (
        id: string,
        kind: LibraryDeleteFailure["kind"],
        abs: string,
        recursive: boolean,
        /**
         * 库外路径时**要不要留记录**。默认留(`pdf` / `markdown` 那两档一旦越界就是
         * 记录被写坏了);通用文件那一支另说 —— 见它的调用点。
         */
        keepRecordOnOutside = true,
      ): boolean => {
        if (!isInsideLibrary(abs)) {
          // 库外路径**不是"失败了要重试"**,是"这一份不该由库来删"。但它仍然要说出来:
          // 用户点了「同时删除文件」,而这份文件没有被删 —— 一声不响的话他以为删干净了,
          // 或者反过来以为软件坏了。
          recordFailure(
            id,
            kind,
            abs,
            "这个路径不在资料库目录里,所以没有删(它指向的是你自己的文件)",
            keepRecordOnOutside,
          );
          return false;
        }
        if (!existsSync(abs)) return true; // 本来就不在 —— 没什么可删的,也不算失败
        try {
          rmSync(abs, { force: true, recursive });
          return true;
        } catch (err) {
          log.warn(`library delete ${kind} failed (${abs}): ${(err as Error).message}`);
          recordFailure(id, kind, abs, (err as Error).message, true);
          return false;
        }
      };

      for (const id of allIds) {
        const item = LibraryRepo.get(id);
        if (!item) continue;

        if (item.pdfPath && !sharedWithSurvivor(item.pdfPath)) {
          const pdfAbs = fromLibraryRelative(item.pdfPath);
          dropAbs(id, "pdf", pdfAbs, false);
          // **PDF 旁边的两份 sidecar 跟着本体一起走。** 一条 PDF 条目在盘上不止一个文件:
          //   - `.<名字>.mcode-highlights.json` —— 批注索引(`pdfHighlightsStore.ts` 的"事实来源");
          //   - `.<名字>.mcode-original.pdf` —— **干净底稿**,第一次"烤进 PDF"前存的一份
          //     **整份 PDF 拷贝**。
          // 它们由高亮 handler 创建,而在这次修复之前**全仓没有任何一处删过它们**(只有创建/
          // 读取)。硬删一篇划过批注的 PDF,本体没了、两份 sidecar 留在 `papers/<ab>/<cd>/` 下,
          // 其中底稿是**与 PDF 等大**的拷贝 —— 而 `papers/` 用户根本不翻,谁都看不见。
          //
          // 只在**本体真的要被删**时删(上面那道 `sharedWithSurvivor`)。sidecar 属于那个 PDF
          // 文件本身,不属于某一条记录:同 sha 的 PDF 还有别的条目指着时,它连同批注一起留着。
          // `kind` 用 "pdf"(它们是这个 PDF 的footprint,契约只认 pdf/markdown/file 三档)。
          for (const sidecar of [highlightsPathFor(pdfAbs), originalPathFor(pdfAbs)]) {
            dropAbs(id, "pdf", sidecar, false);
          }
        }

        // 一份 md 产物可能是一整个目录(外部工具转的 / 「采纳 Markdown」,里面还有 images/)。
        // 该删哪个由 `markdownArtifact` 按**落点结构**决定 —— 早先这里按"父目录名像不像
        // 一个 sha256"猜,猜不中「采纳」那一种,于是它的 images/ 永远留在磁盘上。
        //
        // ⚠️ **和 `deletePreviewCore` 用同一张清单**(M34 的复核请求):预览按
        // `markdownArtifactsOfItem` 把"按 PDF sha 派生的旧平转录 / 旧整包"也列进「会一起删」,
        // 而这里原先只删 `mdPath` 指的那一份 —— 用户勾了、界面说删了,旧产物却还躺在盘上。
        // 守卫分两档:`mdPath` 那一份看 mdPath 的引用计数;sha 派生的那几份看 **PDF 本体**
        // 是否还有别的记录指着(同 sha 的 PDF 只有一份,幸存者还在就一个字节都不动)。
        const mdOwn = item.mdPath ? markdownArtifact(fromLibraryRelative(item.mdPath)).path : null;
        const pdfShared = item.pdfPath ? sharedWithSurvivor(item.pdfPath) : false;
        // 用户点名保留这条的转录(keepTranscripts):整段跳过 —— md + 图床留在盘上。
        // ⚠️ 只对**真有转录**的条目生效(有原件才算转录;与 deletePreviewCore 同一
        // 条件):纯 md 笔记的 mdPath 是正文本体,预览那头不给勾,这里也不认名单 ——
        // 否则调用方塞个 id 就能把笔记正文留成没有记录指着的孤儿文件。
        for (const artifact of keepTranscript.has(id) && hasConvertibleOriginal(item) ? [] : markdownArtifactsOfItem(item)) {
          const isMdOwn = artifact.path === mdOwn;
          if (isMdOwn) {
            if (!item.mdPath || sharedWithSurvivor(item.mdPath)) continue;
          } else if (pdfShared || sharedWithSurvivor(toLibraryRelative(artifact.path))) {
            continue;
          }
          dropAbs(id, "markdown", artifact.path, artifact.recursive);
        }

        const fileRel = item.filePath;
        if (fileRel && !sharedWithSurvivor(fileRel)) {
          // 两档路径各按自己的语义还原成绝对路径:`linked` 存的就是**用户给的那个绝对
          // 路径原样**,attached 存的是**相对库根**的(见 `fileImport.ts` 的 toRel)。
          // 混用会把 attached 的 `files/xxx` 解析成相对 cwd 的路径 —— 那种路径既不在
          // 库里(被守卫挡下),也就永远删不掉。
          const linked = item.entryMode === "linked";
          // ⚠️ 永远 `recursive: false`(理由见 handler 头注释):attached 的副本按构造
          // 就是平文件,而"是目录就递归"配上一条被写坏的记录会把整个 `files/` 端掉。
          // 目录真的落在那个位置上时 `rmSync` 会抛 EISDIR —— 那会**如实报成失败**,
          // 记录也留着,用户看得见、也还够得着。
          dropAbs(
            id,
            "file",
            linked ? fileRel : fromLibraryRelative(fileRel),
            false,
            // 库外的 `linked` 条目:报出来,但**记录照删**(那种条目的文件和库无关,
            // 留住记录就成了"永远删不掉的一条")。除它之外都留:越界的 `pdf` / `markdown`
            // 是记录被写坏了,证据得留着;`rmSync` 抛了的那种更是必须留。
            !linked,
          );
        }
      }
    }

    // 文件没删掉的那几条**记录也不删** —— 删了用户就再也够不着那个文件了。
    const toDelete = allIds.filter((id) => !keepIds.has(id));

    LibraryRepo.delete(toDelete);
    // 删掉的可能正是右栏正在看的那一篇 —— 广播出去,右栏自己会清掉悬空的选中态。
    // 一条都没删成时不广播:那是一次什么都没发生的调用,没必要惊动界面重拉。
    if (toDelete.length > 0) notifyLibraryChanged(`delete:${toDelete.length}`);
    // **全量**(不是 `list({})` —— 它有 200 条上限,大库上"完整列表"被截断,渲染端拿
    // 它替换本地列表会让第 200 条之后的条目凭空消失)。与 `restoreItems` 同一条口径。
    return { items: LibraryRepo.listAllItems(), failed: failures };
}

/**
 * 删除**之前**看一眼:这一批会带走什么。
   *
   * ## 为什么要有这一条
   *
   * 用户的原话:「删除的时候会把当前要删除的文档所链接的其他文献也展示出来,可以选择性
   * 的把连接的文档也删除,尤其是对于转录成 md 的文档…这个链接是 md 和图床一起的,要删
   * 都一起删掉,可以批量删除,批量删除的时候会有个浮窗展示当前的链接情况,每个文档都能
   * 选择」。
   *
   * 所以弹窗要画的是"每个文档一组勾选",而**只读查询**先行:用户点取消时不希望库里
   * 有任何东西被动过。
   *
   * ## `deleteFiles: false` 时这一条不适用
   *
   * 只删记录(不动磁盘)时不展示转录那一项 —— 那时候 `！[](images/…)` 还指着盘上还在的
   * 文件,把 md 列进去说"会一起删"是假话。界面按同一个开关决定要不要问。
   */
/**
 * 高亮读写的路径围栏(OBS-M35-02)。
 *
 * 原来只认 `findContainingWorkspaceRoot`(项目根 / worktree / 用户文档根)。**已入库的
 * linked PDF** 恰恰常在这些根之外(用户从别处关联进来的),于是它能预览却"这个位置不允许
 * 写入"。补两档:库根之内;或**正是某条记录登记的路径**(`pathRefCounts` 的键就是三列
 * 的原值 —— linked 存绝对路径)。不放开任意路径:未入库又不在根内的仍被拒。
 */
function highlightPathAllowed(pdfPath: string): boolean {
  if (findContainingWorkspaceRoot(pdfPath)) return true;
  if (isInsideLibrary(pdfPath)) return true;
  const refs = LibraryRepo.pathRefCounts();
  if (refs.has(pdfPath)) return true;
  const rel = toLibraryRelative(pdfPath);
  return refs.has(rel);
}

/**
 * 这条的 md 算不算**转录产物**(2026-09-28,两次收紧):
 *
 *   ① 纯 md 笔记(只有 mdPath)—— md 是正文本体,不是转录;
 *   ② 导入的 .md(filePath 本身就是 markdown 家族)—— 同上,没有发生过\"转换\",
 *     mdPath 只是正文(用户:「转录只有 pdf、word 这种才转录呀」)。
 *
 * 判定 = 有 **可转换的原件**:pdfPath,或扩展名不属于 markdown 家族的 filePath。
 * `deletePreviewCore`(列不列「转录产物」档)与 `deleteItemsCore`(认不认
 * keepTranscripts 名单)**必须用同一个判定** —— 分家就会出现\"预览不给勾、
 * 删除却认名单\"这种把正文留成孤儿文件的缝。
 */
const MARKDOWN_FAMILY = /\.(md|markdown|mdown|mdwn|mkd|mkdn|mdtxt|mdtext)$/i;
function hasConvertibleOriginal(item: { pdfPath?: string; filePath?: string }): boolean {
  if (item.pdfPath) return true;
  return !!item.filePath && !MARKDOWN_FAMILY.test(item.filePath);
}

function deletePreviewCore(ids: string[]): LibraryDeletePreviewResult {
  const entries: LibraryDeletePreviewEntry[] = [];
  const inBatch = new Set(ids);
  const linksOfBatch = LibraryLinkRepo.viewsOfMany(ids);
  for (const id of ids) {
    const item = LibraryRepo.get(id);
    if (!item) continue;
    const links: LibraryDeletePreviewLink[] = [];

    // ① 关联表里的东西 —— 有几行就报几行。批量删的时候 A→B 而 B 也在这一批里,
    //    B 本来就要没了,再列一次只会让用户以为漏了一条。
    for (const view of linksOfBatch[id] ?? []) {
      if (view.otherItemId) {
        if (inBatch.has(view.otherItemId)) continue;
        links.push({ form: "item", targetItemId: view.otherItemId, title: view.title });
        continue;
      }
      if (view.otherPath) {
        links.push({ form: "path", targetPath: view.otherPath, title: view.title });
      }
    }

    // ② 这份文献自己的 Markdown 转录产物。**md 和它那一包图床是一个整体**
    //    (用户原话「这个链接是 md 和图床一起的,要删都一起删掉」),所以界面上它是
    //    一个勾。`md_path` 只有一个值,而盘上可能有**两版**(先本地转一版、后来采纳
    //    一版),两版都列出来 —— 见 `markdownArtifactsOfItem`。
    //
    //    ⚠️ **只报真在盘上的**。删除那一步本来就不把"不在"当失败(`dropAbs` 里
    //    `!existsSync` 直接算成功),把一条不存在的产物列进"会一起删"的清单里,
    //    用户勾了它会以为自己删掉了什么 —— 那是假话。
    //
    //    ⚠️ 纯 md 笔记 / 导入的 .md 不进这一档(md 即正文;见 hasConvertibleOriginal)。
    for (const artifact of hasConvertibleOriginal(item) ? markdownArtifactsOfItem(item) : []) {
      if (!existsSync(artifact.path)) continue;
      const images = artifact.recursive ? countImageFiles(artifact.path) : 0;
      links.push({
        form: "transcript",
        title: basename(artifact.path),
        ...(images > 0 ? { imageCount: images } : {}),
      });
    }

    entries.push({ id, title: item.title, links });
  }
  return { entries };
}

  /* ─────────────────────────── 集合 ─────────────────────────── */

  ipcMain.handle(IPC.LIBRARY_LIST_COLLECTIONS, async () => ({ collections: collectionsForRenderer() }));

  ipcMain.handle(IPC.LIBRARY_CREATE_COLLECTION, async (_evt, raw) => {
    const input = CollectionCreateSchema.parse(raw);
    // 契约允许省略 groupId（默认为第一个大类），但不能把 NULL 写入库：
    // 左栏按 groupId 过滤，这样的分类会“建成功”却在任何大类下都看不见。
    const groups = loadLibraryGroups();
    const groupId = input.groupId ?? groups[0]?.id;
    if (!groupId || !groups.some((g) => g.id === groupId)) {
      throw new Error("分类所属大类不存在，请刷新左栏后重试");
    }
    CollectionRepo.create(input.name, input.parentId ?? null, groupId, input.prompt);
    notifyLibraryChanged(`create_collection:${input.name}`);
    return { collections: collectionsForRenderer() };
  });

  ipcMain.handle(IPC.LIBRARY_RENAME_COLLECTION, async (_evt, raw) => {
    const input = CollectionRenameSchema.parse(raw);
    // 名字与「给 AI 的说明」都可改,至少改一样(schema 的 refine 保证)。
    // 重名时 rename 返回 false —— 如实回传给渲染端提示,而不是静默失败
    let ok = true;
    if (input.name !== undefined) {
      ok = CollectionRepo.rename(input.id, input.name);
      // 改名被拒(重名)时**不要**再写 prompt —— 否则界面显示"失败"但说明已落盘,
      // 半应用;用户重试还会再写一遍。
      if (!ok) return { collections: collectionsForRenderer(), ok };
    }
    if (input.prompt !== undefined) {
      CollectionRepo.setPrompt(input.id, input.prompt);
    }
    if (ok) notifyLibraryChanged(`rename_collection:${input.name ?? input.id}`);
    return { collections: collectionsForRenderer(), ok };
  });

  ipcMain.handle(IPC.LIBRARY_DELETE_COLLECTION, async (_evt, raw) => {
    const input = CollectionDeleteSchema.parse(raw);
    // 删之前先记下这个库收了哪些文献 —— 删完它们可能就成了孤儿,要收进回收站。
    // (删的正好是回收站本身时不收:那会立刻把它又建出来,用户删不掉。)
    //
    // ⚠️ **必须连整棵子树一起收**(`listByCollectionTree`,不是 `listByCollection`)。
    // 分类是树(`library_collections.parent_id … ON DELETE CASCADE`),而子分类是
    // **跟着一起被删掉的** —— 它们的成员关系被 CASCADE 静默摘掉,没人收的话那些条目
    // 从此既不在任何分类里、也没进回收站,变成左栏里找不回来的僵尸记录(`trash.ts`
    // 文件头警告的正是这一种)。只见这一层的话,同一个用户动作"删掉这个分类"的结果
    // 取决于一个他看不见的结构细节:条目挂在父上就没事,挂在子分类上就丢。
    const affected = shouldSweepAfterRemoval(input.id)
      ? LibraryRepo.listByCollectionTree(input.id).map((i) => i.id)
      : [];
    // 只删分组,不动文献 —— 集合是视图,不是所有权
    CollectionRepo.delete(input.id);
    if (affected.length > 0) sweepToTrash(affected);
    notifyLibraryChanged(`delete_collection:${input.id}`);
    return { collections: collectionsForRenderer() };
  });

  ipcMain.handle(IPC.LIBRARY_MOVE_COLLECTION, async (_evt, raw) => {
    const input = CollectionMoveSchema.parse(raw);
    // 判环、判重名、重排同级次序都在 `CollectionRepo.move` 一处 —— 它返回 ok/原因,
    // 这里原样回传(与 renameCollection 同一条口径:拒了就说为什么,不静默不动)。
    const res = CollectionRepo.move(input.id, input.parentId);
    if (res.ok) notifyLibraryChanged(`move_collection:${input.id}`);
    return {
      collections: collectionsForRenderer(),
      ok: res.ok,
      ...(res.ok ? {} : { error: res.error }),
    };
  });

  ipcMain.handle(IPC.LIBRARY_ASSIGN_COLLECTION, async (_evt, raw) => {
    const input = CollectionAssignSchema.parse(raw);
    // 实现在 operations.ts(AI 的 library_move 工具走同一条路)—— 回收站摘除与
    // 孤儿收集这两处分支都跟着一起过去了。
    assignToCollection(input.collectionId, input.itemIds, input.add);
    // 移动 / 移除会改变两个分类的内容 —— 左栏展开着的那两处都要跟着变
    notifyLibraryChanged(`assign:${input.itemIds.length}`);
    return { collections: collectionsForRenderer() };
  });

  /* ──────────────────────── 检索与导入 ──────────────────────── */

  /**
   * 从本地 PDF 文件导入。用户手上大量是已经下载好的 PDF,没有 DOI 文本可粘 ——
   * 这一条是他们的主入口。
   *
   * `convert` 默认开:导入完就转 Markdown,这样「加进对话让 AI 读」立刻就能用。
   * 转换是分钟级的(pdf.js 同线程跑),所以这里**串行** —— 并发几份 PDF 只会互相
   * 抢 CPU,反而更慢。
   */
  ipcMain.handle(IPC.LIBRARY_IMPORT_FILES, async (_evt, raw) => {
    const input = LibraryImportFilesSchema.parse(raw);
    // **通用导入**（kind 退役）：按扩展名分派 —— pdf 走文献管线、md/txt 走笔记
    // 管线、其余收通用条目；mode 控制目录是"一个条目"还是"拆开逐个导"。
    const res = await importAnyFiles(input.paths, {
      mode: input.mode,
      collectionIds: input.collectionIds,
      convert: input.convert,
    });
    notifyLibraryChanged(`import_files:${res.added}`);
    return res;
  });

  /**
   * 导入 Markdown 笔记(笔记库)。
   *
   * 与 importFiles 分开:笔记入库即完成,没有元数据要抓、也没有东西要转录。
   * 业务逻辑在 `main/library/notesImport.ts`。
   */
  ipcMain.handle(IPC.LIBRARY_IMPORT_NOTES, async (_evt, raw) => {
    const input = LibraryImportNotesSchema.parse(raw);
    const res = importNoteFiles(input.paths, input.collectionIds);
    notifyLibraryChanged(`import_notes:${res.added}`);
    return { items: res.items, added: res.added, skipped: res.skipped, errors: res.errors };
  });

  /**
   * 把库里已有的 PDF 批量转 Markdown(存量文献的补转入口)。
   *
   * 不传 ids 就转整个库 / 某个集合 —— 但**已经有 md 的会跳过**(除非 force),
   * 所以重复点这个按钮不会做白工。
   */
  ipcMain.handle(IPC.LIBRARY_CONVERT, async (_evt, raw) => {
    const input = LibraryConvertSchema.parse(raw ?? {});
    if (input.repair) {
      const result = await repairCollectionMarkdown(input.collectionId!);
      if (result.converted > 0 || result.cleaned > 0) notifyLibraryChanged(`repair:${result.converted}:${result.cleaned}`);
      return result;
    }
    const targets = input.ids?.length
      ? input.ids.map((id) => LibraryRepo.get(id)).filter((x): x is LibraryItem => Boolean(x))
      : LibraryRepo.list({ collectionId: input.collectionId, limit: 100_000 }).items;

    let converted = 0;
    const failed: Array<{ id: string; error: string }> = [];
    for (const item of targets) {
      const res = await convertItemToMarkdown(item, { force: input.force });
      if (res.ok) converted += 1;
      else failed.push({ id: item.id, error: res.error });
    }
    // 转完会写 md_path —— 左栏的「待转」标记和右栏正在看的那一篇都要跟着变。
    // 一条都没转成时什么都不变,不白惊动一遍界面。
    if (converted > 0) notifyLibraryChanged(`convert:${converted}`);
    return { converted, cleaned: 0, failed };
  });

  /**
   * 在系统文件管理器里定位库里的文件。
   *
   * ## 为什么不复用 `shell.showItemInFolder`
   *
   * 那个 handler 有一条**刻意的围栏**:路径必须落在「已知且未归档的项目根」内,
   * 否则**静默返回**(防的是被攻破的渲染端拿它去揭任意文件)。库根不是项目根,
   * 所以走那条路会被拒 —— 用户看到的就是"点了没反应"。
   *
   * 这里**不去放宽那条围栏**,而是换一条入参只有**条目 id** 的通道:路径由主进程
   * 从数据库里取、自己拼出来,渲染端根本没机会指定任意路径。这比放宽围栏更安全,
   * 也顺手免掉了渲染端手工拼 `${root}/${relPath}` 那种混合分隔符的字符串。
   */
  ipcMain.handle(IPC.LIBRARY_REVEAL_FILE, async (_evt, raw) => {
    const input = LibraryRevealFileSchema.parse(raw);
    const item = LibraryRepo.get(input.id);
    if (!item) return { ok: false, error: "找不到这篇文献" };
    const wantMd = input.which === "md";
    const rel = wantMd ? item.mdPath : item.pdfPath;
    if (!rel) {
      return { ok: false, error: wantMd ? "还没有转换产物" : "还没有 PDF" };
    }
    const abs = fromLibraryRelative(rel);
    if (!existsSync(abs)) return { ok: false, error: `文件不在了:${rel}` };
    // 打开**所在文件夹**。原来用 `shell.showItemInFolder`(在父目录里选中该文件),
    // 但那个 API 在这台机器上不成(原因见 main/lib/reveal.ts)—— 用户报的就是
    // 「在文件夹中显示点不开」。打开所在文件夹同样达到目的。
    const err = await openDirectory(dirname(abs));
    return err ? { ok: false, error: err } : { ok: true };
  });

  /**
   * 读一篇文献的 Markdown 正文,给**应用内预览**用。
   *
   * 顺带把正文里引用的图片解析成 data URL 一起返回 —— 渲染端读不了本地文件,而
   * md 里写的是 `images/xxx.jpg` 这种相对路径,只有主进程知道它相对于谁。
   * 细节(体积上限、越界保护)见 `main/library/markdownPreview.ts`。
   */
  ipcMain.handle(IPC.LIBRARY_READ_MARKDOWN, (_evt, raw) => {
    const input = LibraryReadMarkdownSchema.parse(raw);
    return readMarkdownForPreview(input.id);
  });

  /**
   * 读 PDF 字节,给应用内的 pdf.js 阅读器用(见 `main/library/pdfRead.ts`)。
   */
  ipcMain.handle(IPC.LIBRARY_READ_PDF, (_evt, raw) => {
    const input = LibraryReadPdfSchema.parse(raw);
    return readPdfBytes(input.id);
  });

  /**
   * 条目下的小笔记(读文献时随手记的)。
   *
   * 与笔记库的 `createNote` / `writeNote` **不是一回事**:那边一条笔记就是一篇
   * Markdown 文件(自己是一个条目),这边一条只是挂在某篇论文/教材下的一段文字。
   */
  /** 改条目的显示标题(三个库通用)。只改数据库里的 title,不重命名磁盘文件。 */
  ipcMain.handle(IPC.LIBRARY_RENAME_ITEM, (_evt, raw) => {
    const input = LibraryRenameItemSchema.parse(raw);
    if (!LibraryRepo.get(input.id)) return { item: null };
    LibraryRepo.setTitle(input.id, input.title.trim());
    // 左栏改的名必须立刻出现在右栏的标题上(反之亦然)—— 两边各有缓存,靠这条广播对齐
    notifyLibraryChanged(`rename_item:${input.id}`);
    return { item: LibraryRepo.get(input.id) };
  });

  ipcMain.handle(IPC.LIBRARY_LIST_NOTES, (_evt, raw) => {
    const input = LibraryNotesListSchema.parse(raw);
    return { notes: NoteRepo.listByItem(input.itemId) };
  });

  ipcMain.handle(IPC.LIBRARY_SAVE_NOTE, (_evt, raw) => {
    const input = LibraryNoteSaveSchema.parse(raw);
    NoteRepo.save(input);
    return { notes: NoteRepo.listByItem(input.itemId) };
  });

  ipcMain.handle(IPC.LIBRARY_DELETE_NOTE, (_evt, raw) => {
    const input = LibraryNoteDeleteSchema.parse(raw);
    const itemId = NoteRepo.delete(input.id);
    return { notes: itemId ? NoteRepo.listByItem(itemId) : [] };
  });

  /** 新建一篇笔记(笔记库)。业务逻辑在 `main/library/notesImport.ts`。 */
  ipcMain.handle(IPC.LIBRARY_CREATE_NOTE, (_evt, raw) => {
    const input = LibraryCreateNoteSchema.parse(raw);
    const item = createNote(input.title, input.collectionIds);
    // 建不出来就不广播 —— 那是一次什么都没发生的调用
    if (item) notifyLibraryChanged(`create_note:${item.id}`);
    return { item };
  });

  /** 把编辑器的内容写回笔记文件。 */
  ipcMain.handle(IPC.LIBRARY_WRITE_NOTE, (_evt, raw) => {
    const input = LibraryWriteNoteSchema.parse(raw);
    const res = writeNote(input.id, input.text);
    // 笔记正文写在磁盘上,左栏那一行显示的还是标题 —— 广播出去让右栏的预览换成新内容
    // (预览是从磁盘读的,不重读就会一直显示上一次保存的版本)
    notifyLibraryChanged(`write_note:${input.id}`);
    return res;
  });

  /**
   * 挂上一份现成的 Markdown(跳过转录)。业务逻辑在 `main/library/adoptMarkdown.ts`。
   *
   * 与 `library.convert` 的分工:那条是**去转**,这条是**收下用户已经转好的**。
   */
  ipcMain.handle(IPC.LIBRARY_ADOPT_MARKDOWN, (_evt, raw) => {
    const input = LibraryAdoptMarkdownSchema.parse(raw);
    const res = adoptMarkdownFile(input.id, input.path);
    if (res.ok) notifyLibraryChanged(`adopt_markdown:${input.id}`);
    return { ok: res.ok, error: res.error, imageCount: res.imageCount };
  });

  /**
   * 用系统默认程序打开库里的文件 —— 主要用途是**看 md 的渲染效果**。
   *
   * 为什么不复用 `shell.openPath`:那个更严 —— 只允许**恰好等于某个项目根**的目录。
   * 库根不是项目根,走那条必然被拒。这里同样只收条目 id,路径在 main 里拼,
   * 渲染端无从指定任意路径。
   */
  ipcMain.handle(IPC.LIBRARY_OPEN_FILE, async (_evt, raw) => {
    const input = LibraryOpenFileSchema.parse(raw);
    const item = LibraryRepo.get(input.id);
    if (!item) return { ok: false, error: "找不到这篇文献" };
    const wantMd = input.which === "md";
    // 和 `readEntryFile` / `LIBRARY_ENTRY_PATH` 同一判据(OBS-M35-02):本体(`file_path`,
    // 含 linked 的库外绝对路径)→ PDF → 转录。原来只认 pdf/md 两列,通用条目的「外部打开」
    // 永远是"还没有 PDF"。
    const abs = entryRootAbsPath(item, input.which);
    if (!abs) return { ok: false, error: wantMd ? "还没有转换产物" : "这条资料还没有关联文件" };
    if (!existsSync(abs)) return { ok: false, error: `文件不在了:${basename(abs)}` };
    const err = await shell.openPath(abs);
    return err ? { ok: false, error: err } : { ok: true };
  });

  /**
   * **条目 → 磁盘绝对路径**（2026-09-21）—— 中间栏那个 `FileEditor` 要的。
   *
   * ## 它和上面两条的区别
   *
   * `revealFile` / `openFile` 是"让系统去开"，路径不出主进程。这一条**把路径交出去**，
   * 因为编辑器要拿它去 `file:readFile` / `file:writeFile`。
   *
   * ## 和 `readEntryFile` 用同一个判据
   *
   * 都走 `entryRootAbsPath(item, which)` —— 三条来源（`file_path` → `pdf_path` →
   * `md_path`）都认，指名了 `which` 就只认那一样。**不另写一套**：两处判据分家的话，
   * "预览能看到、打开编辑却说没有文件"这种事迟早发生。
   */
  ipcMain.handle(IPC.LIBRARY_ENTRY_PATH, (_evt, raw) => {
    const input = LibraryEntryPathSchema.parse(raw);
    const item = LibraryRepo.get(input.id);
    if (!item) return { path: null, error: "找不到这条资料" };
    const abs = entryRootAbsPath(item, input.which);
    if (!abs) {
      // 逐条说清是哪一种，不合并成一句"失败" —— 用户在两种情形下要做的事不同。
      return input.which === "md"
        ? { path: null, error: "这条还没有转录产物" }
        : { path: null, error: "这条资料还没有关联文件" };
    }
    if (!existsSync(abs)) return { path: null, error: `文件不在了：${basename(abs)}` };
    // 目录**给路径也打不开编辑**（它是"往下翻"那一层）。如实报出来，让调用方退回预览
    // —— 比丢给 Monaco 让它去"编辑"一个目录好。
    const isDir = statSync(abs).isDirectory();
    return { path: abs, ...(isDir ? { isDir: true } : {}) };
  });

  /**
   * 读某篇 PDF 的全部高亮。
   *
   * 高亮**不存在数据库里** —— 存在 PDF 旁边的 `.<名字>.mcode-highlights.json`
   * （理由见 `pdfHighlightsStore.ts` 头注）。所以入参是**路径**不是条目 id：
   * 项目目录里那些根本不在资料库里的 PDF 也要能有高亮。
   *
   * 路径要过 `pathGuard` —— 渲染端只能请求"某个已知工作区根内的文件"的高亮。
   */
  ipcMain.handle(IPC.LIBRARY_READ_HIGHLIGHTS, (_evt, raw) => {
    const input = PdfHighlightsReadSchema.parse(raw);
    const guard = highlightPathAllowed(input.pdfPath);
    // ⚠️ **围栏不过就报错,不返回空数组。** 返回空数组的话,一个越界路径看起来
    //    就像"这篇还没划过高亮"—— 静默错,用户永远不知道自己在看一个假结果。
    //    (从前这里写着同一句话、代码却回的是 `{highlights: []}` —— 注释和实现对不上。)
    if (!guard) throw new Error("这个位置不允许读取高亮(不在任何已知工作区/资料库内)");
    return { highlights: readHighlights(input.pdfPath) };
  });

  /**
   * **只写索引**（PDF 旁边那份 JSON）—— 划一笔就走这条。
   *
   * 不动 PDF 本身。用户定的用法是"划一下先存、写回延后"：每划一笔都重写整篇 PDF
   * （论文十几 MB）又慢又危险。
   */
  ipcMain.handle(IPC.LIBRARY_SAVE_HIGHLIGHTS, (_evt, raw) => {
    const input = PdfHighlightsSaveSchema.parse(raw);
    if (!highlightPathAllowed(input.pdfPath)) {
      return { ok: false, error: "这个位置不允许写入" };
    }
    if (!existsSync(input.pdfPath)) return { ok: false, error: "文件不在了" };
    try {
      writeHighlights(input.pdfPath, input.highlights as PdfHighlight[]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /**
   * 把高亮**写回 PDF 文件本身**（真 `/Highlight` 批注）。
   *
   * ## 为什么不在这里调 pdf.js
   *
   * 写回要的是 `PDFDocumentProxy.saveDocument()`，而那个对象**只在渲染端存在**
   * （pdf.js 跑在渲染进程里）。所以字节由渲染端算好、base64 送过来，主进程只负责
   * **落盘**（原子替换）和**更新索引**。这也让主进程不必依赖 pdf.js 的运行时。
   */
  ipcMain.handle(IPC.LIBRARY_WRITE_HIGHLIGHTS, (_evt, raw) => {
    const input = PdfHighlightsWriteBackSchema.parse(raw);
    if (!highlightPathAllowed(input.pdfPath)) {
      return { ok: false, error: "这个位置不允许写入" };
    }
    if (!existsSync(input.pdfPath)) return { ok: false, error: "文件不在了" };

    const bytes = Buffer.from(input.bytesBase64, "base64");
    if (bytes.length === 0) return { ok: false, error: "字节是空的" };

    /**
     * ⚠️ **先把干净底稿存下来**（只存一次，绝不覆盖）。
     *
     * 烘烤是**画上去**的（`exportPdf` 把标注画进页面），**擦不掉也改不了** ——
     * 所以"改个颜色再烤"会变成烤两遍（旧的还在）。渲染端每次都是拿
     * `<底稿 + 全部标注>` 重新算一份，这里负责让那份底稿**存在且永远是干净的**。
     *
     * 顺序要紧：**必须在覆盖 PDF 之前**。反过来的话，这一篇的原始内容就永远没了。
     */
    try {
      if (!hasOriginal(input.pdfPath)) {
        ensureOriginal(input.pdfPath, readFileSync(input.pdfPath));
        log.info(`[library] 存了干净底稿：${basename(originalPathFor(input.pdfPath))}`);
      }
    } catch (err) {
      // 底稿存不下来就**不许烤** —— 烤下去会把原始内容永久盖掉（标注擦不掉），
      // 而用户以为还能撤销。
      return { ok: false, error: `存底稿失败，为了不弄坏原文件已放弃：${(err as Error).message}` };
    }

    // ⚠️ **原子替换。** 渲染端给的是整个文件；直接写原路径、中途崩了，
    //    用户那篇论文就毁了。临时文件必须落在**同一个目录**（跨盘 rename 在
    //    Windows 上会抛 EXDEV）。
    const tmp = join(dirname(input.pdfPath), `.${Date.now().toString(36)}-annot.tmp.pdf`);
    try {
      writeFileSync(tmp, bytes);
      renameSync(tmp, input.pdfPath);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* 尽力而为 */
      }
      return { ok: false, error: (err as Error).message };
    }

    // 索引跟着一起更新 —— 分两次调用会留下"文件写了、索引没写"的不一致窗口。
    if (input.highlights) {
      try {
        writeHighlights(input.pdfPath, input.highlights as PdfHighlight[]);
      } catch (err) {
        // 文件已经写成功了，索引失败只影响"下次打开看到什么" —— 如实记下来，
        // 但**不改 ok**（用户的批注确实进 PDF 了）。
        log.warn(`[library] 写高亮索引失败：${(err as Error).message}`);
      }
    }
    return { ok: true, written: input.highlights?.length ?? 0, skipped: [] };
  });

  /**
   * 读**干净底稿**的字节 —— 渲染端烘烤时从它出发。
   *
   * 没有底稿（还没烤过）时返回当前文件本身 —— 那时它**就是**干净的。
   */
  ipcMain.handle(IPC.LIBRARY_READ_ORIGINAL_PDF, (_evt, raw) => {
    const input = PdfHighlightsReadSchema.parse(raw);
    if (!findContainingWorkspaceRoot(input.pdfPath)) return { bytes: null };
    const original = originalPathFor(input.pdfPath);
    const src = existsSync(original) ? original : input.pdfPath;
    if (!existsSync(src)) return { bytes: null };
    try {
      const buf = readFileSync(src);
      // 走结构化克隆（与 `library.readPdf` 同一条）—— base64 会让论文多涨三分之一。
      return { bytes: new Uint8Array(buf) };
    } catch {
      return { bytes: null };
    }
  });

  ipcMain.handle(IPC.LIBRARY_CONVERSION_STATS, () => LibraryRepo.conversionStats());

  /** 逐篇的转换完整度 —— 设置页「转录检测」列表。 */
  ipcMain.handle(IPC.LIBRARY_CONVERSION_REPORT, () => {
    const rows = conversionReport();
    const complete = rows.filter((r) => r.complete).length;
    return { rows, total: rows.length, complete, pending: rows.length - complete };
  });

  /* ─────────────────────────── 全文检索 ─────────────────────── */

  /**
   * 全文检索走 ripgrep 而不是 SQL —— sql.js 不含 FTS5(已在 node_modules 里核实)。
   *
   * 只用**已转换的 Markdown** 作为检索面:PDF 是二进制,rg 无从下手;
   * 转换是异步的,没转的条目自然搜不到(界面上有「待转换」状态可见)。
   *
   * 顺带白拿一个好处:rgGrep 内部做了 UTF-8 + GBK 双通道,中文文献可搜。
   */
  ipcMain.handle(IPC.LIBRARY_FULL_TEXT_SEARCH, async (_evt, raw) => {
    const input = LibraryFullTextSearchSchema.parse(raw);
    const seq = ++fullTextSearchSeq;
    const root = libraryRoot();
    const markdownDir = `${root}/markdown`;
    if (!existsSync(markdownDir)) return { matches: [] };

    const result = await rgGrep(
      markdownDir,
      input.query,
      { caseSensitive: false, limit: input.limit ?? 100, maxPerFile: 5, includeExts: ["md"] },
      [],
    );
    // 后发的检索请求胜出 —— 避免用户在输入框里连打时旧结果覆盖新结果
    if (seq !== fullTextSearchSeq) return { matches: [] };
    if (!result) return { matches: [] };

    // 逻辑路径 → 条目。md 落在 markdown/<ab>/<cd>/<sha>.md,而库里存的是
    // 相对库根的路径,所以要把它拼回去再比对。
    const byRel = new Map<string, LibraryItem>();
    for (const item of LibraryRepo.list({ limit: 100000 }).items) {
      if (item.mdPath) byRel.set(item.mdPath, item);
    }

    const matches: FullTextMatch[] = [];
    for (const m of result.matches) {
      const rel = `markdown/${m.relativePath}`.replace(/\\/g, "/");
      const item = byRel.get(rel);
      if (!item) continue;
      if (input.collectionIds?.length) {
        const owned = CollectionRepo.collectionsOfItem(item.id);
        if (!owned.some((c) => input.collectionIds!.includes(c))) continue;
      }
      matches.push({
        itemId: item.id,
        title: item.title,
        relativePath: rel,
        lineNumber: m.lineNumber,
        lineText: m.lineText,
      });
    }
    return { matches };
  });

  /**
   * 生成/刷新某个库的清单 Markdown,并返回它的绝对路径。
   *
   * 这是「把文献库加进对话上下文」的落点,机制**刻意与文件附件一致**:
   * 提示词里只放一行 `@<这个路径>`,内容由 agent 用 Read 工具自己读 ——
   * 不把正文预先塞进提示词,上下文才不会被一个库撑爆。
   *
   * 每次调用都重写:库的内容随时在变(新下载了 PDF、改了元数据),缓存清单只会
   * 让 agent 读到过期信息。写一个几百 KB 的 Markdown 是毫秒级的,不值得省。
   */
  /**
   * 单独一篇的清单 —— 用户在「+」菜单里展开分类、只挑了一篇时用它。
   *
   * 与整库清单刻意长得不一样:整库那张表是**索引**(让模型知道库里有什么),这一份
   * 是**这一篇该怎么读**(读哪个文件、元数据够不够、我自己在上面记了什么)。
   */
  ipcMain.handle(IPC.LIBRARY_ITEM_MANIFEST, async (_evt, raw) => {
    const input = LibraryItemManifestSchema.parse(raw);
    // **屏蔽是硬过滤,这道门与 `attachToChat` 是同一个判据、同一个函数。**
    //
    // 用户在「+」菜单里展开分类、只挑一篇时走的是这里 —— 而 `attachToChat` 那条路
    // 早就挡了(`manifest.ts` 里那句「就算是我手动挂的一个文件,只要是屏蔽状态,也挂
    // 不上去」)。同一个意图的两个入口,一个挡一个不挡,结果就是"屏蔽"这件事在界面上
    // 时灵时不灵:左栏右键挂不上,「+」菜单挑得中。挡不住的那条还把文件路径写进了清单。
    //
    // 判据只有一份(见 `library/suppress.ts`),这里不重写它。
    const reason = suppressionReasonOfItem(input.id);
    if (reason) return { path: "", count: 0, name: "", blockedReason: reason };
    // 实现在 library/manifest.ts —— AI 也能挂库(见 mcp/libraryServer.ts 的
    // library_attach_to_chat),两边共用同一份,免得长出两种清单格式。
    return writeItemManifest(input.id);
  });

  ipcMain.handle(IPC.LIBRARY_MANIFEST, async (_evt, raw) => {
    const input = LibraryManifestSchema.parse(raw);
    // 同上:实现搬去 library/manifest.ts,与 AI 的挂库共用。
    return writeCollectionManifest(input.collectionId);
  });

  ipcMain.handle(IPC.LIBRARY_GROUPS_GET, async (_evt, raw) => {
    LibraryGroupsGetSchema.parse(raw ?? {});
    return { groups: loadLibraryGroups() };
  });
  ipcMain.handle(IPC.LIBRARY_GROUPS_SAVE, async (_evt, raw) => {
    const input = LibraryGroupsSaveSchema.parse(raw);
    return saveLibraryGroups(input.groups);
  });

  // 屏蔽规则 —— 与上面两条同一种形状(读走缓存、写是整表替换、校验在主进程)。
  ipcMain.handle(IPC.LIBRARY_SUPPRESS_GET, async (_evt, raw) => {
    LibrarySuppressGetSchema.parse(raw ?? {});
    return { rule: loadSuppress() };
  });
  ipcMain.handle(IPC.LIBRARY_SUPPRESS_SAVE, async (_evt, raw) => {
    const input = LibrarySuppressSaveSchema.parse(raw);
    return saveSuppress(input.rule);
  });

  // 条目关联 —— 增删查。加/解除都**不改条目本身**,只动关联表。
  ipcMain.handle(IPC.LIBRARY_LINKS_OF, async (_evt, raw) => {
    const input = LibraryLinksOfSchema.parse(raw);
    // 视图行 = 关联 + 另一头的摘要(`viewsOf` 查),再补上屏蔽原因 ——
    // 屏蔽判定要读规则、查祖先链,那是主进程的事。**被屏蔽的照常返回**
    // (带上原因):界面上要看得见"它存在,只是被挡了",否则用户会以为关联丢了。
    const links = LibraryLinkRepo.viewsOf(input.itemId).map((v) => {
      if (!v.otherItemId) return v;
      const reason = suppressionReasonOfItem(v.otherItemId);
      return reason ? { ...v, suppressedReason: reason } : v;
    });
    return { links };
  });
  // 一批条目的关联条数 —— 左栏行尾的徽标。**只数不查摘要**:徽标只显示一个数字,
  // 摘要等用户点开右栏时再按 `linksOf` 拉(那是单条的、带缓存的)。
  ipcMain.handle(IPC.LIBRARY_LINK_COUNTS, async (_evt, raw) => {
    const input = LibraryLinkCountsSchema.parse(raw);
    return { counts: LibraryLinkRepo.countsOf(input.itemIds) };
  });
  ipcMain.handle(IPC.LIBRARY_LINK_ADD, async (_evt, raw) => {
    const input = LibraryLinkAddSchema.parse(raw);
    // schema 的 refine 已经保证二选一,这里按它分派 —— 两处用同一条规矩。
    const target =
      input.targetItemId !== undefined
        ? { targetItemId: input.targetItemId }
        : { targetPath: input.targetPath! };
    const link = LibraryLinkRepo.add(input.itemId, target);
    notifyLibraryChanged(`link_add:${input.itemId}`);
    return { link };
  });
  ipcMain.handle(IPC.LIBRARY_LINK_REMOVE, async (_evt, raw) => {
    const input = LibraryLinkRemoveSchema.parse(raw);
    const ok = LibraryLinkRepo.remove(input.linkId);
    if (ok) notifyLibraryChanged(`link_remove:${input.linkId}`);
    return { ok };
  });

  // 通用文件条目:linked 只记路径、attached 复制进库(见 library/fileImport.ts)。
  // 指定了 collectionIds 就顺手归组 —— 和文献导入同一个体验,不用用户再点一遍。
  ipcMain.handle(IPC.LIBRARY_IMPORT_GENERIC, async (_evt, raw) => {
    const input = LibraryImportGenericSchema.parse(raw);
    // 归属交给导入器自己(`importGenericFiles` → `assignImportedToCollections`):
    // 失效的分类 id 跳过,不让 handler 在文件**已复制进库**之后撞外键整个抛掉;
    // 重复导入给回的旧条目也照样归入 —— 与 LIBRARY_IMPORT_FILES 同一套行为。
    const res = importGenericFiles({
      paths: input.paths,
      mode: input.mode,
      collectionIds: input.collectionIds,
    });
    notifyLibraryChanged(`import_generic:${res.added}`);
    return res;
  });

  ipcMain.handle(IPC.LIBRARY_READ_FILE, async (_evt, raw) => {
    const input = LibraryReadFileSchema.parse(raw);
    return { content: readEntryFile(input.id, input.relPath, input.which) };
  });

  /**
   * 把一条附件挂到指定会话的输入框上 —— 左栏右键「添加到当前对话」。
   *
   * 与 AI 的 `library_attach_to_chat` 调的是**同一个** `attachToChat`,所以用户
   * 自己挂和 AI 挂的结果必然一致(用户的原话:「他对文件系统的操作要和用户在 ui
   * 的操作一样」)。这里只负责解析入参。
   */
  ipcMain.handle(IPC.LIBRARY_ATTACH_TO_CHAT, async (_evt, raw) => {
    const input = LibraryAttachToChatSchema.parse(raw);
    return attachToChat(input.sessionId, input.key);
  });
}
