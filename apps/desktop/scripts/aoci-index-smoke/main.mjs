/**
 * aoci-index-smoke — 【MC-009】AOCI 代码索引 vs 磁盘源码的一致性回归网。
 *
 * ## 盯的是什么
 *
 * `aoci.code.txt`（AOCI 代码索引，仓库根、被 git 跟踪）在结构变动后容易与磁盘漂移：
 *  - **目录段根**被写死在初始化时的 worktree 名（历史 bug：整份索引顶到
 *    `.../aoci-mcode-wt/`，而当前项目根是 `.../mcode/`），于是 409 个目录段标签
 *    全部指向一个不存在的根；
 *  - **对象条目**指向已删除/改名的文件（孤儿条目），AI 按旧模块继续排查或漏掉新模块；
 *  - 条目 `R:` 字段里的 `code:` 关系引用指向已不存在的路径（悬空引用）。
 *
 * ## 判据（三条，全部 fail-closed）
 *
 *  1. **目录段根一致**：每个 `===…===` 目录段标签必须落在**当前仓库根**之下。
 *  2. **对象不悬空**：每个 `<name>[Tag]:` 条目解析出的文件必须真实存在于磁盘。
 *  3. **关系引用不悬空**：每条 `code:<repo-rel-path>` 引用必须指向真实文件。
 *
 * 任一违例即 `exit 1` 并打印精确位置，CI/本地可复跑。索引本身**只读**，本套件不
 * 修改 `aoci.code.txt`。可用 `MCODE_AOCI_CODE=<path>` 指向副本做变异验证（不碰真索引）。
 *
 * Run: scripts/aoci-index-smoke/run.sh
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts/aoci-index-smoke/ → apps/desktop/scripts → apps/desktop → apps → 仓库根
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

/** 归一成 `/` 分隔、去尾斜杠、小写（Windows 盘符/大小写不敏感）的路径键。 */
function normKey(p) {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

const ROOT_KEY = normKey(REPO_ROOT);

const CODE_PATH = process.env.MCODE_AOCI_CODE
  ? resolve(process.env.MCODE_AOCI_CODE)
  : join(REPO_ROOT, "aoci.code.txt");

let checks = 0;
let failures = 0;
function fail(msg) {
  failures += 1;
  console.log(`  FAIL ${msg}`);
}

if (!existsSync(CODE_PATH)) {
  console.error(`aoci-index-smoke: 找不到索引文件 ${CODE_PATH}`);
  process.exit(1);
}
const text = readFileSync(CODE_PATH, "utf8");
const lines = text.split("\n");

const DIR_RE = /^===(.+?)===$/;
const ENTRY_RE = /^(\S+)\[([A-Z0-9]{1,6})\]:/;
// 关系引用路径可含中文(如 docs/Mcode-公众号风介绍.md);以 `,`/空白/`|` 为界。
const REF_RE = /code:([^\s,|]+)/g;
// `code:` 关系引用**只出现在 R 字段**。F/A/S 是自由文本,里面可能有形如 `{ok:false,code:conflict}`
// 或「每条code:关系引用不悬空」这样的字面,那不是引用 —— 只扫 R 段,避免把散文里的 `code:`
// 当成悬空引用报假红。
const R_SEGMENT_RE = /\|\s*R:(.*?)(?:\s*\|\s*[FAS]:|$)/s;

let curDir = null; // 归一化后的目录段绝对路径
const entries = []; // { name, dirKey, lineNo }
const dirLabels = []; // { label, lineNo }
const refs = []; // { ref, lineNo }

for (let i = 0; i < lines.length; i++) {
  const ln = lines[i];
  const lineNo = i + 1;
  const dm = DIR_RE.exec(ln);
  if (dm) {
    curDir = normKey(dm[1]);
    dirLabels.push({ label: dm[1], lineNo });
    continue;
  }
  const em = ENTRY_RE.exec(ln);
  if (em && curDir !== null) {
    entries.push({ name: em[1], dirKey: curDir, lineNo });
  }
  // 只在 R 段里找 `code:` 引用(F/A/S 的自由文本可能含形如 `code:conflict` 的字面)。
  const rSeg = R_SEGMENT_RE.exec(ln);
  if (rSeg) {
    let rm;
    REF_RE.lastIndex = 0;
    while ((rm = REF_RE.exec(rSeg[1])) !== null) {
      refs.push({ ref: rm[1], lineNo });
    }
  }
}

// —— 1. 目录段根必须在当前仓库根之下 ——
checks++;
let badRoots = 0;
for (const { label, lineNo } of dirLabels) {
  const k = normKey(label);
  // 允许 `===<root>===` 本身与 `===<root>/<sub>===`
  if (k !== ROOT_KEY && !k.startsWith(ROOT_KEY + "/")) {
    badRoots++;
    if (badRoots <= 10) fail(`目录段根不符(L${lineNo}): ${label}  期望前缀 ${REPO_ROOT}`);
  }
}
if (badRoots > 10) fail(`…还有 ${badRoots - 10} 个目录段根不符`);
if (badRoots === 0) console.log(`  ok   目录段根一致(${dirLabels.length} 段)`);

// —— 2. 对象条目不悬空 ——
checks++;
let orphans = 0;
for (const { name, dirKey, lineNo } of entries) {
  // dirKey 是绝对路径(已归一)，name 是文件名 → 相对根的部分
  const rel = dirKey.startsWith(ROOT_KEY + "/")
    ? dirKey.slice(ROOT_KEY.length + 1)
    : dirKey === ROOT_KEY
      ? ""
      : null;
  if (rel === null) {
    // 根不符已在检查 1 报过；这里跳过，避免重复噪声
    continue;
  }
  const abs = join(REPO_ROOT, rel, name);
  if (!existsSync(abs)) {
    orphans++;
    if (orphans <= 10) fail(`孤儿条目(L${lineNo}): ${rel ? rel + "/" : ""}${name} 不存在于磁盘`);
  }
}
if (orphans > 10) fail(`…还有 ${orphans - 10} 个孤儿条目`);
if (orphans === 0) console.log(`  ok   对象条目全部存在于磁盘(${entries.length} 条)`);

// —— 3. `code:` 关系引用不悬空 ——
checks++;
let dangling = 0;
const seenRef = new Set();
for (const { ref, lineNo } of refs) {
  if (seenRef.has(ref)) continue;
  seenRef.add(ref);
  const abs = join(REPO_ROOT, ref.replace(/\//g, "/"));
  if (!existsSync(abs)) {
    dangling++;
    if (dangling <= 10) fail(`悬空引用(L${lineNo}): code:${ref}`);
  }
}
if (dangling > 10) fail(`…还有 ${dangling - 10} 个悬空引用`);
if (dangling === 0) console.log(`  ok   code: 关系引用全部存在(${seenRef.size} 个去重引用)`);

// —— 4. 【诊断，不判失败】磁盘上受管源码里尚未进索引的新文件 ——
// MC-009 的「漏掉新模块」方向。这里是**诊断**而非硬门：索引在活跃开发期合法滞后
// (仓库多处注明「索引可能滞后」「并行编辑」)，若硬失败会常驻红；真正的补录由
// `aoci_maintain` 完成。此处只如实报数，供重建索引时核对。
const indexedRel = new Set(entries.map((e) => {
  const rel = e.dirKey.startsWith(ROOT_KEY + "/") ? e.dirKey.slice(ROOT_KEY.length + 1) : "";
  return (rel ? rel + "/" : "") + e.name;
}));
const SRC_ROOT = join(REPO_ROOT, "apps", "desktop", "src");
const unindexed = [];
function walk(dir) {
  let names;
  try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of names) {
    const p = join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name === "node_modules" || d.name === ".git") continue;
      walk(p);
    } else if (/\.(ts|tsx)$/.test(d.name)) {
      const rel = p.slice(REPO_ROOT.length + 1).split(/[\\/]/).join("/");
      if (!indexedRel.has(rel)) unindexed.push(rel);
    }
  }
}
walk(SRC_ROOT);
console.log(`  info 磁盘受管源码未进索引 ${unindexed.length} 个(诊断，非失败；补录走 aoci_maintain)`);

console.log(`aoci-index-smoke: ${checks} 类检查,${failures} 条违例(文件 ${CODE_PATH})`);
if (failures > 0) process.exit(1);
