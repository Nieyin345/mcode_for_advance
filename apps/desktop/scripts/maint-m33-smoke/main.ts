/**
 * M33 维护套件 —— 导入链路上"**错了不报错**"的四处:
 *
 *  1. **`attached` 模式收到目录** → 复制那一步被 `if (!isDir)` 静默跳过,
 *     条目的 `file_path` 却写上了一个**从来没被创建过**的落点(`files/<id>-<名>`)。
 *     点开是「文件不存在(被移走了?)」,而用户什么都没做错。目录条目的唯一
 *     合法形态是 linked(`fileImport.ts` 文件头自己写着"linked **可以是目录**"),
 *     `importAnyFiles` 也是这么分派的 —— 但 `library.importGeneric` 这条 IPC
 *     允许 `mode:"attached"` + 任意路径,直达这块死区。
 *
 *  2. **`attached` 复制失败留半截条目**。顺序是"先建条目拿 id → 复制 → 写路径",
 *     复制一抛,catch 只记 `errors`,**刚建的那行留在库里**(无文件、无归属)。
 *     `fileImport.ts` 里那句注释("反过来的话,失败会留下没主的无文件条目")
 *     说反了方向 —— 按现在的顺序,失败留下的是**没文件的无主条目**。
 *
 *  3. **笔记导入对失效分类 id 直调 `CollectionRepo.assign`**。sql.js 不开外键,
 *     一个过期的分类 id 会**静默插一行幽灵归属**:条目"属于"一个不存在的分类,
 *     于是它既不出现在任何分类下,又因为"有归属"而永远不会被 `sweepToTrash`
 *     收进回收站 —— 界面上**任何入口都够不着它**。PDF/通用文件那两条管线走的
 *     是 `assignImportedToCollections`(先核对分类还在),笔记这条漏了。
 *     `library.addItems` 与 `library.importGeneric` 两条 IPC 也在裸调。
 *
 *  4. **笔记导入失败后重试被自己卡死**。复制失败时条目行已经建了(同 2),
 *     而笔记的查重是**按标题**的 —— 重试那一次撞上自己留下的半截行,被判成
 *     "已经收过了",`skipped` +1,笔记**永远进不来**,也没有任何报错。
 *     顺带:重复导入(同标题)时选定的分类也被丢掉了 —— PDF 管线在
 *     `alreadyPresent` 那条路上专门写了"这条也要归属",笔记没有。
 *
 * 只用 fixture(临时数据根 + 临时源目录),不触任何真实服务。
 *
 * Run: scripts/maint-m33-smoke/run.sh
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";

/* ──────────────── 0. 起环境 ──────────────── */

const TMP = mkdtempSync(join(tmpdir(), "mcode-maint-m33-"));
const DATA = join(TMP, "data");
const SRC = join(TMP, "src");
mkdirSync(DATA, { recursive: true });
mkdirSync(SRC, { recursive: true });
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

const { IPC } = await import("@contracts/ipc");
const { registerLibraryHandlers } = await import("@main/ipc/library.js");
const { initDb } = await import("@main/store/db.js");
const { LibraryRepo, CollectionRepo } = await import("@main/store/repositories.js");
const { libraryRoot } = await import("@main/library/paths.js");
const { importGenericFiles, readEntryFile } = await import("@main/library/fileImport.js");
const { importNoteFiles, createNote } = await import("@main/library/notesImport.js");

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

const handlers = new Map<string, (...a: unknown[]) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (...a: unknown[]) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;
registerLibraryHandlers(fakeIpc);
await initDb();

const invoke = <T,>(channel: string, raw: unknown): Promise<T> => {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`没注册 ${channel}`);
  return Promise.resolve(fn(null, raw)) as Promise<T>;
};

const ROOT = libraryRoot();
/** 全库条目(list 默认只给 200,数条数必须绕开它)。 */
const allItems = () => LibraryRepo.list({ limit: 100_000 }).items;

/* ──────────────── 1. attached 模式收到目录:不许造"指向不存在文件"的条目 ──────────────── */

