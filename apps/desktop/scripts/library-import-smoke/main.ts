/**
 * Headless smoke for **通用文件导入**(`main/library/fileImport.ts` 的
 * `importGenericFiles` + `readEntryFile`)。
 *
 * ## 为什么要有这一套
 *
 * 这条路是"把东西放进库"的唯一入口(ppt、word、用户手上的任意文件/目录,界面上
 * 那两颗「导入文件」/「导入文件夹」按钮)。它有两件容易写错、而且**错了不报错**的事:
 *
 *  1. **attached 模式把文件复制进 `<库根>/files/`** —— 复制失败/半途而废会在库里
 *     留下一条**没有文件**的条目。所以顺序必须是"先建条目拿 id,再复制,再把路径写上";
 *     反过来(先复制)失败就留下无主文件。
 *  2. **`readEntryFile` 的越界判定**。目录条目内寻址靠 `relPath`,而拼完之后必须在
 *     那个目录里 —— 判错了就是"任意路径读文件"。判据用的是**字符串前缀**
 *     (`target.startsWith(root + sep)`),而前缀判定的经典漏洞是**兄弟目录**:
 *     `<dir>` 与 `<dir>-备份` 前缀相同却不是同一个目录。这一套把那一档钉住。
 *
 * 数据根换成本脚本自己的临时目录(见 run.sh 的 `--alias`),跑完就删 ——
 * 它真的会往"库根"里写文件,所以这一条不是可选项。
 *
 * Run: scripts/library-import-smoke/run.sh
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

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

const DATA = mkdtempSync(join(tmpdir(), "mcode-lib-import-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;
/** 库根在哪由 `dataRoot()` 决定,这里跟着算一份,用来核对落点。 */
const ROOT = join(DATA, "library");
/** 用户的"别处" —— 导入的来源文件都放这儿,和库根隔开。 */
const SRC = mkdtempSync(join(tmpdir(), "mcode-lib-import-src-"));

const { initDb } = await import("@main/store/db.js");
const { LibraryRepo } = await import("@main/store/repositories.js");
const { importGenericFiles, readEntryFile, entryFileAbsPath } = await import(
  "@main/library/fileImport.js"
);
const { libraryRoot } = await import("@main/library/paths.js");
const { importedIds, externals } = await import("./stubs/runtimeManager.js");

await initDb();
eq("库根就是临时数据根下面那个", libraryRoot(), ROOT);

/* ──────────────── 1. linked:只记路径,文件原地不动 ──────────────── */

console.log("\nlinked · 只记绝对路径");

const linkedSrc = join(SRC, "课件.pptx");
writeFileSync(linkedSrc, "假装是 ppt", "utf8");

const linked = importGenericFiles({ paths: [linkedSrc], mode: "linked" });
eq("导入成功一条", linked.added, 1);
eq("没有失败", linked.errors.length, 0);
const linkedItem = linked.items[0];
eq("落法是 linked", linkedItem?.entryMode, "linked");
eq("存的是绝对路径", linkedItem?.filePath, linkedSrc);
check("库里没有多出一份副本(files/ 下是空的)", !existsSync(join(ROOT, "files", `${linkedItem?.id}-课件.pptx`)));

// 同一条路径再导入一次 = 跳过(用户对同一个文件点两次是常态)。
const again = importGenericFiles({ paths: [linkedSrc], mode: "linked" });
eq("重复导入被跳过", again.skipped, 1);
eq("而且没有新增", again.added, 0);
eq("给回来的是原来那一条", again.items[0]?.id, linkedItem?.id);

// **同一个来源、两种落法**:linked 是"只记路径",attached 是"复制进库"。
// 它们查重查的不是同一个字段(linked 比绝对路径,attached 比库内相对路径),
// 所以**不该**互相算重复 —— 用户完全可能既要引用原件、又要在库里留一份副本。
const bothWays = importGenericFiles({ paths: [linkedSrc], mode: "attached" });
eq("同源文件另存一份 attached", bothWays.added, 1);
check("而且是一条新条目", bothWays.items[0]?.id !== linkedItem?.id, bothWays.items[0]?.id);

// 一次导入**同一个文件两遍**:只该进去一条。去重表是在这一趟开始时拍的快照
// (所以不能用数据库查),同一批里重复的路径必须靠它挡掉。
const twiceSrc = join(SRC, "同一批里出现两次.md");
writeFileSync(twiceSrc, "x", "utf8");
const twice = importGenericFiles({ paths: [twiceSrc, twiceSrc], mode: "linked" });
eq("同一批里出现两次 → 只进一条", twice.added, 1);
eq("另一条算跳过", twice.skipped, 1);
eq("两次给回来的是同一条目", twice.items[0]?.id, twice.items[1]?.id);

// 路径不存在 —— 要**说出来**,不能安静地少一条。
const missing = importGenericFiles({ paths: [join(SRC, "没有这个文件.pdf")], mode: "linked" });
eq("不存在的路径没有导入", missing.added, 0);
eq("记了一条错误", missing.errors.length, 1);
check("错误里说了是哪个路径", missing.errors[0]?.path.includes("没有这个文件") === true, missing.errors[0]);

