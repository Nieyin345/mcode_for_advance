/**
 * Headless smoke for **`CollectionRepo.move`** —— 「把分类挪到别的父下面 / 调同级次序」。
 *
 * ## 这一套钉住的是什么
 *
 * 目录树一旦有层级,「把它挪到另一支下面」就是最常见的整理动作,而这个能力在
 * `move` 之前**根本不存在** —— 项目自己在 `docs/planning/Status-and-Plan.md` 里就记着
 * 「「移」:改父级 / 换所属类型的入口还没做,只能删了重加」。
 *
 * 而它管的是**用户看不见的数据形状**:`parent_id` 那一列写错了不会报错,只会让
 * 分类在界面上落在别的地方、或者整棵子树从所有遍历里消失。所以断的是**结果**:
 * 挪完之后 `list()` 里那条的 `parentId` 是什么、同级次序是什么。
 *
 * ## 走的是**真的那条 handler**
 *
 * 判据整个住在 `CollectionRepo.move` 的函数体里,而它从前门进来是
 * `library:moveCollection` 那条 handler。只 import `repositories.ts` 直接调
 * `CollectionRepo.move`,验的是"我调的这个函数现在返回什么" —— 有人把 handler 里
 * 那个方法名换掉、或者 schema 把 `parentId` 吃掉了,这套照样全绿。那正是
 * CLAUDE.md 里那句「套件跑绿但**根本没覆盖到**被改的文件」。
 *
 * 所以按 `library-trash-smoke` 的办法搭:`ipcMain` 的记名替身 + 按 channel 取回
 * 注册进去的真函数,然后**调那个用户动作本身**。
 *
 * ## 它不碰用户真正的库
 *
 * 数据根换成 `mktemp -d`,跑完就删。
 *
 * Run: scripts/library-move-smoke/run.sh
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

/** 数组比较。`Object.is` 对两个内容相同的数组是 false。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const DATA = mkdtempSync(join(tmpdir(), "mcode-move-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

/* ──────────────── 0. 把真 handler 取出来 ──────────────── */

/**
 * `ipcMain` 的**记名替身**(抄 `library-trash-smoke` / `library-delete-smoke`)。
 *
 * 挪分类那条路的判据住在 handler 的**函数体**里,而它从来不是导出符号 —— 唯一拿得到
 * 的办法就是调 `registerLibraryHandlers`,把注册进来的那批函数按 channel 收下来。
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
const { CollectionRepo } = await import("@main/store/repositories.js");

await initDb();

function handlerFor(channel: string): (raw: unknown) => Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`registerLibraryHandlers 没有注册 ${channel}`);
  return (raw: unknown) => Promise.resolve(fn(null, raw));
}

/** 「挪一个分类」—— **真的那条 IPC**。下面每一条断言都走它。 */
const move = handlerFor(IPC.LIBRARY_MOVE_COLLECTION) as (
  raw: unknown,
) => Promise<{ collections: unknown[]; ok: boolean; error?: string }>;
check("拿到了 moveCollection 的 handler", handlers.has(IPC.LIBRARY_MOVE_COLLECTION));

/** 一条分类现在的父是谁 —— 断言里反复要用。 */
const parentOf = (id: string): string | null | undefined =>
  CollectionRepo.list().find((c) => c.id === id)?.parentId ?? null;

/** 某个父下面,按 sort_order 排好的子分类名字。 */
const kidsNamed = (parent: string | null): string[] =>
  CollectionRepo.list()
    .filter((c) => (c.parentId ?? null) === parent)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
    .map((c) => c.name);

/* ──────────────── 1. 挪到另一个父下面 ──────────────── */

console.log("\n挪到一个父下面");

{
  const a = CollectionRepo.create("甲", null, "paper").id;
  const b = CollectionRepo.create("乙", null, "paper").id;
  const child = CollectionRepo.create("甲的孩子", a, "paper").id;

  eq("挪之前挂在甲下面", parentOf(child), a);

  const res = await move({ id: child, parentId: b });

  eq("回来了 ok", res.ok, true);
  eq("★ parentId 真的变成乙了", parentOf(child), b);
  eq("甲下面空了", kidsNamed(a).length, 0);
  same("乙下面正好是这个孩子", kidsNamed(b), ["甲的孩子"]);
  // 挪的是归属,**不是身份** —— id 与名字都不该变
  eq("id 没变", CollectionRepo.list().some((c) => c.id === child), true);
}

