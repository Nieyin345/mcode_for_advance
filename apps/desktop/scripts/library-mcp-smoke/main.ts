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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

for (const name of [
  "library_convert",
  "library_adopt_markdown",
  "library_links",
  "library_link_add",
  "library_link_remove",
]) {
  check(`工具表里有 ${name}`, byName.has(name));
}
// 名字不许重复 —— 表里两个同名工具时,SDK 那边的行为是"后面那个赢",静默顶掉一个。
eq("工具名没有重复", new Set(tools.map((t) => t.name)).size, tools.length);
// 只读集合与工具表必须对得上:写工具混进只读集合 = 不弹审批就改东西;
// 读工具漏在外面 = 每次查询都打扰用户一次。
check("library_links 是只读工具", LIBRARY_READONLY_TOOLS.has("library_links"));
check("library_convert 不是只读工具(它会写 md)", !LIBRARY_READONLY_TOOLS.has("library_convert"));
check(
  "library_adopt_markdown 不是只读工具(它会写库、会往库里搬文件)",
  !LIBRARY_READONLY_TOOLS.has("library_adopt_markdown"),
);
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

/* ──────────────── 2. library_adopt_markdown · 把外部转好的挂回库 ──────────────── */

console.log("\nlibrary_adopt_markdown · 外部工具转好的挂回库");

