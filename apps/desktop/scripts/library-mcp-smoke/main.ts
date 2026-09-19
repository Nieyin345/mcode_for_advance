/**
 * Headless smoke for **资料库里那几条给自动化用的 MCP 工具** ——
 * `library_convert` / `library_links` / `library_link_add` / `library_link_remove`
 * (见 `main/mcp/libraryServer.ts`)。
 *
 * ## 为什么要单独一套
 *
 * 这四条是"把转录与关联搬进自动化"缺的那两块拼图。它们的**形状**看不出对错:
 *
 *  - `library_convert` 是**分钟级**的(`convertItemToMarkdown` 里那条注释),所以
 *    重复调用必须不白烧 MinerU 的额度 —— 已经有 md 的条目要**跳过**,而且回报里
 *    得把"跳过"和"这次真转了"分开说,否则模型会向用户汇报一件没发生的事;
 *  - 它还必须**如实退回**:没配密钥、MinerU 挂了、PDF 是扫描件,三条路各自要给
 *    说得清的话,不能都塌成一句"失败";
 *  - 关联那三条是**幂等**的(`LibraryLinkRepo.add` 已存在就返回原来那条)——
 *    自动化里跑两遍不该长出两条关联。这条只有真调一次才看得见。
 *
 * 同时钉住**工具表与只读集合的一致性**:`library_links` 声明成读工具就必须真的在
 * `LIBRARY_READONLY_TOOLS` 里 —— 少了它每次查询都要用户点一次审批,而那正是
 * 设置页那栏注释里说的"常用动作变成打扰"。
 *
 * ## 它真的会往"库根"里写文件
 *
 * 转换会在 `<库根>/markdown/<ab>/<cd>/<sha>.md` 落盘。所以数据根必须换成临时目录
 * (复用 db-migrate-smoke 的 dataRoot/logger 桩),跑完就删 —— 绝不碰用户真正的资料库。
 *
 * ## 没覆盖的(写清楚,免得被当已验)
 *
 *  - **MinerU 那一路的真调用**(要把 PDF 上传到 mineru.net)。本套只验"配了密钥时
 *    它会被走到"[*],而且失败会**如实退回本地抽取**并说明原因 —— 上传本身要一次
 *    真凭证,那是真机用一次的事;
 *  - **zod 校验与审批闸门**:那两条在 `mcp-endpoint-smoke` 里(它直接驱
 *    `createWebToolHost`)。本套直接调 handler,验的是 handler 自己。
 *
 * [*] 见 main.ts 第 3 段:那条断言看的是"退回了没有、理由里有没有提到 MinerU"。
 *
 * Run: scripts/library-mcp-smoke/run.sh
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const DATA = mkdtempSync(join(tmpdir(), "mcode-lib-mcp-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;
const ROOT = join(DATA, "library");
/** 用户的"别处" —— 库外的那个文件放这儿。 */
const SRC = mkdtempSync(join(tmpdir(), "mcode-lib-mcp-src-"));

const { initDb } = await import("@main/store/db.js");
const { LibraryRepo, LibraryLinkRepo, CollectionRepo, SettingRepo } = await import(
  "@main/store/repositories.js"
);
const { libraryMcpTools, LIBRARY_READONLY_TOOLS } = await import("@main/mcp/libraryServer.js");
const { libraryRoot, fromLibraryRelative, pdfPathForHash } = await import("@main/library/paths.js");
const { saveSuppress, resetSuppressCacheForTest } = await import("@main/library/suppress.js");

await initDb();
eq("库根就是临时数据根下面那个", libraryRoot(), ROOT);

/** 相对库根的路径(`file_path` / `md_path` 那一列存的就是这个拼法)。 */
function rel(abs: string): string {
  return abs.slice(ROOT.length + 1).split("\\").join("/");
}

/**
 * 一份**真的能读出文本**的 PDF(仓里提交着的样例,见 `scripts/fixtures/`)。
 *
 * ⚠️ 不在脚本里手工拼一份最小 PDF:**本地抽取那条路走的是 pdf.js**,它对结构
 * (交叉引用表、字体描述符、内容流长度)的挑剔程度是"拼错一处就解析不出来",而那看起来
 * 和"被测代码坏了"一模一样。样例是真结构、不联网,而且生成脚本也一起提交了。
 */
const PDF_FIXTURE = join(process.cwd(), "scripts", "fixtures", "sample-paper.pdf");
if (!existsSync(PDF_FIXTURE)) {
  throw new Error(`样例 PDF 不在:${PDF_FIXTURE} —— 这一套靠它验「本地抽取」那条真路`);
}

/**
 * 造一条**真的能读出文本**的文献:样例 PDF 落到内容寻址的位置,条目上写好 `pdf_path`。
 *
 * ⚠️ 走 `setPdf` 而不是 upsert 的字段:`pdf_path` 的相对拼法只有那一处说了算,
 * 本套复述一遍就绕过了被测路径的一半。
 */