/* ──────────────── 2. 挪到最外层(null 有明确含义) ──────────────── */

console.log("\n挪到最外层");

{
  const root = CollectionRepo.create("根", null, "paper").id;
  const sub = CollectionRepo.create("子", root, "paper").id;

  // null 是**显式的"移到最外层"**,不是"没传"。少这条语义,子集合就再也回不到根上。
  const res = await move({ id: sub, parentId: null });

  eq("回来了 ok", res.ok, true);
  eq("★ parentId 变成 null 了", parentOf(sub), null);
  check("它现在是一个根分类", kidsNamed(null).includes("子"));
  // 别的根分类不受影响
  check("根上原本那条还在", kidsNamed(null).includes("根"));
}

/* ──────────────── 3. 不许成环 ──────────────── */

console.log("\n成环要拒,而且要说清为什么");

{
  const p = CollectionRepo.create("祖父", null, "paper").id;
  const c = CollectionRepo.create("父", p, "paper").id;
  const g = CollectionRepo.create("孙", c, "paper").id;

  // 移到**自己**下面
  const self = await move({ id: c, parentId: c });
  eq("移到它自己下面 → 拒", self.ok, false);
  check("给了原因", typeof self.error === "string" && self.error.length > 0, self.error);
  eq("★ 数据一个字没动(没写进去)", parentOf(c), p);

  // 移到**自己的后代**下面 —— 这一条才是环。外键不防环,所以必须显式判。
  const cycle = await move({ id: p, parentId: g });
  eq("移到它孙子的下面 → 拒", cycle.ok, false);
  eq("★ 祖父还在最外层(没被写成环)", parentOf(p), null);
  eq("父还在祖父下面", parentOf(c), p);
  eq("孙还在父下面", parentOf(g), c);

  // 反过来是允许的:把孙子提上来当祖父的兄弟,没环。
  const up = await move({ id: g, parentId: null });
  eq("把孙提成根 → 允许", up.ok, true);
  eq("它现在在根上", parentOf(g), null);
}

/* ──────────────── 4. 重名 / 找不到 ──────────────── */

console.log("\n拒的时候要说人话");

{
  const t1 = CollectionRepo.create("目标", null, "paper").id;
  const t2 = CollectionRepo.create("别处", null, "paper").id;
  const moving = CollectionRepo.create("要挪的", t2, "paper").id;

  /**
   * ⚠️ **这一段的同名状态是直接写库造出来的,而且必须是这样。**
   *
   * `move` 的重名判据是**同一层**里有没有同名的;而 `create` / `rename` 走
   * `isNameTaken`,那是**同一个库里全局唯一**(不分层)。后者严得多 —— 所以在正常
   * 操作下,同一个库里根本造不出两个同名的分类,`move` 那条分支从公开 API 走**到不了**。
   *
   * 它仍然留着,是因为数据可以从别的地方进来:老库、模板迁移、脚本直接写库。那正是
   * 这条守卫存在的理由 —— 所以这一段也照那个形状造:**直接写一行**,然后断言 `move`
   * 拒它,而不是假装存在一条能造出它的公开路径。
   */
  const { getDb } = await import("@main/store/db.js");
  getDb().run("UPDATE library_collections SET name = ? WHERE id = ?", ["要挪的", moving]);
  // 现在 t1 下面有一个「要挪的」,而 moving 也叫这个、正要从 t2 挪进去
  const placeholder = CollectionRepo.create("占位", t1, "paper").id;
  getDb().run("UPDATE library_collections SET name = ? WHERE id = ?", ["要挪的", placeholder]);

  // 先把"同名状态造好了"本身断一下 —— 造不出来时下面那条会红得莫名其妙
  same("造好了:t1 下面有个同名的", kidsNamed(t1), ["要挪的"]);
  eq(
    "要挪的那个名字也对",
    CollectionRepo.list().find((c) => c.id === moving)?.name,
    "要挪的",
  );

  const clash = await move({ id: moving, parentId: t1 });
  eq("同层重名 → 拒", clash.ok, false);
  check("说的是重名", (clash.error ?? "").includes("同名"), clash.error);
  eq("★ 没挪过去", parentOf(moving), t2);
  // 换个不重名的落点就该放行 —— 证明上面那条拒的确实是**重名**,不是别的原因
  getDb().run("UPDATE library_collections SET name = ? WHERE id = ?", ["改过名的", moving]);
  const fine = await move({ id: moving, parentId: t1 });
  eq("换个不重名的位置就放行", fine.ok, true);
  eq("确实挪过去了", parentOf(moving), t1);

  const gone = await move({ id: "lc_根本不存在", parentId: t1 });
  eq("找不到自己 → 拒", gone.ok, false);
  check("给了原因", typeof gone.error === "string" && gone.error.length > 0, gone.error);

  const noParent = await move({ id: t1, parentId: "lc_目标也没了" });
  eq("找不到目标父级 → 拒", noParent.ok, false);
  eq("★ 没被挪到不存在的父上", parentOf(t1), null);
}

