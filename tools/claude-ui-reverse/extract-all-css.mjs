/**
 * 解析**全部 25 个 CSS**，输出：
 *   1. 每个文件里定义了哪些变量（用来回答「我该看哪个文件」）
 *   2. `--df-*`（侧栏）的分档表 —— 同一个变量在不同选择器下的不同值
 *
 * ## 为什么必须做这个
 *
 * 上一轮只解析了主 CSS（`c6a992d55-*.css`，1.49 MB），于是把
 * `--df-row-h` 判成「CSS 里零定义、只能运行时算」。
 *
 * **那是错的。** 它在 `shared-styles-*.css`（87 KB）里，而且有 6 个不同的定义点。
 *
 * 教训写进 README：**「我搜过了」必须写清「我搜了哪些文件」。**
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const R = (p) => resolvePath(REPO_ROOT, p);
const CSS_DIR = "C:/Program Files/WindowsApps/Claude_3.6556.2.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist/assets/v1";

/** 切成 `sel{body}`。 */
function rules(src) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push({ sel: m[1].trim(), body: m[2] });
  return out;
}

const files = readdirSync(CSS_DIR).filter((f) => f.endsWith(".css")).sort();
console.error(`扫 ${files.length} 个 CSS`);

/* ── 一、每个文件定义了哪些变量前缀 ── */
const perFile = [];
const allDefs = [];   // { file, sel, name, value }

for (const f of files) {
  const css = readFileSync(join(CSS_DIR, f), "utf8");
  const names = new Set();
  for (const { sel, body } of rules(css)) {
    for (const part of body.split(";")) {
      const mm = part.match(/^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/);
      if (!mm) continue;
      names.add(mm[1]);
      allDefs.push({ file: f, sel, name: mm[1], value: mm[2] });
    }
  }
  const byPrefix = {};
  for (const n of names) {
    const p = n.split("-").slice(0, 3).join("-");   // --cds-font / --df-row / --font
    byPrefix[p] = (byPrefix[p] ?? 0) + 1;
  }
  if (names.size) perFile.push({ file: f, total: names.size, byPrefix });
}

/* ── 二、--df-* 分档表 ── */
const dfNames = [...new Set(allDefs.filter((d) => d.name.startsWith("--df-")).map((d) => d.name))].sort();

/** 对每个 --df-* 变量，列出它的全部定义点（去掉变量自身的定义，只看给了字面值的）。 */
const tiers = new Map();
for (const n of dfNames) {
  const defs = allDefs.filter((d) => d.name === n);
  // 去重：同一个值多个选择器就合并
  const byValue = new Map();
  for (const d of defs) {
    if (!byValue.has(d.value)) byValue.set(d.value, []);
    byValue.get(d.value).push(d.sel);
  }
  tiers.set(n, [...byValue.entries()]);
}

/* ── 输出 ── */
let out = `Claude 3.6556.2.0 —— 全部 ${files.length} 个 CSS 的变量定义

⚠️ 上一轮只解析了主 CSS，导致把 --df-row-h 误判成「运行时才算出来」。
   它在 shared-styles-*.css 里，而且有多个定义点。见 README。

## 一、每个文件定义了哪些变量

`;
for (const { file, total, byPrefix } of perFile.sort((a, b) => b.total - a.total)) {
  const parts = Object.entries(byPrefix).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([p, n]) => `${p}(${n})`).join(" · ");
  out += `  ${String(total).padStart(5)} 个变量  ${file}\n               ${parts}\n`;
}

out += `\n\n## 二、侧栏 --df-* 的分档（${dfNames.length} 个变量，每个列出全部定义点）\n`;

const CRITICAL = ["--df-sidebar-width", "--df-chrome-bar-height", "--df-header-h", "--df-row-h",
  "--df-row-gap", "--df-row-px", "--df-leading-slot", "--df-icon-size", "--df-row-font",
  "--df-group-font", "--df-radius-pill", "--df-footer-btn-size", "--df-group-pt",
  "--df-row-stack-gap", "--df-pill-size", "--df-described-line"];

for (const n of CRITICAL) {
  const t = tiers.get(n);
  if (!t) continue;
  out += `\n${"-".repeat(78)}\n${n}\n${"-".repeat(78)}\n`;
  for (const [value, sels] of t) {
    out += `  ${String(value).padEnd(22)} ← ${sels.length} 个选择器\n`;
    for (const s of sels.slice(0, 4)) out += `      ${s.slice(0, 160)}\n`;
    if (sels.length > 4) out += `      …还有 ${sels.length - 4} 个\n`;
  }
}

out += `\n\n## 三、其余 --df-* 变量的全部定义点\n`;
for (const n of dfNames) {
  if (CRITICAL.includes(n)) continue;
  const t = tiers.get(n);
  out += `\n${n}\n`;
  for (const [value, sels] of t) {
    out += `    ${String(value).slice(0, 60).padEnd(62)} (${sels.length})\n`;
  }
}

writeFileSync(R(".tmp/rev/all-css-vars.txt"), out);
console.log(out.slice(0, 9000));
console.log(`\n完整：.tmp/rev/all-css-vars.txt`);
