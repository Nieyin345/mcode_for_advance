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
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { shell, type IpcMain } from "electron";
import {
  IPC,
  LIBRARY_ROOT_SETTING_KEY,
  LibraryAddItemsSchema,
  LibraryDeleteItemsSchema,
  LibraryDownloadSchema,
  LibraryFullTextSearchSchema,
  LibraryImportSchema,
  LibraryImportFilesSchema,
  LibraryImportNotesSchema,
  LibraryConvertSchema,
  LibraryRevealFileSchema,
  LibraryOpenFileSchema,
  LibraryReadMarkdownSchema,
  LibraryReadPdfSchema,
  LibraryAdoptMarkdownSchema,
  LibraryCreateNoteSchema,
  LibraryWriteNoteSchema,
  LibraryNotesListSchema,
  LibraryNoteSaveSchema,
  LibraryNoteDeleteSchema,
  LibraryRenameItemSchema,
  LibraryExportSchema,
  LibraryItemIdSchema,
  LibraryListSchema,
  LibrarySearchSchema,
  LibrarySetRootSchema,
  LibraryAttachToChatSchema,
  LibraryTypesGetSchema,
  LibraryTypesSaveSchema,
  LibraryGroupsGetSchema,
  LibraryGroupsSaveSchema,
  LibraryImportGenericSchema,
  LibraryReadFileSchema,
  LibraryManifestSchema,
  LibraryItemManifestSchema,
  LibraryKindManifestSchema,
  CollectionAssignSchema,
  CollectionCreateSchema,
  CollectionDeleteSchema,
  CollectionRenameSchema,
} from "@contracts/ipc";
import type { FullTextMatch, LibraryCollection, LibraryItem } from "@contracts/library";
import { LIBRARY_KINDS } from "@contracts/library";
import { formatAuthorList } from "@contracts/library";
import { LibraryRepo, CollectionRepo, DownloadJobRepo, NoteRepo, SettingRepo } from "@main/store/repositories.js";
import { awaitDb } from "@main/store/db.js";
import { rgGrep } from "@main/lib/rgSearch.js";
import { log } from "@main/lib/logger.js";
import { searchExternal } from "@main/library/metadata.js";
import { importPdfFiles } from "@main/library/pdfImport.js";
import { createNote, importNoteFiles, writeNote } from "@main/library/notesImport.js";
import { convertItemToMarkdown, conversionReport } from "@main/library/convert.js";
import { readMarkdownForPreview } from "@main/library/markdownPreview.js";
import { readPdfBytes } from "@main/library/pdfRead.js";
import { adoptMarkdownFile } from "@main/library/adoptMarkdown.js";
import { exportCitations } from "@main/library/citationExport.js";
import { openDirectory } from "@main/lib/reveal.js";
import {
  sweepToTrash,
  shouldSweepAfterRemoval,
  ensureTrashCollection,
  markTrashCollections,
} from "@main/library/trash.js";
import { notifyLibraryChanged } from "@main/library/broadcast.js";
import { loadLibraryTypes, saveLibraryTypes, loadLibraryGroups, saveLibraryGroups } from "@main/library/kindRegistry.js";
import { importGenericFiles, readEntryFile } from "@main/library/fileImport.js";
import { assignToCollection, importIdentifiers } from "@main/library/operations.js";
import {
  attachToChat,
  writeCollectionManifest,
  writeItemManifest,
  writeKindManifest,
} from "@main/library/manifest.js";
import { enqueueDownloads, processDownloadQueue, setDownloadCompleteHook, resumeDownloadsOnStartup } from "@main/library/downloader.js";
import { ensureLibraryDirs, libraryRoot, fromLibraryRelative, toLibraryRelative } from "@main/library/paths.js";
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

  // 上次退出时中断的下载:「正在跑」是主进程里的内存状态,进程一没就没了,而库里
  // 那条记录会永远停在 running —— 界面上永远转圈,队列也不会再捡起它。这里把它们
  // 打回 pending 并把队列重新拉起来,否则用户只能一条条手动点重试。
  //
  // ⚠️ **必须等数据库就绪**。`registerLibraryHandlers` 跑在 `initDb()` **之前**
  // (见 index.ts:DB 初始化是后台进行的,窗口不等它),这时查库会抛
  // `getDb() called before initDb() resolved`。原来直接调用,于是恢复逻辑**看运气**
  // —— DB 先好就正常,否则整块被 catch 吞掉、队列根本不启动,表现成"点了下载没反应"。
  void awaitDb().then(() => resumeDownloadsOnStartup());

  // 下载完 → 自动转录 Markdown。用户的要求是「导入之后是软件自动下载，自动转录的，
  // 不需要 ai 去管」，所以这里**没有开关**：接了 MinerU 就走 MinerU，没接就走本地
  // pdf.js 抽文本(便宜、快)。
  //
  // 重复触发是安全的：convertItemToMarkdown 自己会跳过"已经有 md 的"条目，也有一份
  // in-flight 去重(见 convert.ts 的 inFlight)。钩子是同步调用，所以这里立刻返回、
  // 把活儿丢进后台 —— 转录是分钟级的(MinerU 要上传解析)，不能卡住下载队列。
  setDownloadCompleteHook((item) => {
    void convertItemToMarkdown(item)
      .then((res) => {
        if (!res.ok) log.warn(`auto-convert failed (${item.title}): ${res.error}`);
        else log.info(`auto-convert ok: ${item.title} (${res.source})`);
      })
      .catch((err: unknown) => log.warn(`auto-convert threw: ${(err as Error).message}`));
  });

  // 三个库的**回收站分类**也在启动时建好。
  //
  // 用户的要求是「论文、教材、笔记都要有回收站这个分类」—— 而回收站原本是"第一次有
  // 东西掉进去"时才懒创建的,所以教材/笔记库里根本看不到它。这里先建出来,用户随时
  // 能看到、也能自己往里拖东西。
  //
  // 走 awaitDb():这个函数在数据库就绪**之前**就会跑(handler 注册阶段),直接读库
  // 会抛。所以挂到 ready promise 上,失败也不阻断启动 —— 回收站晚一点建出来不是大事。
  void awaitDb()
    .then(() => {
      for (const k of LIBRARY_KINDS) ensureTrashCollection(k);
    })
    .catch((err: unknown) => log.warn(`trash: ensure failed: ${(err as Error).message}`));

  /* ─────────────────────────── 条目 ─────────────────────────── */

  ipcMain.handle(IPC.LIBRARY_LIST, async (_evt, raw) => {
    const input = LibraryListSchema.parse(raw ?? {});
    return LibraryRepo.list({
      collectionId: input.collectionId ?? undefined,
      // 不传 kind = 不限库。左栏的「全部」视图和按库筛选共用这一条
      kind: input.kind,
      query: input.query,
      pdfState: input.pdfState,
      limit: input.limit,
      offset: input.offset,
    });
  });

  ipcMain.handle(IPC.LIBRARY_GET, async (_evt, raw) => {
    const input = LibraryItemIdSchema.parse(raw);
    return { item: LibraryRepo.get(input.id), job: DownloadJobRepo.getByItem(input.id) };
  });

  /**
   * 入库。
   *
   * 元数据补齐策略:**只用调用方给的值**,不主动联网 —— 检索时 AI 或界面已经
   * 拿到过元数据,再查一次只会让入库变慢且可能被限流。缺元数据的条目由后续的
   * 「补全元数据」操作补(单条明确动作,用户看得见花了多久)。
   */
  ipcMain.handle(IPC.LIBRARY_ADD_ITEMS, async (_evt, raw) => {
    const input = LibraryAddItemsSchema.parse(raw);
    const items: LibraryItem[] = [];
    for (const entry of input.items) {
      const item = LibraryRepo.upsert({
        kind: entry.kind,
        doi: entry.doi,
        arxivId: entry.arxivId,
        title: entry.title,
        authors: entry.authors,
        year: entry.year,
        venue: entry.venue,
        volume: entry.volume,
        issue: entry.issue,
        page: entry.page,
        publisher: entry.publisher,
        abstract: entry.abstract,
        type: entry.type,
        language: entry.language,
        url: entry.url,
        source: entry.source ?? "manual",
        license: entry.license,
      });
      if (entry.collectionIds?.length) {
        for (const cid of entry.collectionIds) CollectionRepo.assign(cid, [item.id], true);
      }
      items.push(item);
    }
    // 入库后按需排队下载 —— 默认排队,调用方可显式关掉
    const toDownload = input.items
      .map((e, i) => (e.queueDownload === false ? null : items[i].id))
      .filter((id): id is string => id !== null);
    if (toDownload.length) enqueueDownloads(toDownload);
    // 用户自己加完也要广播:右栏那一屏是它自己的 state,不重拉就一直停在旧列表上
    // (与 AI 走 MCP 工具加的那条路共用同一条广播,见 library/broadcast.ts)
    notifyLibraryChanged(`add:${items.length}`);
    return { items };
  });

  /**
   * **彻底删除**:数据库行 + 磁盘上的 PDF / Markdown。
   *
   * 这是库里唯一不可逆的操作(回收站只是"不属于任何分类",记录和文件都还在)。
   *
   * ## 文件删除为什么要在这里手写
   *
   * `LibraryRepo.delete` 刻意不碰文件系统(见它的注释),所以编排落在这一层。而且
   * 有两件事非处理不可 —— 它们都是"界面上删干净了、磁盘上却留着垃圾"的来源:
   *
   * ① **同一个文件可能被别的条目指着。** PDF 按内容哈希寻址,同一篇先用 DOI 导、
   *    又用 arXiv ID 导了一次,就是两条记录指向同一个路径。删之前先看还有没有幸存
   *    者指着它,有就一个字节都不动。
   * ② **MinerU 的产物是一整个目录**(`full.md` 加 `images/`)。只删 `full.md` 会把
   *    几十张配图整包留在磁盘上,而且再也认不出是谁的。所以 md 落在
   *    `markdown/<2>/<2>/<sha>/` 里时,删的是那个目录。
   */
  ipcMain.handle(IPC.LIBRARY_DELETE_ITEMS, async (_evt, raw) => {
    const input = LibraryDeleteItemsSchema.parse(raw);
    if (input.deleteFiles) {
      // 先删文件再删记录:反过来的话拿不到路径了
      /**
       * 库内每个路径被多少条记录引用着。**不能拿 `LibraryRepo.list({})` 来数** ——
       * 那个有 200 条的默认上限,大库上会漏判,而漏判的后果是删掉另一条记录的 PDF。
       */
      const refs = LibraryRepo.pathRefCounts();
      /** 这几条**自己**占的引用数。减掉它剩下的才是"别人还在用"。 */
      const own = new Map<string, number>();
      const bumpOwn = (p: string | undefined) => {
        if (p) own.set(p, (own.get(p) ?? 0) + 1);
      };
      for (const id of input.ids) {
        const it = LibraryRepo.get(id);
        if (!it) continue;
        bumpOwn(it.pdfPath);
        bumpOwn(it.mdPath);
      }
      /** 还有别的记录指着它 → 一个字节都不许动。 */
      const sharedWithSurvivor = (p: string) =>
        (refs.get(p) ?? 0) - (own.get(p) ?? 0) > 0;

      /**
       * 删一个库内路径。
       *
       * **只删库内路径** —— 记录万一被写入过外来路径,这里会把它挡掉,而不是照着
       * 删用户别处的文件。`recursive` 给 MinerU 那种"整包是一个目录"的产物用。
       */
      const dropAbs = (abs: string, label: string, recursive: boolean) => {
        try {
          if (toLibraryRelative(abs).startsWith("..")) return;
          if (!existsSync(abs)) return;
          rmSync(abs, { force: true, recursive });
        } catch (err) {
          log.warn(`library delete ${label} failed (${abs}): ${(err as Error).message}`);
        }
      };

      for (const id of input.ids) {
        const item = LibraryRepo.get(id);
        if (!item) continue;

        if (item.pdfPath && !sharedWithSurvivor(item.pdfPath)) {
          dropAbs(fromLibraryRelative(item.pdfPath), "pdf", false);
        }

        const mdRel = item.mdPath;
        if (!mdRel || sharedWithSurvivor(mdRel)) continue;
        const mdAbs = fromLibraryRelative(mdRel);
        const parent = dirname(mdAbs);
        // 父目录名是 64 位十六进制 → 只可能是内容哈希的目录形态(MinerU 那一包,
        // 里面是 `full.md` 加 `images/`)。平的那种是 `markdown/<2>/<2>/<sha>.md`,
        // 上一级只有两位,永远不会命中。
        //
        // 同哈希被两条记录引用时它们的 mdPath 是**同一个**,上面那道引用计数已经拦住
        // 了 —— 所以这里不需要再看别的条目。
        if (/^[0-9a-f]{64}$/.test(basename(parent))) {
          dropAbs(parent, "markdown dir", true);
          continue;
        }
        dropAbs(mdAbs, "markdown", false);
      }
    }
    LibraryRepo.delete(input.ids);
    // 删掉的可能正是右栏正在看的那一篇 —— 广播出去,右栏自己会清掉悬空的选中态
    notifyLibraryChanged(`delete:${input.ids.length}`);
    return { items: LibraryRepo.list({}).items };
  });

  ipcMain.handle(IPC.LIBRARY_DOWNLOAD, async (_evt, raw) => {
    const input = LibraryDownloadSchema.parse(raw);
    enqueueDownloads(input.ids, input.force);
    return { jobs: DownloadJobRepo.list() };
  });

  ipcMain.handle(IPC.LIBRARY_JOBS, async () => ({ jobs: DownloadJobRepo.list() }));

  /* ─────────────────────────── 集合 ─────────────────────────── */

  ipcMain.handle(IPC.LIBRARY_LIST_COLLECTIONS, async () => ({ collections: collectionsForRenderer() }));

  ipcMain.handle(IPC.LIBRARY_CREATE_COLLECTION, async (_evt, raw) => {
    const input = CollectionCreateSchema.parse(raw);
    CollectionRepo.create(input.name, input.parentId ?? null, input.kind ?? "paper", input.prompt);
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
    const affected = shouldSweepAfterRemoval(input.id)
      ? LibraryRepo.listByCollection(input.id).map((i) => i.id)
      : [];
    // 只删分组,不动文献 —— 集合是视图,不是所有权
    CollectionRepo.delete(input.id);
    if (affected.length > 0) sweepToTrash(affected);
    notifyLibraryChanged(`delete_collection:${input.id}`);
    return { collections: collectionsForRenderer() };
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
   * 转换是分钟级的,所以这里**串行**跑 —— 并发几份 PDF 会把带宽和 MinerU 的
   * 队列都占满,反而更慢。
   */
  ipcMain.handle(IPC.LIBRARY_IMPORT_FILES, async (_evt, raw) => {
    const input = LibraryImportFilesSchema.parse(raw);
    const results = await importPdfFiles({
      paths: input.paths,
      collectionIds: input.collectionIds,
      kind: input.kind,
    });

    const fresh = results.filter((r) => r.item && !r.alreadyPresent);
    const skipped = results.filter((r) => r.alreadyPresent).length;
    const errors = results
      .filter((r) => r.error)
      .map((r) => ({ path: r.path, error: r.error as string }));

    // 只把**这次真正新增**的条目归入集合 —— 已存在的重复条目不该被重新分组
    const ids = fresh.map((r) => r.item!.id);
    for (const cid of input.collectionIds ?? []) {
      if (ids.length > 0) CollectionRepo.assign(cid, ids, true);
    }

    let converted = { ok: 0, failed: 0 };
    if (input.convert !== false) {
      for (const r of fresh) {
        const res = await convertItemToMarkdown(r.item!);
        if (res.ok) converted.ok += 1;
        else converted.failed += 1;
      }
    }

    // 转换会写 md_path,所以重新取一遍再回给渲染端
    const items = fresh.map((r) => LibraryRepo.get(r.item!.id) ?? r.item!);
    notifyLibraryChanged(`import_files:${fresh.length}`);
    return { items, added: fresh.length, skipped, errors, converted };
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
   * 所以重复点这个按钮不会白烧 MinerU 的额度。
   */
  ipcMain.handle(IPC.LIBRARY_CONVERT, async (_evt, raw) => {
    const input = LibraryConvertSchema.parse(raw);
    const targets = input.ids?.length
      ? input.ids.map((id) => LibraryRepo.get(id)).filter((x): x is LibraryItem => Boolean(x))
      : LibraryRepo.list({ collectionId: input.collectionId, limit: 500 }).items;

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
    return { converted, failed };
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
   * 导出引用格式(GB/T 7714 / APA / BibTeX)到库根的 `exports/`。
   *
   * `reveal` 时顺手打开所在文件夹 —— 路径**由主进程自己拼**,渲染端始终拿不到
   * 「打开任意路径」的能力。
   */
  ipcMain.handle(IPC.LIBRARY_EXPORT_CITATIONS, async (_evt, raw) => {
    const input = LibraryExportSchema.parse(raw);
    const res = exportCitations({ style: input.style, collectionId: input.collectionId });
    if (!res.ok || !input.reveal) return res;
    // 导出已经成功,只是"顺手打开"这一步失败 —— 如实带上原因,但不改 ok
    const err = await openDirectory(dirname(res.path));
    return err ? { ...res, error: err } : res;
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
    const rel = wantMd ? item.mdPath : item.pdfPath;
    if (!rel) return { ok: false, error: wantMd ? "还没有转换产物" : "还没有 PDF" };
    const abs = fromLibraryRelative(rel);
    if (!existsSync(abs)) return { ok: false, error: `文件不在了:${rel}` };
    const err = await shell.openPath(abs);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle(IPC.LIBRARY_CONVERSION_STATS, () => LibraryRepo.conversionStats());

  /** 逐篇的转换完整度 —— 设置页「转录检测」列表。 */
  ipcMain.handle(IPC.LIBRARY_CONVERSION_REPORT, () => {
    const rows = conversionReport();
    const complete = rows.filter((r) => r.complete).length;
    return { rows, total: rows.length, complete, pending: rows.length - complete };
  });

  ipcMain.handle(IPC.LIBRARY_SEARCH_EXTERNAL, async (_evt, raw) => {
    const input = LibrarySearchSchema.parse(raw);
    return {
      results: await searchExternal({
        query: input.query,
        sources: input.sources,
        limit: input.limit,
        yearFrom: input.yearFrom,
        yearTo: input.yearTo,
      }),
    };
  });

  /**
   * 导入通道。不用 AI 也能走的确定路径:粘一段 DOI 列表或 BibTeX 即可。
   *
   * 与 `addItems` 的区别是**这里会联网补元数据** —— 导入的输入往往只有标识符
   * (一串 DOI),没有标题作者,不补的话入库就是一堆「(无标题)」。
   */
  ipcMain.handle(IPC.LIBRARY_IMPORT, async (_evt, raw) => {
    const input = LibraryImportSchema.parse(raw);
    // 实现搬到 operations.ts —— AI 的 library_import 工具走的是同一条路,
    // 免得"界面上导入"和"AI 导入"慢慢长出两套行为。
    const { items } = await importIdentifiers(input.text, {
      collectionIds: input.collectionIds,
      queueDownload: input.queueDownload,
    });
    return { items };
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

  /* ─────────────────────────── 库位置 ───────────────────────── */

  ipcMain.handle(IPC.LIBRARY_GET_ROOT, async () => ({ path: libraryRoot() }));
  ipcMain.handle(IPC.LIBRARY_SET_ROOT, async (_evt, raw) => {
    const input = LibrarySetRootSchema.parse(raw);
    SettingRepo.set(LIBRARY_ROOT_SETTING_KEY, input.path);
    return { path: libraryRoot() };
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
    // 实现在 library/manifest.ts —— AI 也能挂库(见 mcp/libraryServer.ts 的
    // library_attach_to_chat),两边共用同一份,免得长出两种清单格式。
    return writeItemManifest(input.id);
  });

  ipcMain.handle(IPC.LIBRARY_MANIFEST, async (_evt, raw) => {
    const input = LibraryManifestSchema.parse(raw);
    // 同上:实现搬去 library/manifest.ts,与 AI 的挂库共用。
    return writeCollectionManifest(input.collectionId);
  });

  /** 整个库的清单 —— 「全部文献 / 全部教材 / 全部笔记」那一行挂进对话时用的。 */
  ipcMain.handle(IPC.LIBRARY_KIND_MANIFEST, async (_evt, raw) => {
    const input = LibraryKindManifestSchema.parse(raw);
    return writeKindManifest(input.kind);
  });

  // 类型注册表:读是纯缓存读;写是整表替换(校验在 saveLibraryTypes 里,失败时把
  // 那句说人话的原样交回去 —— 渲染端显示它,不做二次加工)。
  ipcMain.handle(IPC.LIBRARY_TYPES_GET, async (_evt, raw) => {
    LibraryTypesGetSchema.parse(raw ?? {});
    return { types: loadLibraryTypes() };
  });
  ipcMain.handle(IPC.LIBRARY_TYPES_SAVE, async (_evt, raw) => {
    const input = LibraryTypesSaveSchema.parse(raw);
    return saveLibraryTypes(input.types);
  });
  ipcMain.handle(IPC.LIBRARY_GROUPS_GET, async (_evt, raw) => {
    LibraryGroupsGetSchema.parse(raw ?? {});
    return { groups: loadLibraryGroups() };
  });
  ipcMain.handle(IPC.LIBRARY_GROUPS_SAVE, async (_evt, raw) => {
    const input = LibraryGroupsSaveSchema.parse(raw);
    return saveLibraryGroups(input.groups);
  });

  // 通用文件条目:linked 只记路径、attached 复制进库(见 library/fileImport.ts)。
  // 指定了 collectionIds 就顺手归组 —— 和文献导入同一个体验,不用用户再点一遍。
  ipcMain.handle(IPC.LIBRARY_IMPORT_GENERIC, async (_evt, raw) => {
    const input = LibraryImportGenericSchema.parse(raw);
    const res = importGenericFiles({
      paths: input.paths,
      mode: input.mode,
      kind: input.kind,
    });
    if (input.collectionIds?.length) {
      for (const collectionId of input.collectionIds) {
        assignToCollection(collectionId, res.items.map((i) => i.id), true);
      }
    }
    notifyLibraryChanged(`import_generic:${res.added}`);
    return res;
  });

  ipcMain.handle(IPC.LIBRARY_READ_FILE, async (_evt, raw) => {
    const input = LibraryReadFileSchema.parse(raw);
    return { content: readEntryFile(input.id, input.relPath) };
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

  // 启动时把上次没跑完的队列接着跑(下载是分钟级操作,进程可能在中途退出)。
  // 必须等数据库就绪 —— 注册发生在 initDb() 之前,直接查会抛 "getDb() called
  // before initDb() resolved"。
  void awaitDb().then(() => processDownloadQueue());
}
