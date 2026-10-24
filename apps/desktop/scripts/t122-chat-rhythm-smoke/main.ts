/**
 * 【T122】聊天节律 + 版心 gutter 回归。
 *
 * ## 这套断言的是**算出来的像素**，不是源码文本
 *
 * 本仓刚有过 94 条 `source.includes("--x: 10px")` 被「注释掉真代码」骗过的先例
 * （T119，`859a7e9b` 才修）。那种写法在这里毫无价值：它只证明文件里存在那串字，
 * 不证明浏览器真的会渲染出那个间距。所以本套件先把注释剥掉再解析声明，然后
 * 按 CSS 语义**算出最终值**。
 *
 * ## 为什么断言「关系」而不是「值」
 *
 * `--chat-row-gap-user: 15px` 只能证明有人敲过这三个字符。会坏掉的是：
 *
 *   - 轮次之间不比轮内更松（层次反了 → 读不清一轮从哪开始）；
 *   - 三个值各自漂移（上游是两个乘积档，不是三个独立数）；
 *   - gutter 在断点处跳变，让「窗口变宽 → 正文变窄」（T122 的主要缺陷）。
 *
 * 这些每一条都能在**值全对但关系反**的情况下失败，反之亦然。
 *
 * ## 上游依据
 *
 * `open-claude-ui/code-examples/cds-theme.css:178-181`：
 *   --chat-body: .875rem (14px)   --chat-leading: 1.42857
 *   --chat-turn-gap = body × leading × .75 = 15px
 *   --chat-item-gap = body × leading × .50 = 10px
 * `docs/v1/03-会话核心流与指令交互引擎.md:110-112` 明写「轮次间距精确为 15px，
 * 块间距精确为 10px」。
 *
 * 上游 `:174` 的 gutter 公式（本套件逐字复算）：
 *   clamp(0px, (100% - 384px) * .175, 56px)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

let total = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  total++;
  if (!ok) failed++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`));
}

const cssPath = resolve(process.cwd(), "src/renderer/styles.css");
const raw = readFileSync(cssPath, "utf8");

/**
 * 剥 CSS 注释。
 *
 * ⚠️ 不剥就中招：注释里留着的同名声明会被读成真代码 —— 这正是 T119 那 94 条
 * 断言的失效形态（`includes` 把注释也算命中）。CSS 只有块注释一种，比 JS 好剥。
 */
function stripCssComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}
const css = stripCssComments(raw);

/** 取某个选择器块内的 `--var: value` 声明表。 */
function declarationsInBlock(selectorSource: string | RegExp): Map<string, string> {
  const out = new Map<string, string>();
  // RegExp 直接用；字符串按正则源解析（本文件两种都传）。
  const re = selectorSource instanceof RegExp ? new RegExp(selectorSource.source, "m") : new RegExp(selectorSource, "m");  const m = re.exec(css);
  if (!m) return out;
  const braceStart = css.indexOf("{", m.index);
  if (braceStart < 0) return out;
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return out;
  for (const decl of css.slice(braceStart + 1, end).split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    const name = decl.slice(0, idx).trim();
    if (name.startsWith("--")) out.set(name, decl.slice(idx + 1).trim());
  }
  return out;
}

/** rem / px 字面量 → 像素。其它形式返回 null（由调用方判定）。 */
function toPx(value: string | undefined): number | null {
  if (!value) return null;
  const v = value.trim();
  const rem = /^(-?[\d.]+)rem$/.exec(v);
  if (rem) return parseFloat(rem[1]) * 16;
  const px = /^(-?[\d.]+)px$/.exec(v);
  if (px) return parseFloat(px[1]);
  return null;
}

/* ══════════════════════════════════════════════════════════════════════
   一、默认档间距对齐上游公式
   ══════════════════════════════════════════════════════════════════════ */

console.log("\n== 一、默认档间距对齐上游公式 ==");

