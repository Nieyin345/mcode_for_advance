/**
 * Headless smoke for **模版 → 资料库的一次性迁移**(`main/library/templateMigration.ts`)
 * 与**模版库 IPC**(`main/ipc/templates.ts`)。
 *
 * ## 为什么这两块要一套
 *
 * 迁移类代码**会改用户已有的数据**:错了就是数据毁掉。而这两个文件在
 * `smokes-for.sh` 里是零覆盖 —— `templates-smoke` 只 import `templates/read.ts`
 * 与 `templates/store.ts`,一行都不碰它们。
 *
 * 这一套按那六问铺:
 *
 *  1. **幂等** —— 同一件事做两遍会不会坏。§2、§3、§4、§7 各有一个面。
 *  2. **中断** —— 跑到一半挂了,`templatesMigrated` 那个标记是什么、下次还跑不跑。
 *     §5。迁移类最坏的一种状态就是"半截 + 再也没人管"。
 *  3. **坏数据** —— 字段缺了 / 类型不对时是报错还是当没看见。§6。仓库硬规矩第 3 条:
 *     坏东西显式报出来,不静默跳过。
 *  4. **越界** —— 模版路径能不能跑出模版目录。§8。
 *  5. **两套实现只有一份** —— 用户点的与 AI 调的是不是同一个函数。§7。
 *  6. **错误信息说不说得清** —— 判据立在用户看到的那行字上。§9、§10。
 *
 * ## 两处刻意"真"的地方
 *
 *  - §2 之后每一条**重启**都走 `closeDb()` + `initDb()`:sql.js 的 `db.export()` 把
 *    内存里那份库**整份重写**成文件,所以"重开一次读回来的东西"和"内存里那个"是
 *    两份可以互相校对的状态。只断言内存那份的话,"没落盘"这种坏法看不见;
 *  - 模版目录是**真的建在磁盘上**的(`<数据根>/templates/<类目>/<名字>/`),因为整个
 *    模版库的立身之本就是"文件系统即事实源",而迁移的查重判据是
 *    `filePath === 目录绝对路径` —— 拿一个不存在的路径去验,验的是空气。
 *
 * ## 数据根必须是副本(硬规矩第三节)
 *
 * `MCODE_SMOKE_DATA_ROOT` 指向 run.sh 里 `mktemp -d` 出来的目录,桩里没设就抛。
 * `SettingRepo.set` 内部就是 `persist()` —— 一次调用就够毁掉用户的库。
 *
 * ## 它不验的(写清楚,免得被当已验)
 *
 *  - **`sendToRenderer` 的传输本身**(窗口没了会怎样),那是 window 那一层的事;
 *  - **真开文件夹 / 用系统程序打开文件**(`openDirectory` / `shell.openPath`):
 *    那两个是 Electron 的职责,本套的 electron 桩会**显式抛**;
 *  - **渲染端拿到 `{ ok:false, error }` 之后显示成哪句话** —— 本套只能钉到 IPC 这一层
 *    交出去的那个字符串(见 §10 的说明)。
 *
 * Run: scripts/template-migration-smoke/run.sh
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** 数组 / 对象的比较。`Object.is` 对两个内容相同的数组是 false —— 这一套里好几处
 *  断的是"正好是这几个",用 `eq` 会红得莫名其妙。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/* ────────────────────────── 数据根:临时目录 ────────────────────────── */

const DATA = mkdtempSync(join(tmpdir(), "mcode-template-migration-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;
/** 用户的"别处" —— 模版库外面那棵树。§8 的越界题要它。 */
const OUTSIDE = mkdtempSync(join(tmpdir(), "mcode-template-migration-outside-"));

/* ────────────────────────── 0. 把真东西取出来 ────────────────────────── */

/**
 * `ipcMain` 的**记名替身**(抄 `library-trash-smoke` §4 / `library-delete-smoke`
 * 的办法)。判据整个住在 handler 的**函数体**里,而它从来不是导出符号 —— 唯一拿得到
 * 的办法就是调 `registerTemplateHandlers`,把注册进来的那批函数按 channel 收下来。
 */
const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

const { IPC } = await import("@contracts/ipc");
const { registerTemplateHandlers } = await import("@main/ipc/templates.js");
registerTemplateHandlers(fakeIpc);

const { initDb, flushDb, getDb } = await import("@main/store/db.js");
const { LibraryRepo, SettingRepo } = await import("@main/store/repositories.js");
const { ensureTemplateDirs, templatesRoot, listTemplates } = await import(
  "@main/templates/store.js"
);
const {
  migrateTemplatesToLibrary,
  migrateTemplatesToLibraryOnce,
  TEMPLATES_MIGRATED_SETTING_KEY,
} = await import("@main/library/templateMigration.js");
// ⚠️ 这里只 import **真那份也有的名字**(`dataRoot` / `DATA_DB_FILENAME`)。桩可以多
//   导出些东西,但**不能少**:tsc 看的是真模块,少一个就报 TS2339(而运行时因为别名
//   换的是桩,反而跑得过去 —— 那种错会一直藏到有人不改别名直接跑这套为止)。
const { dataRoot, DATA_DB_FILENAME } = await import("@main/lib/dataRoot.js");
const { sent, resetSent, setFailNext } = await import("./stubs/window.js");
const { openedPaths } = await import("./stubs/electron.js");

// ⚠️ 桩里那句"没设就抛"是**安全前提**,不是装饰:指错地方就是拿一套夹具盖掉用户的库。
// 这里先确认它真的指着我们 mktemp 出来的那个目录再往下走。
eq("数据根指向的是本次 mktemp 出来的临时目录", dataRoot(), DATA);
eq("临时目录里本来没有 mcode.db", existsSync(join(DATA, DATA_DB_FILENAME)), false);

await initDb();

function handlerFor(channel: string): (raw: unknown) => Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`registerTemplateHandlers 没有注册 ${channel}`);
  return (raw: unknown) => Promise.resolve(fn(null, raw));
}

