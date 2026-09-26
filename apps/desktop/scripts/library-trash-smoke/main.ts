/**
 * Headless smoke for **`main/library/trash.ts`** —— 「孤儿条目去哪儿」。
 *
 * ## 为什么单独一套
 *
 * 这个模块零覆盖,而它管的是**用户看不见的数据归属**:
 *
 *  - 「从当前文献库移除」把条目变成孤儿,不收的话它就从左栏消失 —— 用户以为删掉了,
 *    其实还在库里占着磁盘;
 *  - 但**从回收站本身移除时绝不能收**(否则用户永远删不掉东西,`sweepToTrash` 把它
 *    又捞回来);
 *  - 收的时候**全库共用一个**(2026-09-20 改的;早先是每个库各一个)。
 *
 * ## 2026-09-20:从「每库一个」改成「全库一个」
 *
 * 用户的原话:「我之前说的共用一个,放在最下面固定住」。所以这一套的第二、三节整个
 * 换了判据 —— 原来断的是"笔记进了笔记库的回收站、没跑去论文库",现在要断的恰好相反:
 * **两个库的东西落进同一个回收站**。
 *
 * 改这一条最危险的不是新逻辑,而是**老数据**:升级上来的库里可能同时躺着两三个回收站
 * (每个库一个)。界面只画一个,另外几个里的条目就再也够不着了 —— 所以
 * `ensureTrashCollection` 必须顺手把它们合掉。§3 钉的就是这一步。
 *
 * ## §4 走的是**真的那条 handler**,不是复述
 *
 * ⚠️ 第一版 §4 是复述的:自己写一句 `LibraryRepo.listByCollectionTree(父)` 再
 * `sweepToTrash`,意思是"handler 现在就是这么查的"。**那验的是一份副本。** 有人把
 * handler 里那个方法名换回不递归的那个,这套照样全绿 —— 因为本套从头到尾没碰过
 * handler 一行。这正是 CLAUDE.md 里那句「套件跑绿但**根本没覆盖到**被改的文件」。
 *
 * 现在按 `library-delete-smoke` 的办法搭:`ipcMain` 的记名替身 + 按 channel 取回
 * 注册进去的真函数,然后**调那个用户动作本身**。
 *
 * ## 它不碰用户真正的库
 *
 * 数据根换成 `mktemp -d`,跑完就删。
 *
 * Run: scripts/library-trash-smoke/run.sh
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 数组比较。`Object.is` 对两个内容相同的数组是 false —— 这一套里好几处断的是
 *  "集合里正好是这几个",用 `eq` 会红得莫名其妙。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const DATA = mkdtempSync(join(tmpdir(), "mcode-trash-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

/* ──────────────── 0. 把真 handler 取出来 ──────────────── */

/**
 * `ipcMain` 的**记名替身**(抄 `library-delete-smoke` 的办法)。
 *
 * 删分类那条路的判据整个住在 handler 的**函数体**里,而它从来不是导出符号 —— 唯一
 * 拿得到的办法就是调 `registerLibraryHandlers`,把注册进来的那批函数按 channel 收下来。
 * 这是本套唯一需要的脚手架:不起 Electron,也没有真的 preload。
 */
const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

const { IPC } = await import("@contracts/ipc");
const { registerLibraryHandlers } = await import("@main/ipc/library.js");
registerLibraryHandlers(fakeIpc);

const { initDb } = await import("@main/store/db.js");
const { LibraryRepo, CollectionRepo, SettingRepo } = await import("@main/store/repositories.js");
const {
  trashCollectionId,
  allTrashCollectionIds,
  ensureTrashCollection,
  trashedItemIds,
  sweepToTrash,
  shouldSweepAfterRemoval,
  restoredTargetOf,
  restoreItemsFromTrash,
  markTrashCollections,
} = await import("@main/library/trash.js");
const { libraryTrashSettingKey, LIBRARY_TRASH_COLLECTION_SETTING_KEY } = await import(
  "@contracts/ipc"
);

