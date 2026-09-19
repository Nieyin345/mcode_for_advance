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
 *  - 收的时候要**按条目自己的库**分组 —— 教材进教材的回收站,不是三个库共用一个。
 *
 * ## 这一套钉住的那条缝(2026-09-20 已修)
 *
 * 分类是**树**(`library_collections.parent_id REFERENCES library_collections(id)
 * ON DELETE CASCADE`),而删分类那条 IPC 原来只查 `LibraryRepo.listByCollection(父)`,
 * 那个查询**不递归**。于是同一个用户动作(「删掉这个分类」)的结果取决于一个他看不见
 * 的结构细节:条目挂在被删的那一层就有人收,挂在**它的子分类**下就没人收 —— 成员关系
 * 被 CASCADE 静默摘掉,条目从此既不在回收站里、也没被删,变成界面上找不回来的僵尸记录。
 * 那正是 `trash.ts` 自己文件头警告过的东西。
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
  sweepToTrash,
  shouldSweepAfterRemoval,
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

/* ──────────────── 1. 找回回收站:三条来源,依次退 ──────────────── */

console.log("\n回收站是哪一个");

// 一条都没建过时不该凭空认一个出来 —— 「找不到」和「找到了」的区别就是
// `ensureTrashCollection` 会不会新建一个集合。
eq("没建过 → null", trashCollectionId("paper"), null);
same("三个库都没建过 → 一个都没有", allTrashCollectionIds(), []);

// ① 这个库自己的设置键。
const paperTrash = ensureTrashCollection("paper");
check("ensure 建出来了", typeof paperTrash === "string" && paperTrash.length > 0);
eq("设置键写上了", SettingRepo.get(libraryTrashSettingKey("paper")), paperTrash);
eq("再 ensure 一次是同一个(幂等)", ensureTrashCollection("paper"), paperTrash);
eq(
  "库里只有一个叫回收站的分类",
  CollectionRepo.list("paper").filter((c) => c.name === "回收站").length,
  1,
);

// ② **论文库**回退读旧的全局键 —— 老数据里那个回收站建在论文库下,升级上来的用户
// 不能因为键改名了就凭空多出第二个「回收站」。
SettingRepo.set(libraryTrashSettingKey("textbook"), "");
SettingRepo.set(LIBRARY_TRASH_COLLECTION_SETTING_KEY, paperTrash);
eq("论文库读旧全局键", trashCollectionId("paper"), paperTrash);

// ①②都不成立时 ③ 按名字认。
const byName = CollectionRepo.create("回收站", null, "note").id;
eq("笔记库没有设置键 → 按名字认出那个", trashCollectionId("note"), byName);

// **设置键指向一个已经不存在的集合**(用户手工删过)时不能认它 —— 否则 sweep 会往
// 一个空 id 上 assign,条目静默消失。
SettingRepo.set(libraryTrashSettingKey("note"), "lc_早就没了");
eq("设置键指向不存在的集合 → 退回按名字认", trashCollectionId("note"), byName);

/* ──────────────── 2. 别自己把自己收回来 ──────────────── */

console.log("\n从回收站移除时不收");

// 「从回收站移除」也会让条目变成孤儿。不加判断的话它会被立刻重新收进去,**用户根本
// 删不掉**。这条是整个模块存在的主要理由,必须钉住。
eq("从论文库回收站移除 → 不收", shouldSweepAfterRemoval(paperTrash), false);
eq("从笔记库回收站移除 → 不收", shouldSweepAfterRemoval(byName), false);
check("从普通分类移除 → 要收", shouldSweepAfterRemoval("lc_普通") === true);

/* ──────────────── 3. 收:按条目自己的库分组 ──────────────── */

console.log("\n收进回收站");

const paperItem = LibraryRepo.upsert({ kind: "paper", title: "一篇论文", source: "manual" }).id;
const noteItem = LibraryRepo.upsert({ kind: "note", title: "一条笔记", source: "manual" }).id;

// 两个都还没归属任何分类 = 孤儿,该被收。
eq("收两个孤儿 → 真动了", sweepToTrash([paperItem, noteItem]), true);

// **各回各的库**:笔记不该跑到论文库的回收站里去。
const inPaper = LibraryRepo.listByCollection(paperTrash).map((i) => i.id);
const noteTrash = ensureTrashCollection("note");
const inNote = LibraryRepo.listByCollection(noteTrash).map((i) => i.id);
check("论文进了论文库的回收站", inPaper.includes(paperItem), inPaper);
check("笔记进了笔记库的回收站,没跑去论文库", inNote.includes(noteItem), inNote);
eq("论文库的回收站里没有那条笔记", inPaper.includes(noteItem), false);

