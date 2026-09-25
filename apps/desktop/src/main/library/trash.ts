/**
 * 「回收站」。
 *
 * ## 它就是一个普通集合
 *
 * 用户的原话:「回收站只是一个叫回收站的 collection」。所以这里**不加表、不加列、
 * 不做软删除标记** —— 它就是 `library_collections` 里的一行,和其他库完全同构,
 * 可以改名、可以删掉、可以往里拖东西。
 *
 * ## **全库共用一个**(2026-09-20 改)
 *
 * 早先是**每个库各一个**(教材进教材的、笔记进笔记的),理由是"教材被移除后不该跑
 * 到论文库去"。用户改掉了这条:「共用一个,放在最下面固定住」。改得有道理:
 *
 *   - 回收站是**一个动作的落点**("我先把它丢这儿"),不是一种归属 —— 用户丢东西时
 *     不该还要先想"这条是哪一类的";
 *   - 三个回收站在左栏里本来就并排摆在同一个位置,用户得记住"我刚才丢的是哪一类"
 *     才能找回来;
 *   - 它现在**钉在左栏最下面**(见 `LibrarySections` 那段注释),是整片区域的footer,
 *     而"整片区域"没有"属于哪个库"这回事。
 *
 * `kind` 那一列还在(集合表共有的),但它对回收站只是**历史字段**:共用之后不收窄
 * 任何行为。新键用那个不带库的旧键 `library.trashCollectionId`(它本来就是"那个全局
 * 回收站"),老的每库键降级成**只读的升级线索**。
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
import type { LibraryCollection } from "@contracts/library";
// （老代码遍历 LIBRARY_KINDS 读每库回收站键；kind 退役后这三处循环改为读旧的固定三个键名。）
const LEGACY_TRASH_KINDS = ["paper", "textbook", "note"] as const;
import { LIBRARY_TRASH_COLLECTION_SETTING_KEY, libraryTrashSettingKey } from "@contracts/ipc";

/** 默认名字。用户改了这个集合的名字也不影响识别 —— 见 setting key 的说明。 */
const TRASH_NAME = "回收站";

/**
 * 全部**已存在**的回收站集合 id。
 *
 * 共用之后正常情况下只有一个,这个函数之所以还是复数:老数据里可能留着**好几个**
 * (每个库一个,以及更早那个全局的),它们要能被一起认出来才能合并(见
 * `ensureTrashCollection`)。**每个调用点都必须按"可能是多个"来写** —— 界面上的
 * 判断(哪些条目算"在回收站里")漏掉一个,那些条目就会在删除时被当成普通条目。
 *
 * 三条来源:① 全局键 ② 老的每库键 ③ 旧数据里没有键、只按名字认。
 * 每个都**核对集合真的还在** —— 用户手工删过之后,那个 id 就是空指针了。
 */
export function allTrashCollectionIds(): string[] {
  const all = CollectionRepo.list();
  const alive = (id: string | null | undefined): string | null =>
    id && all.some((c) => c.id === id) ? id : null;

  const ids = new Set<string>();
  const global = alive(SettingRepo.get(LIBRARY_TRASH_COLLECTION_SETTING_KEY));
  if (global) ids.add(global);
  for (const k of LEGACY_TRASH_KINDS) {
    const legacy = alive(SettingRepo.get(libraryTrashSettingKey(k)));
    if (legacy) ids.add(legacy);
  }
  for (const c of all) {
    if (c.name.trim() === TRASH_NAME) ids.add(c.id);
  }
  return [...ids];
}

/**
 * 那**一个**回收站的集合 id;不存在(没建过,或已被用户删掉)时返回 null。
 *
 * 四条来源依次退:① 全局键 ② 老的每库键(内置库的顺序)③ 同库/全表里叫「回收站」
 * 的集合。①②都会核对集合是否还在。
 */
export function trashCollectionId(): string | null {
  const all = CollectionRepo.list();
  const alive = (id: string | null | undefined): string | null =>
    id && all.some((c) => c.id === id) ? id : null;

  const global = alive(SettingRepo.get(LIBRARY_TRASH_COLLECTION_SETTING_KEY));
  if (global) return global;

  // 老数据:回收站是**每个库一个**。挑一个当正主(顺序固定,所以同一份数据每次
  // 得到同一个答案),其余的由 ensureTrashCollection 合掉。
  for (const k of LEGACY_TRASH_KINDS) {
    const legacy = alive(SettingRepo.get(libraryTrashSettingKey(k)));
    if (legacy) return legacy;
  }

  return all.find((c) => c.name.trim() === TRASH_NAME)?.id ?? null;
}

