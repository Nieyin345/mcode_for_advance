/**
 * Headless smoke for **`main/workflows/assets.ts` 的 `LIBRARY_PY`** —— 交给模型的那个
 * 只读查询脚本。它不在 tsc 的视野里(是一段反引号里的 Python 字面量),而它直读 sqlite:
 * 列名写错、SQL 坏、`--kind` 那种参数退役后还在查 `kind` 列,都要到"用户真去用了"才暴露 ——
 * 暴露出来的样子是一句"库里什么都没有",不指向本仓库任何一行代码。
 *
 * kind 退役那一轮正是这个形状(见 `.py` 文件头)。这套把它挡住。
 *
 * ## 为什么走真 python + 真 sqlite
 *
 * 断言的是**行为**:把字面量落成 `.py`、用真解释器跑、喂一个真库,然后看**输出里有没有
 * 那一条**。断言"源码里包含某个字符串"在语法坏掉的脚本上照样绿 —— 那是仓规里
 * 「断言要测行为不是文本」那一课。
 *
 * ## 它不碰用户真正的库
 *
 * 库建在 `mktemp -d` 给的临时目录下,跑完由 `run.sh` 删。
 *
 * Run: scripts/library-py-smoke/run.sh
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_CITATIONS_PY, LIBRARY_PY } from "@main/workflows/assets.js";

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

const OUT = process.argv[2];
if (!OUT) throw new Error("run.sh 要把临时目录当第一个参数传进来");

/* ──────────────── 0. 把字面量落成真的 .py ──────────────── */

const PY = join(OUT, "library.py");
writeFileSync(PY, LIBRARY_PY, "utf8");

/** 跑一遍脚本,拿它的 stdout。参数直接传给 python。 */
function run(...args: string[]): string {
  return execFileSync("python", [PY, ...args], { encoding: "utf8", cwd: OUT });
}

