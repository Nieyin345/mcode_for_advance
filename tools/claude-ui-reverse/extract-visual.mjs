/**
 * 从 CSS 抽「视觉 token」：颜色、阴影、层级、动画。
 *
 * 与 extract-tokens.mjs 的分工：
 *   extract-tokens  → 尺寸与排版（字号、间距、圆角）
 *   本脚本          → 颜色、阴影、z-index、过渡时长
 *
 * 输出**亮/暗两列并排**，因为最容易出错的正是「只看了亮色」。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const R = (p) => resolvePath(REPO_ROOT, p);

const css = readFileSync(R(".tmp/rev/main.css"), "utf8");
const tokens = JSON.parse(readFileSync(R(".tmp/rev/tokens.json"), "utf8"));

/** 把所有 `--name:value` 按已有的层表合并（亮色 = root+base，暗色 = root+dark+dark-media）。 */
const LIGHT = { ...tokens.root, ...tokens.base };
const DARK = { ...tokens.root, ...tokens.dark, ...tokens["dark-media"] };

/** 递归解 var()，最多 16 层；解不开就原样返回。 */
function deref(name, table, depth = 0, seen = new Set()) {
  if (depth > 16 || seen.has(name)) return `⟳${name}`;
  const raw = table[name];
  if (raw === undefined) return undefined;
  seen.add(name);
  return String(raw).replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (_, n, fb) => {
    const v = deref(n, table, depth + 1, new Set(seen));
    return v !== undefined && v !== "" ? v : (fb ?? "");
  });
}

/* ═══════════════════════════════════════════════════════════════
 * 一、颜色 —— 按语义分组
 * ═══════════════════════════════════════════════════════════════ */
const COLOR_GROUPS = [
  ["底色 surface", /^--cds-surface-/],
  ["文字 text", /^--cds-text-/],
  ["填充 fill", /^--cds-fill-(?!git)/],
  ["边框 border", /^--cds-border/],
  ["强调 accent / 状态", /^--cds-(accent|danger|success|warning|pro|info|role-)/],
  ["git 状态", /^--cds-(fill|border|text)-git-/],
  ["调色板 gray/red/blue…", /^--cds-(gray|red|orange|yellow|green|blue|purple|pink|teal|cyan|brown|amber|lime|violet|indigo|rose|slate|zinc|neutral|stone)-\d+$/],
];

function colorTables() {
  const names = new Set([...Object.keys(LIGHT), ...Object.keys(DARK)]);
  const rows = [];
  for (const [group, re] of COLOR_GROUPS) {
    const inGroup = [...names].filter((n) => re.test(n)).sort();
    if (!inGroup.length) continue;
    rows.push({ group, entries: inGroup.map((n) => ({
      name: n,
      light: deref(n, LIGHT),
      dark: deref(n, DARK),
      rawLight: LIGHT[n],
      rawDark: DARK[n],
    })) });
  }
  return rows;
}

/* ═══════════════════════════════════════════════════════════════
 * 二、阴影
 * ═══════════════════════════════════════════════════════════════ */
function shadows() {
  return [...new Set([...Object.keys(LIGHT), ...Object.keys(DARK)])]
    .filter((n) => /shadow|ring-color|focus-shadow/.test(n))
    .sort()
    .map((n) => ({ name: n, light: deref(n, LIGHT), dark: deref(n, DARK) }));
}

/* ═══════════════════════════════════════════════════════════════
 * 三、z-index 层级 —— 在 CSS 规则里，不在变量里
 * ═══════════════════════════════════════════════════════════════ */
function zIndexes() {
  const out = new Map();
  const re = /(?:^|[;{}])\s*z-index\s*:\s*([^;}]+)/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    // 回溯到这个声明所在的选择器
    let i = m.index, depth = 0;
    while (i > 0) {
      if (css[i] === "}") depth++;
      else if (css[i] === "{") {
        if (depth === 0) break;
        depth--;
      }
      i--;
    }
    const selStart = Math.max(css.lastIndexOf("}", i - 1), css.lastIndexOf("{", i - 1), css.lastIndexOf(";", i - 1));
    const sel = css.slice(selStart + 1, i).trim();
    // 只收语义类（不是 Tailwind 的 .z-\[…\]）
    const v = m[1].trim();
    if (!out.has(v)) out.set(v, new Set());
    out.get(v).add(sel.slice(0, 90));
  }
  return [...out]
    .map(([v, set]) => ({ value: v, selectors: [...set].slice(0, 6) }))
    .filter((x) => /^-?\d+$/.test(x.value))
    .sort((a, b) => Number(a.value) - Number(b.value));
}