await initDb();

function handlerFor(channel: string): (raw: unknown) => Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`registerLibraryHandlers 没有注册 ${channel}`);
  return (raw: unknown) => Promise.resolve(fn(null, raw));
}

/** 「删掉这个分类」—— **真的那条 IPC**。§4 只走它。 */
const deleteCollection = handlerFor(IPC.LIBRARY_DELETE_COLLECTION);
check("拿到了 deleteCollection 的 handler", handlers.has(IPC.LIBRARY_DELETE_COLLECTION));

/** 「从回收站还原」—— 也是真那条。§5 只走它。 */
const restoreItems = handlerFor(IPC.LIBRARY_RESTORE_ITEMS);
check("拿到了 restoreItems 的 handler", handlers.has(IPC.LIBRARY_RESTORE_ITEMS));

/* ──────────────── 1. 找回回收站:三条来源,依次退 ──────────────── */

console.log("\n回收站是哪一个");

// 一条都没建过时不该凭空认一个出来 —— 「找不到」和「找到了」的区别就是
// `ensureTrashCollection` 会不会新建一个集合。
eq("没建过 → null", trashCollectionId(), null);
same("一个都没建过 → 一个都没有", allTrashCollectionIds(), []);

// ③ 按名字认:老数据里那个回收站没有键,只有名字(`libraryTrashSettingKey` 是后加的)。
const byName = CollectionRepo.create("回收站", null, "note").id;
eq("没有设置键 → 按名字认出那个", trashCollectionId(), byName);

// ① 设置键优先于名字。
SettingRepo.set(LIBRARY_TRASH_COLLECTION_SETTING_KEY, "");
const created = ensureTrashCollection();
eq("设置键写上了", SettingRepo.get(LIBRARY_TRASH_COLLECTION_SETTING_KEY), created);
eq("按名字认出来的那个被复用,没新建", created, byName);
eq("再 ensure 一次是同一个(幂等)", ensureTrashCollection(), created);

// **设置键指向一个已经不存在的集合**(用户手工删过)时不能认它 —— 否则 sweep 会往
// 一个空 id 上 assign,条目静默消失。
SettingRepo.set(LIBRARY_TRASH_COLLECTION_SETTING_KEY, "lc_早就没了");
CollectionRepo.delete(byName);
const rebuilt = ensureTrashCollection();
check("指向不存在的集合 → 重新建一个", rebuilt !== "lc_早就没了" && rebuilt.length > 0);
eq("库里只有一个叫回收站的分类", CollectionRepo.list().filter((c) => c.name === "回收站").length, 1);

// ② 老的**每库键**是升级线索:老库里那个回收站建在论文库下,不能因为键改名了就
// 凭空多出第二个「回收站」。
SettingRepo.set(LIBRARY_TRASH_COLLECTION_SETTING_KEY, "");
SettingRepo.set(libraryTrashSettingKey("paper"), rebuilt);
eq("没有全局键时退回读老的每库键", trashCollectionId(), rebuilt);

/* ──────────────── 2. 别自己把自己收回来 ──────────────── */

console.log("\n从回收站移除时不收");

// 「从回收站移除」也会让条目变成孤儿。不加判断的话它会被立刻重新收进去,**用户根本
// 删不掉**。这条是整个模块存在的主要理由,必须钉住。
const trash = rebuilt;
eq("从回收站移除 → 不收", shouldSweepAfterRemoval(trash), false);
check("从普通分类移除 → 要收", shouldSweepAfterRemoval("lc_普通") === true);

/* ──────────────── 3. 收:**全库共用一个** ──────────────── */

console.log("\n收进回收站 · 全库共用一个");

const paperItem = LibraryRepo.upsert({ title: "一篇论文" }).id;
const noteItem = LibraryRepo.upsert({ title: "一条笔记" }).id;
const bookItem = LibraryRepo.upsert({ title: "一本教材" }).id;

