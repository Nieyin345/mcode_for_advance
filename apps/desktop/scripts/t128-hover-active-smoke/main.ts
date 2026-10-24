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

/**
 * 把 `var(--x)` 解到字面量。
 *
 * ⚠️ 必须能解**跨文件**的别名：`--selected-bg: var(--m-gray-80)` 在 tokens 里，
 * 但 `--selected-bg: var(--surface-hover)`（某些主题/变异下）指向 styles.css 自己的
 * token。只在 tokens 里查会让解析器抛错 —— **而抛错不是「断言红」，是套件崩了**，
 * 那属于「改坏了程序，不是改坏了被验的东西」（变异失效第 3 种形态）。
 *
 * 所以：先在 tokens.cds.css 找，找不到再到 styles.css 本体的 `:root` 块里找。
 * 深度上限防环。
 */
function resolveVar(value: string, depth = 0): string {
  if (depth > 8) throw new Error(`变量解析层数过深（可能循环）: ${value}`);
  const m = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  if (!m) return value;
  const name = m[1]!;
  const re = new RegExp(`--${name}:\\s*([^;]+);`);
  const hit = re.exec(tokensCss) ?? re.exec(css);
  if (!hit) throw new Error(`两个文件里都找不到 --${name}`);
  return resolveVar(hit[1]!.trim(), depth + 1);
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
  //
  // ⚠️ **口径变化（2026-10-24 第二批）**：`/60` 转实色会把裸计数**推高**
  // （14 处 /60 → 实色），而净效果是又少了 14 处 alpha 变体。所以这里同时钉
  // 两条：裸实色有上限，**alpha 变体必须为 0**（那才是真正要收干净的东西）。
  let alphaVariants = 0;
  for (const name of ["StreamSidebar", "LeftBar", "LeftBarParts", "Titlebar"]) {
    const t = readFileSync(root(`src/renderer/components/layout/${name}.tsx`), "utf8");
    alphaVariants += (t.match(/hover:bg-surface-hover\/\d+/g) ?? []).length;
  }
  check("★ 这四个文件里不再有 hover:bg-surface-hover/NN alpha 变体（本批收干净了）",
    alphaVariants === 0, { alphaVariants });
  check("★ 裸 hover:bg-surface-hover（不含 /alpha）不多于 130", raw <= 130, { raw });
  check("★ 至少有一处用上了 cds-hover-ghost", migrated > 0, { migrated });
}