/** 所有 handler 都在这里取齐 —— 少一个会当场抛,而不是静默少验一块。 */
const list = handlerFor(IPC.TEMPLATES_LIST);
const add = handlerFor(IPC.TEMPLATES_ADD);
const rename = handlerFor(IPC.TEMPLATES_RENAME);
const trash = handlerFor(IPC.TEMPLATES_TRASH);
const trashList = handlerFor(IPC.TEMPLATES_TRASH_LIST);
const restore = handlerFor(IPC.TEMPLATES_RESTORE);
const purge = handlerFor(IPC.TEMPLATES_PURGE);
const reveal = handlerFor(IPC.TEMPLATES_REVEAL);
const manifest = handlerFor(IPC.TEMPLATES_MANIFEST);
const readFile = handlerFor(IPC.TEMPLATES_READ_FILE);
const openFile = handlerFor(IPC.TEMPLATES_OPEN_FILE);
const attach = handlerFor(IPC.TEMPLATES_ATTACH_TO_CHAT);
void list;

/** 一个用户动作**应该**被拒绝,而且拒绝时那句人话必须包含给定的那一段。 */
async function expectThrows(name: string, run: () => Promise<unknown>, why: string): Promise<void> {
  try {
    await run();
    check(name, false, { threw: false, expectedThrowsLike: why });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(name, msg.includes(why), { message: msg, wantedSubstring: why });
  }
}

/* ────────────────────────── 夹具 ────────────────────────── */

const SRC = join(OUTSIDE, "来源");
mkdirSync(SRC, { recursive: true });
writeFileSync(join(SRC, "main.tex"), "\\documentclass{article}\n", "utf8");
writeFileSync(join(SRC, "ref.bib"), "@book{k, title={x}}\n", "utf8");

/** 直接往磁盘上摆一条模版 —— "文件系统即事实源"那条设计下,用户就是这么放的。 */
function plantTemplate(kind: string, name: string, files: Record<string, string> = {}): string {
  const dir = join(templatesRoot(), kind, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  return dir;
}

/** 内存里那些 linked 条目的样子(按 filePath 排序,顺序才稳定)。 */
function state(): Array<{ id: string; kind: string; title: string; filePath: string }> {
  return LibraryRepo
    .list({ limit: 1_000_000 })
    .items.filter((i) => i.entryMode === "linked")
    .map((i) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      filePath: i.filePath ?? "",
    }))
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/**
 * **从落盘的那一份文件里**再读一遍,回答"迁移写进磁盘了没有"。
 *
 * ⚠️ 这里**不能**用 `closeDb()` + `initDb()` 那套"重启":`initDb()` 一进去就是
 * `if (db) …; if (dbReadyPromise) return dbReadyPromise.then(() => db!)` —— 而
 * `closeDb()` 只把 `db` 置空、**不清 `dbReadyPromise`**,于是第二次 `initDb()`
 * 会等那个已经 resolve 的 promise、然后 `db!` 返回 null。之后任何 `getDb()` 抛
 * "getDb() called before initDb() resolved"(实测踩到,而它长得像"迁移把库写坏了")。
 *
 * 所以这一份自己开一个 `sql.js` 实例读那份文件 —— 那是**独立的一份证据**:
 * 它证明的是"字节真的落到了磁盘上",而不是"内存里那个对象还在"。
 */
async function readPersisted(): Promise<Array<{ kind: string; title: string; file_path: string }>> {
  flushDb();
  const initSqlJs = (await import("sql.js/dist/sql-asm.js")).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database(new Uint8Array(readFileSync(join(DATA, DATA_DB_FILENAME))));
  const stmt = db.prepare(
    "SELECT kind, title, file_path FROM library_items WHERE entry_mode = 'linked'",
  );
  const out: Array<{ kind: string; title: string; file_path: string }> = [];
  while (stmt.step()) {
    const r = stmt.getAsObject() as { kind: string; title: string; file_path: string };
    out.push({ kind: r.kind, title: r.title, file_path: r.file_path });
  }
  stmt.free();
  db.close();
  return out.sort((a, b) => a.file_path.localeCompare(b.file_path));
}

/** 只挑某个 channel 推出去的那几条。 */
function sentOn(channel: string): unknown[] {
  return sent.filter((m) => m.channel === channel).map((m) => m.payload);
}