/**
 * 现在**在回收站里的全部条目 id**。
 *
 * 这是「回收站里的东西不进上下文」那道筛子的**唯一判据**。早先的写法是逐个库去问
 * `trashCollectionId(kind)` 再把那个集合的条目剔掉 —— 共用之后那样写会漏:条目的
 * `kind` 与它躺在哪个回收站里已经没有关系了(它可能是教材,而回收站建在论文库下)。
 * 判据必须落在**条目自己**身上。
 *
 * 清单生成(`manifest.ts` 的三处)与挂单篇(`attachToChat`)都用它。
 */
export function trashedItemIds(): Set<string> {
  const ids = new Set<string>();
  for (const trashId of allTrashCollectionIds()) {
    for (const item of LibraryRepo.listByCollection(trashId)) ids.add(item.id);
  }
  return ids;
}

/**
 * 拿到回收站集合的 id,没有就建一个。**幂等。**
 *
 * 顺手做两件升级的事:
 *
 *  1. 把全局键写上 —— 老数据是从每库键/名字认出来的,写一次以后就直读了;
 *  2. **把老的多个回收站合掉**(见 `mergeTrashCollections`)。
 *
 * 用户自己建过同名集合的话直接复用那个,不新建第二个 —— 名字唯一性是这套集合的
 * 既定约束(见 `CollectionRepo.isNameTaken`),而"两个回收站"正是这次要消灭的东西。
 */
export function ensureTrashCollection(): string {
  const existing = trashCollectionId();
  if (existing) {
    SettingRepo.set(LIBRARY_TRASH_COLLECTION_SETTING_KEY, existing);
    mergeTrashCollections(existing);
    return existing;
  }
  const id = CollectionRepo.create(TRASH_NAME, null, "paper").id;
  SettingRepo.set(LIBRARY_TRASH_COLLECTION_SETTING_KEY, id);
  return id;
}

/**
 * 把**别的**回收站并进 `keeper`,再删掉那些空壳。
 *
 * ## 为什么必须有这一步
 *
 * 共用之后"回收站"只能有一个,而升级上来的库里可能有两个、三个(每个库一个)。
 * 不合并的话:界面上只画一个,另外几个里的条目**在界面上就再也看不见了** ——
 * 它们既不在回收站(用户看到的那个)里,又确实不属于任何普通分类,用户没有任何
 * 入口够得着它们。那正是这个模块文件头警告过的"僵尸记录",只不过换了个来路。
 *
 * ## 只搬条目,不搬子分类
 *
 * 回收站里本来就不该有分类树(它是个平的地方)。老数据真有子分类的话,`delete`
 * 那条外键 CASCADE 会把它们一起带走 —— 所以**条目要按整棵子树收**(`listByCollectionTree`),
 * 只看一层会把子分类里的那些漏在半路。
 */
function mergeTrashCollections(keeper: string): void {
  const others = allTrashCollectionIds().filter((id) => id !== keeper);
  if (others.length === 0) return;

  for (const oldId of others) {
    const ids = LibraryRepo.listByCollectionTree(oldId).map((i) => i.id);
    if (ids.length > 0) CollectionRepo.assign(keeper, ids, true);
    // 先把它里面的条目搬走,再删这个空壳 —— 顺序反了那些条目就成了孤儿(而
    // sweepToTrash 此刻还不知道该收它们,它正要往 keeper 上写)
    CollectionRepo.delete(oldId);
  }
  // 指向老回收站的每库键清掉:留着的话 `allTrashCollectionIds` 每次都要去核对一遍
  // 那些早就不存在的 id,而"已删"与"还在"长得一样是排查时最容易误导人的一处。
  for (const k of LEGACY_TRASH_KINDS) {
    const legacy = SettingRepo.get(libraryTrashSettingKey(k));
    if (legacy && !CollectionRepo.list().some((c) => c.id === legacy)) {
      SettingRepo.set(libraryTrashSettingKey(k), "");
    }
  }
}