/** 建一个临时库。列形状照**新装** Mcode：学术字段在新库根本不存在。 */
function seed(root: string): void {
  mkdirSync(join(root, "library", "markdown"), { recursive: true });
  mkdirSync(join(root, "library", "notes"), { recursive: true });
  const py = join(OUT, "seed.py");
  writeFileSync(
    py,
    `
import sqlite3, json, pathlib
root = pathlib.Path(${JSON.stringify(root)})
db = root / "mcode.db"
if db.exists(): db.unlink()
c = sqlite3.connect(db)
c.executescript("""
CREATE TABLE library_items(id TEXT PRIMARY KEY, title TEXT NOT NULL, abstract TEXT, language TEXT,
  url TEXT, pdf_path TEXT, pdf_sha256 TEXT, md_path TEXT, entry_mode TEXT NOT NULL DEFAULT 'attached',
  file_path TEXT, added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE library_collections(id TEXT PRIMARY KEY, name TEXT, parent_id TEXT, group_id TEXT, sort_order INTEGER);
CREATE TABLE library_collection_items(collection_id TEXT, item_id TEXT);
CREATE TABLE library_notes(id TEXT, item_id TEXT, content TEXT, origin TEXT, created_at INTEGER);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
""")
c.executemany("INSERT INTO library_items(id,title,abstract,url,md_path,pdf_path,file_path,added_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)", [
  ("li_p1", "注意力就是全部", "关键摘要字串", "https://doi.org/10.1000/p1", "markdown/a.md", None, None, 1000, 1000),
  ("li_n1", "一条随手记", None, None, "notes/li_n1.md", None, None, 1000, 1000),
  ("li_t1", "LaTeX 论文模版", None, None, None, None, None, 1000, 1000),
  ("li_orphan", "无家可归的一条", None, None, None, None, "raw/x.bin", 1000, 1000),
  # 按文件类型屏蔽按**份**算(见下面 extensions 的 .pdf):转录过的只给转录;只有 PDF 的整条挡
  ("li_pm", "转录过的 PDF", None, None, "markdown/b.md", "papers/b.pdf", None, 1000, 1000),
  ("li_po", "只有 PDF 的论文", None, None, None, "papers/c.pdf", None, 1000, 1000),
  # 通用文件只有 file_path —— 从前 file_of 只认 md / pdf,于是说它「没有文件」
  ("li_doc", "课题报告", None, None, None, None, "files/li_doc-report.docx", 1000, 1000),
  ("li_dm", "转录过的 Word", None, None, "markdown/imported/li_dm/full.md", None, "files/li_dm-a.docx", 1000, 1000),
  # 回收站里的条目 —— 用户"我不要它了"的意思,不该进模型上下文(见下面 3b 段)
  ("li_trash", "被丢进回收站的那一篇", None, None, "markdown/t.md", None, None, 1000, 1000),
  # ★ 改过名的**老回收站**:名字不是「回收站」,只有老的**每库键**认得它(见 3b 段)
  ("li_legacy_trash", "老回收站里改过名的那一篇", None, None, "markdown/lt.md", None, None, 1000, 1000),
])
c.executemany("INSERT INTO library_collections(id,name,parent_id,group_id,sort_order) VALUES(?,?,?,?,?)", [
  ("lc_aw", "精读队列", None, "docs", 0),
  ("lc_sub", "子分类", "lc_aw", "docs", 1),
  ("lc_tpl", "模版集", None, "templates", 0),
  ("lc_orphan", "没挂大类的", None, None, 0),
  ("lc_trash", "回收站", None, "docs", 2),
  # 改过名的老回收站:它叫「归档处」,名字那条来源认不出 —— 只有老的每库键认它。
  ("lc_legacy_trash", "归档处(改过名的老回收站)", None, "docs", 3),
])
c.executemany("INSERT INTO library_collection_items(collection_id,item_id) VALUES(?,?)", [
  ("lc_aw", "li_p1"), ("lc_sub", "li_p1"), ("lc_tpl", "li_t1"), ("lc_orphan", "li_orphan"),
  ("lc_aw", "li_pm"), ("lc_aw", "li_po"), ("lc_aw", "li_doc"), ("lc_aw", "li_dm"),
  ("lc_trash", "li_trash"),
  ("lc_legacy_trash", "li_legacy_trash"),
])
c.execute("INSERT INTO settings(key,value) VALUES(?,?)", ("library.groups", json.dumps([
  # NOTE: 老库里这份 JSON 仍然带着 kinds —— 代码停写但没删列。脚本必须忽略它,
  # 而不是因此判整份非法(那样升级上来的库在脚本这边就读不到自己的大类名)。
  {"id": "docs", "name": "文档", "kinds": ["paper", "textbook", "note"]},
  {"id": "templates", "name": "模版", "kinds": ["document", "slides", "latex", "code", "image"]},
])))
c.execute("INSERT INTO settings(key,value) VALUES(?,?)", ("library.suppress", json.dumps({
  "nodes": ["group:templates", "type:paper"],  # 老数据里残留的 type: 那条该被丢掉
  "extensions": [".pdf"],
})))
# ★ 老的每库键(带 kind 后缀)指向**改过名**的那个老回收站。它名字不是「回收站」,
#   全局键也没有 —— 只有这条老的每库键认得出它。主进程 libraryTrashSettingKey(kind)
#   就是这个格式,脚本必须照读(见 assets.ts 里 load_trash_ids 那段注释)。
c.execute("INSERT INTO settings(key,value) VALUES(?,?)", ("library.trashCollectionId.paper", "lc_legacy_trash"))
c.commit(); c.close()
`,
    "utf8",
  );
  execFileSync("python", [py], { encoding: "utf8" });
}

const ROOT = join(OUT, "root");
seed(ROOT);

/** 跑一条命令,带 `--root`。 */
function at(...args: string[]): string {
  return run("--root", ROOT, ...args);
}

/* ──────────────── 1. 语法与用法 ──────────────── */

console.log("\n脚本本身跑得起来");

{
  // `--help` 绿 = 解释器把整份读下来了。语法坏的话这里就抛(SyntaxError)。
  const help = at("--help");
  check("--help 跑得起来(语法是好的)", help.includes("list"), help.slice(0, 120));
  // ⚠️ **`--kind` 退役了**。留着的话它去查一个已经停写的列,永远返回空 —— 而模型会
  // 把那个空当成"库里没有论文"如实汇报。这一条钉住它没有被留着。
  const listHelp = at("list", "--help");
  check("★ list 不再有 --kind", !listHelp.includes("--kind"), listHelp);
  check("★ list 有 --group(按大类过滤)", listHelp.includes("--group"), listHelp);
}

/* ──────────────── 2. collections:大类 → 分类树 ──────────────── */

console.log("\ncollections · 按大类分段落");