/* ──────────────── 2. linked 的目录条目(模版"目录即条目") ──────────────── */

console.log("\nlinked 目录 · 读的是目录下的文件列表");

const dirSrc = join(SRC, "一套模版");
mkdirSync(join(dirSrc, "子目录"), { recursive: true });
writeFileSync(join(dirSrc, "说明.txt"), "正文", "utf8");
writeFileSync(join(dirSrc, "封面.docx"), "x", "utf8");

const dirItems = importGenericFiles({ paths: [dirSrc], mode: "linked" });
eq("目录也能导入", dirItems.added, 1);
const dirItem = dirItems.items[0]!;
eq("路径就是那个目录", entryFileAbsPath(dirItem), dirSrc);

const listing = readEntryFile(dirItem.id);
eq("读出来的是目录", listing.type, "dir");
if (listing.type === "dir") {
  const names = listing.files.map((f) => f.name);
  check("列了那两个文件", names.includes("说明.txt") && names.includes("封面.docx"), names);
  check("列了那个子目录", names.includes("子目录"), names);
  eq("子目录被标成目录", listing.files.find((f) => f.name === "子目录")?.isDir, true);
  eq("文件被标成文件", listing.files.find((f) => f.name === "说明.txt")?.isDir, false);
}

// 目录内寻址:能读到具体文件。
const inner = readEntryFile(dirItem.id, "说明.txt");
eq("能读目录里的文件", inner.type, "text");
eq("内容对", inner.type === "text" ? inner.text : "", "正文");

/* ──────────────── 3. 目录内寻址不能逃出去 ──────────────── */

console.log("\nreadEntryFile · relPath 越界");

// `..` 直接往上爬。
const up = readEntryFile(dirItem.id, "../../../等等.txt");
eq("`..` 爬出去 → 拒", up.type, "unsupported");
check("而且说了是越界", up.type === "unsupported" && up.error.includes("越出") === true, up.type === "unsupported" ? up.error : up);

// **兄弟目录**:`<dir>` 与 `<dir>-备份` 字符串前缀相同,却不是同一个目录。
// 这正是"用 startsWith 判包含"最经典的漏判 —— 必须连这一档一起挡住。
const sibling = `${dirSrc}-备份`;
mkdirSync(sibling, { recursive: true });
writeFileSync(join(sibling, "机密.txt"), "不该被读到", "utf8");
const escape = readEntryFile(dirItem.id, "../" + "一套模版-备份/机密.txt");
eq("兄弟目录(前缀相同但不是同一个目录)→ 拒", escape.type, "unsupported");
check(
  "没有把兄弟目录里的文件读出来",
  !(escape.type === "text" && escape.text.includes("不该被读到")),
  escape,
);

/* ──────────────── 4. attached:复制进库 ──────────────── */

console.log("\nattached · 复制进 <库根>/files/");

const attachSrc = join(SRC, "参考资料.md");
writeFileSync(attachSrc, "# 标题", "utf8");

const attached = importGenericFiles({ paths: [attachSrc], mode: "attached", kind: "document" });
eq("导入成功", attached.added, 1);
const attachedItem = attached.items[0]!;
eq("落法是 attached", attachedItem?.entryMode, "attached");
check(
  "存的是**相对库根**的路径(随库搬迁)",
  attachedItem?.filePath !== undefined && !attachedItem.filePath.includes(":"),
  attachedItem?.filePath,
);
const copiedAbs = entryFileAbsPath(attachedItem)!;
check("复制过去的文件真的在", existsSync(copiedAbs), copiedAbs);
eq("内容一模一样", readFileSync(copiedAbs, "utf8"), "# 标题");
check("落在库根的 files/ 下面", copiedAbs.startsWith(join(ROOT, "files") + sep), copiedAbs);

// 条目**真的有文件**(先建条目再复制那条顺序的验收:反过来失败会留下无主条目)。
const reread = readEntryFile(attachedItem.id);
eq("attached 条目读得动", reread.type, "text");

// ⚠️ **这里曾经想断言"同一个文件再按 attached 导入一次会跳过",但那个断言是错的** ——
// 记一笔免得以后有人再写一遍。`attached` 的 `file_path` 是
// `<库根>/files/<条目 id>-<原名>`,而 id 是**新建时**才生成的;库里也不记来源路径。
// 所以"这个文件是不是已经复制进库过"**事后问不出答案**,跨调用的重复认不出来。
// (早先的写法是拿绝对路径去比这个相对路径列,那一支恒假 —— 也是假的,只是假在
// 另一头:它连同一趟里的重复都不挡。)
//
// 能挡住的是**同一趟里**的重复(用户拖一个文件夹,里面两个东西指同一个文件;或者
// 手滑点两次)—— 见上面 `twice` 那一段。
const attachAgain = importGenericFiles({ paths: [attachSrc], mode: "attached" });
eq("attached 跨调用认不出重复(已知的形态代价,不是这次修的)", attachAgain.added, 1);

