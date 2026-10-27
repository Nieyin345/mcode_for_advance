/**
 * 从本机 Claude 3.6556.2.0 的 CSS 里抽出 `--cds-*` 的真值。
 *
 * ## 三个坑（都踩过，记下来）
 *
 * 1. **只按顶层 `{}` 切块** → `@media` / `@layer` 整层被吞，1282 个变量落进 other。
 *    现在：正则扫 `--name:value;`，再回到最近的 `{` 取选择器。
 *
 * 2. **选择器用 `includes` 判** → `.cds-root [data-step="3"]` 也含 `.cds-root`，
 *    于是「文本大小档 3」被当成 base 覆盖了真 base。
 *    现在：**选择器必须 trim 后完全等于** `.cds-root` 才算 base。
 *
 * 3. **主题不在 `:root` / `.dark`** → 在 `.cds-root` 上，暗色走
 *    `[data-mode=dark]` 与 `@media (prefers-color-scheme: dark)`。
 *
 * ## Claude 的字号是「多层可变」的，不是一个固定值
 *
 *   .cds-root                     默认
 *   .cds-root[data-density=comfortable]    宽松密度
 *   .cds-root [data-step="1".."5"]         文本大小设置（5 档）
 *   .cds-root [data-size=xs|sm|lg]         组件尺寸
 *
 * 所以「Claude 的正文字号是多少」这句话本身就缺参数。本脚本把
 * **每一层**都抽出来，输出成矩阵，让调用方能明确选择。
 *//**
 * 路径全部相对**仓库根**解析，不依赖调用者的 cwd。
 *
 * ⚠️ 这是踩过的坑：脚本原本用相对路径 `R(".tmp/rev/main.css")`，
 * 从别处调用时就变成「找 <那里>/.tmp/rev/main.css」——
 * 和 CLAUDE.md 里 `run.sh` 在 `cd` 之后还用 `dirname "$0"` 是同一类错误。
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const R = (p) => resolvePath(REPO_ROOT, p);

import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync(R(".tmp/rev/main.css"), "utf8");

/** 该位置是否落在 `@media (prefers-color-scheme:dark)` 里。 */
function mediaAt(css, pos) {
  let i = pos, depth = 0;
  while (i > 0) {
    const ch = css[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) {
        const st = Math.max(css.lastIndexOf("}", i - 1), css.lastIndexOf("{", i - 1));
        const head = css.slice(st + 1, i);
        if (head.startsWith("@media")) {
          return /prefers-color-scheme\s*:\s*dark/.test(head) ? "dark"
            : /prefers-color-scheme\s*:\s*light/.test(head) ? "light" : null;
        }
        i = st;
        continue;
      }
      depth--;
    }
    i--;
  }
  return null;
}

/** 扫所有 `--cds-*: value;`。 */
function scan(css) {
  const out = [];
  const re = /--cds-[\w-]+\s*:/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const name = m[0].slice(0, -1).trim();
    let i = m.index + m[0].length, depth = 0, inStr = null, val = "";
    for (; i < css.length; i++) {
      const ch = css[i];
      if (inStr) { val += ch; if (ch === inStr) inStr = null; continue; }
      if (ch === '"' || ch === "'") { inStr = ch; val += ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if ((ch === ";" || ch === "}") && depth === 0) break;
      val += ch;
    }
    const lb = css.lastIndexOf("{", m.index);
    const st = Math.max(css.lastIndexOf("}", lb - 1), css.lastIndexOf("{", lb - 1), css.lastIndexOf(";", lb - 1));
    out.push({
      name,
      value: val.trim(),
      sel: css.slice(st + 1, lb).trim(),
      mq: mediaAt(css, m.index),
    });
  }
  return out;
}

const entries = scan(src);
console.error(`扫到 ${entries.length} 条 --cds-* 声明`);

/**
 * 归类。**用「选择器完全相等」判，不用 includes。**
 *
 * ⚠️ 但「完全相等」要按**逗号分隔后的每一段**判 —— Claude 把三层暗色写成
 * **一个**逗号组合的选择器：
 *
 *   [data-mode=dark] .cds-root:not([data-mode=light]):not([data-mode=system]),
 *   .cds-root[data-mode=dark],
 *   .cds-dark-scope[data-mode=dark] { … }
 *
 * 上一版只匹配了第一段，于是 `.cds-root[data-mode=dark]` 这条路径根本没进暗色层。
 */