// 模拟一个外部工具（mineru CLI 之类）的产物目录：`full.md` 加一个同级 `images/`。
const TOOL_OUT = mkdtempSync(join(tmpdir(), "mcode-lib-mcp-tool-"));
{
  mkdirSync(join(TOOL_OUT, "images"), { recursive: true });
  writeFileSync(
    join(TOOL_OUT, "full.md"),
    "# 外部转录的正文\n\n![图一](images/a.jpg)\n\n正文。\n",
    "utf8",
  );
  // 写点真字节，好验"图真的搬过来了"而不只是改了库字段。
  writeFileSync(join(TOOL_OUT, "images", "a.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
}

const target = seedPaper("外部转录挂回来的那一篇", "c".repeat(64));

const adoptText = await call("library_adopt_markdown", {
  itemId: target,
  path: join(TOOL_OUT, "full.md"),
});
check("挂载成功说的是已挂上", adoptText.includes("已挂上"), adoptText);
check("并报了几张图", adoptText.includes("1 张图"), adoptText);

const after = LibraryRepo.get(target)!;
eq("md_path 落到了 imported/<id>/ 下面", after.mdPath, `markdown/imported/${target}/full.md`);
check("落点是目录形态（删条目时该整目录删）", after.mdPath!.includes("/imported/"));

// **图真的搬到库里了** —— 只改库字段的话预览全是断链，而这件事在数据库里看不出任何异常。
const landedImg = join(ROOT, "markdown", "imported", target, "images", "a.jpg");
check("图床一起搬进库了", existsSync(landedImg), landedImg);
check("搬的是真内容，不是空文件", existsSync(landedImg) && statSync(landedImg).size === 7);

// 正文也在。
check(
  "正文读得出来",
  existsSync(fromLibraryRelative(after.mdPath!)) &&
    readFileSync(fromLibraryRelative(after.mdPath!), "utf8").includes("外部转录的正文"),
);

// 非 md 要拒（说清是扩展名的问题，不是一句"失败"）。
const txtPath = join(TOOL_OUT, "notes.txt");
writeFileSync(txtPath, "不是 markdown", "utf8");
const notMd = await call("library_adopt_markdown", { itemId: target, path: txtPath });
check("非 md 拒绝", notMd.includes("失败"), notMd);
check("并说了是扩展名的问题", notMd.includes("Markdown"), notMd);

// 文件不在要拒。
const ghostFile = await call("library_adopt_markdown", {
  itemId: target,
  path: join(TOOL_OUT, "根本没有这份.md"),
});
check("文件不在要拒", ghostFile.includes("失败"), ghostFile);

// 条目不在要拒。
const ghostItem = await call("library_adopt_markdown", {
  itemId: "li_根本没有这条",
  path: join(TOOL_OUT, "full.md"),
});
check("条目不在要拒", ghostItem.includes("失败"), ghostItem);

// 笔记不用挂（它自己就是 md）。
{
  const note = LibraryRepo.upsert({ kind: "note", title: "一条笔记" }).id;
  const onNote = await call("library_adopt_markdown", { itemId: note, path: join(TOOL_OUT, "full.md") });
  check("笔记要拒（它自己就是 Markdown）", onNote.includes("失败"), onNote);
}

// **覆盖语义**：再挂一次要整目录替换，旧的图不许留下。
{
  const FIRST = mkdtempSync(join(tmpdir(), "mcode-lib-mcp-tool2-"));
  writeFileSync(join(FIRST, "full.md"), "# 第二版\n\n没有图了。\n", "utf8");
  await call("library_adopt_markdown", { itemId: target, path: join(FIRST, "full.md") });
  check("再挂一次：旧那包被整个换掉（md 换了）",
    readFileSync(fromLibraryRelative(LibraryRepo.get(target)!.mdPath!), "utf8").includes("第二版"));
  check("再挂一次：旧 images/ 不留残渣", !existsSync(join(ROOT, "markdown", "imported", target, "images")));
  rmSync(FIRST, { recursive: true, force: true });
}

// **源文件就在落点里时要拦下来，而且不许把自己删掉。**
//
// 落点是 `markdown/imported/<id>/`，而下面第一件事是整目录 `rmSync`。没有这道拦截的话，
// 用户/模型把"库里那份 md"当源文件再挂一次 —— 那是**很容易发生**的一次操作（条目详情页
// 正开着，手上就是那个路径，模型手上也正好有它）—— 会**先删掉它再复制一个已经不存在的
// 文件**，报一句 `复制失败：ENOENT`，看不出是路径的问题。而这一份是用户唯一的转录产物。
{
  const inPlace = LibraryRepo.get(target)!.mdPath!;
  const abs = fromLibraryRelative(inPlace);
  const before = readFileSync(abs, "utf8");
  const again = await call("library_adopt_markdown", { itemId: target, path: abs });
  check("源文件就在落点里：拒绝", again.includes("失败"), again);
  check("说的是「已经在库里了」，不是一句复制失败", again.includes("已经在"), again);
  // ⚠️ **文件必须还在，而且内容一字未动** —— 这道拦截漏了的话，这里读到的是 ENOENT。
  check("那份 md 没有被误删", existsSync(abs), abs);
  eq("内容一字未动", readFileSync(abs, "utf8"), before);
  eq("库里的 md_path 也没被改坏", LibraryRepo.get(target)!.mdPath, inPlace);
}

/* ──────────────── 2b. 图床目录名不能写死 ──────────────── */

console.log("\nlibrary_adopt_markdown · 图床不叫 images 也要带上");

// 用户的工具可能把图放 `figures/`、`assets/` 或者跟 md 不同级。只认 `images/` 的话，
// 图会丢，预览全断链 —— 而"软件认不出我的目录名"是用户完全没法自救的一类问题。
{
  const ALT = mkdtempSync(join(tmpdir(), "mcode-lib-mcp-alt-"));
  mkdirSync(join(ALT, "figures"), { recursive: true });
  writeFileSync(join(ALT, "paper.md"), "# 图在 figures/ 里\n\n![图](figures/x.png)\n", "utf8");
  writeFileSync(join(ALT, "figures", "x.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]));

  const altTarget = seedPaper("图床目录名不同的那一篇", "d".repeat(64));
  const altText = await call("library_adopt_markdown", {
    itemId: altTarget,
    path: join(ALT, "paper.md"),
  });
  check("挂上了", altText.includes("已挂上"), altText);
  check(
    "figures/ 一起搬进来了",
    existsSync(join(ROOT, "markdown", "imported", altTarget, "figures", "x.png")),
    altText,
  );
  check("并且数得到那张图", altText.includes("1 张图"), altText);
  rmSync(ALT, { recursive: true, force: true });
}


/* ──────────────── 2c. 引用不到的图必须报出来 ──────────────── */

console.log("\nlibrary_adopt_markdown · 缺图要报，不静默丢");

// 仓规第 3 条：坏东西显式报出来。md 里引了一张源目录里没有的图时，软件**不能**
// 假装没事 —— 用户看到的会是一份断图的 md，而没人告诉他为什么。
{
  const BROKEN = mkdtempSync(join(tmpdir(), "mcode-lib-mcp-broken-"));
  writeFileSync(
    join(BROKEN, "full.md"),
    "# 有断链的一篇\n\n![在的](images/ok.png)\n\n![不在的](images/gone.png)\n",
    "utf8",
  );
  mkdirSync(join(BROKEN, "images"), { recursive: true });
  writeFileSync(join(BROKEN, "images", "ok.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));

  const brokenTarget = seedPaper("有一张图丢了的那一篇", "e".repeat(64));
  const brokenText = await call("library_adopt_markdown", {
    itemId: brokenTarget,
    path: join(BROKEN, "full.md"),
  });
  check("照样挂上了（一张缺图不该让整次挂载失败）", brokenText.includes("已挂上"), brokenText);
  check("在的那张搬到了", existsSync(join(ROOT, "markdown", "imported", brokenTarget, "images", "ok.png")));
  check("缺的那张**报出来了**", brokenText.includes("gone.png"), brokenText);
  check("并说清了是「找不到」", brokenText.includes("找不到"), brokenText);
  rmSync(BROKEN, { recursive: true, force: true });
}

/* ──────────────── 2d. 越界引用不搬 ──────────────── */

console.log("\nlibrary_adopt_markdown · 源目录外面的东西不跟着进来");

// `../` 往外爬的引用是**别的目录**里的东西，不是这份产物的配图。跟着搬的话，
// 一份别人发来的 md 能把任意路径的文件拷进用户库里。
{
  const OUTER = mkdtempSync(join(tmpdir(), "mcode-lib-mcp-outer-"));
  const INNER = join(OUTER, "product");
  mkdirSync(INNER, { recursive: true });
  writeFileSync(join(OUTER, "secret.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 42]));
  writeFileSync(
    join(INNER, "full.md"),
    "# 往外爬的引用\n\n![外面的](secret.png)\n\n![爬上去的](../secret.png)\n",
    "utf8",
  );

  const outerTarget = seedPaper("有越界引用的那一篇", "f".repeat(64));
  const outerText = await call("library_adopt_markdown", {
    itemId: outerTarget,
    path: join(INNER, "full.md"),
  });
  check("挂上了", outerText.includes("已挂上"), outerText);
  check(
    "源目录外面的图**没有**被拷进来",
    !existsSync(join(ROOT, "markdown", "imported", outerTarget, "secret.png")) &&
      !existsSync(join(ROOT, "markdown", "imported", outerTarget, "..", "secret.png")),
  );
  rmSync(OUTER, { recursive: true, force: true });
}

/* ──────────────── 2e. 工具输出要给出 PDF 的绝对路径 ──────────────── */

console.log("\nitemLine · 外部转录要拿得到文件路径");

// 没有路径的话，"拿这篇的 PDF 去转"这件事根本无从下手 —— 模型只能去猜库根
// 加内容哈希的拼法。
{
  const pathText = await call("library_search", {});
  check("工具输出里有 PDF 的路径", pathText.includes("PDF:"), pathText.slice(0, 400));
  // 给的是**绝对**路径（外部工具在库外跑，相对路径是相对谁的它无从判断）。
  check(
    "给的是绝对路径",
    new RegExp(`PDF:\\s*[A-Za-z]:[\\\\/]`).test(pathText) ||
      new RegExp(`PDF:\\s*/`).test(pathText),
    pathText.slice(0, 400),
  );
}

rmSync(TOOL_OUT, { recursive: true, force: true });

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

/* ──────────────── 5. 屏蔽对"翻库"这两条也必须生效 ──────────────── */

console.log("\n屏蔽:翻库的路");

// **`library_search` 与 `library_items` 是模型"翻库"的两个出口**,而它们直连仓储
// (`searchItems` / `LibraryRepo.listByCollection`)、从前一次屏蔽判定都不过。
//
// 这不是"多列了一条":屏蔽在设置里是**硬过滤**,左栏那条右键的路早就挡住了
// (`manifest.ts` 里那句"就算是我手动挂的一个文件,只要是屏蔽状态,也挂不上去")。
// 而这两条路不但把条目列出来,`itemLine` 还**顺手带上了 PDF 的绝对路径** —— 模型
// 拿到路径就能自己 Read/shell 打开,屏蔽等于白设。
//
// 挡法上还有一条不那么显眼的要求:挡掉之后**要当场说出来**,不能静默少几条。模型
// 看不见的那几条若一声不响,它会向用户汇报一份"库里只有这些"的错误结论 —— 而那正是
// `library_search` 的说明里点名的用法("判断库里有没有某一篇时用它")。
{
  // 上面那段留下的屏蔽还在(分类 `col` 里的 `c`)。再补一条**没有分类**的,专门盯
  // `library_items` 那条路 —— 它按分类列,所以得让被屏蔽的那篇真的在某个分类里。
  const solo = LibraryRepo.upsert({ kind: "paper", title: "翻库要被挡的那篇" });
  const col2 = CollectionRepo.create("翻库屏蔽分类", null, "paper");
  CollectionRepo.assign(col2.id, [solo.id], true);
  saveSuppress({ nodes: [`collection:${col2.id}`], extensions: [] });
  resetSuppressCacheForTest();

  const hit = await call("library_search", { query: "翻库要被挡的那篇" });
  // ⚠️ 判据用 **id**,不用标题:被挡时那句话会把用户的查询词原样回显
  // (`匹配「翻库要被挡的那篇」的 1 条都在屏蔽列表里`),拿标题当判据会把自己的回显
  // 当成泄漏。真正不能出现的是**条目本身**(`id=` 那一行)。
  check("library_search:被屏蔽的不出现在结果里", !hit.includes(solo.id), hit);
  check("library_search:并说了挡掉几条", hit.includes("屏蔽"), hit);
  // 关键的那半句:模型得知道"查不到"不等于"库里没有"。
  check("library_search:说明了那是屏蔽,不是没有", !hit.includes("库里没有匹配"), hit);

  const listed = await call("library_items", { collectionId: col2.id });
  check("library_items:被屏蔽的也不出现", !listed.includes(solo.id), listed);
  check("library_items:并说了挡掉几条", listed.includes("屏蔽"), listed);

  // 绝对路径那条线:库外被屏蔽的关联本来是 `linked` 条目,`itemLine` 会给 PDF 路径。
  // 这里只确认"被挡的条目整个不出现"就够了 —— 路径自然也就跟着没了。
  const searchAll = await call("library_search", { query: "" });
  check("library_search:留空列全部时也过筛子", !searchAll.includes(solo.id), searchAll.slice(0, 600));

  // 收尾:清掉屏蔽,免得影响后面(以及别的段)的判断。
  resetSuppressCacheForTest();
  saveSuppress({ nodes: [], extensions: [] });
}

/* ──────────────── 6. 长尾:调用方最可能踩的两个错 ──────────────── */

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
