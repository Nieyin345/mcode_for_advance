/**
 * 从 `shared-styles-*.css` 里抽出侧栏（`--df-*`）的**完整变量表**。
 *
 * ## 为什么上一轮漏了
 *
 * 上一轮只解析了主 CSS（`c6a992d55-*.css`），而 `--df-*` 的**默认值全在
 * `shared-styles-*.css`** 里 —— 那是第二个 CSS 文件，1.49 MB 之外还有 87 KB。
 *
 * 于是上一轮把 `--df-row-h` 判成「CSS 里零定义、只能运行时算」，
 * **那是错的**。它在 `.dframe-root { --df-row-h: 26px }` 里躺着。
 *
 * 教训：**「我搜过了」要写清「我搜了哪些文件」**。
 *
 * ## 这个脚本做什么
 *
 * 按选择器分组输出所有 `--df-*` 的定义，并按密度档（compact / 默认 / comfortable）
 * 分别汇总，这样「会话行多高」这种问题有直接答案。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const R = (p) => resolvePath(REPO_ROOT, p);

const CSS = readFileSync(R(".tmp/rev/shared-styles.css"), "utf8");

/** 切成 `sel{body}`（不处理嵌套，这份 CSS 里没有）。 */
function rules(src) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ sel: m[1].trim(), body: m[2] });
  }
  return out;
}

/** 从 body 里取 `--df-*: value`。 */
function dfProps(body) {
  const out = [];
  for (const part of body.split(";")) {
    const mm = part.match(/^\s*(--df-[\w-]+)\s*:\s*(.+?)\s*$/);
    if (mm) out.push([mm[1], mm[2]]);
  }
  return out;
}

const all = rules(CSS);
const blocks = [];
for (const { sel, body } of all) {
  const props = dfProps(body);
  if (props.length) blocks.push({ sel, props });
}

/* ── 输出一：按选择器 ── */
let out = `Claude 3.6556.2.0 —— 侧栏变量（--df-*）完整表

数据源：ion-dist/assets/v1/shared-styles-D_GJawPO.css（87 KB）
⚠️ 上一轮只解析了主 CSS，把 --df-row-h 误判成「运行时才算出来的」。
   实际它就在这里。见 README「我搜了哪些文件」。

共 ${blocks.length} 个规则块，${new Set(blocks.flatMap((b) => b.props.map(([k]) => k))).size} 个不同变量。
`;

for (const { sel, props } of blocks) {
  out += `\n${"-".repeat(76)}\n${sel.slice(0, 200)}\n`;
  for (const [k, v] of props) out += `  ${k.padEnd(34)} ${v}\n`;
}

writeFileSync(R(".tmp/rev/sidebar-vars.txt"), out);

/* ── 输出二：密度档对照（最常问的那几个量）── */
const KEY = [
  "--df-row-h", "--df-row-ctl", "--df-row-px", "--df-row-gap",
  "--df-leading-slot", "--df-icon-size", "--df-row-font", "--df-group-font",
  "--df-radius-pill", "--df-footer-btn-size", "--df-new-circle-size",
  "--df-row-stack-gap", "--df-group-band-mt", "--df-described-line",
  "--df-row-pad-end", "--df-chrome-icon-size",
];

/**
 * 找出「定义了一组完整密度值」的块。
 * 判据：同时给了 --df-row-h 和 --df-row-gap（说明是一个完整的密度档）。
 */
const densityBlocks = blocks.filter(({ props }) => {
  const names = new Set(props.map(([k]) => k));
  return names.has("--df-row-h") && names.has("--df-row-gap");
});

console.log(`侧栏变量块 ${blocks.length} 个；完整密度档 ${densityBlocks.length} 个\n`);

for (const { sel, props } of densityBlocks) {
  console.log(`\n=== ${sel.slice(0, 150)} ===`);
  const map = new Map(props);
  for (const k of KEY) {
    if (map.has(k)) console.log(`  ${k.padEnd(28)} ${map.get(k)}`);
  }
}

// 单独把 .dframe-root 那个「基准档」打出来
const base = blocks.find(({ sel }) => sel === ".dframe-root");
if (base) {
  console.log("\n\n=== .dframe-root（基准档，全部变量）===");
  for (const [k, v] of base.props) console.log(`  ${k.padEnd(34)} ${v}`);
}

console.log(`\n完整表：.tmp/rev/sidebar-vars.txt`);
