/**
 * font-scale-smoke —— 判据是「同一语义位置的**计算后字号**必须同档」。
 *
 * 为什么算 px 而不是比类名：
 *   `text-[length:var(--chat-fs-sm)]` 与 `text-[0.9286em]` 在 14px 基准下**都是 13px**，
 *   比字符串会把它们判成不同档（假阳性）；而两个不同写法真的算出不同 px 时，
 *   比字符串又会漏掉（假阴性）。**只有算出来的数才是同一把尺子。**
 *
 * 背景：`tailwind.config.js` 在 2026-10-24 之前**连 fontSize 都没配**，于是全仓三套并存：
 *   硬写 px 656 处（12 个档位）、em 相对 728 处（18 档）、Tailwind 默认 469 处。
 *   用户说的是「看起来不对劲但说不出哪不对」—— 这就是来源。
 *
 * ⚠️ 这套**不验「有没有迁移到新档位」**（那是分区域分批的事，见 T121 §1.7）。
 *  它只验一件事：**同一个语义位置，现在是不是同一个字号。**
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { stripComments } from "../lib/sourceText.js";

// run.sh 会先 `cd` 到 apps/desktop —— 用 cwd 而不是 import.meta.dirname，
// 因为 esbuild 把 main.ts 打进一个临时目录，dirname 会指向 /tmp。
const ROOT = resolve(process.cwd());
if (!readdirSafe(join(ROOT, "src/renderer/styles.css"))) {
  console.error(`font-scale-smoke: 必须在 apps/desktop 下运行（cwd=${ROOT}）`);
  process.exit(2);
}
function readdirSafe(p: string): boolean {
  try { readFileSync(p); return true; } catch { return false; }
}
let total = 0;
let failures = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
function info(msg: string): void {
  console.log(`       ${msg}`);
}

// ── 读 styles.css 的 token 值（用于把 var(...) 解析成 px）──
const css = readFileSync(join(ROOT, "src/renderer/styles.css"), "utf8");
const CHAT_FONT_SIZE = Number(css.match(/--chat-font-size:\s*(\d+(?:\.\d+)?)px/)?.[1] ?? 14);
const RP_FONT_SIZE = Number(css.match(/--right-panel-font-size:\s*(\d+(?:\.\d+)?)px/)?.[1] ?? 14);

/** 把 `styles.css` 里的 `--chat-fs-*` / `--rp-fs-*` 解成 px。 */
function tokenPx(name: string): number | null {
  const m = css.match(new RegExp(`--${name}:\\s*calc\\(var\\(--(chat-font-size|right-panel-font-size)\\)\\s*\\*\\s*([\\d.]+)\\)`));
  if (!m) return null;
  const base = m[1] === "chat-font-size" ? CHAT_FONT_SIZE : RP_FONT_SIZE;
  return Number((base * Number(m[2])).toFixed(2));
}

// ── 读组件源码 ──
const files: string[] = [];
const walk = (d: string): void => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".tsx")) files.push(p);
  }
};
walk(join(ROOT, "src/renderer/components"));

const read = (rel: string): string => readFileSync(join(ROOT, "src/renderer/components", rel), "utf8");

/** 把一处 `className` 里的字号写法解成 px（无法解析时返回 null）。 */
function sizeToPx(token: string, parentEm = CHAT_FONT_SIZE): number | null {
  // text-[10px]
  let m = token.match(/^text-\[(\d+(?:\.\d+)?)px\]$/);
  if (m) return Number(m[1]);
  // text-[0.8571em] —— 相对父元素（这里按 chat 基准算）
  m = token.match(/^text-\[([\d.]+)em\]$/);
  if (m) return Number((parentEm * Number(m[1])).toFixed(2));
  // text-[length:var(--chat-fs-xs)]
  m = token.match(/^text-\[length:var\(--([\w-]+)\)\]$/);
  if (m) return tokenPx(m[1]);
  // text-xs(12) / text-sm(14) / text-base(16) —— Tailwind 默认阶梯
  const tw: Record<string, number> = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, "2xl": 24 };
  m = token.match(/^text-(xs|sm|base|lg|xl|2xl)$/);
  if (m) return tw[m[1]];
  return null;
}

