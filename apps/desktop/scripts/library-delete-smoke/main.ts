/**
 * Headless smoke for **彻底删除**(`ipc/library.ts` 的 `library:deleteItems` +
 * `LibraryRepo.pathRefCounts`)。
 *
 * ## 为什么要有这一套
 *
 * 这条 handler 是库里**唯一不可逆**的操作,而它的覆盖面有一条明摆着的缺口:
 *
 *  1. **`filePath` 那一支从来没被删过。** handler 从头到尾只看 `pdfPath` / `mdPath`,
 *     删一条**只有 `filePath` 的通用条目**(attached 的 ppt / word / 任意文件)时
 *     直接跳过 —— 数据库行没了,`<库根>/files/<id>-<原名>` 永远躺在盘上。
 *     判据必须走到**最后一个引用者**才动手(见下面第 3 段)。
 *  2. **`pathRefCounts()` 也没数 `file_path`。** 光加删除分支不够:引用计数那道护栏
 *     本身没覆盖它的话,两条记录指着同一份副本时会删掉别人还在用的文件。
 *  3. **失败被静默吞掉。** `dropAbs` 整个包在 try/catch 里,catch 只 `log.warn` ——
 *     那写的是 `<userData>/logs/main.log`,**界面上什么都看不到**。而且调用方拿到
 *     的 `{ items }` 里没有任何字段能带"哪个文件没删掉"。于是"记录没了、文件还在"
 *     这件事对用户完全不可见,而他再也没法从界面上把它删掉。
 *
 * ## 两条踩过的坑,这一套钉住
 *
 *  - **`linked` 条目指向库外,而且可以是目录。** 用户自己的文件**不该被删** ——
 *    `isInsideLibrary` 那道守卫是救命的,不能因为"多了一个删除分支"就绕过它。
 *  - **`rmSync(dir, {recursive:false})` 在 Windows 上抛 `ERR_FS_EISDIR`,而且目录
 *    原地不动**(实测)。所以"记录删了、目录还在"是个**可复现**的形状,不是理论上
 *    的可能性 —— 第 5 段就拿它当夹具,顺便验"失败之后记录必须留着"。
 *
 * ## 它真的会往"库根"里写文件、也会真的删文件
 *
 * 数据根换成本脚本自己的临时目录(见 run.sh 的 `--alias`),跑完就删 ——
 * 绝不碰用户真正的资料库。库外那棵"用户的目录"也在一份独立的 `mktemp` 里。
 *
 * Run: scripts/library-delete-smoke/run.sh
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
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

const DATA = mkdtempSync(join(tmpdir(), "mcode-lib-delete-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;
/** 库根在哪由 `dataRoot()` 决定,这里跟着算一份,用来核对落点。 */
const ROOT = join(DATA, "library");
/** 用户的"别处" —— 库外那份文件/目录放这儿,和库根隔开。 */
const SRC = mkdtempSync(join(tmpdir(), "mcode-lib-delete-src-"));

const { initDb } = await import("@main/store/db.js");
const { LibraryRepo } = await import("@main/store/repositories.js");
const { libraryRoot } = await import("@main/library/paths.js");
const { importGenericFiles, entryFileAbsPath } = await import("@main/library/fileImport.js");
const { registerLibraryHandlers } = await import("@main/ipc/library.js");
const { IPC } = await import("@contracts/ipc");
const { changedReasons, resetSent } = await import("./stubs/window.js");
const { ensureWorkflowsCalls } = await import("./stubs/workflowsSeed.js");

/* ──────────────── 0. 把 handler 从注册函数里取出来 ──────────────── */

/**
 * `ipcMain` 的**记名替身**。本套要测的东西全在 handler 的**函数体**里(`dropAbs`
 * 的守卫、引用计数、失败怎么回报),而那些永远不是导出符号 —— 唯一能拿到的办法就是
 * 调 `registerLibraryHandlers`,把注册进来的那批函数按 channel 收下来。
 *
 * 这是本套唯一需要的脚手架:不起 Electron,也不需要真的 preload。
 */
const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

registerLibraryHandlers(fakeIpc);
await initDb();

function handlerFor(channel: string): (raw: unknown) => Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`registerLibraryHandlers 没有注册 ${channel}`);
  return (raw: unknown) => Promise.resolve(fn(null, raw));
}

const deleteItems = handlerFor(IPC.LIBRARY_DELETE_ITEMS);

