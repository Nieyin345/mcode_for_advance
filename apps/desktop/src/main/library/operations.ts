/**
 * 库的**写操作** —— IPC handler 与 AI 工具(mcode-library MCP server)共用这一份实现。
 *
 * ## 为什么不能各写一份
 *
 * 这几件事都不平凡:
 *   - 导入:先按标识符联网补元数据,再入库,最后**排队下载**;
 *   - 归入分类:顺手要把条目从回收站里摘出来(它只在"不属于任何非回收站分类"时才
 *     该待在回收站);
 *   - 从分类移除:移除后如果它成了孤儿,要收进回收站,而不是让它凭空消失。
 *
 * 各写一份的话,这些分支迟早分叉 —— 界面上做一件事、AI 做同一件事却得到不同结果,
 * 是最难查的一类 bug(而且用户会觉得"AI 把我东西弄没了")。所以两边都调这里。
 *
 * ## 这些操作都走内存里的数据库
 *
 * 它们**必须**在主进程里执行(和界面共用同一个 sql.js 实例)。这也是为什么 AI 的
 * 写操作走 MCP 工具而不是脚本:`<数据根>/workflows/scripts/` 下那些 Python 脚本
 * 直接读 `mcode.db` 文件是安全的,**写**则会被应用的下一次整库重写覆盖掉。
 */
import type { LibraryItem, LibraryKind, LibraryAuthor, LibraryItemType } from "@contracts/library";
import { LibraryRepo, CollectionRepo } from "@main/store/repositories.js";
import { parseImportText } from "./importer.js";
import { fetchByDoi, fetchByArxivId, findOpenAccessPdfUrl } from "./metadata.js";
import { arxivIdFromDoi } from "./oaResolvers.js";
import { enqueueDownloads, PDF_URL_RE } from "./downloader.js";
import { allTrashCollectionIds, shouldSweepAfterRemoval, sweepToTrash } from "./trash.js";
import { log } from "@main/lib/logger.js";

/**
 * 把一段自由文本(DOI 列表 / arXiv 列表 / BibTeX)解析、补齐元数据、入库、排队下载。
 *
 * 返回**逐条的结果**,而不是只返回成功的那些:AI 导入 20 条时,它需要知道哪几条
 * 没成、为什么 —— 否则它只会告诉用户"导入完成",而实际少了三篇。
 */
export interface ImportOutcome {
  /** 成功入库的条目(新建的或命中的已有条目)。 */
  items: LibraryItem[];
  /** 解析出来但没能入库的,连同原因。 */
  failed: Array<{ raw: string; reason: string }>;
}

export async function importIdentifiers(
  text: string,
  opts: { collectionIds?: string[]; queueDownload?: boolean } = {},
): Promise<ImportOutcome> {
  const parsed = parseImportText(text);
  const items: LibraryItem[] = [];
  const failed: ImportOutcome["failed"] = [];

  for (const entry of parsed) {
    if (!entry.doi && !entry.arxivId && !entry.title) {
      failed.push({ raw: entry.raw, reason: "看不出是 DOI、arXiv ID 还是 BibTeX 条目" });
      continue;
    }
    // 类型**显式写出来**,不靠字面量推断:下面几处会往里补字段(url 存开放获取直链、
    // arxivId 从 arXiv 的 DOI 换算),推断出来的类型上没有这些字段,赋值会报错。
    let meta: {
      doi?: string;
      arxivId?: string;
      title?: string;
      authors?: LibraryAuthor[];
      year?: number;
      venue?: string;
      type?: LibraryItemType;
      url?: string;
    } = {
      doi: entry.doi,
      arxivId: entry.arxivId,
      title: entry.title,
      authors: entry.authors,
      year: entry.year,
      venue: entry.venue,
      type: entry.type,
    };

    // 只有标识符、没有标题时联网补齐。补不上**不阻断** —— 元数据缺了照样入库,
    // 详情面板会标「待补全」,用户之后可以自己填。
    if (!meta.title) {
      try {
        const fetched = meta.doi
          ? await fetchByDoi(meta.doi)
          : meta.arxivId
            ? await fetchByArxivId(meta.arxivId)
            : null;
        if (fetched) meta = { ...meta, ...fetched, doi: meta.doi ?? fetched.doi };
      } catch (err) {
        log.warn(`import metadata fetch failed (${entry.raw}): ${(err as Error).message}`);
      }
    }

    // arXiv 的 DOI(`10.48550/arXiv.2302.01934`)认成 arxivId。
    // 不认的话:① 同一篇会以两条记录入库(一条按 DOI、一条按 arxivId);
    // ② 下载器看不出这是 arXiv,只能去 doi.org 的落地页 —— 那是网页,下不了。
    if (!meta.arxivId) {
      const fromDoi = arxivIdFromDoi(meta.doi);
      if (fromDoi) meta = { ...meta, arxivId: fromDoi };
    }

    // 手上没有 PDF 直链时,问一次 OpenAlex 有没有开放获取版本。
    //
    // **这一步是「导入成功但全都下载失败」的解药**:Crossref 给的 url 是
    // `https://doi.org/...` 落地页,而下载器只认 PDF 直链。OpenAlex 对不少论文给出
    // 出版社 OA 版 / arXiv 副本 / 机构库的 pdf_url,存进 url 之后下载那步就能成。
    // 查不到、或网络失败都只是"这一篇没有现成 OA",不影响入库。
    if (meta.doi && !(meta.url && PDF_URL_RE.test(meta.url))) {
      try {
        const oa = await findOpenAccessPdfUrl(meta.doi);
        if (oa) meta = { ...meta, url: oa };
      } catch (err) {
        log.warn(`OA pdf lookup failed (${meta.doi}): ${(err as Error).message}`);
      }
    }

    try {
      const item = LibraryRepo.upsert({ ...meta, source: "import" });
      if (opts.collectionIds?.length) {
        for (const cid of opts.collectionIds) assignToCollection(cid, [item.id], true);
      }
      items.push(item);
    } catch (err) {
      failed.push({ raw: entry.raw, reason: (err as Error).message });
    }
  }

  if (opts.queueDownload !== false && items.length > 0) {
    enqueueDownloads(items.map((i) => i.id));
  }
  return { items, failed };
}

