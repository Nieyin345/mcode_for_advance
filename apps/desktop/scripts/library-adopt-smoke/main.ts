/**
 * Headless smoke for **采纳 Markdown 这条路上的两个数据丢失**
 * (`main/library/adoptMarkdown.ts` + `main/library/convert.ts`)。
 *
 * ## 钉的两件事
 *
 * **① 采纳必须是可逆的。** `adoptMarkdownFile` 早先是"先 `rmSync` 老整包 → 再
 * `copyFileSync` 新的"。中间任一步失败(源文件读不了、父目录不可写、磁盘满、路径太长),
 * 用户**原来那一包就没了**,新的也没进来 —— 不可逆。用户点一下「改用这个 Markdown」,
 * 原有产物静默消失。
 *
 * **② 重转不许覆盖用户给的那份。** `convertItemToMarkdown` 从前只看 `force`,而"重转"
 * 这条路**永远带 force**(设置页的「重转这篇」、详情页的「重新转换」、AI 的
 * `library_convert` 都带)。于是用户手动采纳进来、或自己改过的 Markdown,会被本地抽取
 * 重新生成的覆盖掉 —— 而本地抽取只有纯文本,是**降级**,不是重做。
 *
 * ## 失败不靠撞运气
 *
 * 「拷到一半失败」这种瞬时故障若只靠"碰一次",这套冒烟就是摆设。所以用 `icacls` 把
 * **读 / 写权限对所有人拒掉**,造出 `EPERM` —— 确定性、可重复、而且正好落在被测的那一步
 * (见 `denyRead` / `denyWriteIn` 的注释,那里记着实测的 errno)。
 *
 * ⚠️ `icacls` 的拒绝 ACE **不是对称的**:父目录上事后新建的子目录**不会**继承它。所以
 * 注入过的路径必须逐个反转,否则临时目录删不掉(反转失败会让本套"通过但留下垃圾",
 * 所以反转也断言)。
 *
 * 数据根换成本脚本自己的临时目录(见 run.sh 的 `--alias`),跑完就删 —— 它会真的建库、
 * 真的往"库根"里写文件、真的删目录。
 *
 * Run: scripts/library-adopt-smoke/run.sh
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

const DATA = mkdtempSync(join(tmpdir(), "mcode-adopt-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;
const ROOT = join(DATA, "library");
/** 用户的"别处" —— 待采纳的 md 与它的配图都放这儿,和库根隔开。 */
const SRC = mkdtempSync(join(tmpdir(), "mcode-adopt-src-"));

const { initDb } = await import("@main/store/db.js");
const { LibraryRepo } = await import("@main/store/repositories.js");
const { adoptMarkdownFile } = await import("@main/library/adoptMarkdown.js");
const { convertItemToMarkdown, repairCollectionMarkdown, conversionReport } = await import("@main/library/convert.js");
const { libraryRoot, fromLibraryRelative, toLibraryRelative, pdfPathForHash } = await import(
  "@main/library/paths.js"
);
const { libraryMcpTools } = await import("@main/mcp/libraryServer.js");

await initDb();
eq("库根就是临时数据根下面那个", libraryRoot(), ROOT);

/* ──────────────── 故障注入的小工具 ──────────────── */

/**
 * 对"所有人"(`S-1-1-0`)拒掉某个路径的一种权限。
 *
 * 三档各对应一个真实故障,理由见各自的调用点:
 *   - `(RD)` 读 —— 源文件读不了(源被占用 / 权限 / 网络盘掉了);
 *   - `(OI)(CI)(WD,AD)` 写+建子目录 —— 目标目录不可写(磁盘满 / 权限 / 只读介质)。
 *
 * ⚠️ 用 `S-1-1-0`(Everyone)而不是当前用户:当前用户是管理员时,把 ACE 加在用户名上
 * 那条拒绝对他没有约束力,失败就"注入不进去"了(实测)。
 */