function seedPaper(title: string, sha: string): string {
  const id = LibraryRepo.upsert({ kind: "paper", title }).id;
  const target = pdfPathForHash(sha);
  mkdirSync(join(target, ".."), { recursive: true });
  copyFileSync(PDF_FIXTURE, target);
  LibraryRepo.setPdf(id, rel(target), sha);
  return id;
}

/* ──────────────── 0. 工具表本身 ──────────────── */

console.log("\n工具表");

const tools = libraryMcpTools();
const byName = new Map(tools.map((t) => [t.name, t]));
const call = async (name: string, args: unknown): Promise<string> => {
  const tool = byName.get(name);
  if (!tool) throw new Error(`工具表里没有 ${name}`);
  const res = await tool.handler(args, { sessionId: "s_smoke" });
  return res.content.map((c) => c.text).join("\n");
};

for (const name of ["library_convert", "library_links", "library_link_add", "library_link_remove"]) {
  check(`工具表里有 ${name}`, byName.has(name));
}
// 名字不许重复 —— 表里两个同名工具时,SDK 那边的行为是"后面那个赢",静默顶掉一个。
eq("工具名没有重复", new Set(tools.map((t) => t.name)).size, tools.length);
// 只读集合与工具表必须对得上:写工具混进只读集合 = 不弹审批就改东西;
// 读工具漏在外面 = 每次查询都打扰用户一次。
check("library_links 是只读工具", LIBRARY_READONLY_TOOLS.has("library_links"));
check("library_convert 不是只读工具(它会写 md)", !LIBRARY_READONLY_TOOLS.has("library_convert"));
check("library_link_add 不是只读工具", !LIBRARY_READONLY_TOOLS.has("library_link_add"));
check("library_link_remove 不是只读工具", !LIBRARY_READONLY_TOOLS.has("library_link_remove"));
for (const name of LIBRARY_READONLY_TOOLS) {
  check(`只读集合里的 ${name} 在工具表里存在`, byName.has(name));
}

/* ──────────────── 1. library_convert · 没配 MinerU 时走本地 ──────────────── */

console.log("\nlibrary_convert · 本地抽取那条路");

const item = seedPaper("冒烟用的一篇", "a".repeat(64));

const okText = await call("library_convert", { ids: [item] });
check("转换成功时说清了用的是哪条路", okText.includes("本地抽取"), okText);
{
  const fresh = LibraryRepo.get(item)!;
  check("md_path 真的写上了", Boolean(fresh.mdPath), fresh.mdPath);
  check(
    "md 文件真的在盘上、有内容",
    Boolean(fresh.mdPath) && readFileSync(fromLibraryRelative(fresh.mdPath!), "utf8").length > 0,
  );
}

// **重复调用必须跳过** —— 这是这个工具唯一"烧钱"的地方(MinerU 额度)。
const againText = await call("library_convert", { ids: [item] });
check("重复调用说的是「没有重转」", againText.includes("已有 Markdown"), againText);
check("而不是谎报又转了一遍", !againText.includes("已转好"), againText);

// 不存在的 id 要**如实**列出来,不能安静地少一行。
const missingText = await call("library_convert", { ids: ["li_根本没有这条"] });
check("不存在的 id 说了「库里没有这个 id」", missingText.includes("库里没有这个 id"), missingText);

// 没有 PDF 的条目:本地那条路也走不了,原因要说清。
const noPdf = LibraryRepo.upsert({ kind: "paper", title: "还没有 PDF 的一篇" });
const noPdfText = await call("library_convert", { ids: [noPdf.id] });
check("没有 PDF 时说的是「先下载或导入一份」", noPdfText.includes("先下载或导入一份"), noPdfText);

/* ──────────────── 3. 关联那三条 ──────────────── */

console.log("\nlibrary_links / add / remove");

const a = LibraryRepo.upsert({ kind: "paper", title: "甲" });
const b = LibraryRepo.upsert({ kind: "paper", title: "乙" });
const outFile = join(SRC, "库外的一份资料.md");
writeFileSync(outFile, "# 参考资料", "utf8");

eq("一开始没有关联", LibraryLinkRepo.viewsOf(a.id).length, 0);
const emptyText = await call("library_links", { itemId: a.id });
check("查空关联时说的是「还没有任何关联」", emptyText.includes("还没有任何关联"), emptyText);

const addText = await call("library_link_add", { itemId: a.id, targetItemId: b.id });
check("加关联时说清了关联到谁", addText.includes("《乙》"), addText);
check("并把 linkId 给出来了", addText.includes("linkId=ll_"), addText);

// **幂等**:自动化里跑两遍不该长出两条。
const addAgain = await call("library_link_add", { itemId: a.id, targetItemId: b.id });
const firstId = addText.split("linkId=")[1]!.trim();
const secondId = addAgain.split("linkId=")[1]!.trim();
eq("再加一次给回的是同一条", secondId, firstId);
eq("库里也只有一条", LibraryLinkRepo.viewsOf(a.id).length, 1);

