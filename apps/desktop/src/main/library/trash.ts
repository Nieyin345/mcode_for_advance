/**
 * 「回收站」。
 *
 * ## 它就是一个普通集合
 *
 * 用户的原话:「回收站只是一个叫回收站的 collection」。所以这里**不加表、不加列、
 * 不做软删除标记** —— 它就是 `library_collections` 里的一行,和其他库完全同构,
 * 可以改名、可以删掉、可以往里拖东西。
 *
 * ## 什么时候进回收站
 *
 * **当一篇文献不再属于任何集合时。** 也就是说「从当前文献库移除」「移动到别的库」
 * 这类操作把它变成孤儿之后,它不会凭空消失,而是落进回收站 —— 用户还能找回来。
 *
 * ## 什么时候真删
 *
 * **在回收站里删,才是真正的删除**(`library.deleteItems`:数据库行 + 磁盘上的
 * PDF/Markdown 一起删)。这条不在这个模块里,由 IPC 那一层直接调。
 *
 * ## 唯一需要小心的地方:别自己把自己收回来
 *
 * 「从回收站移除」也会让文献变成孤儿 —— 如果不加判断,它会立刻被重新收进回收站,
 * 用户根本删不掉。所以**从回收站本身移除时不收**。同理,删掉回收站这个集合时也不收
 * (那会把它又建出来)。
 */
import { SettingRepo, CollectionRepo, LibraryRepo } from "@main/store/repositories.js";
import { LIBRARY_KINDS, type LibraryCollection, type LibraryKind } from "@contracts/library";
import { LIBRARY_TRASH_COLLECTION_SETTING_KEY, libraryTrashSettingKey } from "@contracts/ipc";

/** 默认名字。用户改了这个集合的名字也不影响识别 —— 见 setting key 的说明。 */
const TRASH_NAME = "回收站";

/**
 * 某个库的回收站集合 id;不存在(没建过,或已被用户删掉)时返回 null。
 *
 * 三条来源依次退:① 这个库自己的设置键;② **论文库**回退读旧的全局键(老数据里那个
 * 回收站建在论文库下);③ 同库里叫「回收站」的集合(用户可能自己建过)。
 */
export function trashCollectionId(kind: LibraryKind): string | null {
  const inKind = (id: string | null | undefined): string | null =>
    id && CollectionRepo.list(kind).some((c) => c.id === id) ? id : null;

  const own = inKind(SettingRepo.get(libraryTrashSettingKey(kind)));
  if (own) return own;

  if (kind === "paper") {
    const legacy = inKind(SettingRepo.get(LIBRARY_TRASH_COLLECTION_SETTING_KEY));
    if (legacy) return legacy;
  }

  return CollectionRepo.list(kind).find((c) => c.name.trim() === TRASH_NAME)?.id ?? null;
}

/** 全部三个库的回收站 id(已存在的那些)。 */
export function allTrashCollectionIds(): string[] {
  return LIBRARY_KINDS.map((k) => trashCollectionId(k)).filter((id): id is string => !!id);
}

/**
 * 拿到回收站集合的 id,没有就建一个。**幂等。**
 *
 * 用户自己建过同名库的话直接复用那个,不新建第二个 —— 否则会出现两个"回收站",
 * 而名字唯一性是这套集合的既定约束(见 CollectionRepo.isNameTaken)。
 */
export function ensureTrashCollection(kind: LibraryKind): string {
  const existing = trashCollectionId(kind);
  if (existing) {
    // 顺手把新键写上 —— 老数据是从旧键/名字认出来的,写一次以后就直读了
    SettingRepo.set(libraryTrashSettingKey(kind), existing);
    return existing;
  }
  const id = CollectionRepo.create(TRASH_NAME, null, kind).id;
  SettingRepo.set(libraryTrashSettingKey(kind), id);
  return id;
}

/**
 * 把「已经不属于任何集合」的文献收进回收站。
 *
 * 返回是否真的动了(调用方据此决定要不要回传新的集合列表)。
 */
export function sweepToTrash(itemIds: string[]): boolean {
  if (itemIds.length === 0) return false;
  const orphans = itemIds.filter((id) => CollectionRepo.collectionsOfItem(id).length === 0);
  if (orphans.length === 0) return false;

  // **按条目自己的库分组收** —— 教材进教材的回收站,笔记进笔记的回收站。
  // 原来只有一个全局回收站(在论文库下),教材被移除后会跑到论文库去。
  const byKind = new Map<LibraryKind, string[]>();
  for (const id of orphans) {
    const item = LibraryRepo.get(id);
    if (!item) continue;
    const list = byKind.get(item.kind) ?? [];
    list.push(id);
    byKind.set(item.kind, list);
  }
  for (const [kind, ids] of byKind) {
    CollectionRepo.assign(ensureTrashCollection(kind), ids, true);
  }
  return true;
}

/** 「移除之后要不要顺手收进回收站」 —— 从**任何一个**回收站移除时不收,否则用户删不掉。 */
export function shouldSweepAfterRemoval(fromCollectionId: string): boolean {
  return !allTrashCollectionIds().includes(fromCollectionId);
}

/**
 * 给分类列表标上「谁是回收站」,再交给渲染端。
 *
 * 界面必须知道这件事,因为**在回收站里删东西是真正的删除**,而在别处删只是移出
 * 分组。少了这个标记,回收站里的右键菜单只能给出「从当前文献库移除」—— 那在那里
 * 恰好是反的:条目被摘出回收站、又没被删掉,变成界面上再也找不回来的僵尸记录。
 *
 * 标在这一层(而不是 `CollectionRepo.list`)是因为识别规则要用到本模块,而本模块
 * 依赖 repos —— 反过来引会成环。
 */
export function markTrashCollections(cols: LibraryCollection[]): LibraryCollection[] {
  const ids = new Set(allTrashCollectionIds());
  return cols.map((c) => (ids.has(c.id) ? { ...c, isTrash: true } : c));
}