/* ──────────────── 5. 跨库要拒 ──────────────── */

console.log("\n跨大类移动(kind 退役后允许)");

{
  // kind 退役后分类直接挂大类,move 不再挡"另一个库" —— 原来的限制随之撤销。
  const paperCol = CollectionRepo.create("论文里的", null).id;
  const noteCol = CollectionRepo.create("笔记里的", null).id;

  const res = await move({ id: paperCol, parentId: noteCol });
  eq("跨大类 → 允许", res.ok, true);
  eq("★ 父级真的换过去了", parentOf(paperCol), noteCol);
}

/* ──────────────── 6. 挪过去落在新那一层的末尾 ──────────────── */

console.log("\n落点是新那一层的末尾 · 同级次序不重号");

{
  const host = CollectionRepo.create("新家", null).id;
  const first = CollectionRepo.create("原有的一", host).id;
  const second = CollectionRepo.create("原有的二", host, "paper").id;
  const mover = CollectionRepo.create("待挪的", null, "paper").id;

  const res = await move({ id: mover, parentId: host });
  eq("挪进去了", res.ok, true);
  eq("父对了", parentOf(mover), host);
  // 追加而不是插队 —— 不传 index 时它落在末尾,不会把别人挤乱
  same("★ 落在新那一层的末尾", kidsNamed(host), ["原有的一", "原有的二", "待挪的"]);
  check("原来那两条都还在", [first, second].every((id) => parentOf(id) === host));

  // 整层重写:同一层里不该有两个同号的 sort_order(那会让次序随查询飘)
  const orders = CollectionRepo.list()
    .filter((c) => (c.parentId ?? null) === host)
    .map((c) => c.sortOrder);
  eq("★ 同级 sort_order 没有重号", new Set(orders).size, orders.length);
  same("★ 而且就是 0..n-1", orders.slice().sort((a, b) => a - b), [0, 1, 2]);
}

/* ──────────────── 7. 返回给界面的那份列表 ──────────────── */

console.log("\n回给渲染端的列表");

{
  const a = CollectionRepo.create("甲组", null, "paper").id;
  const b = CollectionRepo.create("乙组", null, "paper").id;
  const moving = CollectionRepo.create("最后要挪的", null, "paper").id;

  const res = await move({ id: moving, parentId: a });
  eq("ok", res.ok, true);
  // 左栏不再自己重拉一次才认账 —— 返回的列表必须是**挪完之后的**真相,
  // 否则界面会先画回旧位置再跳一下。
  const inList = res.collections.find((c) => (c as { id: string }).id === moving) as
    | { parentId: string | null }
    | undefined;
  check("列表里带上了它", inList !== undefined);
  eq("★ 列表里那一条的 parentId 已经是新的", inList?.parentId, a);
  check("甲和乙都在列表里", [a, b].every((id) => res.collections.some((c) => (c as { id: string }).id === id)));
}

rmSync(DATA, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