{
  const out = at("collections");
  check("★ 大类用**名字**当段落标题(不是 id)", out.includes("文档:") && out.includes("模版:"), out);
  check("分类树还在(子分类缩进在网上)", out.includes("精读队列") && out.includes("子分类"), out);
  check("分类 id 报出来了(模型要拿它去调别的工具)", out.includes("id=lc_aw"), out);
  // 用户自建/没挂大类的分类也要列 —— 漏掉的话模型看不到它下面的条目。
  check("★ 没挂大类的分类单独列出来", out.includes("不属于任何大类") && out.includes("没挂大类的"), out);
}

/* ──────────────── 3. list:按大类过滤 + 屏蔽 ──────────────── */

console.log("\nlist · 全量、按大类、屏蔽");

{
  const all = at("list");
  check("全量里能看到论文那条", all.includes("注意力就是全部"), all);
  check("也能看到笔记那条", all.includes("一条随手记"), all);
  // 模板集挂在 templates 大类下 → 被 group:templates 挡住。
  check("★ 挂在被屏蔽大类下的条目被挡掉", !all.includes("LaTeX 论文模版"), all);
  check("而且如实说挡了几条", all.includes("屏蔽规则挡掉了"), all);
  // ⚠️ **老数据里那条 `type:paper` 不该挡掉任何东西。** 这一条测的是**结果**:
  // paper 条目还在。它与"脚本把那一条丢掉了"是两件事 —— 丢掉与留着**今天**行为上
  // 无差别(没有代码再生成 `type:` 键去匹配它,于是它永远命中不了),所以这一条
  // **抓不住**"没丢"的变异。丢掉它只是为了与主进程口径对齐,不是可观测的行为,
  // 别把它当成后者的证据。
  check("★ 过时的 type: 没挡掉任何东西(论文那条还在)", all.includes("注意力就是全部"), all);
}

{
  const docs = at("list", "--group", "docs");
  check("★ --group docs 只给文档大类下的", docs.includes("注意力就是全部"), docs);
  // 挂在 templates 下的那条本来就被屏蔽了,所以"看不到"不构成证据;换个说法:
  // 它至少不该出现在 docs 这一路。
  check("★ --group docs 不给别的大类的条目", !docs.includes("LaTeX 论文模版"), docs);
}

/* ──────────────── 3b. 回收站里的条目也不该进上下文(2026-10-08 补) ──────────────── */

console.log("\nlist · 回收站那道门");

// **「回收站里的东西不进上下文」是一条既定的硬规矩** —— 用户把一条丢进回收站的意思
// 就是"我不要它了"。所有面向 AI 的出口都守着它(manifest 三处、attachToChat、
// envPrompt.selectVisibleItems、libraryServer 的翻库两条、customUi)。而这个脚本从前
// 只过**屏蔽**、漏了回收站 —— 被丢掉的条目连同绝对路径照样列给模型。
{
  const all = at("list");
  check("★ list:回收站里的条目不出现", !all.includes("被丢进回收站的那一篇"), all);
  // 与屏蔽**分开报**:两者是不同的用户动作,说的话该不一样("还原" vs "改设置")。
  check("★ 而且如实说是回收站挡的(不是笼统的屏蔽)", all.includes("回收站里的"), all);
  const f = at("find", "回收站");
  check("★ find:回收站里的条目不出现", !f.includes("被丢进回收站的那一篇"), f);

  // ★ 改过名的**老回收站**:名字不是「回收站」,全局键也没有 —— 只有老的**每库键**
  //   (`library.trashCollectionId.paper`)认得它。漏读它 = 那个老回收站里的条目(连同
  //   绝对路径)照常进模型上下文,正是这段要守的那条硬规矩被绕过。
  check(
    "★ 老的每库键认出的(改过名)回收站里的条目不出现",
    !all.includes("老回收站里改过名的那一篇"),
    all,
  );
  check(
    "★ find 也拿不到老回收站里那条",
    !at("find", "老回收站").includes("老回收站里改过名的那一篇"),
    at("find", "老回收站"),
  );
}

{
  // 孤儿分类下的条目:**不在任何大类**里 → 勾任何大类都拿不到,但全量里看得见。
  const all = at("list");
  check("★ 没挂大类的条目在全量里看得见", all.includes("无家可归的一条"), all);
  const tpl = at("list", "--group", "templates");
  check("★ 但它不属于任何大类(勾 templates 拿不到)", !tpl.includes("无家可归的一条"), tpl);
  const docs = at("list", "--group", "docs");
  check("★ 勾 docs 同样拿不到", !docs.includes("无家可归的一条"), docs);
}