console.log("\n1. attached + 目录 → 按目录条目的唯一合法形态(linked)收,不造死条目");
{
  const dir = join(SRC, "一套讲义");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "第一章.txt"), "正文", "utf8");

  type GenericResult = {
    items: Array<{ id: string; entryMode?: string; filePath?: string }>;
    added: number;
    skipped: number;
    errors: Array<{ path: string; error: string }>;
  };
  const res = await invoke<GenericResult>(IPC.LIBRARY_IMPORT_GENERIC, {
    paths: [dir],
    mode: "attached",
  });
  eq("导入报成功一条", res.added, 1);
  eq("没有报错", res.errors.length, 0);
  const item = res.items[0]!;
  // ★ 症结:attached 分支对目录跳过复制,filePath 却写上 files/<id>-<名>。
  eq("★ 目录条目落成 linked(attached 装不下目录)", item.entryMode, "linked");
  eq("★ filePath 是那个目录本身", item.filePath, dir);
  check(
    "★ 库里没有指向 files/ 下不存在落点的死路径",
    !String(item.filePath ?? "").includes("files/") && !String(item.filePath ?? "").includes("files\\"),
    item.filePath,
  );
  const read = readEntryFile(item.id);
  eq("★ 点开条目读得动(目录列表),不是「文件不存在」", read.type, "dir");

  // 同一个目录再按 attached 导一次:linked 形态有键可查,必须认出重复。
  const again = await invoke<GenericResult>(IPC.LIBRARY_IMPORT_GENERIC, {
    paths: [dir],
    mode: "attached",
  });
  eq("★ 再导一次认出重复(skipped=1)", again.skipped, 1);
  eq("给回来的是原来那条", again.items[0]?.id, item.id);
}

/* ──────────────── 2. attached 复制失败:不留半截条目,重试可成 ──────────────── */

console.log("\n2. attached 复制失败 → 清理刚建的行;修好环境后重试成功");
{
  // 把 <库根>/files 占成一个**文件**:filesDir() 的 mkdirSync 必然抛。
  // 这是"复制那一步失败"的最小确定性模拟(磁盘满/权限跪在 CI 上都造不稳)。
  const filesPath = join(ROOT, "files");
  if (existsSync(filesPath)) rmSync(filesPath, { recursive: true, force: true });
  writeFileSync(filesPath, "占位:让 files/ 落点不可用", "utf8");

  const src = join(SRC, "要复制进库的.docx");
  writeFileSync(src, "一份文档", "utf8");

  const before = allItems().length;
  const res = importGenericFiles({ paths: [src], mode: "attached" });
  eq("失败如实报了", res.errors.length, 1);
  eq("added 为 0", res.added, 0);
  // ★ 症结:upsert 在复制之前,失败后那一行留在库里(无文件、无归属、够不着)。
  eq("★ 失败不留半截条目", allItems().length, before);

  // 环境修好后重试:必须成,而且文件真的落进 files/。
  rmSync(filesPath, { force: true });
  const retry = importGenericFiles({ paths: [src], mode: "attached" });
  eq("重试成功", retry.added, 1);
  const copied = retry.items[0]?.filePath ?? "";
  check("副本真的在库里", copied.startsWith("files/") && existsSync(join(ROOT, copied)), copied);
  eq("内容一致", readFileSync(join(ROOT, copied), "utf8"), "一份文档");
}

/* ──────────────── 3. 笔记导入 + 失效分类 id:不落幽灵归属行 ──────────────── */

console.log("\n3. 笔记导入带失效分类 id → 跳过归属,不插幽灵行");
{
  const note = join(SRC, "笔记甲.md");
  writeFileSync(note, "# 读书摘录甲\n\n正文", "utf8");

  const res = importNoteFiles([note], ["col_早就被删掉的分类"]);
  // ★ 症结:裸调 CollectionRepo.assign。外键关了是幽灵归属行(条目从此不出现在
  //   任何分类下,又因"有归属"永远进不了回收站);外键开着则 assign 抛,笔记被
  //   报成"导入失败",却已经半截入库。两种形态都不该发生。
  eq("★ 失效分类不该让笔记导入失败", res.added, 1);
  eq("★ 没有报错", res.errors.length, 0);
  const id = res.items[0]?.id;
  eq(
    "★ 不给不存在的分类插归属行(条目也不许悄悄半截入库)",
    id ? CollectionRepo.collectionsOfItem(id).length : allItems().filter((i) => i.title === "读书摘录甲").length,
    0,
  );
}

/* ──────────────── 4. 笔记重复导入:分类要跟上,条目要给回来 ──────────────── */