const layers = new Map();
const put = (key, e) => {
  if (!layers.has(key)) layers.set(key, {});
  layers.get(key)[e.name] = e.value;
};

/** 把选择器按顶层逗号拆开（`()` / `[]` 里的逗号不算）。 */
function splitSelector(sel) {
  const out = [];
  let buf = "", depth = 0;
  for (const ch of sel) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(buf.trim()); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** 选择器的任意一段满足条件即算命中。 */
const anySeg = (e, test) => splitSelector(e.sel).some(test);

const LAYER_RULES = [
  // [key, 判定]

  // ── 全局 ──
  // `:where(:root,:host)` 是调色板本体（--cds-gray-* / --cds-neutral-* …）。
  // 上一版只认 `:root`，于是所有 `var(--cds-gray-20)` 都解不开。
  ["root",  (e) => anySeg(e, (x) => x === ":root" || x === ":where(:root,:host)" || x === ":where(:root, :host)") && !e.mq],
  ["base",  (e) => anySeg(e, (x) => x === ".cds-root") && !e.mq],

  // ── 暗色 ──
  // `.cds-root[data-mode=dark]` 与 `.cds-dark-scope[data-mode=dark]` 是显式暗色；
  // `[data-mode=dark] .cds-root:not(...)` 是「根上有 dark」的继承式。
  ["dark", (e) => !e.mq && anySeg(e, (x) =>
    x === ".cds-root[data-mode=dark]" ||
    x === ".cds-dark-scope[data-mode=dark]" ||
    /^\[data-mode=dark\]\s+\.cds-root:not\(\[data-mode=light\]\):not\(\[data-mode=system\]\)$/.test(x))],
  // `@media (prefers-color-scheme: dark)` 下 `data-mode=system` / 无 data-mode 那一组
  ["dark-media", (e) => e.mq === "dark" && anySeg(e, (x) =>
    /\.cds-root\[data-mode=system\]/.test(x) || /:not\(\[data-mode\]\)/.test(x))],

  ["theme-claude", (e) => anySeg(e, (x) => x === "[data-theme=claude]") && !e.mq],

  // ── 密度 / 字号档 / 尺寸档 ──
  ["comfortable", (e) => anySeg(e, (x) => x === ".cds-root[data-density=comfortable]")],
  ["compact",     (e) => anySeg(e, (x) => x === ".cds-root[data-density=compact]")],
  ...[1, 2, 3, 4, 5].map((n) => [`step${n}`, (e) => anySeg(e, (x) => x === `.cds-root [data-step="${n}"]`)]),
  ["size-xs",     (e) => anySeg(e, (x) => x === ".cds-root [data-size=xs]")],
  ["size-sm",     (e) => anySeg(e, (x) => x === ".cds-root [data-size=sm]")],
  ["size-lg",     (e) => anySeg(e, (x) => x === ".cds-root [data-size=lg]")],

  // ── 组件级变量层 ──
  ["cmp-assistant", (e) => anySeg(e, (x) => x === ".cds-root [data-cds=AssistantMessage]")],
  ["cmp-user",      (e) => anySeg(e, (x) => x === ".cds-root [data-cds=UserMessage]")],
  ["cmp-user-and-bubble", (e) => anySeg(e, (x) => x === ".cds-root [data-cds=UserMessage]") &&
                                     anySeg(e, (x) => x === ".cds-root [data-cds=AssistantMessage][data-variant=bubble]")],
  ["cmp-assistant-bubble", (e) => anySeg(e, (x) => x === ".cds-root [data-cds=AssistantMessage][data-variant=bubble]")],
  ["cmp-prose",     (e) => anySeg(e, (x) => x === ".prose")],
];

for (const e of entries) {
  for (const [key, test] of LAYER_RULES) if (test(e)) { put(key, e); break; }
}

const out = { meta: { source: "Claude 3.6556.2.0 ion-dist/assets/v1/c6a992d55-Che1orl5.css", total: entries.length } };
for (const [k, v] of layers) out[k] = v;
out.meta.layers = Object.fromEntries([...layers].map(([k, v]) => [k, Object.keys(v).length]));

writeFileSync(R(".tmp/rev/tokens.json"), JSON.stringify(out, null, 2));

// ── 人读表：七档字号 × 每一层，全部解析成 px ──
const REM = 16;
/**
 * 把 rem-scale 与 var() 链解开，折算 px。
 *
 * ⚠️ 关键：`var(--cds-rem-scale)` 展开成 `calc(16 / 17)` 之后，
 * 表达式变成 `calc(.6875rem * calc(16 / 17))` —— **嵌套 calc 不是合法 CSS**
 * （浏览器里是不合法的，只是这里的 var 生效后不会真的嵌套），
 * 而我的正则也匹配不了。所以这里**把 scale 单独当数值传进来**，
 * 在算 rem 的时候一次性乘掉。
 */
function toPx(expr, table, scale, depth = 0) {
  if (depth > 12 || expr == null) return null;
  let s = String(expr).trim();

  // ⚠️ 先把 rem-scale 换成裸数值，否则展开后会出现嵌套 calc，
  // 那是非法 CSS，我的正则也匹配不了。
  s = s.replace(/var\(\s*--cds-rem-scale\s*(?:,\s*[^()]*(?:\([^()]*\)[^()]*)*)?\)/g, String(scale));

  // var(--x) / var(--x, fallback)
  s = s.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (_, n, fb) => {
    const v = table[n];
    return v !== undefined && v !== "" ? v : (fb ?? "");
  });
  if (/var\(\s*--(?!cds-rem-scale)/.test(s)) return toPx(s, table, scale, depth + 1);

  // calc(A rem * N) —— N 里已经是展开好的 scale 数值，**不能再乘一次**
  let mul = s.match(/^calc\(\s*([\d.]+)rem\s*\*\s*([\d.\s/*]+)\)$/);
  if (mul) {
    const f = evalSafe(mul[2]);
    return f == null ? null : Number(mul[1]) * REM * f;
  }
  // calc(A * N) —— 纯数字（如 `calc(16 / 17)`）
  mul = s.match(/^calc\(\s*([\d.]+)\s*([*/]\s*[\d.]+)\s*\)$/);
  if (mul) {
    const f = evalSafe(mul[1] + mul[2]);
    return f == null ? null : f;
  }

  // ⚠️ **裸 rem 不乘 scale** —— 这正是 `--cds-font-size-prose: .875rem`
  // 与 `calc(.875rem * var(--cds-rem-scale))` 的区别：
  //   裸 .875rem            = 0.875 × 16           = 14.00px
  //   calc(.875rem * 16/17) = 0.875 × 16 × 0.9412  = 13.18px
  // 上一版把两者当成同一个，于是 prose 报成 13.18 —— 差 6%。
  const bare = s.match(/^(-?[\d.]+)rem$/);
  if (bare) return Number(bare[1]) * REM;

  const px = s.match(/^(-?[\d.]+)px$/);
  if (px) return Number(px[1]);

  const num = s.match(/^-?[\d.]+$/);
  if (num) return Number(s);

  return null;
}
function evalSafe(s) {
  if (!/^[\d./\s*]+$/.test(s)) return null;
  try { return Function(`"use strict";return (${s})`)(); } catch { return null; }
}

/**
 * ⚠️ 上一版这里漏了 `calc(16 / 17)` 这种**没有单位也没有 `*`** 的形状，
 * `--cds-rem-scale` 于是解成 null，回落到 1 —— 后面所有 px 都变成
 * 「rem × 16」而不是「rem × 16 × 16/17」，**每一格都偏大约 6%**，
 * 而输出看上去完全正常。所以现在**原始值和计算值一起打**，肉眼能对。
 */
function resolveScale(t) {
  const raw = t["--cds-rem-scale"] ?? "1";
  if (/^calc\(\s*[\d.]+\s*\/\s*[\d.]+\s*\)$/.test(raw.trim())) {
    const m = raw.match(/calc\(\s*([\d.]+)\s*\/\s*([\d.]+)\s*\)/);
    return Number(m[1]) / Number(m[2]);
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 1;
}

/** 合并多层，得到某一具体组合下的有效表。 */
function effective(...keys) {
  const t = {};
  for (const k of keys) Object.assign(t, layers.get(k) ?? {});
  return t;
}

const TIERS = [
  ["caption",   "--cds-font-size-caption",  "--cds-leading-caption"],
  ["footnote",  "--cds-font-size-footnote", "--cds-leading-footnote"],
  ["code",      "--cds-font-size-code",     "--cds-leading-code"],
  ["body",      "--cds-font-size-body",     "--cds-leading-body"],
  ["prose",     "--cds-font-size-prose",    "--cds-leading-prose"],
  ["heading",   "--cds-font-size-heading",  "--cds-leading-heading"],
  ["title",     "--cds-font-size-title",    "--cds-leading-title"],
];

function table(name, ...keys) {
  // ⚠️ 必须把 `root` 并进来 —— `--cds-rem-scale` 只定义在 `:root` 上，
  // 不并的话每一层都解不出 scale，全部回落到 1，px 值整体偏大。
  const t = effective("root", ...keys);
  const scale = resolveScale(t);
  const row = (label, fsName, lhName) => {
    const fs = toPx(t[fsName], t, scale);
    const lh = toPx(t[lhName], t, scale);
    const rawFs = String(t[fsName] ?? "");
    return `${label.padEnd(10)} ${fs == null ? "?" : fs.toFixed(3).padStart(8)}px  lh ${lh == null ? "?" : lh.toFixed(3).padStart(8)}px   [${rawFs.slice(0, 46)}]`;
  };
  console.log(`\n=== ${name} ===   (rem-scale = ${scale.toFixed(6)})`);
  for (const [label, fs, lh] of TIERS) console.log("  " + row(label, fs, lh));
}

console.log("Claude 3.6556.2.0 —— 七档字阶（每一层都列，别把某层当成唯一值）");
table("默认 .cds-root", "base");
table("comfortable 密度", "base", "comfortable");
for (const n of [1, 2, 3, 4, 5]) table(`文本大小 step=${n}`, "base", `step${n}`);

// 非字号类的几何 token
const GEOM = [
  "--cds-radius", "--cds-radius-composer", "--cds-radius--sm", "--cds-radius--xs",
  "--cds-panel-radius", "--cds-panel-gap", "--cds-panel-inset",
  "--cds-pad-xs", "--cds-pad-sm", "--cds-pad-md", "--cds-pad-lg", "--cds-pad-xl",
  "--cds-gap-xs", "--cds-gap-sm", "--cds-gap-md", "--cds-gap-lg", "--cds-gap-xl",
  "--cds-h-control", "--cds-h-control--sm", "--cds-h-control--xs",
  "--cds-h-control-nested",
  "--cds-message-bubble-item-gap", "--cds-message-bubble-stack-gap",
  "--cds-message-bubble-measure", "--cds-message-bubble-pad-x",
  "--cds-message-bubble-pad-y", "--cds-message-bubble-radius",
  "--cds-assistant-message-text-inset", "--cds-assistant-message-text-stop",
  "--cds-font-size-text-entry-floor",
];
const baseT = effective("root", "base", "cmp-assistant");
const baseScale = resolveScale(baseT);
console.log("\n=== 几何 token（默认层 + 组件层）===");
for (const n of GEOM) {
  const raw = baseT[n];
  const px = toPx(raw, baseT, baseScale);
  console.log(`  ${n.padEnd(38)} → ${px == null ? "?" : px.toFixed(2).padStart(8) + "px"}   [${String(raw).slice(0, 62)}]`);
}

// 组件层单独打一遍 —— 这些值只在这几个选择器上成立
console.log("\n=== 组件层变量（各自的选择器上，不继承到别处）===");
for (const key of ["cmp-assistant", "cmp-user", "cmp-user-and-bubble", "cmp-assistant-bubble", "cmp-prose"]) {
  const layer = layers.get(key);
  if (!layer) { console.log(`\n  [${key}] 空`); continue; }
  console.log(`\n  [${key}]  ${Object.keys(layer).length} 个`);
  for (const [n, raw] of Object.entries(layer).sort(([a], [b]) => a.localeCompare(b))) {
    const px = toPx(raw, baseT, baseScale);
    const suffix = px == null ? "" : `   = ${px.toFixed(2)}px`;
    console.log(`    ${n.padEnd(40)} ${String(raw).slice(0, 52).padEnd(54)}${suffix}`);
  }
}
console.log("\n全表：.tmp/rev/tokens.json");
