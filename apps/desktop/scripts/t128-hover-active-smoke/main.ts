/**
 * 【T128】hover / active 分档回归。
 *
 * ## 这张套件守的是什么
 *
 * 原本 `--surface-hover` 同时承担 hover 和 active 两个语义（旧注释原文：
 * 「hover/active fills」），于是**按下按钮和悬停一模一样** —— 全仓 308 处
 * `hover:bg-surface-hover` 对 6 处 `active:scale-*`。
 *
 * 所以这套断言必须同时钉住**关系**（不是值）：
 *
 *   1. `--surface-active` 与 `--surface-hover` **不同值** —— 否则缺陷照旧；
 *   2. `--surface-active` 对画布**足够可辨** —— 否则按下看不见；
 *   3. 三级阶梯单调：surface → hover → active 逐级加深（亮色）／变亮（暗色）；
 *   4. 亮暗两套都有，且各自满足上面三条。
 *
 * ## 为什么不能只断言值
 *
 * 「`--surface-active` 等于 `#e1e0d9`」这条断言只会证明有人改了那个数，
 * 不证明改对了。变异测试里把 active 改成和 hover 同值，值断言全绿而关系断言红。
 */
import { readdirSync, readFileSync } from "node:fs";
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
const hexOf = (rgb: readonly [number, number, number]): string =>
  "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");

const root = (p: string): string => resolve(process.cwd(), p);
const css = readFileSync(root("src/renderer/styles.css"), "utf8");
const tokensCss = readFileSync(root("src/renderer/tokens.cds.css"), "utf8");

/** 从 `open` 位置找到该 CSS 块的闭合 `}`（花括号配平，跳过注释）。 */
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

function findInBlock(block: string, name: string): string | null {
  const re = new RegExp(`--${name}:\\s*([^;]+);`);
  const m = re.exec(block);
  return m ? m[1]!.trim() : null;
}

function resolveVar(value: string): string {
  const m = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  if (!m) return value;
  const re = new RegExp(`--${m[1]}:\\s*([^;]+);`);
  const hit = re.exec(tokensCss);
  if (!hit) throw new Error(`tokens.cds.css 里找不到 --${m[1]}`);
  return resolveVar(hit[1]!.trim());
}

function parseTriplet(raw: string): [number, number, number] {
  const v = resolveVar(raw);
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
 * 取**第一个**匹配块里的 token。
 *
 * ⚠️ 必须按块边界解析：styles.css 有多个 `:root` / `.dark` / `html.sketch`，
 * 从块起点贪心往后搜会越过块尾读到 sketch 的值（T121 踩过这个坑，算出的
 * 对比度和真值差了一档）。主 token 块是第一个，所以取首次出现是对的。
 */
function readTriplet(selector: string, name: string): [number, number, number] {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`找不到主题块 ${selector}`);
  const open = css.indexOf("{", start);
  const block = css.slice(open, blockEnd(css, open) + 1);
  const raw = findInBlock(block, name);
  if (raw === null) throw new Error(`块 ${selector} 内没有 --${name}`);
  return parseTriplet(raw);
}

/* ══════════════════════════════════════════════════════════════════ */

console.log("[1] 亮色：三级阶梯存在且单调");
{
  const surface = readTriplet(":root {", "surface");
  const hover = readTriplet(":root {", "surface-hover");
  const active = readTriplet(":root {", "surface-active");

  const onSurface = contrast(active, surface);
  const vsHover = contrast(active, hover);
  console.log(
    `      surface=${hexOf(surface)}  hover=${hexOf(hover)}  active=${hexOf(active)}\n` +
    `      active vs surface=${onSurface.toFixed(3)}:1   active vs hover=${vsHover.toFixed(3)}:1`,
  );

  check("★ active 不等于 hover（这正是本卡修的缺陷）",
    hexOf(active) !== hexOf(hover), { active: hexOf(active), hover: hexOf(hover) });
  check("★ active 对画布足够可辨（≥1.20:1，低于此按下看不出来）",
    onSurface >= 1.2, { ratio: Number(onSurface.toFixed(3)) });
  check("★ active 与 hover 区分得开（≥1.10:1，低于此按下与悬停难分）",
    vsHover >= 1.1, { ratio: Number(vsHover.toFixed(3)) });
  check("亮色阶梯单调加深：surface → hover → active（亮度递减）",
    luminance(active) < luminance(hover) && luminance(hover) < luminance(surface),
    { L: { surface: +luminance(surface).toFixed(4), hover: +luminance(hover).toFixed(4), active: +luminance(active).toFixed(4) } });
}

console.log("\n[2] 暗色：同样三条");
{
  const surface = readTriplet(".dark {", "surface");
  const hover = readTriplet(".dark {", "surface-hover");
  const active = readTriplet(".dark {", "surface-active");

  const onSurface = contrast(active, surface);
  const vsHover = contrast(active, hover);
  console.log(
    `      surface=${hexOf(surface)}  hover=${hexOf(hover)}  active=${hexOf(active)}\n` +
    `      active vs surface=${onSurface.toFixed(3)}:1   active vs hover=${vsHover.toFixed(3)}:1`,
  );

  check("★ 暗色 active 不等于 hover",
    hexOf(active) !== hexOf(hover), { active: hexOf(active), hover: hexOf(hover) });
  check("★ 暗色 active 对画布足够可辨（≥1.20:1）",
    onSurface >= 1.2, { ratio: Number(onSurface.toFixed(3)) });
  check("★ 暗色 active 与 hover 区分得开（≥1.10:1）",
    vsHover >= 1.1, { ratio: Number(vsHover.toFixed(3)) });
  check("暗色阶梯单调变亮：surface → hover → active（亮度递增 —— 深底方向相反）",
    luminance(active) > luminance(hover) && luminance(hover) > luminance(surface),
    { L: { surface: +luminance(surface).toFixed(4), hover: +luminance(hover).toFixed(4), active: +luminance(active).toFixed(4) } });
}

