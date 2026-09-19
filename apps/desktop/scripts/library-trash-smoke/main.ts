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
 * ## 这一套要钉出来的那条缝
 *
 * 分类是**树**(`library_collections.parent_id REFERENCES library_collections(id)
 * ON DELETE CASCADE`),但删分类那条 IPC 只查了 `listByCollection(父)`,而它是
 * **不递归**的。于是同一个用户动作("删掉这个分类")的结果取决于一个他看不见的结构
 * 细节:
 *
 *  - 条目直接挂在被删的那个分类下 → 会被收进回收站;
 *  - 条目挂在**它的子分类**下 → 成员关系被 CASCADE 静默摘掉,**没人收**。
 *
 * 后者正是这个模块自己文件头警告过的那种产物:「条目从此既不在回收站里、也没被删,
 * 变成界面上找不回来的僵尸记录」。本套**先把事实钉住**(§4 的两条对照),不改代码 ——
 * 是不是该修由人拍板。
 *
 * ## 它不碰用户真正的库
 *
 * 数据根换成 `mktemp -d`(复用 run-store-smoke 的 dataRoot/logger 桩),跑完就删。
 *
 * Run: scripts/library-trash-smoke/run.sh
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** 数组/对象比较。`Object.is` 对两个内容相同的数组是 false —— 这一套里好几处断的是
 *  "集合里正好是这几个",用 `eq` 会红得莫名其妙。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const DATA = mkdtempSync(join(tmpdir(), "mcode-trash-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

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

// **各回各的库**:教材不该跑到论文库的回收站里去(那是这一处改过的 bug)。
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

/* ──────────────── 4. 删一个**父**分类,子分类里那些条目会怎样 ──────────────── */

console.log("\n删父分类 · 子分类里的条目");

// 这一段是**事实记录**,不是期望值。两个对照跑的是同一个用户动作「删掉这个分类」,
// 唯一的差别是条目挂在哪一层 —— 而那一层用户看不见。
//
// `CollectionRepo.delete` 的注释写着「子集合与成员关系由外键 CASCADE 一并清理」,
// 而删分类那条 IPC(见 `ipc/library.ts` 的 LIBRARY_DELETE_COLLECTION)只查了
// `listByCollection(被删的那个)` —— **不递归**。
{
  const parent = CollectionRepo.create("父分类", null, "paper").id;
  const child = CollectionRepo.create("子分类", parent, "paper").id;
  const direct = LibraryRepo.upsert({ kind: "paper", title: "挂在父上", source: "manual" }).id;
  const under = LibraryRepo.upsert({ kind: "paper", title: "只挂在子上", source: "manual" }).id;
  CollectionRepo.assign(parent, [direct], true);
  CollectionRepo.assign(child, [under], true);

  // 删分类那条 IPC 现在**就是这么查的**(见 handlers 里那两行)。这里复述它,是为了
  // 让"少收了谁"变成一个能跑出来的事实,而不是靠读代码推。
  const affected = LibraryRepo.listByCollection(parent).map((i) => i.id);
  CollectionRepo.delete(parent);
  sweepToTrash(affected);

  eq("挂在父上的被收进回收站", LibraryRepo.listByCollection(paperTrash).some((i) => i.id === direct), true);
  // 子分类是**跟着一起没的**,而不是"查不到" —— `list()` 给的是数组,所以这里断的是
  // "结果里没有它",不是 `undefined`(那不是这个 API 的返回形状)。
  eq(
    "子分类本身跟着被删了(CASCADE)",
    CollectionRepo.list("paper").some((c) => c.id === child || c.id === parent),
    false,
  );

  // ★ 下面这两条是这一套存在的理由。
  const stillInChild = LibraryRepo.listByCollection(child).some((i) => i.id === under);
  eq("CASCADE 把子分类的成员关系也摘了(所以它已经不是子分类的了)", stillInChild, false);
  eq(
    "★ 而它没被收进回收站 —— 成了左栏里找不回来的孤儿",
    LibraryRepo.listByCollection(paperTrash).some((i) => i.id === under),
    false,
  );
  // 它也确实还在库里(没被删掉),所以不是"数据没了",是"归不到任何地方"。
  check("（它本身还在库里,只是不属于任何分类）", LibraryRepo.get(under) !== undefined);
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
  eq("标出来的正好是那几个回收站", JSON.stringify(flagged), JSON.stringify(expected));
  check("普通分类没被误标", marked.some((c) => c.id === home && c.isTrash !== true));
  eq("原数组没被就地改", cols.some((c) => c.isTrash === true), false);
}

rmSync(DATA, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