/* ──────────────── 4. files / find / notes / show ──────────────── */

console.log("\n其余几条命令都还跑得通");

{
  const files = at("files", "--group", "docs");
  check("files 给出绝对路径", files.includes("markdown"), files);
  check("files 后面跟着标题与 id", files.includes("注意力就是全部") && files.includes("id=li_p1"), files);

  const found = at("find", "注意力");
  check("find 按关键词命中", found.includes("注意力就是全部"), found);
  const inAbstract = at("find", "关键摘要字串");
  check("find 能查到简介而不依赖旧的作者/期刊列", inAbstract.includes("注意力就是全部"), inAbstract);
  const miss = at("find", "根本不存在的东西");
  check("find 找不到时如实说", miss.includes("库里没有匹配的条目"), miss);
}

{
  const show = at("show", "li_p1");
  check("show 按 id 前缀取到一条", show.includes("注意力就是全部"), show);
  check("show 显示仍在使用的来源 URL 与摘要", show.includes("https://doi.org/10.1000/p1") && show.includes("关键摘要字串"), show);
  // show 的 SELECT 里从前带 kind / type 那两列(一个已停写、一个是自由文本)——
  // 列名错一个就是一次运行期崩溃,这条钉住整条 SELECT 是好的。
  check("show 没有崩(整条 SELECT 是好的)", show.length > 0, show.length);
}

/* ──────────────── 5. 转录与原件 ──────────────── */

console.log("\n转录与原件:一起给,屏蔽按份去掉");

{
  // 屏蔽只管给 AI 看的,而且按**份**算(2026-09-26 用户定的):屏蔽 pdf,模型只看转录。
  const all = at("list");
  check("★ 屏蔽 .pdf 后,转录过的 PDF 还在", all.includes("转录过的 PDF"), all);
  const pmLine = all.split("\n").find((l) => l.includes("id=li_pm")) ?? "";
  check("★ 它只给转录,不给 PDF", pmLine.includes("b.md") && !pmLine.includes("b.pdf"), pmLine);
  check("★ 只有 PDF 的那篇整条挡掉", !all.includes("只有 PDF 的论文"), all);
  const pmShow = at("show", "li_pm");
  check("show 同样只给转录", pmShow.includes("b.md") && !pmShow.includes("b.pdf"), pmShow);
  const files = at("files", "--group", "docs");
  check("★ 通用文件给出文件本身,不说「没有文件」", files.includes("li_doc-report.docx"), files);
  const dmLine = files.split("\n").find((l) => l.includes("li_dm")) ?? "";
  check("★ 转录过的 Word:转录与原件都给出来", dmLine.includes("full.md") && dmLine.includes("li_dm-a.docx"), dmLine);
  check("转录排在原件前面", dmLine.indexOf("full.md") < dmLine.indexOf("li_dm-a.docx"), dmLine);
  const show = at("show", "li_doc");
  check("★ show 通用文件也给出文件本身", show.includes("li_doc-report.docx"), show);
}

/* ──────────────── 6. 引用核对不能读新库里根本不存在的 DOI 等列 ──────────────── */

console.log("\n引用核对 · 新装库 + 来源 DOI URL");
{
  const script = join(OUT, "check_citations.py");
  const bib = join(OUT, "refs.bib");
  writeFileSync(script, CHECK_CITATIONS_PY, "utf8");
  writeFileSync(bib, [
    "@article{doiMatch, title={标题与库中不同}, doi={10.1000/p1}}",
    "@article{unknown, title={从未收录的一篇文献}, doi={10.9999/unknown}}",
  ].join("\n"), "utf8");
  const checked = spawnSync("python", [script, bib, "--root", ROOT], { encoding: "utf8", cwd: OUT });
  const result = checked.stdout;
  check("未收录项令引用核对退出码为 1（不会假绿）", checked.status === 1, { status: checked.status, stderr: checked.stderr });
  check("来源 URL 中的 DOI 可作为本地精确匹配", result.includes("库里有 1 条") && result.includes("[OK] doiMatch"), result);
  check("未收录的仍如实列出", result.includes("[X] unknown"), result);
  check("未收录不等于编造,明确需要外部核实", result.includes("请外部核实后再引用") && !result.includes("很可能是编造"), result);
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