/** 删除的返回。`failed` 是本套要求补上的那一个字段(契约见 `LibraryDeleteItemsResult`)。 */
interface DeleteFailure {
  id: string;
  /** 是哪一份:pdf / markdown / file。 */
  kind: string;
  /** 删不掉的那个**库内**路径。 */
  path: string;
  error: string;
}
interface DeleteResult {
  items: Array<{ id: string }>;
  failed?: DeleteFailure[];
}

async function del(ids: string[], deleteFiles = true): Promise<DeleteResult> {
  return (await deleteItems({ ids, deleteFiles })) as DeleteResult;
}

/** 一次删除的失败清单 —— 字段还没补上时给个空数组,好让断言红在**数目**上而不是崩掉。 */
function failedOf(res: DeleteResult): DeleteFailure[] {
  return res.failed ?? [];
}

/** 相对库根的路径(`file_path` / `md_path` 那一列存的就是这个拼法)。 */
function rel(abs: string): string {
  return abs.slice(ROOT.length + 1).split(sep).join("/");
}

eq("库根就是临时数据根下面那个", libraryRoot(), ROOT);
check("注册时确实调了 ensureWorkflows(流程脚本不能因为改删除而消失)", ensureWorkflowsCalls() > 0);
check("拿到了 deleteItems 的 handler", handlers.has(IPC.LIBRARY_DELETE_ITEMS));

/* ──────────────── 1. attached 副本:`<库根>/files/<id>-<原名>` 必须跟着走 ──────────────── */

console.log("\nattached 副本 · 只有 filePath 的通用条目");

// 这是缺口那一档:**没有 pdfPath、没有 mdPath**,只有 `filePath`。
// 改之前 handler 走到 `if (!mdRel || …) continue` 就跳过了 —— 行没了,文件留着。
const pptSrc = join(SRC, "毕设答辩.pptx");
writeFileSync(pptSrc, "假装是 ppt 的字节", "utf8");
const attached = importGenericFiles({ paths: [pptSrc], mode: "attached" });
const ppt = attached.items[0]!;
const pptCopy = entryFileAbsPath(ppt)!;
check("副本落在 <库根>/files/ 下面", pptCopy.startsWith(join(ROOT, "files") + sep), pptCopy);
check("副本真的在盘上", existsSync(pptCopy), pptCopy);
check("条目只有 filePath,没有 pdf/md", !ppt.pdfPath && !ppt.mdPath, {
  pdfPath: ppt.pdfPath,
  mdPath: ppt.mdPath,
});

resetSent();
const pptRes = await del([ppt.id]);
check("记录删掉了", LibraryRepo.get(ppt.id) === null, LibraryRepo.get(ppt.id));
check("返回的列表里也没有它了", !pptRes.items.some((i) => i.id === ppt.id));
// ⚠️ **这一条就是整个套件存在的理由。**
check("磁盘上那份副本也删掉了(不然就是永远躺在 files/ 里的垃圾)", !existsSync(pptCopy), pptCopy);
eq("这一次没有失败", failedOf(pptRes).length, 0);
eq("删完通知了界面", changedReasons.length, 1);

/* ──────────────── 2. linked 指向库外 —— 一个字节都不许动 ──────────────── */

console.log("\nlinked · 用户自己的文件(库外)");

const outerFile = join(SRC, "老板给的表格.xlsx");
writeFileSync(outerFile, "别人还在用这份原件", "utf8");
const linkedFile = importGenericFiles({ paths: [outerFile], mode: "linked" }).items[0]!;
eq("存的是库外的绝对路径", linkedFile.filePath, outerFile);
check("库里没有多出一份副本", !existsSync(join(ROOT, "files", `${linkedFile.id}-老板给的表格.xlsx`)));

const delLinkedFile = await del([linkedFile.id]);
check("记录删掉了", LibraryRepo.get(linkedFile.id) === null);
// 这一条是 `isInsideLibrary` 那道守卫的验收:守卫一旦被绕过,用户的原件就没了。
check("库外那份原件一个字节没动", existsSync(outerFile) && readFileSync(outerFile, "utf8") === "别人还在用这份原件");