function icacls(args: string[]): boolean {
  try {
    execFileSync("icacls", args, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function denyRead(absFile: string): boolean {
  return icacls([absFile, "/deny", "*S-1-1-0:(RD)"]);
}

function denyWriteIn(dir: string): boolean {
  return icacls([dir, "/deny", "*S-1-1-0:(OI)(CI)(WD,AD)"]);
}

/** 反转注入。**必须逐个调** —— 父目录上的拒绝 ACE 不会自动覆盖到事后新建的子目录。 */
function allowAll(p: string): boolean {
  const ok = icacls([p, "/remove:d", "*S-1-1-0"]);
  // icacls 的"已处理 0 个文件"也算成功 —— 没注入过的地方反转是空操作,不该报错。
  if (!existsSync(p)) process.stderr.write(`[smoke] allowAll:${p} 不在了,跳过\n`);
  return ok || !existsSync(p);
}

/* ──────────────── 夹具 ──────────────── */

const IMPORTED = join(ROOT, "markdown", "imported");

/** `markdown/imported/` 下面现在有哪几项(用来断言"没留下暂存残渣")。 */
function importedEntries(): string[] {
  try {
    return readdirSync(IMPORTED).sort();
  } catch {
    return [];
  }
}

/** 落点目录里的一份文件(相对那个条目的包根)。 */
function inPackage(itemId: string, ...rest: string[]): string {
  return join(IMPORTED, itemId, ...rest);
}

/**
 * 落点下面只有这个条目那一项吗,而且没有暂存目录的残渣。
 *
 * ⚠️ 用**拼成字符串**比,不用数组 —— `eq` 是 `Object.is`,两个内容相同的数组永远不等,
 * 而那会红成一条看不出哪错了的断言(本套第一版就踩了)。
 */
function packageOnly(itemId: string): string {
  return importedEntries().join(" | ");
}

/** 读一份库内相对路径的文件文本;不在就给 null(断言里好区分"没了"和"内容不对")。 */
function textAt(abs: string): string | null {
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/**
 * 造一条**真的能读出文本**的文献(样例 PDF 落到内容寻址的位置)。
 *
 * 只有第 4 段需要它:那一组要验"重转到底转不转",没有真 PDF 就无从谈起。
 * ⚠️ 不在脚本里手拼 PDF —— pdf.js 对结构挑剔到"拼错一处就解析不出来",那看起来和
 * "被测代码坏了"一模一样(见 `scripts/fixtures/make_sample_pdf.py`)。
 */
const PDF_FIXTURE = join(process.cwd(), "scripts", "fixtures", "sample-paper.pdf");
if (!existsSync(PDF_FIXTURE)) {
  throw new Error(`样例 PDF 不在:${PDF_FIXTURE} —— 第 4 段靠它验「本地抽取」那条真路`);
}

function seedPaper(title: string, sha: string): string {
  const id = LibraryRepo.upsert({ title }).id;
  const target = pdfPathForHash(sha);
  mkdirSync(join(target, ".."), { recursive: true });
  copyFileSync(PDF_FIXTURE, target);
  LibraryRepo.setPdf(id, toLibraryRelative(target), sha);
  return id;
}

/* ──────────────── 1. 采纳:第一版先正常挂上 ──────────────── */

console.log("\n采纳 · 第一版挂上");

const item = LibraryRepo.upsert({ title: "有一份好转录的那一篇" }).id;

const v1 = mkdtempSync(join(tmpdir(), "mcode-adopt-v1-"));
mkdirSync(join(v1, "images"), { recursive: true });
writeFileSync(join(v1, "full.md"), "# 第一版\n\n![图](images/a.jpg)\n", "utf8");
writeFileSync(join(v1, "images", "a.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));

const first = adoptMarkdownFile(item, join(v1, "full.md"));
check("第一版挂上了", first.ok, first);
eq("md_path 落在 imported/<id>/ 下面", LibraryRepo.get(item)!.mdPath, `markdown/imported/${item}/full.md`);

const pkgMd = inPackage(item, "full.md");
const pkgImg = inPackage(item, "images", "a.jpg");
const v1Text = textAt(pkgMd);
const v1ImgSize = existsSync(pkgImg) ? statSync(pkgImg).size : -1;
eq("正文在", v1Text, "# 第一版\n\n![图](images/a.jpg)\n");
eq("配图也在(7 字节)", v1ImgSize, 7);
eq("落点下面只有这个条目那一项,没有暂存残渣", packageOnly(item), item);
const v1MdPath = LibraryRepo.get(item)!.mdPath;

/* ──────────────── 2. 拷到一半失败 —— 原来那份必须还在 ──────────────── */

console.log("\n采纳 · 源文件读不了时,库里的老包必须完好");

// 场景:用户选了第二份 md,而那份**读不出来**(源被独占 / 权限 / 网络盘掉了)。
//
// ⚠️ 这里拒的是**源文件**,不是父目录:`existsSync` / `statSync().isFile()` 在拒绝读之后
// 仍然成立(实测),所以前面的守卫不会先把它挡掉 —— 失败**恰好落在复制那一步**,也就是
// 老写法里"老包已经删了、新的还在拷"的那一刻。
const v2 = mkdtempSync(join(tmpdir(), "mcode-adopt-v2-"));
writeFileSync(join(v2, "full.md"), "# 第二版(读不出来)\n", "utf8");
check("注入:源文件拒绝读", denyRead(join(v2, "full.md")));

const second = adoptMarkdownFile(item, join(v2, "full.md"));
check("这次采纳**失败了**", !second.ok, second);
check("而且如实说了是复制的问题", (second.error ?? "").includes("复制"), second.error);
eq("失败时 relPath 是空的(没有谎报落点)", second.relPath, "");

// ⚠️ 这套冒烟的全部意义就在下面这三条。老写法在这一刻:老包已经被 rmSync 掉了,
// 下面每条都会红(正文没了 / 图没了 / md_path 指向一个不存在的文件)。
eq("① 那包的正文一个字没动", textAt(pkgMd), v1Text);
eq("② 那包的配图还在、还是 7 字节", existsSync(pkgImg) ? statSync(pkgImg).size : -1, v1ImgSize);
eq("③ 库里的 md_path 也没被改坏", LibraryRepo.get(item)!.mdPath, v1MdPath);
check("④ 落点仍然是那个目录(不是「删了文件留下空目录」)", statSync(inPackage(item)).isDirectory());
eq("⑤ 没有留下暂存残渣", packageOnly(item), item);

/* ──────────────── 2b. 目标写不进去(磁盘满/权限)也一样不能毁老包 ──────────────── */

console.log("\n采纳 · 目标不可写时,老包也必须还在");

// 拒掉 `markdown/imported/` 的**写 + 建子目录**权限 —— 磁盘满 / 只读介质 / 目录权限的
// 确定性等价物。老写法在这一刻的破坏路径是:rmSync(老包) 成功(删不需要父目录的写权限),
// 紧接着 mkdirSync(落点) 抛 EPERM —— **老包已经没了**,报的却是"复制失败"。
if (!existsSync(IMPORTED)) mkdirSync(IMPORTED, { recursive: true });
check("注入:落点父目录拒绝写", denyWriteIn(IMPORTED));

const v3 = mkdtempSync(join(tmpdir(), "mcode-adopt-v3-"));
writeFileSync(join(v3, "full.md"), "# 第三版(写不进去)\n", "utf8");
const third = adoptMarkdownFile(item, join(v3, "full.md"));
check("这次也失败了", !third.ok, third);
check("并如实报出错误", (third.error ?? "").length > 0, third.error);
eq("老包的正文仍然一字未动", textAt(pkgMd), v1Text);
eq("老包的配图仍在", existsSync(pkgImg) ? statSync(pkgImg).size : -1, v1ImgSize);
eq("md_path 仍是原来那个", LibraryRepo.get(item)!.mdPath, v1MdPath);
eq("也没留下暂存残渣", packageOnly(item), item);

check("反转:落点父目录恢复可写", allowAll(IMPORTED), allowAll(IMPORTED));

/* ──────────────── 3. 成功路径:整包替换的语义不能丢 ──────────────── */

console.log("\n采纳 · 成功时仍然是整包替换");

// 上面两条只是"失败时不许毁东西";成功时该做的替换**不能因此被削掉** ——
// 旧包里的 `images/` 若留下来,新 md 引用同名图时会取到旧图,那是比报错更难查的一类 bug。
const v4 = mkdtempSync(join(tmpdir(), "mcode-adopt-v4-"));
mkdirSync(join(v4, "figures"), { recursive: true });
writeFileSync(join(v4, "paper.md"), "# 第四版\n\n![新图](figures/b.png)\n", "utf8");
writeFileSync(join(v4, "figures", "b.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]));

const fourth = adoptMarkdownFile(item, join(v4, "paper.md"));
check("挂上了", fourth.ok, fourth);
eq("正文换成了新的", textAt(inPackage(item, "paper.md")), "# 第四版\n\n![新图](figures/b.png)\n");
check("新包的图搬进来了", existsSync(inPackage(item, "figures", "b.png")));
check("旧的 full.md 不在了(整包替换)", !existsSync(pkgMd));
check("旧的 images/ 不留残渣", !existsSync(inPackage(item, "images")));
eq("md_path 跟着换到新文件名", LibraryRepo.get(item)!.mdPath, `markdown/imported/${item}/paper.md`);
const v4Rel = LibraryRepo.get(item)!.mdPath!;
eq("没有留下暂存残渣", packageOnly(item), item);
eq("图数报的是 1", fourth.imageCount, 1);
const v4MdPath = v4Rel;

/* ──────────────── 3b. 源文件就在落点里:拒绝,而且不许删 ──────────────── */

console.log("\n采纳 · 源文件就在落点里");

// 回归:条目详情页开着的时候,`mdPath` 指的就是这个目录里的文件,用户/模型很容易把
// "库里那份"当源文件再挂一次。那必须**先拦下来** —— 否则整包替换会把那份源文件自己
// 挪走/换掉,而这不是用户要的。
{
  const abs = fromLibraryRelative(v4MdPath);
  const before = readFileSync(abs, "utf8");
  const again = adoptMarkdownFile(item, abs);
  check("拒绝", !again.ok, again);
  check("说的是「已经在库里了」", (again.error ?? "").includes("已经在"), again.error);
  eq("那份文件没有被误删", textAt(abs), before);
  eq("md_path 也没被改坏", LibraryRepo.get(item)!.mdPath, v4MdPath);
}

/* ──────────────── 3c. md 里有坏转义:一份坏引用不该掀掉整份产物 ──────────────── */

console.log("\n采纳 · md 里有不合法的百分号转义");

// md 的内容是数据。`![图](images/100%.png)` 里的 `%` 不是合法转义,`decodeURIComponent`
// 对它抛 URIError —— 从前那一下掀掉**整份**产物的采纳(外层 catch 报"采纳失败"),
// 正文都换不上去。正确口径:这一条记成"配图没找到",其余照常挂上。
{
  const bomItem = LibraryRepo.upsert({ title: "带坏转义的那一篇" }).id;
  const dir = mkdtempSync(join(tmpdir(), "mcode-adopt-bom-"));
  mkdirSync(join(dir, "images"), { recursive: true });
  writeFileSync(join(dir, "images", "ok.png"), Buffer.from([1, 2, 3]));
  writeFileSync(join(dir, "full.md"), "# 正文\n\n![好图](images/ok.png)\n\n![坏图](images/100%.png)\n", "utf8");
  const res = adoptMarkdownFile(bomItem, join(dir, "full.md"));
  check("整份还是挂上了(没被一处坏转义掀掉)", res.ok, res);
  eq("正文换上了", textAt(inPackage(bomItem, "full.md")), "# 正文\n\n![好图](images/ok.png)\n\n![坏图](images/100%.png)\n");
  check("能搬的那张图搬进来了", existsSync(inPackage(bomItem, "images", "ok.png")));
  eq("图数报的是 1", res.imageCount, 1);
  check("坏的那一条进了 missing", res.missing.some((m) => m.includes("100%")), res.missing);
  check("落点下面没有暂存残渣", !packageOnly(bomItem).match(/stage|\.tmp|adopt-/i), packageOnly(bomItem));
}

/* ──────────────── 3d. 老包挪不动时的"整体放弃":暂存也必须清干净 ──────────────── */

console.log("\n采纳 · 老包挪不动 → 放弃,但暂存不许留下");

// 文件头写着"换上去之前失败 → **只删暂存**,老包一个字节都没动"。而"老包挪不动"这一档
// (`renameSync(destDir, backupDir)` 抛 EPERM —— Windows 上落点里有一份文件被别的程序
// 打开就是这一档)走的是**另一个** return:它在把老包 rename 到退路的那一步失败时就
// `return fail(...)` 了,此时**暂存里已经拷好了完整的一包**(正文 + 全部配图)。
//
// 那条 early return **没有清理暂存** —— 于是每次"老包被占用"都在 `markdown/imported/`
// 里永久留下一个 `.adopt-<id>-<随机>/` 的整包副本(几十 MB 的教材图床尤其刺眼),
// 而用户得到的只是一句"关掉它再试一次"。这正是文件头那段"失败路径上要守住"要防的东西。
//
// 注入方式与真实故障同一形态:持有一个**包内文件**的读句柄(不关),rename 就该抛 EPERM
// (实测:只要包里有文件被打开,rename 该目录在 Windows 上必 EPERM)。
{
  const stuckItem = LibraryRepo.upsert({ title: "老包被占用的一篇" }).id;
  const s0 = mkdtempSync(join(tmpdir(), "mcode-adopt-stuck0-"));
  mkdirSync(join(s0, "images"), { recursive: true });
  writeFileSync(join(s0, "full.md"), "# 老的那一版\n", "utf8");
  writeFileSync(join(s0, "images", "a.png"), Buffer.from([1, 2, 3, 4, 5]));
  eq("先正常挂上第一版", adoptMarkdownFile(stuckItem, join(s0, "full.md")).ok, true);
  const stuckMd = inPackage(stuckItem, "full.md");
  const stuckBefore = readFileSync(stuckMd, "utf8");

  // 占住包里的那份正文 —— rename(destDir → backupDir) 从此必 EPERM。
  const held = openSync(stuckMd, "r");
  try {
    const s1 = mkdtempSync(join(tmpdir(), "mcode-adopt-stuck1-"));
    mkdirSync(join(s1, "images"), { recursive: true });
    writeFileSync(join(s1, "full.md"), "# 想换上去的那一版\n", "utf8");
    writeFileSync(join(s1, "images", "b.png"), Buffer.from([9, 9, 9, 9, 9]));

    const stuck = adoptMarkdownFile(stuckItem, join(s1, "full.md"));
    check("这次失败了", !stuck.ok, stuck);
    eq("老包的正文一字未动", textAt(stuckMd), stuckBefore);
    // ★ 症结:stageDir 从没被清掉,一整包(含全部配图)永久留在 imported/ 下。
    check(
      "★ 暂存整包没有留下(失败时要清干净,不留垃圾)",
      !packageOnly(stuckItem).match(/\.adopt-|\.old-|stage/i),
      packageOnly(stuckItem),
    );
  } finally {
    closeSync(held);
  }
  // 反转后能再挂上去 —— 证明上面确实只是"被占用",不是别的坏法。
  const s2 = mkdtempSync(join(tmpdir(), "mcode-adopt-stuck2-"));
  writeFileSync(join(s2, "full.md"), "# 关掉之后换上的那一版\n", "utf8");
  eq("关掉占用后重试成功", adoptMarkdownFile(stuckItem, join(s2, "full.md")).ok, true);
}

/* ──────────────── 4. 重转:不许覆盖用户采纳进来的那份 ──────────────── */

console.log("\n重转 · 用户给的那份不许被机器覆盖");

// 一条**有真 PDF** 的文献:不拦的话,`force` 这条路是真会把 md 重写一遍的 ——
// 所以这一段的断言不是空的。
const userItem = seedPaper("用户自己转好挂进来的那一篇", "a".repeat(64));

const userMd = mkdtempSync(join(tmpdir(), "mcode-adopt-user-"));
writeFileSync(join(userMd, "full.md"), "# 用户自己转的那份\n\n公式和表格都是对的。\n", "utf8");
const userAdopt = adoptMarkdownFile(userItem, join(userMd, "full.md"));
check("先把它挂上", userAdopt.ok, userAdopt);

// 判据的根据:`conversionReport()` 早就按**落点结构**把这份认成 `imported` 了
// (不是"机器转的"那种 `markdown/<ab>/<cd>/<sha>.md`)。这段断言钉的就是"这个判据是活的"
// —— 下面那个跳过分支用的正是同一条判据,没有发明新字段。
{
  const row = conversionReport().find((r) => r.id === userItem);
  eq("conversionReport 把它认成 imported", row?.source, "imported");
}

const userAbs = fromLibraryRelative(LibraryRepo.get(userItem)!.mdPath!);
const userBefore = readFileSync(userAbs, "utf8");

// Deprecated entry points must fail closed, even for formerly machine-generated output.
for (const force of [false, true]) {
  const result = await convertItemToMarkdown(LibraryRepo.get(userItem)!, { force });
  check("核心转换入口明确转交自动化", !result.ok && result.error.includes("自动化"), result);
  eq("采纳的正文一字未动", readFileSync(userAbs, "utf8"), userBefore);
}
writeFileSync(inPackage(userItem, ".mineru-generated"), "legacy marker");
writeFileSync(userAbs, "# 用户编辑了旧机器产物", "utf8");
const marked = await convertItemToMarkdown(LibraryRepo.get(userItem)!, { force: true });
check("机器标记不是覆盖用户编辑的许可", !marked.ok);
eq("旧机器产物上的用户编辑得到保留", readFileSync(userAbs, "utf8"), "# 用户编辑了旧机器产物");
const repair = await repairCollectionMarkdown("legacy-collection");
eq("兼容修复入口不清理文件", repair.cleaned, 0);
eq("兼容修复入口不转录", repair.converted, 0);
check("兼容修复入口给出自动化指引", repair.failed.some((r) => r.error.includes("自动化")));
eq("修复不改变原文件", readFileSync(userAbs, "utf8"), "# 用户编辑了旧机器产物");
check("MCP 不再暴露核心转录工具", !libraryMcpTools().some((t) => t.name === "library_convert"));
const emptyItem = seedPaper("仅导入的文件", "b".repeat(64));
const rejected = await convertItemToMarkdown(LibraryRepo.get(emptyItem)!);
check("没有 Markdown 也不能绕过自动化", !rejected.ok);
check("不生成或关联隐式转录产物", !LibraryRepo.get(emptyItem)!.mdPath);

/* ──────────────── 收尾 ──────────────── */

allowAll(IMPORTED);
for (const n of importedEntries()) allowAll(join(IMPORTED, n));

rmSync(DATA, { recursive: true, force: true });
rmSync(SRC, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