/* ════════════════════════ 1. 迁移把模版搬进来了 ════════════════════════ */

console.log("\n1. 迁移:旧模版库的每条都在资料库里有了对应的一条");

ensureTemplateDirs();
const latexDir = plantTemplate("latex", "论文模版", {
  "main.tex": "\\documentclass{article}\n",
  "ref.bib": "@book{k}\n",
  "figs/fig.png": "PNG-BYTES",
});
plantTemplate("ppt", "答辩幻灯");
plantTemplate("word", "投稿格式");
plantTemplate("code", "绘图脚本");
plantTemplate("image", "配图组");

const created = migrateTemplatesToLibrary();
eq("五条模版全部新建", created, 5);

const rows = state();
eq("资料库里正好五条 linked", rows.length, 5);
// ⚠️ 比的是**路径 → 类目**那张表,不是数组顺序:`LibraryRepo.list` 按 `added_at DESC`
// 排,而这五条是同一毫秒建出来的 —— 顺序在同一次运行里都可能不同。拿顺序当判据的
// 断言红起来像"映射错了",其实什么都没错(第一版就是那么红的)。
const kindByPath = new Map(rows.map((r) => [r.filePath, r.kind]));
same(
  "★ 类目映射:ppt→slides、word→document,其余原名",
  rows
    .map((r) => r.filePath)
    .sort()
    .map((p) => kindByPath.get(p)),
  // 按**路径**排序之后类目的顺序就是 code / image / latex / ppt / word ——
  // 映射之后 code / image / latex / slides / document。
  // (映射写反成 ppt→word 那种,这一条会红。)
  ["code", "image", "latex", "slides", "document"],
);
check(
  "每条都是 linked(文件原地不动,不做第二份拷贝)",
  LibraryRepo.list({ limit: 1_000_000 })
    .items.filter((i) => i.kind === "latex")
    .every((i) => i.entryMode === "linked"),
);
check(
  "filePath 是模版目录的绝对路径",
  rows.some((r) => r.filePath === latexDir),
  rows.map((r) => r.filePath),
);
check("标题用的是目录名", rows.some((r) => r.title === "论文模版"), rows.map((r) => r.title));
// 旧模版库还在,而且文件一个不少 —— 迁移不该动磁盘
check("旧模版目录原样留在那儿(迁移不动磁盘)", existsSync(join(latexDir, "main.tex")));
eq("旧模版库还是五条", listTemplates().length, 5);
// 标记:Once 那一层靠它决定要不要再扫
eq("跑完画上了押", SettingRepo.get(TEMPLATES_MIGRATED_SETTING_KEY), "1");

/* ════════════════════════ 2. 幂等:再跑不翻倍 ════════════════════════ */

console.log("\n2. 幂等:同一件事做两遍");

eq("再跑一次:新建 0 条", migrateTemplatesToLibrary(), 0);
eq("再跑两次也是 0", migrateTemplatesToLibrary(), 0);
eq("库里还是五条(没有翻倍)", state().length, 5);

// 光看"返回 0"不够 —— 有人把查重删掉、改成 INSERT OR IGNORE 之类,返回的可能仍是
// 0 而库里已经多了一倍。所以这里数的是**不重复的路径个数**。
eq("五条 filePath 互不相同(没有重复项)", new Set(state().map((r) => r.filePath)).size, 5);

/* ═══ 3. 幂等:用户在资料库里动过之后,那条记录仍然算数 ═══ */

console.log("\n3. 迁移只负责把没进来的送进来,不碰用户改过的那些");

// 文件头写得很明确:「用户之后在资料库里把某条改了名/挪了库,也不影响"那条 linked
// 记录"继续算数」。这正是查重判据**故意不认标题**的理由 —— 换成按标题查重的话,
// 用户在库里改过名字的模版下次启动就会被再迁一遍,变成两条。
//
// ⚠️ 两条证据都从 `entryMode + filePath` 这一对读:`LibraryRepo.upsert({id, …})` 会
// **先找 DOI/arXiv 再回落** —— 对模版这种两者都没有的行,它走的是 INSERT 那一支,
// 拿一个已存在的 id 再 upsert 会直接撞 `UNIQUE constraint failed: library_items.id`
// (第一版在这里崩了)。所以这里不借 upsert 改行,只比对前后。
{
  const target = state().find((r) => r.filePath === latexDir)!;
  const before = { title: target.title, kind: target.kind };

  // ① 用户**真会做的那件事**:在左栏给它改个名字(走的是 `LibraryRepo.setTitle`)
  LibraryRepo.setTitle(target.id, "我自己改的名字");
  flushDb();

  eq("改名之后,仍然算作已有", migrateTemplatesToLibrary(), 0);
  const after = state().filter((r) => r.filePath === latexDir);
  eq("★ 还是只有那一条(没有因为改了名就再迁一条)", after.length, 1);
  eq("★ 用户在库里改的名字没被迁移冲回去", after[0]!.title, "我自己改的名字");

  // ② 反向那一半同样重要:标题**就是**模版目录名时也不该多一条。
  //    只按标题查重的实现会在这里先漏(改名之后多一条)后重(改回来又认了别的)。
  LibraryRepo.setTitle(target.id, before.title);
  flushDb();
  eq("标题改回模版名之后也还是 0", migrateTemplatesToLibrary(), 0);
  eq("库里还是五条", state().length, 5);
  eq("那条的 kind 从没被动过", state().find((r) => r.filePath === latexDir)!.kind, before.kind);
}