console.log("\n4. 同标题笔记重复导入 → 已有条目归入新选的分类,并给回那一条");
{
  const colA = CollectionRepo.create("笔记去处甲", null).id;
  const colB = CollectionRepo.create("笔记去处乙", null).id;

  const first = join(SRC, "周报.md");
  writeFileSync(first, "# 十月周报\n\n第一版", "utf8");
  const r1 = importNoteFiles([first], [colA]);
  eq("首次导入成功", r1.added, 1);
  const noteId = r1.items[0]!.id;
  check("归入了选定分类", CollectionRepo.collectionsOfItem(noteId).includes(colA));

  // 另一个文件、同一个正文标题 —— 笔记查重按标题,这是它的既定语义。
  const second = join(SRC, "周报-又拖了一次.md");
  writeFileSync(second, "# 十月周报\n\n手滑的第二次", "utf8");
  const r2 = importNoteFiles([second], [colB]);
  eq("判成重复(skipped=1)", r2.skipped, 1);
  eq("没有新增", r2.added, 0);
  // ★ 与 PDF 管线同一条口径:「这一份已经有了」不改变「用户要它出现在这个分类里」。
  check(
    "★ 已有条目归入了这次选的分类",
    CollectionRepo.collectionsOfItem(noteId).includes(colB),
    CollectionRepo.collectionsOfItem(noteId),
  );
  eq("★ 给回来的是原来那条(不是空手而归)", r2.items[0]?.id, noteId);
}

/* ── 4b. 笔记查重不许被一条静默的行数上限截断 ── */

console.log("\n4b. 库里匹配行多到超过上限时,同标题笔记仍要认出重复(不静默又建一条)");
{
  const first = join(SRC, "项目周会.md");
  writeFileSync(first, "# 项目周会\n\n第一版", "utf8");
  const r1 = importNoteFiles([first]);
  eq("首次导入成功", r1.added, 1);
  const noteId = r1.items[0]!.id;

  // 造一堆**标题里含同一个子串**的其它条目(没有 mdPath,不会被当成那篇笔记本身),
  // 它们比原笔记新,于是把原笔记挤出按 added_at 倒序的前 N 行窗口。
  // 从前查重是 `LibraryRepo.list({ query: title, limit: 50 })` —— 上限 50 在**精确匹配
  // 之前**把结果截掉,原笔记一旦落在这个窗口外,`find` 就找不到它,于是同一个标题
  // **静默又建一条**(而不是 skipped)。`findLinkedByPath` 的注释点名的正是这类:
  // "list() 有上限,超了就翻不到,重复导入静默变成又建了一条"。
  await new Promise((r) => setTimeout(r, 5)); // 保证填充条目比原笔记新(added_at 严格更大)
  for (let i = 0; i < 60; i += 1) LibraryRepo.upsert({ title: `项目周会 纪要副本 ${String(i)}` });

  // 另一个文件、同一个正文标题 —— 与 §4 同一个语义,只是库里多了足够多的匹配行。
  const second = join(SRC, "项目周会-又导了一次.md");
  writeFileSync(second, "# 项目周会\n\n第二次", "utf8");
  const r2 = importNoteFiles([second]);
  eq("★ 仍判成重复(skipped=1)", r2.skipped, 1);
  eq("★ 没有又建一条", r2.added, 0);
  eq("★ 给回来的是原来那条", r2.items[0]?.id, noteId);
}

/* ──────────────── 5. 笔记导入失败:不留半截行,重试不被卡死 ──────────────── */

console.log("\n5. 笔记复制失败 → 清理半截行;重试成功而不是被判『已存在』");
{
  // 把 <库根>/notes 占成文件,让 mkdir/copy 必然抛(ensureLibraryDirs 会吞掉它的失败)。
  const notesPath = join(ROOT, "notes");
  if (existsSync(notesPath)) rmSync(notesPath, { recursive: true, force: true });
  writeFileSync(notesPath, "占位:让 notes/ 落点不可用", "utf8");

  const note = join(SRC, "会议纪要.md");
  writeFileSync(note, "# 九月复盘会\n\n记录", "utf8");

  const r1 = importNoteFiles([note]);
  eq("失败如实报了", r1.errors.length, 1);
  eq("added 为 0", r1.added, 0);
  // ★ 症结之一:upsert 在复制之前,失败留下同标题的半截行。
  eq("★ 失败不留半截条目", allItems().filter((i) => i.title === "九月复盘会").length, 0);

  // 修好环境重试。
  rmSync(notesPath, { force: true });
  mkdirSync(notesPath, { recursive: true });
  const r2 = importNoteFiles([note]);
  // ★ 症结之二:半截行 + 按标题查重 = 重试被自己卡死(skipped=1、什么都没进来)。
  eq("★ 重试成功,而不是被半截行判成『已存在』", r2.added, 1);
  eq("这次没有 skipped", r2.skipped, 0);
  const saved = r2.items[0];
  check("md 真的落在 notes/ 下", Boolean(saved?.mdPath) && existsSync(join(ROOT, saved!.mdPath!)), saved?.mdPath);
}

/* ── 5b. `createNote` 与 `importNoteFiles` 是同一支流水,失败清理必须一样 ── */