// 但**同一趟里**的重复必须挡住 —— 拖进来一个文件夹时里面两个东西指同一个文件是常事。
// 这一条是 `seen` 那张表存在的唯一理由:`linked` 有键可查(建条目时就把绝对路径写上
// 了),`attached` **没有** —— 它的 `file_path` 要等条目建出来、文件复制过去才写得上,
// 所以同一批里的第二次走到查库那一步时,第一次那条还查不到。
const twiceAttachSrc = join(SRC, "同一批里出现两次.md");
writeFileSync(twiceAttachSrc, "y", "utf8");
const twiceAttach = importGenericFiles({ paths: [twiceAttachSrc, twiceAttachSrc], mode: "attached" });
eq("attached 同一批里出现两次 → 只进一条", twiceAttach.added, 1);
eq("另一条算跳过", twiceAttach.skipped, 1);
eq("两次给回来的是同一条目", twiceAttach.items[0]?.id, twiceAttach.items[1]?.id);

// 文件类型不认识要**说出来**,不能让用户对着空白发呆。
const weirdPath = join(SRC, "奇怪.xyzzy");
writeFileSync(weirdPath, "x", "utf8");
const weird = importGenericFiles({ paths: [weirdPath], mode: "attached" });
const weirdRead = readEntryFile(weird.items[0]!.id);
eq("不认识的扩展名 → unsupported", weirdRead.type, "unsupported");
check(
  "而且说了是哪种扩展名",
  weirdRead.type === "unsupported" && weirdRead.error.includes("xyzzy"),
  weirdRead.type === "unsupported" ? weirdRead.error : weirdRead,
);

/* ──────────────── 5. 入库成功的那个信号 ──────────────── */

console.log("\n入库信号(library.item.imported)");

// 这条事件是**自动化的事件触发器与钩子唯一的信号** —— 少了就是"东西进库了、
// 自动化永远不响"。三个导入入口都从 `library/broadcast.ts` 的同一个函数发,而
// 导入器自己发出它(`fileImport.ts` 里那两处)正是"两条路共用一份实现"的落点。
const emitted = importedIds();
check("attached 那条发了", emitted.includes(attachedItem.id), { emitted, want: attachedItem.id });
check("linked 那条发了", emitted.includes(linkedItem!.id), { emitted, want: linkedItem!.id });
check("目录条目也发了", emitted.includes(dirItem.id), { emitted, want: dirItem.id });
// 一次导入一条,不多不少:**八条**进过库(linked 的文件、那个目录、linked 同源另存的
// attached 副本、同一批里那第二条路径首次入库、attached 的 md、那个不认识的扩展名、
// 上面那条 attached 重复导入(它确实又进了一条,那是这个落法的形态代价)、以及
// attached 同一批里的第二条路径首次入库)。上面被跳过的那三次(重复导入、同一批里的
// 第二次、同源另存之后再按 attached 存一次)以及那个不存在的路径都**不该**发 ——
// 计数正好把这一点也钉住(数目对不上就是"跳过/失败也发了",那种假信号会让自动化
// 对着一条根本没进库的东西跑起来)。
eq("一次导入一条,不多不少", emitted.length, 8);

// 而 attached 那条**真的复制了一份进库** —— 去重若按来源路径判,这里会被当成
// "已经导过"而跳过,文件就不会出现在库里(条目还在,点开是空的)。
const bothWaysCopy = entryFileAbsPath(bothWays.items[0]!);
check("另存的副本真的落了盘", bothWaysCopy !== null && existsSync(bothWaysCopy), bothWaysCopy);
eq("两份内容一致", bothWaysCopy ? readFileSync(bothWaysCopy, "utf8") : "", "假装是 ppt");
// 事件的形状:会话是合成哨兵"(system)"(导入不属于任何对话),模型侧靠它认。
eq("会话用 (system) 哨兵", (externals[0] as { sessionId?: string })?.sessionId, "(system)");

// ⚠️ `library:changed`(界面重拉)不在这一层 —— 它是**调用方**发的:用户那条路在
// `ipc/library.ts` 的 handler 末尾。所以这里看不到它,也不该在这里断言它。

/* ──────────────── 6. 一条都读不到的东西 ──────────────── */

console.log("\n读不动的条目");

const noFile = LibraryRepo.upsert({ kind: "document", title: "没有文件的条目" });
const noFileRead = readEntryFile(noFile.id);
eq("没有关联文件 → unsupported", noFileRead.type, "unsupported");
eq("凭空一条 id → unsupported", readEntryFile("li_根本没有这条").type, "unsupported");
// 文件被移走(linked 那条路的常态:用户把源文件删了)也要说清楚。
rmSync(linkedSrc, { force: true });
const goneRead = readEntryFile(linkedItem!.id);
eq("源文件被移走 → unsupported", goneRead.type, "unsupported");
check(
  "说的是「不在了」而不是别的",
  goneRead.type === "unsupported" && goneRead.error.includes("不存在"),
  goneRead.type === "unsupported" ? goneRead.error : goneRead,
);

/** 读目录里某个文件用的相对路径 —— 上面第五段用完之后不再需要,留着说明这个 sep 的用处。 */
void dirname;

/* ──────────────── 收尾 ──────────────── */

rmSync(DATA, { recursive: true, force: true });
rmSync(SRC, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