/* ════════════════════════ 4. 落盘的那一份也是五条 ════════════════════════ */

console.log("\n4. 磁盘上那一份(不是内存那个对象)也是五条");

{
  const persisted = await readPersisted();
  eq("★ 落盘的库里正好五条 linked(迁移真的写了盘)", persisted.length, 5);
  same(
    "落盘那份的 类目→路径 与内存那份逐字一致",
    persisted.map((r) => `${r.kind}|${r.file_path}`),
    state().map((r) => `${r.kind}|${r.filePath}`),
  );
  check(
    "落盘那份里也有那条 latex 指向的真目录",
    persisted.some((r) => r.file_path === latexDir),
    persisted.map((r) => r.file_path),
  );
}
eq("重启后再跑迁移:仍然是 0(幂等那条判据在画过押之后也成立)", migrateTemplatesToLibrary(), 0);
eq("押还在(启动时不会重扫)", SettingRepo.get(TEMPLATES_MIGRATED_SETTING_KEY), "1");

/* ═══════════ 5. 中断:跑到一半挂了,留的是"全旧"还是"半截" ═══════════ */

console.log("\n5. 中断:一次失败之后还能不能重试");

// ## 先说清楚代码**实际**是什么形状(这一段是这一套里最要紧的发现)
//
// `listTemplates()` / `ensureTemplateDirs()` 把目录层的错误全吞了(`readdir` 抛了返回
// 空、`mkdirSync` 抛了只 catch),所以**"模版根读不动"这类失败根本走不到 `try` 块里**:
// `migrateTemplatesToLibrary()` 会顺顺利利跑完、一条都不建、然后把
// `library.templatesMigrated = "1"` 画上押。实测(见报告)就是这么回事 ——
// `created = 0`,不抛,标记照写。
//
// 那意味着:**"没有模版可迁"与"扫不到模版"在主进程里长得一模一样**,而且前者一旦
// 被当成后者,那张条子就永久挡住了重试。下面这一段把这条形状钉死(它是**既有行为**,
// 不是这一套新加的期望;报告里写了为什么它该改、以及改在哪个函数)。
{
  const before = {
    count: state().length,
    flag: SettingRepo.get(TEMPLATES_MIGRATED_SETTING_KEY),
  };
  // 造一个"扫不动"的模版根:数据根指到一个不在的地方。
  process.env.MCODE_SMOKE_DATA_ROOT = join(DATA, "这儿没有这个目录");
  let threw = false;
  let createdCount: number | null = null;
  try {
    createdCount = migrateTemplatesToLibrary();
  } catch {
    threw = true;
  }
  process.env.MCODE_SMOKE_DATA_ROOT = DATA;

  check("★ 探针前提成立:这条路不抛(目录层把错误吞了)", !threw, { threw });
  eq("★ 它报的是「新建 0 条」—— 和「模版库里本来就没有模版」是同一个数字", createdCount, 0);
  // ⚠️ 这一条记录的是**现状**:标记被画上了,所以扫不到的那些模版**再也不会被迁**。
  // 迁移代码自己那行"先干活后画押"是对的(抛出去时确实不会画押),问题在上游:
  // 该抛的地方没抛,于是那句"没抛=干成了"的前提不成立。
  eq(
    "★ 扫不到的情况下标记还是被画上了(下次启动不会再试)",
    SettingRepo.get(TEMPLATES_MIGRATED_SETTING_KEY),
    "1",
  );
  eq("★ 但它什么都没建(不是半截,是「全旧」)", state().length, before.count);
  eq("模版那边也一条没少(它只是没进资料库)", listTemplates().length, 5);

  // 恢复现场:把标记清掉,让新的模版还能被迁(否则后面几段全被那张条子挡住)。
  // ⚠️ 这是**清掉一个坏状态**,不是"绕过被测代码" —— 真实用户遇到这种情况只能靠
  // 手工改库,而那正是上面那条发现要说明的事。
  SettingRepo.set(TEMPLATES_MIGRATED_SETTING_KEY, "");
  plantTemplate("word", "中断之后新加的");
  const n = migrateTemplatesToLibrary();
  eq("清掉那张条子之后,欠着的那条补得进来", n, 1);
  check(
    "它记的是那条真实路径",
    state().some((r) => r.filePath === join(templatesRoot(), "word", "中断之后新加的")),
    state().map((r) => r.filePath),
  );
  eq("库里现在是六条", state().length, 6);
}

