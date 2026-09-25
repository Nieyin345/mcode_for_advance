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
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIBRARY_PY } from "@main/workflows/assets.js";

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

/** 建一个临时库。**列形状照真库** —— 尤其 `kind` 那一列还在(代码停写但没删列)。 */
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
CREATE TABLE library_items(id TEXT PRIMARY KEY, title TEXT, authors TEXT, year INTEGER, venue TEXT,
  doi TEXT, arxiv_id TEXT, volume TEXT, issue TEXT, page TEXT, publisher TEXT, abstract TEXT,
  type TEXT, url TEXT, md_path TEXT, pdf_path TEXT, file_path TEXT, kind TEXT);
CREATE TABLE library_collections(id TEXT PRIMARY KEY, name TEXT, parent_id TEXT, group_id TEXT, sort_order INTEGER);
CREATE TABLE library_collection_items(collection_id TEXT, item_id TEXT);
CREATE TABLE library_notes(id TEXT, item_id TEXT, content TEXT, origin TEXT, created_at INTEGER);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
""")
c.executemany("INSERT INTO library_items(id,title,authors,year,venue,md_path,pdf_path,file_path,kind) VALUES(?,?,?,?,?,?,?,?,?)", [
  ("li_p1", "注意力就是全部", "[]", 2017, "NeurIPS", "markdown/a.md", None, None, "paper"),
  ("li_n1", "一条随手记", "[]", None, None, "notes/li_n1.md", None, None, "note"),
  ("li_t1", "LaTeX 论文模版", "[]", None, None, None, None, None, "latex"),
  ("li_orphan", "无家可归的一条", "[]", None, None, None, None, "raw/x.bin", "document"),
])
c.executemany("INSERT INTO library_collections(id,name,parent_id,group_id,sort_order) VALUES(?,?,?,?,?)", [
  ("lc_aw", "精读队列", None, "docs", 0),
  ("lc_sub", "子分类", "lc_aw", "docs", 1),
  ("lc_tpl", "模版集", None, "templates", 0),
  ("lc_orphan", "没挂大类的", None, None, 0),
])
c.executemany("INSERT INTO library_collection_items(collection_id,item_id) VALUES(?,?)", [
  ("lc_aw", "li_p1"), ("lc_sub", "li_p1"), ("lc_tpl", "li_t1"), ("lc_orphan", "li_orphan"),
])
c.execute("INSERT INTO settings(key,value) VALUES(?,?)", ("library.groups", json.dumps([
  # NOTE: 老库里这份 JSON 仍然带着 kinds —— 代码停写但没删列。脚本必须忽略它,
  # 而不是因此判整份非法(那样升级上来的库在脚本这边就读不到自己的大类名)。
  {"id": "docs", "name": "文档", "kinds": ["paper", "textbook", "note"]},
  {"id": "templates", "name": "模版", "kinds": ["document", "slides", "latex", "code", "image"]},
])))
c.execute("INSERT INTO settings(key,value) VALUES(?,?)", ("library.suppress", json.dumps({
  "nodes": ["group:templates", "type:paper"],  # 老数据里残留的 type: 那条该被丢掉
  "extensions": [],
})))
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
  const miss = at("find", "根本不存在的东西");
  check("find 找不到时如实说", miss.includes("库里没有匹配的条目"), miss);
}

{
  const show = at("show", "li_p1");
  check("show 按 id 前缀取到一条", show.includes("注意力就是全部"), show);
  // show 的 SELECT 里从前带 kind / type 那两列(一个已停写、一个是自由文本)——
  // 列名错一个就是一次运行期崩溃,这条钉住整条 SELECT 是好的。
  check("show 没有崩(整条 SELECT 是好的)", show.length > 0, show.length);
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
