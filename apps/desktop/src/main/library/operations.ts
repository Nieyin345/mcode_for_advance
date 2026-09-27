/**
 * 库的**写操作** —— IPC handler 与 AI 工具(mcode-library MCP server)共用这一份实现。
 *
 * ## 为什么不能各写一份
 *
 * 这几件事都不平凡:
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
import type { LibraryItem } from "@contracts/library";
import { LibraryRepo, CollectionRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import { allTrashCollectionIds, shouldSweepAfterRemoval, sweepToTrash } from "./trash.js";

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

/** 导入时归入选定分类；重复导入现有条目也要归入，且在发导入事件之前完成。
 * 已失效的分类 id 跳过（批量导入不能因一处旧 id 全盘失败）。
 * 共用 assignToCollection 的回收站摘除规则，避免 PDF / 通用文件走成两套行为。 */
export function assignImportedToCollections(itemId: string, collectionIds?: readonly string[]): void {
  if (!collectionIds?.length) return;
  const known = new Set(CollectionRepo.list().map((c) => c.id));
  for (const cid of collectionIds) {
    if (!known.has(cid)) {
      log.warn(`library: 导入时指定的分类 ${cid} 不存在,跳过归属(${itemId})`);
      continue;
    }
    assignToCollection(cid, [itemId], true);
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
export function searchItems(query: string): LibraryItem[] {
  const q = query.trim().toLowerCase();
  // list() 默认只返回 200 条；给 AI 的库内搜索不能把更旧的条目静默漏掉。
  const all = LibraryRepo.listAllItems();
  if (!q) return all;
  return all.filter((i) => {
    const hay = [i.title, i.abstract ?? "", i.filePath ?? "", i.url ?? ""]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}