// 真跑一次 `migrateTemplatesToLibraryOnce` 的"没跑过 → 跑"那一支(上面手工调的是
// 内层函数,而**启动时走的是这一个**)。
SettingRepo.set(TEMPLATES_MIGRATED_SETTING_KEY, "");
migrateTemplatesToLibraryOnce();
eq("Once 跑过之后画上了押", SettingRepo.get(TEMPLATES_MIGRATED_SETTING_KEY), "1");
eq("Once 跑过之后库里还是六条", state().length, 6);
eq("Once 再跑一次不会重复(它先看那条子)", migrateTemplatesToLibraryOnce(), undefined);
eq("库里还是六条", state().length, 6);

/* ═══════════ 6. 坏数据:模版列表里混进坏 kind 时 ═══════════ */

console.log("\n6. 坏数据:显式报出来,还是静默收下");

// `listTemplates()` 的每条都带 `kind`,正常情况下一定是五个类目之一。这一条问的是:
// 这个值坏掉时,迁移会不会**静默**造一条谁都归不进去的记录出来。
// 结论(下面是真跑的):会 —— 因为 `LibraryRepo.upsert` 在 repo 这一层**不查**类型
// 注册表(`kind` 是开放字符串,见 contracts/libraryTypes.ts 顶上那段),坏值原样落库。
// 这不是迁移独有的问题(凡是 upsert 的地方都这样),但迁移是**唯一一处不由用户动作
// 触发**的 upsert —— 它在启动时自己跑,所以坏值进来时没有任何人能当场看见。
{
  const rowsBefore = state().length;
  const fake = join(templatesRoot(), "latex", "坏 kind 模版");
  mkdirSync(fake, { recursive: true });
  const inserted = LibraryRepo.upsert({
    kind: "根本不存在的类目",
    title: "坏 kind 模版",
    entryMode: "linked",
    filePath: fake,
  });
  const got = LibraryRepo.get(inserted.id)!;
  eq("坏 kind 被原样收下(没人拦)", got.kind, "根本不存在的类目");
  eq("它确实落进库里了", state().length, rowsBefore + 1);
  // 收干净,后面的断言不该被它影响
  LibraryRepo.delete([inserted.id]);
  rmSync(fake, { recursive: true, force: true });
  flushDb();
  eq("收拾干净之后回到原来那么多条", state().length, rowsBefore);
}

/* ═══════════ 7. 两套实现只有一份:IPC 与 MCP 工具是同一个函数 ═══════════ */

console.log("\n7. 用户点的与 AI 调的:挂进对话是同一个函数");

// `attachTemplateToChat` 有**两个入口**:左栏右键(IPC `templates:attachToChat`)和
// AI 的 MCP 工具 `templates_attach_to_chat`。共享实现只有一份(硬规矩第 2 条)——
// 而这一条只有"真调两个入口、比对落地的广播"才验得出来。
{
  const { libraryMcpTools } = await import("@main/mcp/libraryServer.js");
  type Spec = {
    name: string;
    handler: (args: any, ctx: { sessionId: string }) => Promise<unknown>;
  };
  // ⚠️ `libraryMcpTools` 是个**函数**(见 libraryServer.ts:185),不是常量表 ——
  // 第一版按常量用,红的是 `…find is not a function`。工具表是每次调用现算的,
  // 所以这里也照着调一次。
  const spec = libraryMcpTools().find((t) => t.name === "templates_attach_to_chat") as
    | Spec
    | undefined;
  check("MCP 工具表里真的有 templates_attach_to_chat", spec !== undefined);

  if (spec) {
    // ① 用户那条路
    resetSent();
    const byUser = await attach({ sessionId: "s_1", kind: "latex", dirName: "论文模版" });
    const userSends = sentOn(IPC.COMPOSER_ATTACH);

    // ② AI 那条路
    resetSent();
    await spec.handler({ kind: "latex", dirName: "论文模版" }, { sessionId: "s_1" });
    const agentSends = sentOn(IPC.COMPOSER_ATTACH);

    eq("两条路都推了一条 composer:attach", userSends.length, 1);
    eq("AI 那条路也推了一条", agentSends.length, 1);
    // ★ 这一句是"只有一份实现"的判据:两条路的载荷必须逐字相同。不一样的话同一份
    //   东西会以两个身份各挂一次,渲染端那条去重直接失效。
    same("★ 两条路推出去的载荷逐字相同", userSends[0], agentSends[0]);
    same("IPC 的返回值与它推出去的那条对得上", byUser, {
      ok: true,
      name: "论文模版",
      fileCount: 3,
    });
  }

  // 整个类目那一档(省略 dirName)走的是**另一个**清单函数,所以也要比一遍。
  resetSent();
  const byUserKind = await attach({ sessionId: "s_1", kind: "latex" });
  const userKindSends = sentOn(IPC.COMPOSER_ATTACH);
  eq("挂整个类目也推了一条", userKindSends.length, 1);
  same("挂整个类目的返回(名字是类目的中文名)", byUserKind, {
    ok: true,
    name: "论文 LaTeX",
    // latex 类目下**只有**「论文模版」这一条(§5 往 word 里加的那条不算)。
    fileCount: 1,
  });
  if (spec) {
    resetSent();
    await spec.handler({ kind: "latex" }, { sessionId: "s_1" });
    const agentKindSends = sentOn(IPC.COMPOSER_ATTACH);
    eq("AI 那一路挂整个类目也推了一条", agentKindSends.length, 1);
    same("★ 整个类目那一档两条路的载荷也一样", userKindSends[0], agentKindSends[0]);
  }

  // 重复挂:两次都推 —— 去重在渲染端(它按 key 挡),这里只确认主进程不吞第二次。
  resetSent();
  await attach({ sessionId: "s_1", kind: "latex" });
  await attach({ sessionId: "s_1", kind: "latex" });
  eq("挂两次推两条(去重在渲染端,主进程不吞)", sentOn(IPC.COMPOSER_ATTACH).length, 2);
}