// ⚠️ **linked 的删除带一条"失败",而这是刻意的、也是必需的。**
//
// 用户点的是「彻底删除」,确认框里写着"文件也会被删" —— 而这份文件**没有被删**
// (它本来也不该被删:它在用户自己的目录里,库只是记了个路径)。返回 `failed: []`
// 等于告诉他"删干净了",而磁盘上那份原件还在,他会以为软件没删干净、或者以为
// 这几条根本不删文件。
//
// 所以库外路径走进 `failed`:调用方拿得到"这一份我没动,因为它是你的文件",
// 界面上就能说清楚。**记录照删** —— `linked` 条目的记录删掉正是用户的本意。
// 换句话说:`failed` 在这里的语义是"哪一份文件没被删掉",不是"哪一条没删成功"。
const linkedFailures = failedOf(delLinkedFile);
eq("库外的 linked 报了一条", linkedFailures.length, 1);
eq("说的是哪一条", linkedFailures[0]?.id, linkedFile.id);
eq("说的是哪一份", linkedFailures[0]?.kind, "file");
eq("带上了库外那个路径", linkedFailures[0]?.path, outerFile);
check("理由说清了那是他自己的文件", (linkedFailures[0]?.error ?? "").includes("不在资料库目录"), linkedFailures[0]);

// linked 还**可以是目录**(模版"目录即条目")。目录那一档要更小心:
// `rmSync(dir, {recursive:true})` 会连里面所有东西一起端掉。
const outerDir = join(SRC, "我自己的一套模版");
mkdirSync(join(outerDir, "子目录"), { recursive: true });
writeFileSync(join(outerDir, "说明.txt"), "正文", "utf8");
writeFileSync(join(outerDir, "子目录", "深处.txt"), "再深一层", "utf8");
const linkedDir = importGenericFiles({ paths: [outerDir], mode: "linked" }).items[0]!;
eq("目录条目的路径就是那个目录", entryFileAbsPath(linkedDir), outerDir);

const delLinkedDir = await del([linkedDir.id]);
check("记录删掉了", LibraryRepo.get(linkedDir.id) === null);
check("库外那个目录还在", existsSync(outerDir), outerDir);
check("里面的文件也一个没少", existsSync(join(outerDir, "子目录", "深处.txt")), outerDir);
// 目录那一档同样如实报出来:linked **可以是目录**,而目录比文件更危险 ——
// `rmSync(dir, {recursive:true})` 会把里面所有东西一起端掉。守卫拦住它,并且告诉用户。
const dirFailures = failedOf(delLinkedDir);
eq("目录也报了一条", dirFailures.length, 1);
eq("带上了那个目录", dirFailures[0]?.path, outerDir);

/* ──────────────── 3. 库内文件被别的记录指着 → 不许删 ──────────────── */

console.log("\n共用一份副本 · 引用计数要管住 file_path");

// PDF 按内容哈希寻址,"同一篇导两次"就是两条记录指同一个文件 —— 那一档早就有护栏。
// 这里要钉的是**同一道护栏对 `file_path` 也要成立**:两条记录指着同一份 attached 副本
// 时,删掉其中一条不能把另一条的文件端走。
const sharedSrc = join(SRC, "共用的资料.pdf");
writeFileSync(sharedSrc, "同一份字节", "utf8");
const holderA = importGenericFiles({ paths: [sharedSrc], mode: "attached" }).items[0]!;
const sharedRel = holderA.filePath!;
const sharedAbs = entryFileAbsPath(holderA)!;

// 第二条记录指向**同一个 `file_path`**。正常导入算不出这个形状(attached 的路径带自己
// 的 id),但库里只要有两条行指着同一个字符串就足够 —— 判据本来就是按路径数行。
const holderB = LibraryRepo.upsert({ title: "指着同一份副本的第二条", entryMode: "attached" });
LibraryRepo.setFilePath(holderB.id, sharedRel);
eq("两条记录确实指着同一个路径", LibraryRepo.get(holderB.id)!.filePath, sharedRel);

// ⚠️ 引用计数本身的第一条断言:`pathRefCounts()` 必须把 `file_path` 数进去。
// 少了它,下面"还有别人指着"这一判据建在一张漏了这条列的表上。
eq("pathRefCounts 数得到 file_path", LibraryRepo.pathRefCounts().get(sharedRel), 2);

const keepFirst = await del([holderA.id]);
check("删第一条:副本必须留着(还有别人指着)", existsSync(sharedAbs), sharedAbs);
eq("而且不算失败(那不是失败,是刻意不动)", failedOf(keepFirst).length, 0);

const dropLast = await del([holderB.id]);
check("删最后一条:副本该删了", !existsSync(sharedAbs), sharedAbs);
eq("也没有失败", failedOf(dropLast).length, 0);

/* ──────────────── 4. deleteFiles 关掉时,一个字都不许碰 ──────────────── */

console.log("\n只删记录(deleteFiles 省略)");