// 三个都还没归属任何分类 = 孤儿,该被收。
eq("收三个孤儿 → 真动了", sweepToTrash([paperItem, noteItem, bookItem]), true);

// ★ **同一个地方**。早先这里断的是"笔记进了笔记库的、没跑去论文库",现在反过来:
// 三个库的东西落进同一个回收站,而且**只有这一个**。
const inTrash = LibraryRepo.listByCollection(trash).map((i) => i.id);
check("论文进了回收站", inTrash.includes(paperItem), inTrash);
check("★ 笔记也进了同一个(不再按库分桶)", inTrash.includes(noteItem), inTrash);
check("★ 教材也进了同一个", inTrash.includes(bookItem), inTrash);
same("★ 全库只有一个回收站", allTrashCollectionIds(), [trash]);
eq(
  "没有第二个叫回收站的分类冒出来",
  CollectionRepo.list().filter((c) => c.name === "回收站").length,
  1,
);

// `trashedItemIds` 是「回收站里的不算」那道筛子的**唯一判据**(清单与挂单篇都用它)。
same(
  "trashedItemIds 正好是这三条",
  [...trashedItemIds()].sort(),
  [paperItem, noteItem, bookItem].sort(),
);

// 一个**已经有归属**的条目不是孤儿,不该被顺手收走。
const kept = LibraryRepo.upsert({ title: "有分类的" }).id;
const home = CollectionRepo.create("方法", null, "paper").id;
CollectionRepo.assign(home, [kept], true);
eq("已经有归属的条目 → sweep 不动它", sweepToTrash([kept]), false);
eq("它还在原来的分类里", LibraryRepo.listByCollection(home).length, 1);
eq("它没进回收站", LibraryRepo.listByCollection(trash).some((i) => i.id === kept), false);
eq("它不在 trashedItemIds 里", trashedItemIds().has(kept), false);

// 空批次与全都不是孤儿,都返回 false(调用方据此决定要不要回传新列表)。
eq("空数组 → false", sweepToTrash([]), false);
eq("全都不是孤儿 → false", sweepToTrash([kept]), false);

/* ──────────────── 3b. 升级:老数据里那几个回收站要合掉 ──────────────── */

console.log("\n升级 · 老的多个回收站并成一个");

// 这一段模拟**升级上来的库**:全局键还没有,而两个库里各有一个回收站(老写法)。
// 不合并的话界面上只画一个,另一个里的条目就再也够不着了 —— 它既不在用户看到的
// 那个回收站里,又确实不属于任何普通分类。那是这个模块文件头警告过的僵尸记录。
{
  SettingRepo.set(LIBRARY_TRASH_COLLECTION_SETTING_KEY, "");
  /**
   * ⚠️ **两个老回收站是直接写库造出来的,而且必须是这样。**
   *
   * 回收站的识别规则是「名字**正好**是『回收站』」（见 `allTrashCollectionIds` 的
   * 第三条来源），所以老数据的真实形状是**好几个同名的**「回收站」—— 老写法里
   * `isNameTaken` 只在自己那个库内查重，每个库各建一个同名的不算冲突。
   *
   * kind 退役后 `isNameTaken` 改成**全库唯一**，公开的 `create` 再也造不出这个形状
   * 了。于是照 `library-move-smoke` §4 的办法：直接写两行，模拟升级上来的那份数据 ——
   * 升级路径存在的理由本来就是「老库里已经有这种数据了」。
   */
  const legacyNote = CollectionRepo.create("老二", null).id;
  const legacyBook = CollectionRepo.create("老三", null).id;
  const { getDb } = await import("@main/store/db.js");
  getDb().run("UPDATE library_collections SET name = ? WHERE id IN (?, ?)", [
    "回收站",
    legacyNote,
    legacyBook,
  ]);
  const stranded = LibraryRepo.upsert({ title: "躺在老二里的笔记" }).id;
  CollectionRepo.assign(legacyNote, [stranded], true);
  const oldTrash = CollectionRepo.list().filter((c) => c.id !== rebuilt && allTrashCollectionIds().includes(c.id));
  eq("老数据里有两个别的回收站", oldTrash.length, 2);

  const keeper = ensureTrashCollection();
  check("合并之后只剩一个", allTrashCollectionIds().length === 1, allTrashCollectionIds());

  // ★ 老二里的那条**必须在正主里看得到** —— 这是这一步存在的全部意义。
  check(
    "★ 老二里的条目被搬进正主了",
    LibraryRepo.listByCollection(keeper).some((i) => i.id === stranded),
    LibraryRepo.listByCollection(keeper).map((i) => i.title),
  );
  eq(
    "老壳都删掉了(只剩正主这一个叫回收站的)",
    CollectionRepo.list().filter((c) => c.name === "回收站").length,
    1,
  );
  check("正主不是空壳", LibraryRepo.get(stranded) !== undefined);
  same("trashedItemIds 里能看到它", [...trashedItemIds()].includes(stranded), true);
}