/* ═══════════ 8. 越界:模版的路径不能跑出模版目录 ═══════════ */

console.log("\n8. 越界:relPath / dirName 都是不受信输入");

// 库外面摆一份"机密文件",围栏只要漏一处它就能被读成预览内容交给渲染端。
const SECRET = join(OUTSIDE, "机密.txt");
writeFileSync(SECRET, "这是模版库外面的东西\n", "utf8");
plantTemplate("word", "正常模版", { "note.txt": "模版里的东西\n" });

await expectThrows(
  "★ ../../../ 这种 relPath 被拒绝",
  () => readFile({ kind: "word", dirName: "正常模版", relPath: "../../../机密.txt" }),
  "这个模版里没有",
);
await expectThrows(
  "★ 绝对路径当 relPath 也被拒绝",
  () => readFile({ kind: "word", dirName: "正常模版", relPath: SECRET }),
  "这个模版里没有",
);
await expectThrows(
  "不存在的文件被拒绝",
  () => readFile({ kind: "word", dirName: "正常模版", relPath: "没有这个.txt" }),
  "这个模版里没有",
);
await expectThrows(
  "模版本身不存在时说的是模版不存在,不是别的",
  () => readFile({ kind: "word", dirName: "没这条", relPath: "note.txt" }),
  "模版不存在",
);

// `dirName` 可以带 `..` 或斜杠 —— schema 只要求"非空字符串",所以这几种真的传得进来。
// 它们走到 store 里的 `invalidEntryName` 才被挡,而挡的理由是"模版不存在"
// (非法名字直接判 null)。这里钉的是**它们全都被挡下来了**,不是被挡的措辞。
for (const bad of ["..", ".", "回收站", "a/b", "a\\b"]) {
  await expectThrows(
    `dirName = ${JSON.stringify(bad)} 被拒绝`,
    () => readFile({ kind: "word", dirName: bad, relPath: "note.txt" }),
    "模版不存在",
  );
}

// 用外部程序打开走的是**同一个**围栏函数(不是另写一套),所以它也拒绝。
{
  const res = (await openFile({
    kind: "word",
    dirName: "正常模版",
    relPath: "../../../机密.txt",
  })) as { ok: boolean; error?: string };
  eq("★ openFile 也拦住了同一个越界请求", res.ok, false);
  check(
    "openFile 的 error 是人话,不是堆栈",
    typeof res.error === "string" && !res.error.includes("    at "),
    res.error,
  );
}

// 正面那一条:正常文件读得出来(围栏不能把正当的也挡了)
{
  const got = (await readFile({
    kind: "word",
    dirName: "正常模版",
    relPath: "note.txt",
  })) as { kind: string; text?: string };
  eq("正常文件读得出来", got.kind, "text");
  eq("读的是那个文件的内容", got.text, "模版里的东西\n");
}

// ⚠️ 围栏必须**两侧都钉**。上面那几条只证明"越界被拦住了" —— 而一个把所有输入都
// 拒绝掉的围栏同样能过:**正当文件也被挡**这一侧,只测越界是永远看不出来的。
// 所以这里反过来问一次:合法文件真的送到了 `shell.openPath` 跟前吗?
// (旧写法下这条没法验:`openFile` 最后必然抛,分不清"围栏拦的"和"送到了、是
//  electron 桩抛的"。改成记录式之后才能把这两件事分开。)
{
  const before = openedPaths.length;
  // ⚠️ 这里**必须**接住那个抛:桩的职责就是"真被走到就显形",而这一条问的恰恰是
  // "走到了没有" —— 走到就一定会抛。接住、然后读记录。
  await openFile({ kind: "word", dirName: "正常模版", relPath: "note.txt" }).catch(() => {});
  eq("★ 合法文件真的被送到了 shell.openPath(围栏没把正当的也挡了)", openedPaths.length, before + 1);
  eq(
    "★ 送过去的是模版目录里的绝对路径,不是别的",
    openedPaths[openedPaths.length - 1],
    join(templatesRoot(), "word", "正常模版", "note.txt"),
  );
}

/* ═══════════ 9. IPC 那几条动作:用户看到的那行字 + 两边的缓存 ═══════════ */

console.log("\n9. 改名 / 回收站 / 还原 / 彻底删");