const comfortable = declarationsInBlock(/:root,\s*\n\[data-chat-density="comfortable"\]\s*\{/);

const gapUser = toPx(comfortable.get("--chat-row-gap-user"));
const gapAssistant = toPx(comfortable.get("--chat-row-gap-assistant"));
const gapBlock = toPx(comfortable.get("--chat-block-gap"));

// 上游公式（逐字复算，不是硬编码 15/10）。
const CHAT_BODY = 14;
const CHAT_LEADING = 1.42857;
const UPSTREAM_TURN_GAP = CHAT_BODY * CHAT_LEADING * 0.75;
const UPSTREAM_ITEM_GAP = CHAT_BODY * CHAT_LEADING * 0.5;

console.log(`  · 上游 chat-turn-gap = ${CHAT_BODY} × ${CHAT_LEADING} × .75 = ${UPSTREAM_TURN_GAP.toFixed(4)}px`);
console.log(`  · 上游 chat-item-gap = ${CHAT_BODY} × ${CHAT_LEADING} × .50 = ${UPSTREAM_ITEM_GAP.toFixed(4)}px`);
console.log(`  · 我们的默认档: user=${gapUser} assistant=${gapAssistant} block=${gapBlock}`);

check("默认档 --chat-row-gap-user 解析得出（不是 calc / 不是缺失）", gapUser !== null, {
  parsed: gapUser,
  raw: comfortable.get("--chat-row-gap-user"),
});
check("默认档 --chat-row-gap-assistant 解析得出", gapAssistant !== null, { parsed: gapAssistant });
check("默认档 --chat-block-gap 解析得出", gapBlock !== null, { parsed: gapBlock });

// ★ 对照组：上游换算值与我们的值同时给出。没有这一组时，「都等于 10」
//   可能是两边都算错了（本仓踩过：判据测的是中间量）。
check(
  "★ 对照：user == 上游 chat-turn-gap（15px，容差 0.01）",
  gapUser !== null && Math.abs(gapUser - UPSTREAM_TURN_GAP) < 0.01,
  { ours: gapUser, upstream: Number(UPSTREAM_TURN_GAP.toFixed(4)) },
);
check(
  "★ 对照：assistant == 上游 chat-item-gap（10px，容差 0.01）",
  gapAssistant !== null && Math.abs(gapAssistant - UPSTREAM_ITEM_GAP) < 0.01,
  { ours: gapAssistant, upstream: Number(UPSTREAM_ITEM_GAP.toFixed(4)) },
);
check(
  "★ 对照：block == 上游 chat-item-gap（10px，容差 0.01）",
  gapBlock !== null && Math.abs(gapBlock - UPSTREAM_ITEM_GAP) < 0.01,
  { ours: gapBlock, upstream: Number(UPSTREAM_ITEM_GAP.toFixed(4)) },
);

/* ══════════════════════════════════════════════════════════════════════
   二、层次关系
   ══════════════════════════════════════════════════════════════════════ */

console.log("\n== 二、层次关系（值全对但关系反了，一样是坏的）==");

// 只判「轮次比轮内松」。**不判 assistant vs block 的大小**：它们本就应该
// 相等（上游只有两档；tightTop 的 assistant 行本来就走 block-gap）。
// 这一条要写进回写区，否则下一个人看到两个都是 10 会以为是合并错了。
check(
  "轮次（user）间距 > 轮内（assistant）—— 一轮从哪开始必须读得出来",
  gapUser !== null && gapAssistant !== null && gapUser > gapAssistant,
  { gapUser, gapAssistant },
);
check(
  "轮次（user）间距 > 消息内块间距",
  gapUser !== null && gapBlock !== null && gapUser > gapBlock,
  { gapUser, gapBlock },
);
check(
  "块间距没有被压得比轮内更紧（>= assistant）",
  gapAssistant !== null && gapBlock !== null && gapBlock >= gapAssistant,
  { gapBlock, gapAssistant },
);

// ★ T122 变异抓出来的一条：上一组关系断言**抓不到「轮次太松」**。
//   把 user 改回 20px 时，`20 > 10` 仍成立 —— 关系全绿，只有值断言红。
//   而「太松」正是这次要修的缺陷本身，所以需要一条上界。
//   上界取上游值 +25%：留出设计余量，但容不下旧值 20（比 15 高 33%）。
const USER_GAP_CEILING = UPSTREAM_TURN_GAP * 1.25; // 18.75px
check(
  "★ 轮次间距不超过上游值的 125%（旧值 20px 是 133%，会被这条抓住）",
  gapUser !== null && gapUser <= USER_GAP_CEILING,
  { ours: gapUser, ceiling: Number(USER_GAP_CEILING.toFixed(2)), upstream: Number(UPSTREAM_TURN_GAP.toFixed(2)) },
);
check(
  "★ 轮内间距不超过上游值的 125%（防止 assistant 也偷偷放宽）",
  gapAssistant !== null && gapAssistant <= UPSTREAM_ITEM_GAP * 1.25,
  { ours: gapAssistant, ceiling: Number((UPSTREAM_ITEM_GAP * 1.25).toFixed(2)) },
);
check(
  "★ 块间距不超过上游值的 125%（防止把消息内部拆散）",
  gapBlock !== null && gapBlock <= UPSTREAM_ITEM_GAP * 1.25,
  { ours: gapBlock, ceiling: Number((UPSTREAM_ITEM_GAP * 1.25).toFixed(2)) },
);

/* ══════════════════════════════════════════════════════════════════════
   三、另两档密度保持用户可选的松紧
   ══════════════════════════════════════════════════════════════════════ */

console.log("\n== 三、compact / cozy 不被拉回上游默认值 ==");

const compact = declarationsInBlock(/\[data-chat-density="compact"\]\s*\{/);
const cozy = declarationsInBlock(/\[data-chat-density="cozy"\]\s*\{/);
const compactUser = toPx(compact.get("--chat-row-gap-user"));
const cozyUser = toPx(cozy.get("--chat-row-gap-user"));

check(
  "紧凑档比默认档更紧（用户主动选的不能被拉回默认值）",
  compactUser !== null && gapUser !== null && compactUser < gapUser,
  { compactUser, comfortableUser: gapUser },
);
check(
  "宽松档比默认档更松",
  cozyUser !== null && gapUser !== null && cozyUser > gapUser,
  { cozyUser, comfortableUser: gapUser },
);
check(
  "三档单调：compact < comfortable < cozy",
  compactUser !== null && gapUser !== null && cozyUser !== null &&
    compactUser < gapUser && gapUser < cozyUser,
  { compactUser, gapUser, cozyUser },
);

/* ══════════════════════════════════════════════════════════════════════
   四、★ gutter 不倒挂（T122 的核心缺陷）
   ══════════════════════════════════════════════════════════════════════ */

console.log("\n== 四、★ gutter 不倒挂：窗口变宽，正文不许变窄 ==");

/**
 * 从 styles.css 里读出 gutter 规则，用纯算术复算「内容宽 = pane − 2×gutter」。
 *
 * 这是对**源码声明的复算**，不是浏览器实测（无头 Node 里没有布局引擎）。
 * 浏览器实测在 `.tmp/t122-cqprobe/` 的预览页做过，结论一致（0 处倒挂，
 * 饱和点 704px）。两处都给，是因为纯算术能被变异打断，而实测不能自动化。
 */

// 读出 @supports 块里的 clamp 公式。
const supportsBlock = /@supports\s*\(width:\s*1cqw\)\s*\{[\s\S]*?--chat-gutter:\s*([^;]+);/.exec(css);

check(
  "存在 clamp() 形式的 gutter（台阶式必然倒挂，只有连续函数不会）",
  supportsBlock !== null && /clamp\(/.test(supportsBlock[1]),
  { raw: supportsBlock?.[1]?.trim() },
);

/** 解析 `clamp(A, calc((100cqw - B) * C), D)` 这四个数。 */
function parseGutterClamp(src: string): { floor: number; ref: number; k: number; ceil: number } | null {
  const m = /clamp\(\s*(-?[\d.]+)px\s*,\s*calc\(\s*\(100cqw\s*-\s*(-?[\d.]+)px\)\s*\*\s*(-?[\d.]+)\s*\)\s*,\s*(-?[\d.]+)px\s*\)/.exec(src);
  if (!m) return null;
  return { floor: parseFloat(m[1]), ref: parseFloat(m[2]), k: parseFloat(m[3]), ceil: parseFloat(m[4]) };
}

const clamp = supportsBlock ? parseGutterClamp(supportsBlock[1]) : null;

check("gutter clamp 能解析出四个参数（floor / ref / k / ceil）", clamp !== null, { raw: supportsBlock?.[1]?.trim() });

/**
 * ⚠️ clamp 解析不出来时，**不能只是跳过下面的断言**。
 *
 * 第一版把整段包在 `if (clamp) { ... }` 里，结果「删掉 clamp」的变异只红了
 * 3 条（存在性 / 解析 / 跳过提示），而对照、扫描、斜率、饱和点这 4 条**根本没跑**。
 * **跳过的断言和通过的断言在输出里长得一样** —— 这是本仓反复踩的形态
 * （T119 的「套件全绿但没覆盖到」）。
 *
 * 所以这里改成：clamp 缺失时，**逐条显式 FAIL**，让「没跑」在输出里是红的。
 */
function checkOrFailWhenNoClamp(label: string, fn: () => boolean, detail?: () => unknown): void {
  if (!clamp) {
    check(label, false, { reason: "clamp 未能解析 —— 这条断言没有执行" });
    return;
  }
  check(label, fn(), detail?.());
}

if (clamp) {
  console.log(`  · 解析: floor=${clamp.floor}px ref=${clamp.ref}px k=${clamp.k} ceil=${clamp.ceil}px`);
}

// 上游同型公式（cds-theme.css:174）—— 对照，不是硬编码。
const UP_REF = 384;
const UP_K = 0.175;
const UP_CEIL = 56;

checkOrFailWhenNoClamp(
  "★ 对照：clamp 的参照值与上游一致（384px / .175 / 56px）",
  () => clamp!.ref === UP_REF && Math.abs(clamp!.k - UP_K) < 1e-9 && clamp!.ceil === UP_CEIL,
  () => ({ ours: { ref: clamp!.ref, k: clamp!.k, ceil: clamp!.ceil }, upstream: { ref: UP_REF, k: UP_K, ceil: UP_CEIL } }),
);

function gutterAt(pane: number): number {
  const mid = (pane - clamp!.ref) * clamp!.k;
  return Math.min(Math.max(clamp!.floor, mid), clamp!.ceil);
}
function contentAt(pane: number): number {
  return pane - 2 * gutterAt(pane);
}

// 逐像素扫 300..1700，收集所有倒挂点。
function scanInversions(): Array<{ from: number; to: number; delta: number }> {
  const found: Array<{ from: number; to: number; delta: number }> = [];
  let prev = contentAt(300);
  for (let pane = 301; pane <= 1700; pane++) {
    const now = contentAt(pane);
    if (now < prev - 1e-9) found.push({ from: pane - 1, to: pane, delta: Number((now - prev).toFixed(3)) });
    prev = now;
  }
  return found;
}

const inversions = clamp ? scanInversions() : [];

checkOrFailWhenNoClamp(
  "★ 300–1700px 逐像素扫描：正文宽度单调不减（0 处倒挂）",
  () => inversions.length === 0,
  () => ({ count: inversions.length, first: inversions.slice(0, 5) }),
);
if (clamp) console.log(`  · 扫描结果：倒挂 ${inversions.length} 处（300–1700px，1400 个宽度）`);

// 单调不减在数学上等价于「斜率处处 >= 0」。斜率 = 1 - 2·k，
// 所以只要 k <= 0.5 就永不倒挂。这一条是上一条的独立佐证
// （pixel sweep 只覆盖扫过的区间，斜率覆盖全部实数）。
checkOrFailWhenNoClamp(
  "斜率 1 − 2k >= 0（k <= 0.5）—— 覆盖整个实数域，不只扫描区间",
  () => clamp!.k <= 0.5,
  () => ({ k: clamp!.k, slope: Number((1 - 2 * clamp!.k).toFixed(4)) }),
);

// 饱和点：gutter 到达上限的那个 pane 宽。上游的 56px 上限应在那附近生效。
checkOrFailWhenNoClamp(
  "饱和点 = ref + ceil/k（704px），与上游同型公式一致",
  () => Math.abs(clamp!.ref + clamp!.ceil / clamp!.k - (UP_REF + UP_CEIL / UP_K)) < 1e-6,
  () => ({ ours: Number((clamp!.ref + clamp!.ceil / clamp!.k).toFixed(2)), upstream: UP_REF + UP_CEIL / UP_K }),
);
if (clamp) console.log(`  · 饱和点：pane >= ${(clamp.ref + clamp.ceil / clamp.k).toFixed(0)}px 之后 gutter 恒为 ${clamp.ceil}px`);

// 地板：最窄的 pane 下正文不能被挤没。
checkOrFailWhenNoClamp(
  "地板 20px：pane=300 时正文仍有 >= 200px（窄 pane 不把正文挤没）",
  () => contentAt(300) >= 200,
  () => ({ content: contentAt(300) }),
);

/* ══════════════════════════════════════════════════════════════════════
   五、间距变量真的有消费者
   ══════════════════════════════════════════════════════════════════════ */

console.log("\n== 五、间距变量真的有消费者（定义了没人用 = 假的体系）==");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p);
  }
  return out;
}

const rendererDir = resolve(process.cwd(), "src/renderer");
const tsFiles = walk(rendererDir);

/** 剥 TS/TSX 注释。行注释只在行首剥 —— 避免把 URL 的 `//` 当真注释头。 */
function stripTsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function consumersOf(varName: string): string[] {
  const needle = `var(${varName})`;
  return tsFiles.filter((f) => stripTsComments(readFileSync(f, "utf8")).includes(needle));
}

for (const v of ["--chat-row-gap-user", "--chat-row-gap-assistant", "--chat-block-gap", "--chat-gutter"]) {
  const users = consumersOf(v);
  check(
    `${v} 至少有一个源码消费者`,
    users.length > 0,
    { consumers: users.map((f) => f.replace(rendererDir, "").replace(/\\/g, "/")) },
  );
}

/* ══════════════════════════════════════════════════════════════════════
   收尾
   ══════════════════════════════════════════════════════════════════════ */

console.log(`\nt122-chat-rhythm-smoke:${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);