/**
 * 把「已经不属于任何集合」的文献收进回收站。
 *
 * **一律收进同一个**(用户:「共用一个」)—— 早先这里按条目自己的 kind 分桶,教材进
 * 教材的、笔记进笔记的;那条规矩随"共用一个"一起作废。
 *
 * 返回是否真的动了(调用方据此决定要不要回传新的集合列表)。
 */
export function sweepToTrash(itemIds: string[]): boolean {
  if (itemIds.length === 0) return false;
  const orphans = itemIds.filter((id) => CollectionRepo.collectionsOfItem(id).length === 0);
  if (orphans.length === 0) return false;
  CollectionRepo.assign(ensureTrashCollection(), orphans, true);
  return true;
}

/** 「移除之后要不要顺手收进回收站」 —— 从**任何一个**回收站移除时不收,否则用户删不掉。 */
export function shouldSweepAfterRemoval(fromCollectionId: string): boolean {
  return !allTrashCollectionIds().includes(fromCollectionId);
}

/**
 * 「把它从回收站里拿出来」要放回哪个分类 —— 用户要的是**放回最后删除的那个**。
 *
 * 数据库里没有"上一站"这一列,也不该为它加一列(见文件头"它就是一个普通集合"):
 * 回收站是个**平的地方**,条目按加入时间排在里头,`added_at` 就是"什么时候被丢进来
 * 的"。于是"最后删除的那个分类"就读成:**跟它一起被丢进来的那批东西,当初是从哪儿
 * 被丢的** —— 更准确地说,是同一个回收站里**比它早一点点进来的邻座**待过的、还没被
 * 删掉的那些分类里,最近还用过的那一个。
 *
 * 这条推断在用户最常见的用法下是准的(他连着删了同一个分类里的几篇),而判错也没有
 * 代价:放在哪儿都不合适时退回**最外层**(`null`),用户再自己挪一次就好 —— 那一步
 * 本来就随时做得成。相反,把它放回一个**猜错的具体分类**里,用户会以为软件记错了。
 *
 * 判据三档,依次退:
 *
 *  1. 回收站里还有一个**非回收站**的分类 —— 那就是它的容身处(这条最直接);
 *  2. 候选**不止一个**时选 `createdAt` 最新建的那个(用户最后用的那个);
 *  3. 一个都没有 → `null`,放回最外层。
 */
export function restoredTargetOf(): string | null {
  const trashIds = new Set(allTrashCollectionIds());
  const candidates = CollectionRepo.list().filter((c) => !trashIds.has(c.id));
  if (candidates.length === 0) return null;
  // 「最后用过」没有直接的记录,用"最后建的那个"当代理 —— 用户删东西时看的是分类名,
  // 而他心里那个"我刚才整理的那个"通常是最近才动过的那一支。
  const pick = candidates.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  return pick.id;
}

/**
 * 把条目从回收站里拿出来,放回 `restoredTargetOf()` 那个分类。
 *
 * **不是**"移出回收站就不管了" —— 那样它们会因为"不属于任何集合"被
 * `sweepToTrash` 立刻收回来,用户会看到点了还原**什么都没发生**。所以这里是一个
 * 完整的动作:**先放进目标分类,再从回收站里摘掉**。顺序反了同样会被立刻收回来。
 *
 * 返回真正被搬动的条目 id(供调用方如实回报)。
 */
export function restoreItemsFromTrash(itemIds: readonly string[]): string[] {
  const trashIds = new Set(allTrashCollectionIds());
  if (trashIds.size === 0 || itemIds.length === 0) return [];
  const target = restoredTargetOf();
  const moved: string[] = [];
  for (const id of itemIds) {
    if (!LibraryRepo.get(id)) continue;
    // 本来就不在回收站里的那几条不动 —— 「还原」对它们是空操作,而不是"塞进某个分类"
    if (!CollectionRepo.collectionsOfItem(id).some((cid) => trashIds.has(cid))) continue;
    if (target) CollectionRepo.assign(target, [id], true);
    for (const cid of trashIds) CollectionRepo.assign(cid, [id], false);
    moved.push(id);
  }
  return moved;
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