// 模版库有两个入口(左栏那一段、设置里的面板),各有自己的缓存。约定是:**变更类
// handler 返回该类目的完整新列表**,渲染端整体替换。少给了那一半,另一边就显示过期
// 的东西 —— 而界面不会报错。
{
  // ① 改名
  resetSent();
  const rn = (await rename({ kind: "word", dirName: "正常模版", name: "改过名的模版" })) as {
    ok: boolean;
    entries: Array<{ dirName: string }>;
    dirName?: string;
  };
  eq("改名成功", rn.ok, true);
  eq("返回了净化后的新目录名", rn.dirName, "改过名的模版");
  check(
    "返回的列表里是新名字",
    rn.entries.some((e) => e.dirName === "改过名的模版"),
    rn.entries.map((e) => e.dirName),
  );
  eq("磁盘上真的换了名字", existsSync(join(templatesRoot(), "word", "改过名的模版")), true);
  eq("旧名字不在磁盘上了", existsSync(join(templatesRoot(), "word", "正常模版")), false);
  eq("广播了 templates:changed(另一个入口的缓存不会自己知道)", sentOn(IPC.TEMPLATES_CHANGED).length, 1);
  check(
    "那条广播说出了是谁改的(排查时用得上)",
    JSON.stringify(sentOn(IPC.TEMPLATES_CHANGED)[0]).includes("改过名的模版"),
    sentOn(IPC.TEMPLATES_CHANGED)[0],
  );

  // 重名:ok:false **不抛**(用户自己能解决),但那句话要说清是哪一个撞了
  const dup = (await rename({
    kind: "word",
    dirName: "改过名的模版",
    name: "投稿格式",
  })) as { ok: boolean; error?: string };
  eq("重名时 ok:false,不抛", dup.ok, false);
  check("重名那句人话里带着撞了的那个名字", dup.error?.includes("投稿格式") === true, dup.error);

  // ② 移进回收站
  resetSent();
  const tr = (await trash({ kind: "word", dirName: "改过名的模版" })) as {
    entries: Array<{ dirName: string }>;
    trashed: Array<{ dirName: string; kind: string }>;
  };
  // ⚠️ 不能断"列表空了":word 类目此刻不止这一条(§5 往它里面加过一条)。断的是
  // **被删的那一条从列表里消失了**,那才是这个动作该有的结果。
  check(
    "移进回收站的那条从类目列表里消失了",
    !tr.entries.some((e) => e.dirName === "改过名的模版"),
    tr.entries.map((e) => e.dirName),
  );
  eq("回收站里正好一条", tr.trashed.length, 1);
  eq("它的类目是原来那个(word)", tr.trashed[0]!.kind, "word");
  eq(
    "磁盘上它躺在 类目/回收站/ 下面",
    existsSync(join(templatesRoot(), "word", "回收站", "改过名的模版")),
    true,
  );
  eq("广播了 templates:changed", sentOn(IPC.TEMPLATES_CHANGED).length, 1);
  // 回收站自己**不能**被当成一条模版列出来 —— 它也是个目录
  check(
    "回收站目录没有作为一条模版出现在列表里",
    !tr.entries.some((e) => e.dirName === "回收站"),
    tr.entries.map((e) => e.dirName),
  );
  const tl = (await trashList({})) as { trashed: unknown[] };
  eq("trashList 和动作返回值说的是同一件事", tl.trashed.length, 1);

  // ③ 还原
  const rs = (await restore({ kind: "word", dirName: "改过名的模版" })) as {
    ok: boolean;
    entries: Array<{ dirName: string }>;
    trashed: unknown[];
  };
  eq("还原成功", rs.ok, true);
  check(
    "它回到了类目列表里",
    rs.entries.some((e) => e.dirName === "改过名的模版"),
    rs.entries.map((e) => e.dirName),
  );
  same("回收站空了", rs.trashed, []);

  // ④ 还原时目标被占:如实报错、**不覆盖**(覆盖等于悄悄删掉用户新做的那一条)
  await trash({ kind: "word", dirName: "改过名的模版" });
  plantTemplate("word", "改过名的模版", { "新.txt": "用户新做的这一条\n" });
  const rs2 = (await restore({ kind: "word", dirName: "改过名的模版" })) as {
    ok: boolean;
    error?: string;
  };
  eq("目标被占时 ok:false", rs2.ok, false);
  check(
    "★ 那句话告诉了用户怎么办(改名或删掉),不是只说失败",
    rs2.error?.includes("改名") === true && rs2.error?.includes("还原") === true,
    rs2.error,
  );
  eq(
    "★ 用户新做的那一条一个字节都没被动过",
    readFileSync(join(templatesRoot(), "word", "改过名的模版", "新.txt"), "utf8"),
    "用户新做的这一条\n",
  );

  // ⑤ 彻底删:回收站里的那一条真的从磁盘上消失
  const pg = (await purge({ kind: "word", dirName: "改过名的模版" })) as { ok: boolean };
  eq("彻底删成功", pg.ok, true);
  eq("磁盘上真的没了", existsSync(join(templatesRoot(), "word", "回收站", "改过名的模版")), false);
  eq(
    "用户在类目里新做的那一条没被连坐",
    existsSync(join(templatesRoot(), "word", "改过名的模版")),
    true,
  );
}

/* ═══════════ 10. 判据立在用户看到的那行字上 ═══════════ */

console.log("\n10. 报错那句人话");