/**
 * 把条目加进/移出某个分类。
 *
 * 加进去时要**顺手把它从回收站摘出来** —— 条目只在"不属于任何非回收站分类"时才该
 * 待在回收站。少了这一步,每篇文献都会永远挂着回收站。
 *
 * 移出来时,如果它因此成了孤儿,收进回收站而不是让它凭空消失(用户的原话是
 * 「在哪里,我也移不了呀」—— 条目不能有"不在任何地方"这个状态)。
 */
export function assignToCollection(collectionId: string, itemIds: string[], add: boolean): void {
  if (itemIds.length === 0) return;
  CollectionRepo.assign(collectionId, itemIds, add);
  if (add) {
    for (const trashId of allTrashCollectionIds()) {
      if (trashId !== collectionId) CollectionRepo.assign(trashId, itemIds, false);
    }
  } else if (shouldSweepAfterRemoval(collectionId)) {
    sweepToTrash(itemIds);
  }
}

/**
 * 从库里拿走这几条 —— 移出所有分类,于是成为孤儿,落进回收站。
 *
 * 刻意**不做硬删除**:`LibraryRepo.delete` 是不可逆的,而 AI 的"删除"是它自己判断
 * 出来的动作,判断错了用户得有得救。回收站是这个应用既有的、用户看得懂的兜底。
 * 用户真要从回收站里彻底清掉,在界面上做。
 *
 * 返回真正落进回收站的条目 id(供调用方如实回报)。
 */
export function removeItemsToTrash(itemIds: string[]): string[] {
  const moved: string[] = [];
  for (const id of itemIds) {
    const item = LibraryRepo.get(id);
    if (!item) continue;
    // 先摘出它现在所属的全部分类(回收站除外 —— 摘了还得再放回去)
    const trashIds = new Set(allTrashCollectionIds());
    for (const cid of CollectionRepo.collectionsOfItem(id)) {
      if (!trashIds.has(cid)) CollectionRepo.assign(cid, [id], false);
    }
    moved.push(id);
  }
  if (moved.length > 0) sweepToTrash(moved);
  return moved;
}

/** 改一条的标题。返回是否真的改到了(找不到就是 false,由调用方如实回报)。 */
export function renameItem(id: string, title: string): boolean {
  const item = LibraryRepo.get(id);
  if (!item) return false;
  LibraryRepo.setTitle(id, title.trim());
  return true;
}

/** 按关键词找条目。给 AI 用:它需要"库里有没有这一篇"的确定答案。 */
export function searchItems(query: string, kind?: LibraryKind): LibraryItem[] {
  const q = query.trim().toLowerCase();
  const all = LibraryRepo.list({ kind }).items;
  if (!q) return all;
  return all.filter((i) => {
    const hay = [
      i.title,
      i.venue ?? "",
      i.abstract ?? "",
      i.doi ?? "",
      i.arxivId ?? "",
      i.year ? String(i.year) : "",
      i.authors.map((a) => a.literal ?? [a.given, a.family].filter(Boolean).join(" ")).join(" "),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}
