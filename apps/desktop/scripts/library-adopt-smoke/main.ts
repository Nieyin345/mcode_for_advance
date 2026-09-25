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
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
const { convertItemToMarkdown, conversionReport } = await import("@main/library/convert.js");
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

const forced = await convertItemToMarkdown(LibraryRepo.get(userItem)!, { force: true });
check("force 重转没有覆盖它", forced.ok, forced);
// ⚠️ 判据是 `alreadyDone` 而不是新加的 `skipped`:`alreadyDone` 是**既有的**"没有重转"
// 语义,而两条调用方(IPC 那边只是计数、MCP 那边按它说"已有 Markdown,没有重转")
// 认的都是它。`skipped` 另给一层是为了将来能说得更准,不该拿它当"跳过"的唯一判据。
check("并且如实回报了「跳过」(alreadyDone)", forced.ok && forced.alreadyDone === true, forced);
check("也带上了「跳过」这一档的标记", forced.ok && forced.skipped === true, forced);
check("没有谎报又转了一遍", forced.ok && (forced.ok ? forced.chars : 0) === 0, forced);
eq("正文一字未动", readFileSync(userAbs, "utf8"), userBefore);
eq("md_path 仍是用户那份", LibraryRepo.get(userItem)!.mdPath, `markdown/imported/${userItem}/full.md`);

/* ──────────────── 4b. 对照组:机器转的那种,force 仍然该真转 ──────────────── */

console.log("\n重转 · 机器转的那份照旧可以被 force 重做");

// 加了"不许覆盖"之后最容易出的事是**拦过头**:连机器自己那份也不重转了,于是设置页
// 「重转这篇」变成一个永远说"没有重转"的假按钮。所以这里放一条对照组。
const machineItem = seedPaper("机器转的那一篇", "b".repeat(64));

const auto = await convertItemToMarkdown(LibraryRepo.get(machineItem)!);
check("先按默认转了一次", auto.ok && !auto.alreadyDone, auto);
const machineRel = LibraryRepo.get(machineItem)!.mdPath!;
check("落点是平铺的那种(不是 imported)", !machineRel.includes("/imported/"), machineRel);

const machineAbs = fromLibraryRelative(machineRel);
writeFileSync(machineAbs, "被人改坏的内容", "utf8");

const redone = await convertItemToMarkdown(LibraryRepo.get(machineItem)!, { force: true });
check("force 重转成功", redone.ok, redone);
check("这次是「真转了」,不是跳过", redone.ok && !redone.skipped, redone);
check(
  "盘上的内容真的被重新生成过(不是留着被改坏的)",
  !readFileSync(machineAbs, "utf8").includes("被人改坏的内容"),
  readFileSync(machineAbs, "utf8").slice(0, 80),
);

// 不带 force 时两种都照旧跳过。
const noForce = await convertItemToMarkdown(LibraryRepo.get(machineItem)!);
check("不带 force 时机器那份照旧跳过", noForce.ok && noForce.alreadyDone === true, noForce);

/* ──────────────── 5. AI 那条路走的是同一份实现 ──────────────── */

console.log("\n共享实现 · AI 调 library_convert 也走同一份");

// 仓规第 2 条:用户点的和 AI 调的是同一个函数。这里从**工具表**那一头再走一遍 ——
// 只验直接调用的话,哪天有人在工具里自己写一条分支就漏过去了。
{
  const tools = libraryMcpTools();
  const tool = tools.find((t) => t.name === "library_convert");
  check("工具表里有 library_convert", Boolean(tool));
  const res = await tool!.handler({ ids: [userItem], force: true }, { sessionId: "s_smoke" });
  const out = res.content.map((c) => c.text).join("\n");
  check("AI 那条路也没覆盖它", out.includes("已有 Markdown"), out);
  // ⚠️ 这里**只钉"如实"**这一条,不钉措辞:那句人话在 `libraryServer.ts` 里,而那个文件
  // 这一次不许动。现状是它按 `alreadyDone` 说"已有 Markdown,没有重转" —— 不算说谎,
  // 只是没点明是"用户自己那份"。`ConvertOutcome.skipped` 已经把这个原因备好了,等那条
  // 文案要用它的时候,把这行断言换成"说了是用户采纳的那份"即可。
  check("而且没有谎报又转了一遍", !out.includes("已转好"), out);
  eq("正文仍然一字未动", readFileSync(userAbs, "utf8"), userBefore);
}

/* ──────────────── 6. 用户那份文件丢了:如实报出来,不谎报成功 ──────────────── */

console.log("\n重转 · 用户那份不在了的时候怎么办");

// 不能默默转出一份"机器版"把用户那份顶掉 —— 更不能回报一句"已转好"(那是他没收到的结果)。
{
  const lostItem = seedPaper("采纳的那份文件丢了的一篇", "c".repeat(64));
  const lostSrc = mkdtempSync(join(tmpdir(), "mcode-adopt-lost-"));
  writeFileSync(join(lostSrc, "full.md"), "# 这份过会儿就没了\n", "utf8");
  adoptMarkdownFile(lostItem, join(lostSrc, "full.md"));
  const lostAbs = fromLibraryRelative(LibraryRepo.get(lostItem)!.mdPath!);
  rmSync(lostAbs, { force: true });

  const r = await convertItemToMarkdown(LibraryRepo.get(lostItem)!, { force: true });
  check("如实失败", !r.ok, r);
  check("说的是「文件不在了」而不是一句转换出错", (r.ok ? "" : r.error).includes("不在了"), r);
  check("并指了出路(重新挂一份)", (r.ok ? "" : r.error).includes("挂"), r);
  eq("md_path 没被偷偷改成本地抽取那一份", LibraryRepo.get(lostItem)!.mdPath, `markdown/imported/${lostItem}/full.md`);
}

/* ──────────────── 收尾 ──────────────── */

allowAll(IMPORTED);
for (const n of importedEntries()) allowAll(join(IMPORTED, n));

rmSync(DATA, { recursive: true, force: true });
rmSync(SRC, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