/* ──────────────── 4. 删一个**父**分类 —— 走真的那条 IPC ──────────────── */

console.log("\n删父分类 · 整棵子树的成员都要有归属");

// 这一段**只做一个用户动作**:`await deleteCollection({ id: parent })`。下面所有断言
// 都是它的**结果**,没有一句在复述 handler 内部的写法 —— 这样哪天有人把 handler 里
// 那句查询换回不递归的版本,★ 那两条会立刻红。
{
  const parent = CollectionRepo.create("父分类", null, "paper").id;
  const child = CollectionRepo.create("子分类", parent, "paper").id;
  const grand = CollectionRepo.create("孙分类", child, "paper").id;
  const direct = LibraryRepo.upsert({ title: "挂在父上" }).id;
  const under = LibraryRepo.upsert({ title: "只挂在子上" }).id;
  const deep = LibraryRepo.upsert({ title: "只挂在孙子上" }).id;
  CollectionRepo.assign(parent, [direct], true);
  CollectionRepo.assign(child, [under], true);
  CollectionRepo.assign(grand, [deep], true);

  await deleteCollection({ id: parent });

  const inTrashOf = (id: string): boolean =>
    LibraryRepo.listByCollection(trash).some((i) => i.id === id);

  eq("挂在父上的被收进回收站", inTrashOf(direct), true);
  // ★ 下面两条是这一段存在的理由:它们在**树上更深的两层**,而用户看不出来差别。
  eq("★ 只挂在子分类里的也被收进回收站了", inTrashOf(under), true);
  eq("★ 只挂在孙分类里的也一样(整棵子树,不是只看一层)", inTrashOf(deep), true);

  // 三个分类自己也确实跟着没了 —— 那是外键 CASCADE 在干,不是这次改的。
  // ⚠️ `CollectionRepo.list()` 给的是数组,所以这里断的是"结果里没有它们",不是
  // `undefined`(那不是这个 API 的返回形状)。
  eq(
    "父/子/孙三个分类都不在了(CASCADE)",
    CollectionRepo.list().some((c) => [parent, child, grand].includes(c.id)),
    false,
  );
  // 条目本身还在库里 —— 删分类只动分组,不动文献。不收进回收站的话它们就是孤儿。
  check(
    "三条记录都还在库里(删分类不删文献)",
    [direct, under, deep].every((id) => LibraryRepo.get(id) !== undefined),
  );
}

/* ──────────────── 5. 还原:放回「最后删除的那个分类」 ──────────────── */

console.log("\n还原");

