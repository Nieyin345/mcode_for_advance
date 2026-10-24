/**
 * 【T121】Surface 0–3 分层回归。
 *
 * ## 这套在守什么
 *
 * 「`--surface-raised` 等于 `#ffffff`」这种断言**没有价值** —— 它只证明有人改了那个数。
 * 真正会坏掉的是**层次关系**：
 *
 *   1. 卡片、弹窗、浮层**不再与主画布共用同一个背景**（否则「平」回来了）；
 *   2. 暗色下阶梯**逐层变亮**（`#151515 → #1a1a19 → #20201e`）；
 *   3. **主画布仍然是 `--surface`**（防止有人顺手把整个应用改成 raised）。
 *
 * 第 3 条是这套的主控断言 —— 它守的是「改动没有越界到不该动的地方」。
 *
 * ## 为什么不用 DOM/渲染断言
 *
 * 这套不 import 任何主进程代码、不起 Electron。它读 `styles.css` 与组件源码文本，
 * 断言的是**哪些类名被用在哪里**。可视化观感（阴影够不够、纵深出没出来）只能靠
 * 真机看 —— 这套不假装能验那个。
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

// `run.sh` 会 `cd apps/desktop` 后再跑 node，所以 cwd 就是包根。
// 不能用 `import.meta.dirname` —— esbuild 把本文件打到临时目录，
// 那个属性指向 `/tmp/mcode-surface-layers.XXXX/`，不是仓库。
const ROOT = process.cwd();
const css = readFileSync(resolve(ROOT, "src/renderer/styles.css"), "utf8");
const tailwind = readFileSync(resolve(ROOT, "tailwind.config.js"), "utf8");
const read = (p: string) => readFileSync(resolve(ROOT, "src/renderer/components/ui", p), "utf8");

/* ── 解析 token：`:root { ... }` 与 `.dark { ... }` 里的 --surface-* ── */
interface Tokens {
  surface: string;
  muted: string;
  hover: string;
  raised: string;
  overlay: string;
}

function parseBlock(selector: string): Tokens | null {
  // 抓从 selector 开始到下一个同层 `}` 为止的块。`styles.css` 里这两个块都是
  // 顶层规则，内层没有嵌套大括号，所以用非贪婪的跨行匹配足够。
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\n\\}`, "m");
  const m = re.exec(css);
  if (!m) return null;
  const body = m[1]!;
  const grab = (name: string): string => {
    // ⚠️ 必须带负向断言：`--surface:` 不加限制会匹配到 `--surface-muted:` 的前缀，
    // 于是 `surface` 拿到的是 mute 的值（或解析成空）。
    const mm = new RegExp(`--${name}:(?![-\\w])\\s*([^;]+);`).exec(body);
    return mm ? mm[1]!.trim() : "";
  };
  return {
    surface: grab("surface"),
    muted: grab("surface-muted"),
    hover: grab("surface-hover"),
    raised: grab("surface-raised"),
    overlay: grab("surface-overlay"),
  };
}

const light = parseBlock(":root");
const dark = parseBlock(".dark");

/* ── 十六进制颜色 → 相对亮度，用来验「暗色逐层变亮」 ──
 *
 * 两种来源都要支持：
 *   1. 直接的 hex（`--surface-raised: #1a1a19`）；
 *   2. `var(--m-gray-850)` 这类别名 —— 要到 `tokens.cds.css` 里解析一次。
 * 暗色的 `--surface` 就是第 2 种，只认 hex 会让它变成 null。
 */
const tokensCss = readFileSync(resolve(ROOT, "src/renderer/tokens.cds.css"), "utf8");

function resolveVar(name: string, depth = 0): string {
  if (depth > 4) return "";
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(tokensCss) ?? new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  if (!m) return "";
  const raw = m[1]!.trim();
  const alias = /^var\(--([\w-]+)\)$/.exec(raw);
  return alias ? resolveVar(alias[1]!, depth + 1) : raw;
}