console.log("\n[3] 两个可复用类真的存在，且 :active 与 :hover 不同背景");
{
  // 断言读的是**选择器与声明**，不是整段文本的 includes ——
  // `.includes()` 会把注释掉的规则也算命中（T119 那 94 处的教训）。
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

  const hasGhost = /\.cds-hover-ghost\s*\{/.test(stripped);
  const hasCard = /\.cds-card-interactive\s*\{/.test(stripped);
  check("★ .cds-hover-ghost 存在（去掉注释后仍能匹配）", hasGhost);
  check("★ .cds-card-interactive 存在", hasCard);

  // ⚠️ 去掉 `@media (prefers-reduced-motion)` 块再匹配。
  // 那里有一条 `.cds-hover-ghost:not(:disabled):active { transform: none; }` ——
  // 它只取消位移、**不设背景**。若不在匹配前剔除它，删掉真正的 :active 规则后
  // 这条断言仍会绿（被兜底命中），而缺陷已经存在。变异 2 实测到过这个假阳性。
  const withoutMedia = stripped.replace(/@media[^{]*\{[\s\S]*?\n\}/g, "");
  const hoverRule = /\.cds-hover-ghost:not\(:disabled\):hover\s*\{([^}]*)\}/.exec(withoutMedia);
  const activeRule = /\.cds-hover-ghost:not\(:disabled\):active\s*\{([^}]*)\}/.exec(withoutMedia);

  check("★ .cds-hover-ghost 定义了 :hover 规则", hoverRule !== null);
  check("★ .cds-hover-ghost 定义了 :active 规则", activeRule !== null);

  if (hoverRule && activeRule) {
    const hoverBg = /background-color:\s*rgb\(var\(--([a-z-]+)\)\)/.exec(hoverRule[1]!)?.[1] ?? null;
    const activeBg = /background-color:\s*rgb\(var\(--([a-z-]+)\)\)/.exec(activeRule[1]!)?.[1] ?? null;
    check("★ :hover 与 :active 消费**不同**的 token（同 token 等于没拆）",
      hoverBg !== null && activeBg !== null && hoverBg !== activeBg,
      { hoverBg, activeBg });
    check("  :hover 用 surface-hover", hoverBg === "surface-hover", { hoverBg });
    check("  :active 用 surface-active", activeBg === "surface-active", { activeBg });
  }

  const cardActive = /\.cds-card-interactive:active\s*\{([^}]*)\}/.exec(stripped);
  check("  .cds-card-interactive:active 把位移归零（否则悬停抬起后就卡住不落回）",
    cardActive !== null && /translateY\(0\)/.test(cardActive[1]!),
    cardActive?.[1]?.trim());
}

console.log("\n[4] 示范组件真的接上了，且旧写法已移除");
{
  const button = readFileSync(root("src/renderer/components/ui/button.tsx"), "utf8");
  const strippedButton = button.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  check("★ button.tsx 的 secondary 变体用 .cds-hover-ghost",
    /secondary:[\s\S]{0,200}?cds-hover-ghost/.test(strippedButton));
  check("★ button.tsx 的 ghost 变体用 .cds-hover-ghost",
    /ghost:[\s\S]{0,200}?cds-hover-ghost/.test(strippedButton));
  check("★ button.tsx 不再有裸 hover:bg-surface-hover（那是本卡要收掉的那类写法）",
    !/hover:bg-surface-hover/.test(strippedButton),
    { found: (strippedButton.match(/hover:bg-surface-hover/g) ?? []).length });
  check("  primary 变体仍有 transition-colors（它不走 cds-hover-ghost，别把它弄成无过渡）",
    /primary:[\s\S]{0,200}?transition-colors/.test(strippedButton));
}

console.log("\n[5] tailwind 暴露了 surface.active（否则 bg-surface-active / 类名不可用）");
{
  const tw = readFileSync(root("tailwind.config.js"), "utf8");
  check("★ tailwind.config.js 有 surface.active 映射",
    /active:\s*"rgb\(var\(--surface-active\)/.test(tw));
  check("  surface.hover 映射仍在（别误删）",
    /hover:\s*"rgb\(var\(--surface-hover\)/.test(tw));
}

console.log("\n[6] 迁移进度：裸 hover:bg-surface-hover 的总数只能降（T129 起分批收）");
{
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (e.name.endsWith(".tsx")) out.push(p);
    }
    return out;
  };
  const files = walk(root("src/renderer"));
  let raw = 0;
  let migrated = 0;
  for (const f of files) {
    const t = readFileSync(f, "utf8");
    raw += (t.match(/hover:bg-surface-hover\b(?!\/)/g) ?? []).length;
    migrated += (t.match(/cds-hover-ghost/g) ?? []).length;
  }
  console.log(`      裸 hover:bg-surface-hover = ${raw} 处；cds-hover-ghost = ${migrated} 处`);
  // 上界随迁移推进而下调。写死一个当前值是为了让「有人把类撤了」立刻红，
  // 而不是悄悄回退。**每次迁移一批就把它改小**，别让它永远宽松。
  // 基线口径：**不含 `/60` 这类 alpha 变体**（它们是另一类，迁移会改变观感）。
  // 2026-10-24 第一批迁移后实测 216。
  check("★ 裸 hover:bg-surface-hover（不含 /alpha）不多于 216", raw <= 216, { raw });
  check("★ 至少有一处用上了 cds-hover-ghost", migrated > 0, { migrated });
}

console.log("");
console.log(`t128-hover-active-smoke:${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);