const keepSrc = join(SRC, "只是想从库里移走.docx");
writeFileSync(keepSrc, "内容", "utf8");
const kept = importGenericFiles({ paths: [keepSrc], mode: "attached" }).items[0]!;
const keptAbs = entryFileAbsPath(kept)!;
const keptRes = await del([kept.id], false);
check("记录删掉了", LibraryRepo.get(kept.id) === null);
check("文件原地不动(契约里 deleteFiles 默认 false 就是这个意思)", existsSync(keptAbs), keptAbs);
eq("也不是失败", failedOf(keptRes).length, 0);

/* ──────────────── 5. 删不掉的时候:如实报出来,而且记录留着 ──────────────── */

console.log("\n删失败 · 不能静默吞掉");

// 造一个**真的删不掉**的形状:库内那份副本被换成了同名目录,而 handler 是按"文件"
// 删它的(recursive:false)。Windows 上 `rmSync` 对目录抛 `ERR_FS_EISDIR`,目录原地不动
// —— 实测如此,所以这不是假想的失败。
const acrossSrc = join(SRC, "跨平台会出问题的资料.bin");
writeFileSync(acrossSrc, "字节", "utf8");
const dirCase = importGenericFiles({ paths: [acrossSrc], mode: "attached" }).items[0]!;
const dirCaseAbs = entryFileAbsPath(dirCase)!;
rmSync(dirCaseAbs, { force: true });
mkdirSync(dirCaseAbs, { recursive: true });
writeFileSync(join(dirCaseAbs, "占位的.txt"), "目录里还有东西", "utf8");

const broken = await del([dirCase.id]);
const brokenFailed = failedOf(broken);

// ① 调用方拿得到"哪个文件没删掉" —— 这是渲染端唯一能提示用户的凭据。
eq("返回里带了失败清单", brokenFailed.length, 1);
eq("失败说的是哪一条", brokenFailed[0]?.id, dirCase.id);
eq("失败说的是哪一份", brokenFailed[0]?.kind, "file");
check("失败带上了库内路径", (brokenFailed[0]?.path ?? "").includes(dirCase.id), brokenFailed[0]);
check("失败带上了原因(不是空串)", (brokenFailed[0]?.error ?? "").length > 0, brokenFailed[0]);

// ② ⚠️ **记录必须留着。** 删了记录、文件还在,用户就从界面上再也够不着那个文件了
// —— 失败清单只是锦上添花,这一条才是根子上的。
check("记录没有被删掉(不然用户再也够不着那个文件)", LibraryRepo.get(dirCase.id) !== null);
check("返回的列表里它还在", broken.items.some((i) => i.id === dirCase.id));

// ③ 同一个调用里**成功的那几条照样成功**,不能一条失败就整批回滚。
const okSrc = join(SRC, "同一批里正常的那份.txt");
writeFileSync(okSrc, "正常", "utf8");
const okItem = importGenericFiles({ paths: [okSrc], mode: "attached" }).items[0]!;
const okAbs = entryFileAbsPath(okItem)!;
const mixed = await del([dirCase.id, okItem.id]);
check("同批里正常的那条记录删掉了", LibraryRepo.get(okItem.id) === null);
check("它的文件也删掉了", !existsSync(okAbs), okAbs);
eq("失败清单里只有那一条", failedOf(mixed).length, 1);
eq("还是那一条", failedOf(mixed)[0]?.id, dirCase.id);
check("坏的那条记录仍然留着", LibraryRepo.get(dirCase.id) !== null);

// 收尾:把那个删不掉的目录清掉,别让它拖累后面的断言。
rmSync(dirCaseAbs, { recursive: true, force: true });

/* ──────────────── 6. 删分类:子分类里的条目不能被漏下 ──────────────── */

console.log("\n删分类 · 整棵子树的成员都要有归属");