function parseHex(v: string): [number, number, number] | null {
  if (!v) return null;
  const trimmed = v.trim();
  // `tokens.cds.css` 用的是 "R G B" 三元组（`--m-gray-850: 21 21 21`），
  // 而 `styles.css` 新增的两个 token 用的是 hex。两种都要认。
  const triplet = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/.exec(trimmed);
  if (triplet) return [Number(triplet[1]), Number(triplet[2]), Number(triplet[3])];
  const m = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (m) {
    const n = parseInt(m[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const alias = /^var\(--([\w-]+)\)$/.exec(trimmed);
  if (alias) return parseHex(resolveVar(alias[1]!));
  return null;
}
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance(rgb: [number, number, number]): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

console.log("── §1 token 定义 ──");
check(":root 解析成功", light !== null, { light });
check(".dark 解析成功", dark !== null, { dark });
check(":root 定义了 --surface-raised", !!light?.raised, light?.raised);
check(":root 定义了 --surface-overlay", !!light?.overlay, light?.overlay);
check(".dark 定义了 --surface-raised", !!dark?.raised, dark?.raised);
check(".dark 定义了 --surface-overlay", !!dark?.overlay, dark?.overlay);

/* ── §2 阶梯：暗色逐层变亮；亮色 raised/overlay 比主画布亮 ── */
console.log("\n── §2 明度阶梯 ──");
const lightSurface = parseHex(light?.surface ?? "");
const lightRaised = parseHex(light?.raised ?? "");
const lightOverlay = parseHex(light?.overlay ?? "");
const darkSurface = parseHex(dark?.surface ?? "");
const darkRaised = parseHex(dark?.raised ?? "");
const darkOverlay = parseHex(dark?.overlay ?? "");

check(":root 的 surface / raised / overlay 都是可解析的 hex",
  !!(lightSurface && lightRaised && lightOverlay),
  { lightSurface, lightRaised, lightOverlay });
check(".dark 的 surface / raised / overlay 都是可解析的 hex",
  !!(darkSurface && darkRaised && darkOverlay),
  { darkSurface, darkRaised, darkOverlay });

if (lightSurface && lightRaised && lightOverlay) {
  const ls = luminance(lightSurface), lr = luminance(lightRaised), lo = luminance(lightOverlay);
  check("亮色：raised 不比主画布暗（卡片要浮起，不能下沉）", lr >= ls, { ls, lr });
  check("亮色：overlay 不比 raised 暗（弹窗是最顶层）", lo >= lr, { ls, lr, lo });
  // 规范里亮色 2 和 3 都是纯白，所以 overlay === raised 是**合法的**；
  // 断言用 >= 而不是 >，就是为了不把「规范如此」误判成缺陷。
  check("亮色：raised 确实比主画布亮（不是同一个值）", lr > ls, { ls, lr });
}

if (darkSurface && darkRaised && darkOverlay) {
  const ds = luminance(darkSurface), dr = luminance(darkRaised), dobs = luminance(darkOverlay);
  check("暗色：raised 比主画布亮（逐层变亮的第一档）", dr > ds, { ds, dr });
  check("暗色：overlay 比 raised 更亮（第二档）", dobs > dr, { ds, dr, dobs });
}

/* ── §3 tailwind 配置里有这两个键（否则类名不生成） ── */
console.log("\n── §3 tailwind 配置 ──");
check("tailwind.config.js 有 surface.raised", /raised:\s*"rgb\(var\(--surface-raised\)/.test(tailwind));
check("tailwind.config.js 有 surface.overlay", /overlay:\s*"rgb\(var\(--surface-overlay\)/.test(tailwind));

/* ── §4 接线：哪个组件用哪一层 ── */
console.log("\n── §4 组件接线 ──");
const card = read("card.tsx");
const dialog = read("dialog.tsx");
const select = read("select.tsx");
const tooltip = read("tooltip.tsx");
const infoHint = read("info-hint.tsx");

check("card.tsx 用 bg-surface-raised", card.includes("bg-surface-raised"), { found: card.match(/bg-surface[\w-]*/g) });
check("card.tsx 接上 --shadow-card", card.includes("shadow-[var(--shadow-card)]"), { found: card.match(/shadow-\[[^\]]*\]/g) });
check("dialog.tsx 用 bg-surface-overlay", dialog.includes("bg-surface-overlay"), { found: dialog.match(/bg-surface[\w-]*/g) });
check("select.tsx 下拉浮层用 bg-surface-raised", select.includes("bg-surface-raised"), { found: select.match(/bg-surface[\w-]*/g) });
check("tooltip.tsx 用 bg-surface-raised", tooltip.includes("bg-surface-raised"), { found: tooltip.match(/bg-surface[\w-]*/g) });
check("info-hint.tsx 用 bg-surface-raised", infoHint.includes("bg-surface-raised"), { found: infoHint.match(/bg-surface[\w-]*/g) });

/* ── §5 ★ 主控断言：主画布仍然用 --surface ──
 *
 * 这条守的是「改动没有越界」。card/dialog/浮层都换了，如果主画布也被顺手换成
 * raised，整个应用的底色会变白（亮色）或变亮（暗色），而上面所有断言仍然全绿。
 */
console.log("\n── §5 主控：主画布没有被误改 ──");
const layout = readFileSync(resolve(ROOT, "src/renderer/components/layout/ThreePaneLayout.tsx"), "utf8");
check("ThreePaneLayout 的主区仍是 bg-surface（不是 raised/overlay）",
  /bg-surface(?![\w-])/.test(layout) && !/bg-surface-(raised|overlay)/.test(layout),
  { bgSurfaceMatches: layout.match(/bg-surface[\w-]*/g) });

const shell = readFileSync(resolve(ROOT, "src/renderer/components/shell/ClassicShell.tsx"), "utf8");
check("ClassicShell 的外壳仍是 bg-surface-muted（侧栏轨道，不是 raised）",
  shell.includes("bg-surface-muted") && !shell.includes("bg-surface-raised"),
  { found: shell.match(/bg-surface[\w-]*/g)?.slice(0, 5) });

/* ── §6 负控：卡片/弹窗不该退回 --surface ──
 *
 * ⚠️ 第一版写的是 `!/bg-surface"/.test(card)` —— **那是个恒真的坏判据**：
 * clsx 字符串里 `bg-surface` 后面跟的是 ` shadow-...` 而不是引号，所以
 * 「改回 bg-surface」时它**仍然通过**（变异 1 只红 1 条、预期 3 条，就差在这）。
 * 改成「不含裸 bg-surface（后面不是 -）」，这样 `bg-surface-raised` 不误伤、
 * 裸 `bg-surface` 会被抓。
 */
console.log("\n── §6 负控 ──");
const bareSurface = /bg-surface(?![\w-])/;
check("负控：card.tsx 不含裸 bg-surface（已升到 raised）",
  !bareSurface.test(card), { found: card.match(/bg-surface[\w-]*/g) });
check("负控：dialog.tsx 不含裸 bg-surface（已升到 overlay）",
  !bareSurface.test(dialog), { found: dialog.match(/bg-surface[\w-]*/g) });

console.log(`\nsurface-layers-smoke:${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);