/** 从一段 className 里取字号 token。 */
function sizeTokenOf(className: string): string | null {
  return className.match(/text-\[[^\]]+\]|text-(xs|sm|base|lg|xl|2xl)/)?.[0] ?? null;
}

console.log("font-scale-smoke: 同一语义位置的计算后字号必须同档\n");

// ═══════════════════════════════════════════════════════════════
// 一、★ 主区域：聊天气泡里的「元信息」（时间戳 / 回合统计）
//     这两处都在「一条消息下面那行灰字」这个语义位置上。
// ═══════════════════════════════════════════════════════════════
console.log("── 一、聊天元信息：文字同档，徽标低一档 ──");
{
  // 【T136】**这条断言原来把两种东西混在一个语义类里。**
  //
  // 它比较的是「回合统计行」和「本轮文件卡片的时间戳」，并要求两者同字号。
  // 但 `TurnFilesCard` 里那三处不是同一类：
  //   :195  汇总 +N/−N —— 带 `bg-surface-muted` + `rounded-md` + padding，是**徽标**
  //   :386  文件路径     —— 裸 `<span>`，纯文字
  //   :390  单文件增删   —— 裸 `<span>`，纯文字
  //
  // 所以「四种字号」这个说法是错的；真实情况是「两种东西被当成一种」。
  // 现在分开断言：
  //   ①③④ 文字 → `text-footnote`（12px），必须同档
  //   ②   徽标 → `text-caption`（11px），**必须比文字低一档**（靠底色 + 字号双层区分）
  const rowSrc = read("chat/MessageRow.tsx");
  const filesSrc = read("chat/TurnFilesCard.tsx");

  /** 从一个 span 的 className 里取 `text-<tier>` 或 `text-[Npx]`。 */
  const tierOf = (src: string, anchor: RegExp): string | null => {
    const line = src.split("\n").find((l) => anchor.test(l));
    if (!line) return null;
    return line.match(/text-(footnote|caption|code|body|prose|heading|title)\b/)?.[1]
      ?? line.match(/text-\[([\d.]+px)\]/)?.[1]
      ?? null;
  };
  const TIER_PX: Record<string, number> = {
    caption: 11, footnote: 12, code: 12, body: 14, prose: 15, heading: 16, title: 20,
  };
  const pxOf = (t: string | null): number | null =>
    t === null ? null : (TIER_PX[t] ?? (t.endsWith("px") ? Number(t.replace("px", "")) : null));

  const rowTier = tierOf(rowSrc, /rounded-lg px-\[7px\] py-1 text-content-subtle/);
  const badgeTier = tierOf(filesSrc, /rounded-md bg-surface-muted px-1\.5 py-0\.5/);
  const pathTier = tierOf(filesSrc, /truncate font-mono text-(?:footnote|caption|\[)[^"]*text-content/);
  const tallyTier = tierOf(filesSrc, /flex shrink-0 items-center gap-1 font-mono text-/);

  const rowPx = pxOf(rowTier);
  const badgePx = pxOf(badgeTier);
  const pathPx = pxOf(pathTier);
  const tallyPx = pxOf(tallyTier);

  info(`回合统计行(文字): ${rowTier} = ${rowPx}px`);
  info(`文件路径(文字):   ${pathTier} = ${pathPx}px`);
  info(`单文件增删(文字): ${tallyTier} = ${tallyPx}px`);
  info(`汇总徽标(badge):  ${badgeTier} = ${badgePx}px`);

  check(
    "★ 四个位置的字号都解析出来了（否则下面的比较是假的）",
    rowPx !== null && badgePx !== null && pathPx !== null && tallyPx !== null,
    { rowPx, badgePx, pathPx, tallyPx },
  );

  check(
    "★ 聊天元信息**文字**用同一档（回合统计 / 文件路径 / 单文件增删）",
    rowPx !== null && pathPx !== null && tallyPx !== null
      && rowPx === pathPx && pathPx === tallyPx,
    { 回合统计行: rowPx, 文件路径: pathPx, 单文件增删: tallyPx },
  );

  check(
    "★ 汇总徽标比元信息文字**低一档**（靠底色 + 字号双层区分，不是同档）",
    badgePx !== null && rowPx !== null && badgePx < rowPx,
    { 徽标: badgePx, 文字: rowPx },
  );
}

// ═══════════════════════════════════════════════════════════════
// 二、★ 负控：两组**故意不同**的语义，必须能分辨出来
//     没有这一节，第 1 节是绿的也不能说明判据有分辨力 ——
//     它可能只是「所有东西都解析成 null，null === null」。
// ═══════════════════════════════════════════════════════════════
console.log("\n── 二、★ 负控：不同语义位置必须算出不同值 ──");
{
  const panelTitlePx = sizeToPx("text-[length:var(--chat-fs-sm)]");
  const chatBodyPx = sizeToPx("text-[length:var(--chat-font-size)]") ?? CHAT_FONT_SIZE;
  const captionPx = sizeToPx("text-[10px]");

  info(`面板标题(--chat-fs-sm) = ${panelTitlePx}px`);
  info(`正文基准(--chat-font-size) = ${chatBodyPx}px`);
  info(`硬写 10px = ${captionPx}px`);

  check(
    "★ 判据能分辨「面板标题」和「10px 硬写」",
    panelTitlePx !== null && captionPx !== null && panelTitlePx !== captionPx,
    { panelTitlePx, captionPx },
  );
  check(
    "★ 判据能分辨「面板标题」和「正文基准」",
    panelTitlePx !== null && panelTitlePx !== chatBodyPx,
    { panelTitlePx, chatBodyPx },
  );
}

// ═══════════════════════════════════════════════════════════════
// 三、等价写法必须算出同一个值（这是「比 px 而不比类名」的理由）
// ═══════════════════════════════════════════════════════════════
console.log("\n── 三、判据把等价写法算成同一个数 ──");
{
  const viaVar = sizeToPx("text-[length:var(--chat-fs-sm)]");
  // 0.9286em 在 14px 基准下
  const viaEm = sizeToPx("text-[0.9286em]");
  info(`var(--chat-fs-sm) = ${viaVar}px / 0.9286em = ${viaEm}px`);
  check(
    "★ 两种写法算出的 px 相同（比类名会误判成不同档）",
    viaVar !== null && viaEm !== null && Math.abs(viaVar - viaEm) < 0.01,
    { viaVar, viaEm },
  );
}

// ═══════════════════════════════════════════════════════════════
// 四、tailwind.config.js 的七档已就位，且值 = 规范
// ═══════════════════════════════════════════════════════════════
console.log("\n── 四、CDS 七档字阶（T121 · storybook :659）──");
{
  const tw = readFileSync(join(ROOT, "tailwind.config.js"), "utf8");
  const spec: Array<[string, number, number]> = [
    ["caption", 11, 16],
    ["footnote", 12, 14],
    ["code", 12, 16],
    ["body", 14, 20],
    ["prose", 15, 22],
    ["heading", 16, 20],
    ["title", 20, 24],
  ];
  for (const [name, size, lh] of spec) {
    const m = tw.match(new RegExp(`${name}:\\s*\\["(\\d+)px",\\s*\\{\\s*lineHeight:\\s*"(\\d+)px"`));
    check(
      `${name} = ${size}px / ${lh}px`,
      m !== null && Number(m[1]) === size && Number(m[2]) === lh,
      m ? { actual: [m[1], m[2]] } : "missing",
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// 五、新档位的使用必须**按批次**，不能随手改
//
// ⚠️ 这一节原本的断言是「没有任何组件使用新档位」—— 它验证的是 T121 加
// fontSize 时的承诺：**加配置不改变任何现有渲染**。
//
// 那个承诺在 T133 兑现完了：第一批迁移把 90 处 `text-sm` 换成了 `text-body`。
// 所以「0 处使用」不再是事实，而这**不是回归**。
//
// 断言改成守真正长期有效的那条：**新档位的使用只允许在已迁移的批次里出现，
// 且只允许数值等价的那两档**。
//
//   等价（允许）：text-sm → text-body（14/20 → 14/20）、text-xs → text-code（12/16 → 12/16）
//   收紧（不允许）：text-base → text-heading（16/24 → 16/20，行高变了）
//                   text-xl  → text-title  （20/28 → 20/24，行高变了）
//
// 收紧那两档会**改变渲染**，必须单独一批、单独验。这条断言就是拦住
// 「顺手把 text-base 也换成 text-heading」的那道门。
// ═══════════════════════════════════════════════════════════════
console.log("\n── 五、新档位只用等价的两档（收紧档位要单独一批）──");
{
  const EQUIVALENT = ["body", "code"];             // 数值与对应 Tailwind 默认档相同
  const TIGHTENING = ["heading", "title"];         // 行高会变，本批禁止
  // ── 收紧档位的**显式例外** ──
  //
  // 这道门拦的是「顺手把 text-base 批量换成 text-heading」，不是「永远不许用
  // heading」。所以允许按**文件 + 理由**登记例外：每一条都要能回答「为什么这一处
  // 该改行高」，而不是「我改到这儿了」。
  //
  // 登记过的文件仍然要求：用的是收紧档位、不是等价档位（避免借例外之名做等价迁移）。
  const TIGHTENING_EXCEPTIONS: ReadonlyArray<{ file: string; tier: string; why: string }> = [
    {
      file: "settings/PanelHeader.tsx",
      tier: "heading",
      why: "设置页每个子页面的标题。原来是 --chat-fs-sm（13px）且跟随对话字号，"
        + "两处都不对：heading=16/20 是规范里「页面标题」的档。行高 16→20 是有意的（T136）。",
    },
  ];
  const exceptionFor = (rel: string, tier: string) =>
    TIGHTENING_EXCEPTIONS.find((e) => rel === e.file && e.tier === tier);
  const tighteningHits: string[] = [];
  const equivalentHits: string[] = [];
  let exceptionsUsed = 0;

  for (const f of files) {
    // ⚠️ 必须剥注释再匹配 —— 例外登记后，被登记的文件里通常还留着
    // 「原来用的是 --chat-fs-sm」这类解释性注释；不剥的话「例外确实还在用」
    // 这条会因为注释里的字样而恒真（实测：把 PanelHeader 改成 text-body 之后
    // 计数器仍是 1 —— 它数的是注释里那个 `text-heading`）。
    const t = stripComments(readFileSync(f, "utf8"));
    const rel = f.replace(join(ROOT, "src/renderer/components") + sep, "").split(sep).join("/");
    for (const n of EQUIVALENT) {
      if (new RegExp(`\\btext-${n}(?![\\w-])`).test(t)) equivalentHits.push(rel);
    }
    for (const n of TIGHTENING) {
      if (!new RegExp(`\\btext-${n}(?![\\w-])`).test(t)) continue;
      if (exceptionFor(rel, n)) { exceptionsUsed++; continue; }
      tighteningHits.push(`${rel}: text-${n}`);
    }
  }

  info(`等价档位（body/code）已用于 ${equivalentHits.length} 个文件（T133 第一批）`);
  info(`收紧档位的已登记例外：${exceptionsUsed} 处（共登记 ${TIGHTENING_EXCEPTIONS.length} 处）`);
  check(
    "★ 没有**未登记**的组件使用会改变行高的档位（heading / title）",
    tighteningHits.length === 0,
    tighteningHits,
  );
  check(
    "★ 每条登记过的例外都真的还在用那个档位（防止例外变成空头支票）",
    exceptionsUsed === TIGHTENING_EXCEPTIONS.length,
    { exceptionsUsed, registered: TIGHTENING_EXCEPTIONS.length },
  );
  check(
    "★ 等价档位确实被用起来了（迁移发生过，不是空谈）",
    equivalentHits.length > 0,
    { equivalentHits: equivalentHits.length },
  );
}

console.log(`\nfont-scale-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