console.log("\n[7] 选中态是换色系，不是更深的灰（上游 DraggableSessionList 的四态）");
{
  const surface = readTriplet(":root {", "surface");
  const hover = readTriplet(":root {", "surface-hover");
  const selectedBg = readTriplet(":root {", "selected-bg");
  const accentStrong = readTriplet(":root {", "accent-strong");

  const selectedContent = readTriplet(":root {", "selected-content");

  console.log(
    `      selected-bg=${hexOf(selectedBg)} on surface=${contrast(selectedBg, surface).toFixed(3)}:1\n` +
    `      selected-content=${hexOf(selectedContent)} on selected-bg=${contrast(selectedContent, selectedBg).toFixed(2)}:1`,
  );

  check("★ 选中底色与悬停底色不同（同色 = 选中和悬停分不开）",
    hexOf(selectedBg) !== hexOf(hover), { selectedBg: hexOf(selectedBg), hover: hexOf(hover) });
  check("★ 选中底色比悬停更深（选中是「更确定」的状态，不该更浅）",
    luminance(selectedBg) < luminance(hover), { L: { hover: +luminance(hover).toFixed(4), sel: +luminance(selectedBg).toFixed(4) } });
  check("★ 选中文字对选中底 ≥4.5:1（AA 小字；会话标题就是小字）",
    contrast(selectedContent, selectedBg) >= 4.5,
    { ratio: +contrast(selectedContent, selectedBg).toFixed(2) });
  check("★ 选中文字是**彩色**不是中性灰（R-B 差值必须拉开 —— 防止「用对了 token 名但值换回灰」）",
    Math.abs(selectedContent[0] - selectedContent[2]) >= 40,
    { r: selectedContent[0], b: selectedContent[2], diff: selectedContent[0] - selectedContent[2] });

  // 暗色
  const dSurface = readTriplet(".dark {", "surface");
  const dHover = readTriplet(".dark {", "surface-hover");
  const dSelectedBg = readTriplet(".dark {", "selected-bg");
  const dAccent = readTriplet(".dark {", "selected-content");
  console.log(
    `      dark selected-bg=${hexOf(dSelectedBg)} on surface=${contrast(dSelectedBg, dSurface).toFixed(3)}:1\n` +
    `      dark selected-content=${hexOf(dAccent)} on selected-bg=${contrast(dAccent, dSelectedBg).toFixed(2)}:1`,
  );
  check("★ 暗色选中底色与悬停不同", hexOf(dSelectedBg) !== hexOf(dHover));
  check("★ 暗色选中文字对选中底 ≥4.5:1", contrast(dAccent, dSelectedBg) >= 4.5,
    { ratio: +contrast(dAccent, dSelectedBg).toFixed(2) });
  check("★ 暗色选中文字是彩色", Math.abs(dAccent[0] - dAccent[2]) >= 40,
    { r: dAccent[0], b: dAccent[2] });

  // 选中 + 悬停 **不变色** —— 上游明确如此。检查的方式：选中分支里
  // 不得出现 hover: 修饰的底色类。
  const stream = readFileSync(root("src/renderer/components/layout/StreamSidebar.tsx"), "utf8");
  const selBranch = /active\s*\n?\s*\?\s*"([^"]*)"\s*\n?\s*:\s*"([^"]*)"/.exec(stream);
  check("★ 选中分支里没有 hover: 底色修饰（选中+悬停不该再变）",
    selBranch !== null && !/hover:bg-/.test(selBranch[1]!),
    { selectedBranch: selBranch?.[1] });
  check("★ 选中分支带 font-medium（三件套之一，缺它只剩底色）",
    selBranch !== null && /font-medium/.test(selBranch[1]!));
  check("★ 选中分支用 bg-selected", selBranch !== null && /bg-selected\b/.test(selBranch[1]!));
  check("★ 选中分支用 text-selectedContent", selBranch !== null && /text-selectedContent/.test(selBranch[1]!));
}

console.log("\n[8] .cds-hover-ghost 只能挂在「按钮本体」上，不能挂在行容器上");
{
  // 那个类自带 `:active { transform: scale(0.98) }` —— 那是「按下某个按钮」的
  // 手感。挂到列表行/整行可点容器上会让**整行缩放**，是错误用法。
  //
  // ⚠️ 这个判据是变异逼出来的：把类加到 `BrowserToolbar` 的 `ClickableRow` 上，
  // 整套 36 条断言**全绿** —— 因为没有任何一条看「谁承载了这个类」。
  // 宽松的正则只能抓「类名出现在行容器标签上」这个形状，抓不到语义，但
  // 它把最常见的错误用法（整行可点 + 类）挡住了。
  const rowContainers = [
    { file: "browser/BrowserToolbar.tsx", tag: /<ClickableRow[^>]*cds-hover-ghost/s, label: "ClickableRow" },
    { file: "ide/GitRepoCardParts.tsx", tag: /<ContextMenu\.Trigger[^>]*cds-hover-ghost/s, label: "ContextMenu.Trigger" },
  ];
  for (const { file, tag, label } of rowContainers) {
    let src: string;
    try { src = readFileSync(root(`src/renderer/components/${file}`), "utf8"); }
    catch { continue; }
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    check(`★ ${label} 上没有挂 .cds-hover-ghost（整行缩放是错误用法）`,
      !tag.test(stripped), { file });
  }

  // 正向：类确实挂在了若干 <button> 上 —— 否则上面的「没有」可以靠「谁都没用」通过。
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (e.name.endsWith(".tsx")) out.push(p);
    }
    return out;
  };
  let onButton = 0;
  for (const f of walk(root("src/renderer/components"))) {
    const t = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // 元素开始标签里同时出现 <button 与 cds-hover-ghost
    onButton += (t.match(/<button\b[^>]*cds-hover-ghost/sg) ?? []).length;
  }
  check("★ 至少有一处 .cds-hover-ghost 挂在 <button> 本体上（正控：否则上一条可被「谁都没用」通过）",
    onButton > 0, { onButton });

  // ⚠️ 类不能落在**选中态分支**上 —— 那是 T128 第三批里我自己差点做错的：
  // 三元写成 `active ? "cds-hover-ghost bg-surface-hover …" : "…"`，把类加到了
  // 「已选中」那一支。选中行套上 `:active { scale(0.98) }` 会在按下时缩放整行，
  // 而它常驻选中、不是按钮。类只该在**未选中**那一支（描述悬停）。
  let onSelectedBranch = 0;
  for (const f of walk(root("src/renderer/components"))) {
    const t = readFileSync(f, "utf8");
    // 选中态分支的底色不一定叫 bg-surface-hover —— 也有 bg-accent/20、
    // bg-surface-muted 这类。所以匹配「`? "cds-hover-ghost` 后面跟着任何 bg-」。
    onSelectedBranch += (t.match(/\?\s*"cds-hover-ghost[^"]*\bbg-[a-z]/sg) ?? []).length;
  }
  check("★ .cds-hover-ghost 不在选中态分支上（`? \"…\"` 那一支带 bg-surface-hover）",
    onSelectedBranch === 0, { onSelectedBranch });
}

console.log("");
console.log(`t128-hover-active-smoke:${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);