console.log("\n5b. 新建笔记落文件失败 → 不留半截条目(与 importNoteFiles 同一口径)");
{
  // `createNote`(应用内新建空笔记)与 `importNoteFiles`(导入 md 笔记)在 notesImport.ts
  // 里是同一支流水的两处入口:都是 upsert 一行 → 往 `<库根>/notes/<id>.md` 落文件 →
  // setMarkdown。§5 已经给导入那一侧补了"失败就删掉半截行"的清理;新建那一侧漏了 ——
  // 落文件一抛,那行记录留在库里,界面上是一行打不开的空条目,而它**没有任何入口**够得着。
  const notesPath = join(ROOT, "notes");
  if (existsSync(notesPath)) rmSync(notesPath, { recursive: true, force: true });
  writeFileSync(notesPath, "占位:让 notes/ 落点不可用", "utf8");

  let threw: unknown = null;
  try {
    createNote("半截笔记");
  } catch (err) {
    threw = err;
  }
  check("★ 新建失败要抛出(不静默回一条空条目)", threw !== null);
  eq("★ 失败不留半截条目", allItems().filter((i) => i.title === "半截笔记").length, 0);

  // 修好环境,同一句重试要真的建成 —— 失败清理不能把正常路弄坏。
  rmSync(notesPath, { force: true });
  mkdirSync(notesPath, { recursive: true });
  const created = createNote("半截笔记");
  check("★ 环境修好后新建成功", created !== null && Boolean(created?.mdPath), created);
  check("md 真的落在 notes/ 下", Boolean(created?.mdPath) && existsSync(join(ROOT, created!.mdPath!)), created?.mdPath);
}

/* ──────────────── 6. library.addItems 的分类归属:同一条守门规则 ──────────────── */

console.log("\n6. addItems 带失效分类 id → 不插幽灵行;有效分类照常生效");
{
  type AddResult = { items: Array<{ id: string }> };
  // ★ 症结:handler 裸调 CollectionRepo.assign —— 外键关了是幽灵行,外键开着则
  //   handler 直接抛(条目已建、响应却是报错)。两种形态都不该发生。
  let addFailed: unknown = null;
  let r: AddResult = { items: [] };
  try {
    r = await invoke<AddResult>(IPC.LIBRARY_ADD_ITEMS, {
      items: [{ title: "手记一条", collectionIds: ["col_不存在"] }],
    });
  } catch (err) {
    addFailed = (err as Error).message;
  }
  eq("★ 失效分类不该让 addItems 抛错", addFailed, null);
  const id = r.items[0]?.id;
  eq(
    "★ 失效分类不插幽灵行(条目也不许半截入库)",
    id ? CollectionRepo.collectionsOfItem(id).length : allItems().filter((i) => i.title === "手记一条").length,
    0,
  );

  const colC = CollectionRepo.create("手记去处", null).id;
  const r2 = await invoke<AddResult>(IPC.LIBRARY_ADD_ITEMS, {
    items: [{ title: "手记二条", collectionIds: [colC] }],
  });
  check("有效分类照常归入", CollectionRepo.collectionsOfItem(r2.items[0]!.id).includes(colC));
}

/* ──────────────── 7. library.importGeneric 的 collectionIds:走同一条归属路 ──────────────── */

console.log("\n7. importGeneric 混着一个失效分类 id → 有效的生效,失效的不落幽灵行");
{
  const colD = CollectionRepo.create("通用去处", null).id;
  const src = join(SRC, "随便一份.bin");
  writeFileSync(src, "字节", "utf8");

  type GenericResult = { items: Array<{ id: string }> };
  // ★ 症结:handler 对 collectionIds 逐个裸调 assignToCollection —— 外键关了是
  //   幽灵行;外键开着则 handler 抛,文件已复制进库、调用方却只收到报错。
  let genFailed: unknown = null;
  let r: GenericResult = { items: [] };
  try {
    r = await invoke<GenericResult>(IPC.LIBRARY_IMPORT_GENERIC, {
      paths: [src],
      mode: "attached",
      collectionIds: [colD, "col_也不存在"],
    });
  } catch (err) {
    genFailed = (err as Error).message;
  }
  eq("★ 混着失效分类不该让 importGeneric 抛错", genFailed, null);
  const id = r.items[0]?.id;
  const homes = id ? CollectionRepo.collectionsOfItem(id) : [];
  check("★ 有效分类归入了", homes.includes(colD), { homes, id });
  eq("★ 失效的那个没落幽灵行", homes.length, 1);
}

/* ──────────────── 收尾 ──────────────── */

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
