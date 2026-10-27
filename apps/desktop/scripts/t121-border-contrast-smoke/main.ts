/**
 * 【T121】边框层级对比度回归。
 *
 * ## 为什么这条断言长成这样
 *
 * 「`--edge` 等于 `#d9d9d8`」这种断言**没有价值** —— 它只证明有人改了那个数，
 * 不证明改对了。真正会坏掉的是**关系**：
 *
 *   1. 边框在画布上要够可见（否则结构散了）；
 *   2. 边框坐在 `--surface-hover` 填充上时不能与填充同重（否则边框消失）；
 *   3. 族内必须保持 panel < edge < input < selected 的顺序。
 *
 * 第 2 条是这次差点踩空的那条：规范的 10% 合成（`#e3e3e2`）对画布 1.25:1，
 * 看着没问题，但它对 `--surface-hover` 也是 1.12:1 —— 和填充本身对画布的
 * 对比度**完全相等**，边框落在悬停行上就没了。只看第一条会放它过去。
 *
 * ## 变异性
 *
 * 把 `--edge` 改回 `#c3c2b7`（旧值）→ 第 1 条仍绿、第 2 条仍绿，
 * 但「比现状淡」那条会红。把 `--edge` 改成 `#e3e3e2` → 第 2 条红。
 * 两条分别守不同的东西，缺一条就有一个方向是盲的。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}

/* ── WCAG 相对亮度与对比度 ── */
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance(rgb: readonly [number, number, number]): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}
function contrast(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const css = readFileSync(resolve(process.cwd(), "src/renderer/styles.css"), "utf8");

/**
 * 取某个 token 在指定主题块里的值。
 *
 * ⚠️ **必须按块边界解析，不能「从块起点往后搜第一个」**。
 * 这个文件里有 `:root` / `.dark` / `html.sketch` / `.dark html.sketch` 多个块，
 * 而从 `:root {` 往后贪心搜会越过块尾、读到 sketch 主题的值 —— 我第一次就是
 * 这么写的，结果 `--edge` 对 hover 填充算出了 1.16（用了 sketch 的 hover 填充），
 * 而真值是 1.23。**一个读错值的解析器，会把正确的样式判成错的。**
 *
 * 另外：`--edge` 是三元组，但 `--selected-edge` 是 `var(--m-gray-300)` 别名 ——
 * 别名要先在 `tokens.cds.css` 里解开。只认三元组会让别名直接抛错。
 */
const TOKENS_CSS = readFileSync(resolve(process.cwd(), "src/renderer/tokens.cds.css"), "utf8");

/** 从 `open` 位置找到该 CSS 块的闭合 `}`（做花括号配平，跳过注释与字符串）。 */
function blockEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 1;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** 在**单个块内**找 token，找不到返回 null（不越界到下一个块）。 */
function findInBlock(block: string, name: string): string | null {
  const re = new RegExp(`--${name}:\\s*([^;]+);`);
  const m = re.exec(block);
  return m ? m[1]!.trim() : null;
}

/**
 * 把 `var(--m-x)` 解到 tokens.cds.css 里的字面量。
 *
 * 【UI 重建 2026-10-27】**必须按主题解**。`--m-surface-1` 在
 * `tokens.cds.css` 里定义两次：`:root` 是 `var(--m-gray-10)`（亮），
 * `.dark` 是 `var(--m-gray-850)`（暗）。原来无条件取第一处，于是
 * 暗色断言拿到的是**亮色画布** —— `--edge=#3f3f3f` 对白色算出了
 * 10.26:1（真实是 1.73:1），四条对比度断言结论全不可信。
 *
 * 现在从 `.dark` 块读出来的 token 优先在 `.dark` 段里解别名，
 * 其余按 `:root` 解。这与浏览器的层叠顺序一致：`.dark` 覆盖 `:root`。
 */
const DARK_AT = TOKENS_CSS.indexOf(".dark {");
const DARK_PART = DARK_AT >= 0 ? TOKENS_CSS.slice(DARK_AT) : "";

function resolveVar(value: string, preferDark = false, depth = 0): string {
  if (depth > 6) return value;
  const m = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  if (!m) return value;
  const re = new RegExp(`--${m[1]}:\\s*([^;]+);`);
  const hit = (preferDark ? re.exec(DARK_PART) : null) ?? re.exec(TOKENS_CSS);
  if (!hit) throw new Error(`tokens.cds.css 里找不到 --${m[1]}`);
  return resolveVar(hit[1]!.trim(), preferDark, depth + 1);
}

function parseTriplet(raw: string, preferDark = false): [number, number, number] {
  const v = resolveVar(raw, preferDark);
  const triple = /^([0-9]+)\s+([0-9]+)\s+([0-9]+)$/.exec(v);
  if (triple) return [Number(triple[1]), Number(triple[2]), Number(triple[3])];
  const hex = /^#([0-9a-fA-F]{6})$/.exec(v);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  throw new Error(`无法解析成颜色的值: ${raw} → ${v}`);
}

/**
 * 取**第一个**匹配块里的 token 三元组。
 *
 * 这个文件有多个 `:root`（92/559/577/967/986/1887/2325 行）与多个 `.dark`
 * （286/701 行）。主 token 块是第一个 —— 后面的都是局部补充。所以取首次出现
 * 是对的，但**块尾必须配对**，否则会读到下一个块的值。
 */
function readTriplet(selector: string, name: string): [number, number, number] {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`找不到主题块 ${selector}`);
  const open = css.indexOf("{", start);
  const block = css.slice(open, blockEnd(css, open) + 1);
  const raw = findInBlock(block, name);
  if (raw === null) throw new Error(`块 ${selector} 内没有 --${name}`);
  return parseTriplet(raw, selector.includes(".dark"));
}