// **与 `library-trash-smoke` 的 §4 跑的是同一个动作**,只是这里走**真的那个 handler**
// (`LIBRARY_DELETE_COLLECTION`)—— 那边是直接调 `sweepToTrash` 复盘那条 IPC 的写法,
// 这边是让它真的发生。两处都留着:一个钉住"事实本身",一个钉住"接线接对了没有"。
//
// ## 漏了会怎样
//
// 分类是树,子分类是**跟着一起被 CASCADE 删掉的** —— 它里面的成员关系同时被静默摘掉。
// 只查被删那一层的话(`listByCollection`,不递归),那些条目既不在任何分类里、也没被
// 收进回收站,变成左栏里再也找不回来的僵尸记录(`trash.ts` 文件头警告的正是这一种)。
// 同一个用户动作,结果取决于一个他看不见的结构细节:挂在父上就没事,挂在子分类上就丢。
const { CollectionRepo } = await import("@main/store/repositories.js");
const { ensureTrashCollection } = await import("@main/library/trash.js");
// 回收站得先存在 —— 不然下面"有没有进回收站"断的全是 false(什么都没进,因为
// 压根没有那个集合),而那读起来像"这段改坏了"。
const paperTrash = ensureTrashCollection();
const parentCol = CollectionRepo.create("要被删的父分类", null, "paper").id;
const childCol = CollectionRepo.create("子分类", parentCol, "paper").id;
const grandCol = CollectionRepo.create("孙分类", childCol, "paper").id;

const underParent = LibraryRepo.upsert({ title: "挂在父上" }).id;
const underChild = LibraryRepo.upsert({ title: "只挂在子上" }).id;
const underGrand = LibraryRepo.upsert({ title: "只挂在孙子上" }).id;
CollectionRepo.assign(parentCol, [underParent], true);
CollectionRepo.assign(childCol, [underChild], true);
CollectionRepo.assign(grandCol, [underGrand], true);

// 改之前:`listByCollection(父)` 只给得到 `underParent` 一条,后两条被 CASCADE 摘掉
// 之后就没人管了。这一条断言先把"漏了谁"变成能跑出来的事实。
eq(
  "非递归的查法只会看到挂在父上的那一条(所以光用它不够)",
  LibraryRepo.listByCollection(parentCol).length,
  1,
);
eq(
  "递归的查法(这次改用的)能看到整棵子树的三条",
  LibraryRepo.listByCollectionTree(parentCol).length,
  3,
);

const deleteCollection = handlerFor(IPC.LIBRARY_DELETE_COLLECTION);
await deleteCollection({ id: parentCol });

const inTrash = (itemId: string): boolean =>
  LibraryRepo.listByCollection(paperTrash).some((i) => i.id === itemId);

check("挂在父上的进了回收站", inTrash(underParent));
// ★ 这三条是这一段存在的理由。
check("★ 只挂在子分类上的也进了回收站(不然就是找不回来的孤儿)", inTrash(underChild));
check("★ 只挂在孙分类上的也一样(整棵子树,不是只看一层)", inTrash(underGrand));
check("三条记录都还在库里(删分类不删文献)", [underParent, underChild, underGrand].every((id) => LibraryRepo.get(id) !== null));
// 子分类自己确实是跟着没的 —— 那是外键的 CASCADE 在干,不是这次改的。
check(
  "父/子/孙三个分类都不在了(CASCADE)",
  !CollectionRepo.list().some((c) => [parentCol, childCol, grandCol].includes(c.id)),
);

// **从回收站删分类时不收**(否则条目会被立刻捞回回收站,用户删不掉)。
// 判据仍然是 `shouldSweepAfterRemoval` —— 这次改动一个字都没动它。
{
  const stillOrphan = LibraryRepo.upsert({ title: "待会儿变孤儿的一条" }).id;
  const subOfTrash = CollectionRepo.create("回收站里的子分类", paperTrash, "paper").id;
  CollectionRepo.assign(subOfTrash, [stillOrphan], true);
  // 从**回收站本身**删:不收。
  await deleteCollection({ id: paperTrash });
  check("回收站本身删得掉(没有被重新建出来)", !CollectionRepo.list().some((c) => c.id === paperTrash));
  check("而从它里面删掉的条目没有被收回来(记录还在库里)", LibraryRepo.get(stillOrphan) !== null);
}

/* ──────────────── 7. 库外路径写进了记录(脏数据)也要挡住 ──────────────── */

console.log("\n脏数据 · 记录里的路径指向库外");