// 一个**已经有归属**的条目不是孤儿,不该被顺手收走。
const kept = LibraryRepo.upsert({ kind: "paper", title: "有分类的", source: "manual" }).id;
const home = CollectionRepo.create("方法", null, "paper").id;
CollectionRepo.assign(home, [kept], true);
eq("已经有归属的条目 → sweep 不动它", sweepToTrash([kept]), false);
eq("它还在原来的分类里", LibraryRepo.listByCollection(home).length, 1);
eq("它没进回收站", LibraryRepo.listByCollection(paperTrash).some((i) => i.id === kept), false);

// 空批次与全都不是孤儿,都返回 false(调用方据此决定要不要回传新列表)。
eq("空数组 → false", sweepToTrash([]), false);
eq("全都不是孤儿 → false", sweepToTrash([kept]), false);

/* ──────────────── 4. 删一个**父**分类 —— 走真的那条 IPC ──────────────── */

console.log("\n删父分类 · 整棵子树的成员都要有归属");

// 这一段**只做一个用户动作**:`await deleteCollection({ id: parent })`。下面所有断言
// 都是它的**结果**,没有一句在复述 handler 内部的写法 —— 这样哪天有人把 handler 里
// 那句查询换回不递归的版本,★ 那两条会立刻红。
{
  const parent = CollectionRepo.create("父分类", null, "paper").id;
  const child = CollectionRepo.create("子分类", parent, "paper").id;
  const grand = CollectionRepo.create("孙分类", child, "paper").id;
  const direct = LibraryRepo.upsert({ kind: "paper", title: "挂在父上", source: "manual" }).id;
  const under = LibraryRepo.upsert({ kind: "paper", title: "只挂在子上", source: "manual" }).id;
  const deep = LibraryRepo.upsert({ kind: "paper", title: "只挂在孙子上", source: "manual" }).id;
  CollectionRepo.assign(parent, [direct], true);
  CollectionRepo.assign(child, [under], true);
  CollectionRepo.assign(grand, [deep], true);

  await deleteCollection({ id: parent });

  const inTrash = (id: string): boolean =>
    LibraryRepo.listByCollection(paperTrash).some((i) => i.id === id);

  eq("挂在父上的被收进回收站", inTrash(direct), true);
  // ★ 下面两条是这一段存在的理由:它们在**树上更深的两层**,而用户看不出来差别。
  eq("★ 只挂在子分类里的也被收进回收站了", inTrash(under), true);
  eq("★ 只挂在孙分类里的也一样(整棵子树,不是只看一层)", inTrash(deep), true);

  // 三个分类自己也确实跟着没了 —— 那是外键 CASCADE 在干,不是这次改的。
  // ⚠️ `CollectionRepo.list()` 给的是数组,所以这里断的是"结果里没有它们",不是
  // `undefined`(那不是这个 API 的返回形状)。
  eq(
    "父/子/孙三个分类都不在了(CASCADE)",
    CollectionRepo.list("paper").some((c) => [parent, child, grand].includes(c.id)),
    false,
  );
  // 条目本身还在库里 —— 删分类只动分组,不动文献。不收进回收站的话它们就是孤儿。
  check(
    "三条记录都还在库里(删分类不删文献)",
    [direct, under, deep].every((id) => LibraryRepo.get(id) !== undefined),
  );
}

// **从回收站本身删分类时不收** —— 否则条目被摘出来又立刻被捞回去,用户永远删不掉。
// 判据仍是 `shouldSweepAfterRemoval`,这次改动一个字都没动它,但这条链路值得跑一遍真的。
{
  const orphan = LibraryRepo.upsert({ kind: "paper", title: "待会儿变孤儿的一条" }).id;
  const sub = CollectionRepo.create("回收站里的子分类", paperTrash, "paper").id;
  CollectionRepo.assign(sub, [orphan], true);

  await deleteCollection({ id: paperTrash });

  eq(
    "回收站本身删得掉(没有被重新建出来)",
    CollectionRepo.list("paper").some((c) => c.id === paperTrash),
    false,
  );
  check("从它里面删掉的条目没有被收回来(记录还在库里)", LibraryRepo.get(orphan) !== undefined);
}

/* ──────────────── 5. 给界面标「谁是回收站」 ──────────────── */

console.log("\n标给界面");

// 少了这个标记,回收站里的右键菜单只能给出「从当前文献库移除」—— 而那在那里恰好是
// **反的**:条目被摘出回收站又没被删掉,变成同一类僵尸记录。
{
  const cols = CollectionRepo.list();
  const marked = markTrashCollections(cols);
  const flagged = marked.filter((c) => c.isTrash).map((c) => c.id).sort();
  const expected = allTrashCollectionIds().slice().sort();
  same("标出来的正好是那几个回收站", flagged, expected);
  check("普通分类没被误标", marked.some((c) => c.id === home && c.isTrash !== true));
  eq("原数组没被就地改", cols.some((c) => c.isTrash === true), false);
}

rmSync(DATA, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