console.log("[1] 亮色：边框在画布上的可见度");
{
  const surface = readTriplet(":root {", "surface");
  const hover = readTriplet(":root {", "surface-hover");
  const edge = readTriplet(":root {", "edge");
  check("★ 前置：取到的是三元组而不是别名（别名会让数学失效）",
    Array.isArray(edge) && edge.length === 3, edge);

  const onSurface = contrast(edge, surface);
  const onHover = contrast(edge, hover);
  console.log(`      --edge=${hexOf(edge)}  on surface=${onSurface.toFixed(2)}:1  on hover=${onHover.toFixed(2)}:1`);

  // 1a. 够可见：低于 1.20 就基本看不出了
  check("★ --edge 在 --surface 上对比度 ≥ 1.20:1（结构仍可辨）", onSurface >= 1.20, { onSurface });
  // 1b. 不能过重：超过 1.60 就是「画了条重线」
  check("★ --edge 在 --surface 上对比度 < 1.60:1（不回到实色重线）", onSurface < 1.60, { onSurface });
  // 1c. 关键：坐在 hover 填充上时不能与填充同重
  check("★ --edge 在 --surface-hover 上对比度 ≥ 1.20:1（悬停行上边框不消失）", onHover >= 1.20, { onHover });
}

console.log("[2] 亮色：族内顺序 panel < edge < input < selected");
{
  const surface = readTriplet(":root {", "surface");
  const order = ["panel-edge", "edge", "input-edge", "selected-edge"].map((n) => ({
    name: n,
    ratio: contrast(readTriplet(":root {", n), surface),
  }));
  for (const o of order) console.log(`      --${o.name}: ${o.ratio.toFixed(2)}:1`);
  const ascending = order.every((o, i) => i === 0 || o.ratio > order[i - 1]!.ratio);
  check("★ 四个边框 token 对画布的对比度严格递增", ascending, order);
}

console.log("[3] 暗色：边界不能等于填充");
{
  const surface = readTriplet(".dark {", "surface");
  const hover = readTriplet(".dark {", "surface-hover");
  const edge = readTriplet(".dark {", "edge");
  console.log(`      --edge=${hexOf(edge)}  on surface=${contrast(edge, surface).toFixed(2)}:1  on hover=${contrast(edge, hover).toFixed(2)}:1`);

  // 这条守的正是 T116 记录过、T121 修掉的那个具体缺陷：
  // 深色下 --edge 曾与 --surface-hover 是同一个 #2c2c2a，边框在悬停行上完全消失。
  check("★ 暗色 --edge 与 --surface-hover 不是同一个值（边框不能融进填充）",
    hexOf(edge) !== hexOf(hover), { edge: hexOf(edge), hover: hexOf(hover) });
  check("★ 暗色 --edge 在 --surface-hover 上对比度 ≥ 1.20:1", contrast(edge, hover) >= 1.20,
    { onHover: contrast(edge, hover) });
  check("★ 暗色 --edge 在 --surface 上对比度 ≥ 1.40:1（暗色下线条需要更亮才看得见）",
    contrast(edge, surface) >= 1.40, { onSurface: contrast(edge, surface) });
}

console.log("[4] 暗色：族内顺序");
{
  const surface = readTriplet(".dark {", "surface");
  const order = ["panel-edge", "edge", "input-edge"].map((n) => ({
    name: n,
    ratio: contrast(readTriplet(".dark {", n), surface),
  }));
  for (const o of order) console.log(`      --${o.name}: ${o.ratio.toFixed(2)}:1`);
  const ascending = order.every((o, i) => i === 0 || o.ratio > order[i - 1]!.ratio);
  check("★ panel < edge < input 在暗色下也成立", ascending, order);
}