/* ═══════════════════════════════════════════════════════════════
 * 四、动画时长与缓动
 * ═══════════════════════════════════════════════════════════════ */
function motion() {
  const names = [...new Set([...Object.keys(LIGHT), ...Object.keys(DARK)])];
  return {
    durations: names.filter((n) => /durations?-|--cds-dur-|--cds-duration/.test(n)).sort()
      .map((n) => ({ name: n, light: deref(n, LIGHT), dark: deref(n, DARK) })),
    easings: names.filter((n) => /ease|--cds-ease/.test(n)).sort()
      .map((n) => ({ name: n, light: deref(n, LIGHT), dark: deref(n, DARK) })),
  };
}

/* ═══════════════════════════════════════════════════════════════
 * 五、字体
 * ═══════════════════════════════════════════════════════════════ */
function fonts() {
  const names = [...new Set([...Object.keys(LIGHT), ...Object.keys(DARK)])];
  return names.filter((n) => /^--font-|font-family|font-weight|font-axis|font-opsz|font-grad/.test(n)).sort()
    .map((n) => ({ name: n, light: deref(n, LIGHT), dark: deref(n, DARK) }));
}

/* ═══════════════════════════════════════════════════════════════
 * 输出
 * ═══════════════════════════════════════════════════════════════ */
let out = `Claude 3.6556.2.0 —— 视觉 token（亮/暗并排）

数据源：ion-dist/assets/v1/c6a992d55-Che1orl5.css
层：亮色 = :root + .cds-root；暗色 = :root + [data-mode=dark]（含 prefers-color-scheme）
解引用：var() 递归展开，最多 16 层

`;

for (const { group, entries } of colorTables()) {
  out += `\n${"=".repeat(78)}\n${group}  (${entries.length})\n${"=".repeat(78)}\n`;
  for (const e of entries) {
    const same = e.light === e.dark;
    out += `  ${e.name.padEnd(40)} ${String(e.light ?? "—").padEnd(46)}`;
    out += same ? `  （暗色相同）` : ` | dark: ${e.dark ?? "—"}`;
    out += "\n";
  }
}

out += `\n\n${"=".repeat(78)}\n阴影 / 焦点环  (${shadows().length})\n${"=".repeat(78)}\n`;
for (const s of shadows()) {
  out += `  ${s.name.padEnd(32)}\n`;
  out += `      light: ${s.light ?? "—"}\n`;
  if (s.light !== s.dark) out += `      dark : ${s.dark ?? "—"}\n`;
}

out += `\n\n${"=".repeat(78)}\nz-index 层级  (${zIndexes().length})\n${"=".repeat(78)}\n`;
for (const z of zIndexes()) {
  out += `  ${z.value.padStart(6)}  ${z.selectors.join("  ‖  ")}\n`;
}

const mo = motion();
out += `\n\n${"=".repeat(78)}\n动画时长  (${mo.durations.length})\n${"=".repeat(78)}\n`;
for (const d of mo.durations) out += `  ${d.name.padEnd(44)} ${d.light}\n`;
out += `\n${"=".repeat(78)}\n缓动曲线  (${mo.easings.length})\n${"=".repeat(78)}\n`;
for (const e of mo.easings) out += `  ${e.name.padEnd(44)} ${e.light}\n`;

const fo = fonts();
out += `\n\n${"=".repeat(78)}\n字体  (${fo.length})\n${"=".repeat(78)}\n`;
for (const f of fo) out += `  ${f.name.padEnd(44)} ${String(f.light).slice(0, 120)}\n`;

writeFileSync(R(".tmp/rev/visual-tokens.txt"), out);
writeFileSync(R(".tmp/rev/visual-tokens.json"), JSON.stringify({
  colors: colorTables(), shadows: shadows(), zIndex: zIndexes(), motion: mo, fonts: fo,
}, null, 2));

console.log(out.slice(0, 7000));
console.log(`\n…完整输出：.tmp/rev/visual-tokens.txt`);