// `file_path` 可以是外来的绝对路径(linked 就是这么用的),所以这条路上**没有**"相对
// 库根"那层隐含约束 —— `isInsideLibrary` 是唯一的守卫。这里塞一条 entryMode 写坏的记录:
// attached 的语义是"文件在库里",但路径指到了库外。守卫该拦下来。
const poisonSrc = join(SRC, "不该被删的原件.md");
writeFileSync(poisonSrc, "用户的原件", "utf8");
const poisoned = LibraryRepo.upsert({
  
  title: "路径被写坏的记录",
  entryMode: "attached",
  filePath: poisonSrc, // ← 库外绝对路径,不该被当成"库内副本"
});
const poisonRes = await del([poisoned.id]);
const poisonFailed = failedOf(poisonRes);
check("库外那个文件没被删", existsSync(poisonSrc), poisonSrc);
eq("内容也没动", readFileSync(poisonSrc, "utf8"), "用户的原件");
// 这一档**必须报出来**:记录写坏了(`attached` 的路径指到库外),而这条记录被删了
// —— 用户点的是"连文件一起删",实际什么都没删。静默的话他永远不知道有这件事。
eq("如实报成一条失败", poisonFailed.length, 1);
eq("说的是哪一条", poisonFailed[0]?.id, poisoned.id);
// ⚠️ 与 linked 那一段刻意不同:**这条记录要留着**(所以它不算"删成功")。
// 区别在 entryMode:linked 的语义本来就是"文件在库外",记录删掉是用户的本意;
// 而 attached 的语义是"文件在库里",路径指到库外说明**这条记录是坏的** ——
// 证据得留着,不然用户连"哪条记录坏了"都查不出来。
check("记录留着(它是坏数据,证据不能一起删掉)", LibraryRepo.get(poisoned.id) !== null);

/* ──────────────── 8. 勾了「一起删」的,对面那条也被删 ──────────────── */

console.log("\n删条目 · cascadeLinks(勾 = 这条也一起删)");

// 用户的原话：「会把你选择的文件所链接的文件一并展示出来,由用户选择是否连带链接
// 文件也一起删掉」。所以勾 = **把被链接的那条也删掉**。
//
// ⚠️ 一开始这里断的是"保留关联"(keepLinks),**测试自己红了才发现方向反了**:
// `library_item_links` 两列都带 ON DELETE CASCADE,删掉一头那条关联行由数据库自动
// 带走 —— "保留关联"根本做不到。见契约里那段。
{
  const { LibraryLinkRepo } = await import("@main/store/repositories.js");
  const mkDoc = (name: string) => {
    const f = join(SRC, name);
    writeFileSync(f, name, "utf8");
    return importGenericFiles({ paths: [f], mode: "attached" }).items[0]!;
  };

  // ── ① 不勾:只删自己,被链接的那条**留着** ──
  const hub = mkDoc("hub.txt");
  const out1 = mkDoc("out1.txt");
  const out2 = mkDoc("out2.txt");
  const referrer = mkDoc("referrer.txt");

  LibraryLinkRepo.add(hub.id, { targetItemId: out1.id });
  LibraryLinkRepo.add(hub.id, { targetItemId: out2.id });
  LibraryLinkRepo.add(referrer.id, { targetItemId: hub.id });

  await del([hub.id]);
  eq("hub 自己没了", LibraryRepo.get(hub.id), null);
  check("★ 没勾 → 被它链接的那条**留着**", LibraryRepo.get(out1.id) !== null);
  check("★ 另一条也留着", LibraryRepo.get(out2.id) !== null);
  check("★ 指着它的那条也还在(反面:删 B 不该把 A 也删了)", LibraryRepo.get(referrer.id) !== null);

  // ── ② 勾了:cascadeLinks 里那条也一起删 ──
  const hub2 = mkDoc("hub2.txt");
  const alsoGo = mkDoc("alsogo.txt");
  const stay = mkDoc("stay.txt");
  LibraryLinkRepo.add(hub2.id, { targetItemId: alsoGo.id });
  LibraryLinkRepo.add(hub2.id, { targetItemId: stay.id });

  // 副本的落点是确定的:`<库根>/files/<id>-<原名>`(与第 1 段同一个拼法)。
  const alsoGoCopy = join(ROOT, "files", `${alsoGo.id}-alsogo.txt`);
  check("勾之前:那条的副本在盘上", existsSync(alsoGoCopy), alsoGoCopy);

  await deleteItems({
    ids: [hub2.id],
    deleteFiles: true,
    // 用户勾了"这条也一起删"。
    cascadeLinks: [alsoGo.id],
  });
  eq("★ 勾了的那条**被一起删了**", LibraryRepo.get(alsoGo.id), null);
  check("★ 没勾的那条**还在**", LibraryRepo.get(stay.id) !== null);
  // 文件也要跟着走 —— 它走的是**同一套**清理(dropAbs / 引用计数)。
  check("★ 勾了的那条,磁盘文件也一起没了", !existsSync(alsoGoCopy), alsoGoCopy);
}

/* ──────────────── 收尾 ──────────────── */

rmSync(DATA, { recursive: true, force: true });
rmSync(SRC, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