console.log("[5] 用户气泡：底色必须可见，且与设置面板的默认一致");
{
  // 气泡的 CSS 是 rgb(var(--user-bubble) / var(--user-bubble-alpha))。
  // 断言立在对 --surface 的对比度上 —— 「值等于 #f0f4f8」只证明改了个数。
  const surfL = readTriplet(":root {", "surface");
  const surfD = readTriplet(".dark {", "surface");
  const mix = (fg: readonly [number, number, number], a: number, bg: readonly [number, number, number]) =>
    [0, 1, 2].map((i) => Math.round(fg[i]! * a + bg[i]! * (1 - a))) as [number, number, number];

  const lightBubble = mix(readTriplet(":root {", "user-bubble"), readNumber(":root {", "user-bubble-alpha"), surfL);
  const darkBubble = mix(readTriplet(".dark {", "user-bubble"), readNumber(".dark {", "user-bubble-alpha"), surfD);
  const lightRatio = contrast(lightBubble, surfL);
  const darkRatio = contrast(darkBubble, surfD);
  console.log(`      light ${hexOf(lightBubble)} on ${hexOf(surfL)} = ${lightRatio.toFixed(3)}:1`);
  console.log(`      dark  ${hexOf(darkBubble)} on ${hexOf(surfD)} = ${darkRatio.toFixed(3)}:1`);

  // 「气泡没有消失」的下界。CDS 的气泡本来就极淡（亮 ~1.08 / 暗 ~1.17），
  // 所以门槛只能set得很低 —— 但必须有，否则有人把 alpha 调成 0.2 时套件仍绿。
  check("★ 亮色气泡在画布上 ≥1.05:1（气泡不是不可见）", lightRatio >= 1.05, { lightRatio });
  // 暗色门槛比亮色高：实测 1.17 —— 暗底上同样的反差更难察觉。
  check("★ 暗色气泡在画布上 ≥1.10:1", darkRatio >= 1.10, { darkRatio });

  // ⚠️ 只测对比度是不够的：把颜色改回暖橙 #f7d8cb 也能过 1.05（它其实是 1.28）。
  // 这一条守「真的去暖了」，与「淡了多少」是两件事。
  const lightRaw = readTriplet(":root {", "user-bubble");
  check("★ 亮色气泡色相偏冷（B 通道 ≥ R 通道，不是暖橙）",
    lightRaw[2] >= lightRaw[0], { r: lightRaw[0], b: lightRaw[2] });
  // 亮色下 B 还要明显高于 R，否则灰蓝会退化成中性灰（B ≈ R < 8 会放过 #f0f0f0）
  check("★ 亮色气泡的冷色倾向有实质幅度（B - R ≥ 4）",
    lightRaw[2] - lightRaw[0] >= 4, { diff: lightRaw[2] - lightRaw[0] });

  // 回归：暗色旧值 #240e07 @0.55 只有 1.01:1 —— 这条断言就是为它立的。
  check("★ 暗色气泡与画布不同（不是 1.00:1 的贴片）", hexOf(darkBubble) !== hexOf(surfD),
    { bubble: hexOf(darkBubble), surface: hexOf(surfD) });

  // 设置面板的 fallback 必须等于 CSS 默认 —— 否则用户看到「灰色是默认」而实际是别的。
  const panel = readFileSync(resolve(process.cwd(), "src/renderer/components/settings/AppearancePanel.tsx"), "utf8");
  const declared = /const DEFAULT_USER_BUBBLE_HEX = "(#[0-9a-fA-F]{6})"/.exec(panel)?.[1];
  const firstPreset = /triplet:\s*"(\d+ \d+ \d+)",\s*hex:\s*"(#[0-9a-fA-F]{6})"/.exec(panel);
  const cssDefault = hexOf(readTriplet(":root {", "user-bubble"));
  console.log(`      styles.css=${cssDefault}  panel fallback=${declared}  preset[0]=${firstPreset?.[2]}`);
  check("★ 设置面板的默认值 == styles.css 的 --user-bubble", declared?.toLowerCase() === cssDefault);
  check("★ 设置面板预设第一项 == 默认值（不能标着 default 却不是 default）",
    firstPreset?.[2]?.toLowerCase() === cssDefault);
}

function readNumber(selector: string, name: string): number {
  const start = css.indexOf(selector);
  const open = css.indexOf("{", start);
  const block = css.slice(open, blockEnd(css, open) + 1);
  const raw = findInBlock(block, name);
  if (raw === null) throw new Error(`块 ${selector} 内没有 --${name}`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} 不是数字: ${raw}`);
  return n;
}

function hexOf(rgb: readonly [number, number, number]): string {
  return "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
}

console.log(`\nt121-border-contrast-smoke: ${total - failed}/${total} 通过`);
if (failed > 0) process.exit(1);