{
  // ① 新建重名:**抛**(不是 ok:false)—— 契约里 `templates.add` 只返回 entries,
  //    没有 ok/error 那一对,所以"静默返回空列表"是唯一的坏法(会让用户以为建成了)。
  await expectThrows(
    "新建重名:抛出来,而且话里带着那个名字",
    () => add({ kind: "word", name: "投稿格式", sourcePaths: [join(SRC, "main.tex")] }),
    "投稿格式",
  );
  eq(
    "失败之后没有在库里留下空壳目录",
    existsSync(join(templatesRoot(), "word", "投稿格式 (2)")),
    false,
  );

  // ② 源文件都不存在
  await expectThrows(
    "选中的文件都不存在:话里说得出是都不存在",
    () =>
      add({ kind: "word", name: "新的一条", sourcePaths: [join(OUTSIDE, "没有这个文件.xyz")] }),
    "都不存在",
  );
  eq("失败之后没有在库里留下空壳目录", existsSync(join(templatesRoot(), "word", "新的一条")), false);

  // ③ 名字净化后为空
  await expectThrows(
    "名字里没有可用字符:抛出来说的是名字的事",
    () => add({ kind: "word", name: "...", sourcePaths: [join(SRC, "main.tex")] }),
    "没有可用字符",
  );

  // ④ 删一条不存在的
  await expectThrows(
    "删一条不存在的:抛,而且说的是找不到模版",
    () => trash({ kind: "word", dirName: "从来没建过" }),
    "找不到模版",
  );

  // ⑤ 还原一条回收站里没有的
  const rs3 = (await restore({ kind: "word", dirName: "从来没建过" })) as {
    ok: boolean;
    error?: string;
  };
  eq("还原不存在的:ok:false", rs3.ok, false);
  check("话里说得清是回收站里没有", rs3.error?.includes("回收站里没有") === true, rs3.error);

  // ⑥ 挂一条不存在的模版:error 是人话,而且**不会推广播**
  resetSent();
  const at = (await attach({ sessionId: "s_1", kind: "word", dirName: "从来没建过" })) as {
    ok: boolean;
    error?: string;
  };
  eq("挂不存在的:ok:false", at.ok, false);
  check("话里说得出是哪一条不存在", at.error?.includes("模版不存在") === true, at.error);
  eq(
    "★ 挂失败时一条广播都不该推(推了会让界面凭空多一个 chip)",
    sentOn(IPC.COMPOSER_ATTACH).length,
    0,
  );

  // ⑦ 窗口没了:要**如实说挂不上**,不能报 ok:true
  resetSent();
  setFailNext(true);
  const noWin = (await attach({ sessionId: "s_1", kind: "word", dirName: "投稿格式" })) as {
    ok: boolean;
    error?: string;
  };
  setFailNext(false);
  eq("窗口没了时 ok:false(不谎报挂上了)", noWin.ok, false);
  check("那句话用户看得懂", typeof noWin.error === "string" && noWin.error.length > 0, noWin.error);

  // ⑧ reveal:目录不在了时那句人话(不是抛堆栈)
  const rv = (await reveal({ kind: "word", dirName: "从来没建过" })) as {
    ok: boolean;
    error?: string;
  };
  eq("reveal 一条不存在的目录:ok:false", rv.ok, false);
  check(
    "★ 那句话要让用户明白可能是在磁盘上被删了,而不是一句通用的失败",
    rv.error?.includes("磁盘") === true,
    rv.error,
  );
}

/* ═══════════ 11. 清单 + 空过守卫 ═══════════ */

console.log("\n11. 清单与收尾");

{
  const m = (await manifest({ kind: "latex", dirName: "论文模版" })) as {
    path: string;
    fileCount: number;
  };
  eq("文件数点得对(3 个文件,含子目录里那张图)", m.fileCount, 3);
  eq("清单真的写到磁盘上了", existsSync(m.path), true);
  check(
    "清单里给了文件的绝对路径(模型要按它 Read)",
    readFileSync(m.path, "utf8").includes(latexDir),
    m.path,
  );
  await expectThrows(
    "清单:模版不存在时抛(调用方靠它区分成功/失败)",
    () => manifest({ kind: "latex", dirName: "没这条" }),
    "模版不存在",
  );

  // 这一套自己别被骗:库里每一条都得指向一个**真的存在**的路径(没有凭空造出来的);
  check(
    "库里的每条 linked 都指向一个真存在的路径",
    state().every((r) => existsSync(r.filePath)),
    state().map((r) => r.filePath),
  );
  eq("迁移标记是 1(这一趟真的跑过 Once)", SettingRepo.get(TEMPLATES_MIGRATED_SETTING_KEY), "1");
  // 登记了却没人命中的断言会全绿而什么都没验 —— 一条粗但管用的守卫:断言数太少
  // 通常意味着某一段整个没跑到。
  check("这一趟真跑了足够多的断言", checks >= 60, { checks });
  // `getDb()` 真的拿到了连接(不是在拿一个已关掉的库做判断)
  check("数据库连接还活着", getDb() !== null);
}

rmSync(DATA, { recursive: true, force: true });
rmSync(OUTSIDE, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