// 库外路径也能挂。
const addPathText = await call("library_link_add", { itemId: a.id, targetPath: outFile });
check("库外路径也挂得上", addPathText.includes("库外的一份资料.md"), addPathText);
eq("现在两条关联", LibraryLinkRepo.viewsOf(a.id).length, 2);

// 两个都给 / 都不给 —— 必须拒,而且话要说清(表上的 CHECK 也会拦,
// 但那时用户看到的是一句 SQLite 约束错误)。
const bothText = await call("library_link_add", { itemId: a.id, targetItemId: b.id, targetPath: outFile });
check("两个目标都给 → 拒", bothText.includes("失败"), bothText);
check("并说清是二选一", bothText.includes("不能两个都给或都不给"), bothText);
const neitherText = await call("library_link_add", { itemId: a.id });
check("一个都不给 → 拒", neitherText.includes("失败"), neitherText);

// 目标条目不存在要**当场**拒 —— 让模型拿到一个"成功"再去界面上找个不存在的条目,
// 比直接失败难查得多。
const ghostText = await call("library_link_add", { itemId: a.id, targetItemId: "li_没有这个" });
check("目标条目不存在 → 拒", ghostText.includes("失败"), ghostText);
check("并说了它必须先在库里", ghostText.includes("必须已经在库里"), ghostText);

// **双向看得见**:从乙那边查,应该看到"甲关联了我"。
const fromB = await call("library_links", { itemId: b.id });
check("反向也看得见", fromB.includes("关联它的"), fromB);
check("反向那一行说的是甲", fromB.includes("《甲》"), fromB);
// 而**存**是单向的:甲指出去两条,乙身上一条都没有(方向由查询时算)。
eq("乙自己没有指出去任何关联", LibraryLinkRepo.linksOf(b.id).filter((l) => l.direction === "out").length, 0);

// 解除。
const removeText = await call("library_link_remove", { linkId: firstId });
check("解除说了两边的条目都还在", removeText.includes("两边的条目都还在"), removeText);
eq("甲只剩一条关联", LibraryLinkRepo.viewsOf(a.id).length, 1);
check("乙和甲都还在库里", Boolean(LibraryRepo.get(a.id)) && Boolean(LibraryRepo.get(b.id)));

const removeGhost = await call("library_link_remove", { linkId: "ll_没有这条" });
check("解一条不存在的关联 → 拒", removeGhost.includes("失败"), removeGhost);

// 被屏蔽的条目:查询要**照常返回**,而且**当场把原因说了**。
//
// 为什么这条值得钉:`LibraryLinkRepo.viewsOf` 是**纯仓储查询,不看屏蔽** ——
// `suppressedReason` 是调用方补的(界面上是 `ipc/library.ts` 那个 handler,模型侧
// 是本工具)。所以工具照抄仓储的话,模型看到的是一份**少了屏蔽信息**的关联表,
// 它会去挂一条根本挂不上的关联(挂载那道门是硬过滤),然后拿到一句没头没脑的失败。
{
  const c = LibraryRepo.upsert({ kind: "paper", title: "被屏蔽的那一篇" });
  // 屏蔽按**分类**挡(`nodes` 里只有 group / type / collection 三层,没有"单条")。
  const col = CollectionRepo.create("冒烟屏蔽分类", null, "paper");
  CollectionRepo.assign(col.id, [c.id], true);
  saveSuppress({ nodes: [`collection:${col.id}`], extensions: [] });
  resetSuppressCacheForTest();

  await call("library_link_add", { itemId: a.id, targetItemId: c.id });
  const suppressed = await call("library_links", { itemId: a.id });
  check("被屏蔽的关联照常列出来", suppressed.includes("被屏蔽的那一篇"), suppressed);
  check("并当场说了被屏蔽", suppressed.includes("被屏蔽"), suppressed);
  check("原因里点名了是哪个分类", suppressed.includes("冒烟屏蔽分类"), suppressed);
  // 乙那条上面已经被解除了,所以此刻是两条:库外那份 + 被屏蔽的。
  eq("一共两条关联(库外那份 + 被屏蔽的)", LibraryLinkRepo.viewsOf(a.id).length, 2);
}

/* ──────────────── 4. 长尾:调用方最可能踩的两个错 ──────────────── */

console.log("\n长尾");

// 查一条不存在的条目 —— 要说"库里没有",不能给一个空的关联列表(那读起来像"它有,只是没关联")。
const ghostQuery = await call("library_links", { itemId: "li_没有这个" });
check("查不存在的条目 → 拒", ghostQuery.includes("失败"), ghostQuery);
check("并说了库里没有这个 id", ghostQuery.includes("库里没有条目"), ghostQuery);

// 关联不影响条目本身:解除之后条目还在。
check("解除关联没动条目", LibraryRepo.get(a.id)?.title === "甲");

/* ──────────────── 收尾 ──────────────── */

rmSync(DATA, { recursive: true, force: true });
rmSync(SRC, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