// 用户的要求是「回收站的还原也是还原到最后删除的那个 collection」。数据库里没有
// "上一站"这一列,判据是"最近建的那个非回收站分类"(见 `restoredTargetOf`)。
{
  // 造一个**明确最新**的分类当目标 —— 用户心里那个"我刚才整理的那一支"。
  const latest = CollectionRepo.create("最近用的分类", null, "paper").id;
  eq("还原目标 = 最近建的那个", restoredTargetOf(), latest);

  const lone = LibraryRepo.upsert({ title: "在回收站里的一条" }).id;
  CollectionRepo.assign(trash, [lone], true);
  eq("它在回收站里", LibraryRepo.listByCollection(trash).some((i) => i.id === lone), true);

  const moved = restoreItemsFromTrash([lone]);
  same("还原动了它一条", moved, [lone]);
  // ★ 两件事**必须一起做**:进了目标分类,而且**从回收站里摘掉了**。少了后半步它会被
  // `sweepToTrash` 立刻收回去,用户看到的是"点了还原什么都没发生"。
  check("★ 它回到了目标分类", LibraryRepo.listByCollection(latest).some((i) => i.id === lone));
  eq("★ 它不在回收站里了", LibraryRepo.listByCollection(trash).some((i) => i.id === lone), false);
  eq("它不在 trashedItemIds 里了", trashedItemIds().has(lone), false);

  // 本来就不在回收站里的那几条 → 空操作(不是"塞进某个分类")。
  const outsider = LibraryRepo.upsert({ title: "从来没进过回收站" }).id;
  CollectionRepo.assign(home, [outsider], true);
  same("不在回收站里的不动它", restoreItemsFromTrash([outsider]), []);
  eq(
    "而且它没被搬走(还在原来那个分类里)",
    LibraryRepo.listByCollection(home).some((i) => i.id === outsider),
    true,
  );

  // 走**真的那条 IPC**:它除了搬东西,还要回传新的完整列表(变更类 handler 的既定约定)。
  const viaIpc = LibraryRepo.upsert({ title: "走 IPC 还原的一条" }).id;
  CollectionRepo.assign(trash, [viaIpc], true);
  const res = (await restoreItems({ ids: [viaIpc] })) as { items: unknown[] };
  check("IPC 回传了完整列表", Array.isArray(res.items) && res.items.length > 0);
  check("IPC 之后它回到目标分类", LibraryRepo.listByCollection(latest).some((i) => i.id === viaIpc));
  eq("IPC 之后它不在回收站里", LibraryRepo.listByCollection(trash).some((i) => i.id === viaIpc), false);

  // **一个普通分类都没有**时退回最外层 —— 而不是随便塞进某个地方。
  // (把非回收站的分类全删掉,只剩回收站。)
  for (const c of CollectionRepo.list()) {
    if (!allTrashCollectionIds().includes(c.id)) CollectionRepo.delete(c.id);
  }
  eq("没有普通分类了 → 目标为 null", restoredTargetOf(), null);
  const floating = LibraryRepo.upsert({ title: "没地方可放的一条" }).id;
  CollectionRepo.assign(trash, [floating], true);
  same("放回最外层也算还原成功", restoreItemsFromTrash([floating]), [floating]);
  eq("它出了回收站", LibraryRepo.listByCollection(trash).some((i) => i.id === floating), false);
}

/* ──────────────── 6. 给界面标「谁是回收站」 ──────────────── */

console.log("\n标给界面");

// 少了这个标记,回收站里的右键菜单只能给出「从当前文献库移除」—— 而那在那里恰好是
// **反的**:条目被摘出回收站又没被删掉,变成同一类僵尸记录。
{
  const cols = CollectionRepo.list();
  const marked = markTrashCollections(cols);
  const flagged = marked.filter((c) => c.isTrash).map((c) => c.id).sort();
  const expected = allTrashCollectionIds().slice().sort();
  same("标出来的正好是那几个回收站", flagged, expected);
  eq("原数组没被就地改", cols.some((c) => c.isTrash === true), false);
}

rmSync(DATA, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
