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
   表达式求值（`calc(var(--a) * var(--b) * .75)`）
   ══════════════════════════════════════════════════════════════════════

   【UI 重建 2026-10-27】间距改成了 Claude 的相对公式（`calc()` 里乘
   字号与行高），不再是 px 字面量。第一版的 `toPx` 只认 `Npx` / `Nrem`，
   于是三个间距全解析成 null —— 十五条断言一起红，而**样式本身是对的**。

   ⚠️ 不能只把 `calc(...)` 当字符串忽略：那会让「间距精确等于上游公式」
   这条主控断言永远绿（`null !== 15` 是红，但 `skipped` 是绿的，
   而这里没有 skip 分支）。必须真的算出像素。 */

/** 从某个声明表（再退回 `:root`）里解 `var(--x)`；解不出返回 undefined。 */
function lookupVar(name: string, block: Map<string, string>, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  /* ⚠️ `name` 是**不带 `--` 前缀**的（正则 `var\(--([\w-]+)\)` 捕获的就是它）。
   * 声明表的键却**带** `--`。第一版直接用 `block.get(name)`，于是永远查不到，
   * 整个过程静默失败、`calc()` 解出 null —— 而两侧都「看起来」在正常工作。 */
  const key = name.startsWith("--") ? name : `--${name}`;
  const raw = block.get(key) ?? rootBlock().get(key);
  if (raw === undefined) return undefined;
  const alias = /^var\(--([\w-]+)\)$/.exec(raw.trim());
  return alias ? lookupVar(alias[1]!, block, depth + 1) : raw;
}

let _rootBlock: Map<string, string> | null = null;
function rootBlock(): Map<string, string> {
  /* ⚠️ 必须匹配 `:root {`，不能匹配 `:root,`。
   * 本文件里第一条命中 `:root\s*,` 的是**聊天间距块**（`:root, [data-chat-density="comfortable"]`），
   * 它不含 `--chat-font-size` —— 用它当根，`calc()` 里的字号永远解不出来，
   * 而中间件本身是好的。这是「解析器选错块」的第二例（第一例见 surface-layers）。 */
  if (!_rootBlock) _rootBlock = declarationsInBlock(/:root\s*\{/);
  return _rootBlock;
}

/**
 * 求值一个 CSS 长度表达式。支持 `px` / `rem` / 无单位数字 / `var()` / `calc()`
 * 与 `+ - * /`、括号。**只认这些** —— 遇到别的（`em`、`%`、`clamp()`）返回 null，
 * 让调用方把它当「解析不出」处理，而不是猜一个数。
 */
function evalLength(raw: string | undefined, block: Map<string, string>): number | null {
  if (!raw) return null;
  let s = raw.trim();

  // 1) 递归展开 var()
  for (let i = 0; i < 8 && s.includes("var("); i++) {
    let changed = false;
    s = s.replace(/var\(\s*--([\w-]+)\s*\)/g, (_m, name: string) => {
      const v = lookupVar(name, block);
      if (v === undefined) return _m;
      changed = true;
      return `(${v.trim()})`;
    });
    if (!changed) return null;
  }
  if (s.includes("var(")) return null;

  // 2) 去掉最外层 calc(...)（可以嵌套，逐层剥）
  for (let i = 0; i < 8; i++) {
    const t = s.trim();
    const m = /^calc\(([\s\S]*)\)$/.exec(t);
    if (!m) break;
    // 确认这一对括号确实包住整个表达式（避免 `calc(a) + calc(b)` 被误剥）
    let depth = 0;
    let wrapsAll = true;
    for (let j = 0; j < t.length; j++) {
      if (t[j] === "(") depth++;
      else if (t[j] === ")") {
        depth--;
        if (depth === 0 && j !== t.length - 1) { wrapsAll = false; break; }
      }
    }
    if (!wrapsAll) break;
    s = m[1]!;
  }

  // 3) 词法 + 求值（单位只允许 px/rem；混用单位时统一换成 px）
  const tokens = s.match(/(-?\d*\.?\d+)(px|rem)?|[()+\-*/]/g);
  if (!tokens) return null;
  const rendered = tokens.join("");
  if (rendered.replace(/\s/g, "") !== s.replace(/\s/g, "")) return null; // 有认不出的字符

  let pos = 0;
  function expr(): number | null {
    let left = term();
    while (left !== null && (tokens![pos] === "+" || tokens![pos] === "-")) {
      const op = tokens![pos++]!;
      const right = term();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }
  function term(): number | null {
    let left = factor();
    while (left !== null && (tokens![pos] === "*" || tokens![pos] === "/")) {
      const op = tokens![pos++]!;
      const right = factor();
      if (right === null) return null;
      if (op === "/" && right === 0) return null;
      left = op === "*" ? left * right : left / right;
    }
    return left;
  }
  function factor(): number | null {
    const t = tokens![pos];
    if (t === undefined) return null;
    if (t === "(") {
      pos++;
      const v = expr();
      if (tokens![pos] !== ")") return null;
      pos++;
      return v;
    }
    if (t === "-") { pos++; const v = factor(); return v === null ? null : -v; }
    const m = /^(-?\d*\.?\d+)(px|rem)?$/.exec(t);
    if (!m) return null;
    pos++;
    return m[2] === "rem" ? parseFloat(m[1]!) * 16 : parseFloat(m[1]!);
  }
  const out = expr();
  if (out === null || pos !== tokens.length) return null;
  return out;
}

/* ══════════════════════════════════════════════════════════════════════
   一、默认档间距对齐上游公式
   ══════════════════════════════════════════════════════════════════════ */

console.log("\n== 一、默认档间距对齐上游公式 ==");

const comfortable = declarationsInBlock(/:root,\s*\n\[data-chat-density="comfortable"\]\s*\{/);

const gapUser = evalLength(comfortable.get("--chat-row-gap-user"), comfortable);
const gapAssistant = evalLength(comfortable.get("--chat-row-gap-assistant"), comfortable);
const gapBlock = evalLength(comfortable.get("--chat-block-gap"), comfortable);

/* 【UI 重建 2026-10-27】**上游常数换成我们从本机 Claude 读到的真值。**
 *
 * 原来这里写死 `CHAT_BODY = 14` / `CHAT_LEADING = 1.42857`（第三方逆向产物
 * `open-claude-ui` 的值，已删除）。本机 Claude 3.1623.4.0 的真身是
 * `--cds-font-size-body` ≈ 12.24px、`--cds-leading-body` ≈ 18.82px → 1.5378。
 *
 * 所以「上游 15px / 10px」这个参照已经过时：按真实取值，
 * turn-gap = 12.24 × 1.5378 × .75 ≈ 14.12px，item-gap ≈ 9.41px。
 *
 * **但常数不能从被测代码自己读** —— 那样「间距 == 公式」会变成恒真。
 * 这里用**独立常量**（从本机产物抄下来的原始值），并额外断言它俩与
 * styles.css 里 `--chat-font-size` / `--chat-md-leading` 一致（见下面 §一末），
 * 后者守的是「公式用的基数和样式表里的一致」，前者守的是「间距确实按公式算」。 */
/* 【UI 重建 2026-10-28】**常数换成真 Electron 实测值。上一版两个都是错的。**
 *
 * 上一版 `12.24` / `1.5378`：
 *   - 12.24 = `.8125rem × 16 × 16/17` —— **双重错误**：取了 `.cds-root` 基础层
 *     （comfortable 层是 `.875rem`），又乘了 `16/17`（Windows 上
 *     `--cds-rem-scale` 未定义，应取 1）。
 *   - 1.5378 是拿 `18.82 / 12.24` 反推的比值，而 18.82 本身也是错的。
 *
 * 实测（`.tmp/claude-css-probe/`，真 Electron + Claude 自己的 25 个 CSS，
 * `<div class="cds-root" data-density="comfortable">`）：
 *
 *   `--cds-font-size-body` → **14px**       (.875rem × 1)
 *   `--cds-leading-body`   → **20px**       (1.25rem × 1)
 *   比值                   → **1.428571**
 *
 * 这一层是 **transcript 层**（时间线 / tool 行 / 用户气泡），
 * `--chat-turn-gap` 与 `--chat-item-gap` 都写在这一层上 ——
 * 注意**不是** AI 正文的 `.prose`（那是 16px / 1.5，见 t147）。 */
const CLAUDE_BODY_PX = 14;           // 本机 Claude --cds-font-size-body @ comfortable
const CLAUDE_LEADING = 20 / 14;      // = --cds-leading-body / body = 1.428571
const UPSTREAM_TURN_GAP = CLAUDE_BODY_PX * CLAUDE_LEADING * 0.75;
const UPSTREAM_ITEM_GAP = CLAUDE_BODY_PX * CLAUDE_LEADING * 0.5;

console.log(`  · 上游 chat-turn-gap = ${CLAUDE_BODY_PX} × ${CLAUDE_LEADING} × .75 = ${UPSTREAM_TURN_GAP.toFixed(4)}px`);
console.log(`  · 上游 chat-item-gap = ${CLAUDE_BODY_PX} × ${CLAUDE_LEADING} × .50 = ${UPSTREAM_ITEM_GAP.toFixed(4)}px`);
console.log(`  · 我们的默认档: user=${gapUser} assistant=${gapAssistant} block=${gapBlock}`);

check("默认档 --chat-row-gap-user 解析得出（不是 calc / 不是缺失）", gapUser !== null, {
  parsed: gapUser,
  raw: comfortable.get("--chat-row-gap-user"),
});
check("默认档 --chat-row-gap-assistant 解析得出", gapAssistant !== null, { parsed: gapAssistant });
check("默认档 --chat-block-gap 解析得出", gapBlock !== null, { parsed: gapBlock });

/* ★ 常数守：上面那两个参照值必须和样式表里的基数一致。
 *
 * 没有这一条时，「间距 == 公式」验的是**公式自己**：把 `--chat-font-size`
 * 改成 30px 而间距不变，前面三条照样绿（间距仍等于那个常数算出的值）。
 * 这一条把常数钉在样式表上 —— 改基数不改间距，这里就红。 */
const styleBody = evalLength(rootBlock().get("--chat-font-size"), rootBlock());
/* `--chat-md-leading` 定义在**间距块**里（`:root, [data-chat-density="comfortable"]`），
 * 不在真 `:root`。所以要和间距用同一个声明表查 —— 用 `rootBlock()` 会得到 null，
 * 而 null 只会让这条断言红，不会让上面三条间距断言红（它们是另一条路径）。 */
const styleLeading = evalLength(comfortable.get("--chat-md-leading"), comfortable);
/* 【UI 重建 2026-10-28】**这条原来比错了对象。**
 *
 * `styleBody` / `styleLeading` 取的是 `--chat-font-size` / `--chat-md-leading`，
 * 那是 **AI 正文**的 16px / 1.5；而上面那三条对照用的 `CLAUDE_BODY_PX` /
 * `CLAUDE_LEADING` 是 **transcript 层**的 14px / 1.4286 —— 间距公式现在读的是
 * 后者（`--m-transcript-body` / `--m-transcript-leading`）。
 *
 * 拿正文的值去比 transcript 的常数，必然红，而且红得没有信息量。
 * 现在分别守两条：
 *   a) 间距公式的基数（新变量）== transcript 层真值
 *   b) 正文档确实是 16 / 1.5（防止有人把正文改成 14 来"对齐"间距）
 */
const styleTBody = evalLength(comfortable.get("--m-transcript-body"), comfortable);
const styleTLeadingRaw = comfortable.get("--m-transcript-leading");
const styleTLeading = styleTLeadingRaw ? parseFloat(styleTLeadingRaw) : null;
check(
  "★ 间距公式的基数 = transcript 层真值（--m-transcript-body / --m-transcript-leading）",
  styleTBody !== null && styleTLeading !== null &&
    Math.abs(styleTBody - CLAUDE_BODY_PX) < 0.005 && Math.abs(styleTLeading - CLAUDE_LEADING) < 0.005,
  { styleTBody, styleTLeading, expected: [CLAUDE_BODY_PX, Number(CLAUDE_LEADING.toFixed(6))] },
);
check(
  "★ 正文档仍是 16 / 1.5（不许为了对齐间距把正文压成 14）",
  styleBody !== null && styleLeading !== null &&
    Math.abs(styleBody - 16) < 0.005 && Math.abs(styleLeading - 1.5) < 0.005,
  { styleBody, styleLeading, expected: [16, 1.5] },
);

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
const compactUser = evalLength(compact.get("--chat-row-gap-user"), compact);
const cozyUser = evalLength(cozy.get("--chat-row-gap-user"), cozy);

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
 * gutter 从**连续 clamp 公式**换成了**上游真值：常数 32px + 窄容器降 16px**。
 *
 * 【UI 重建 2026-10-28】上一版守的是
 * `clamp(0px, calc((100cqw - 384px) * .175), 56px)` —— 那个公式出自
 * 第三方逆向仓 `open-claude-ui`，其中 384 / .175 / 56 是
 * `--cds-assistant-message-text-stop` 的参数，**不是 gutter 的**。
 *
 * 上游真值（`.tmp/upstream.css`，逐条取出每个 `--chat-gutter` 定义及其作用域）：
 *
 *   .epitaxy-root                                   { --chat-gutter: 32px }
 *   @container tile-slot (width<=560px)
 *     .epitaxy-chat-panel …                          { --chat-gutter: 16px }
 *   [--chat-gutter:0px]  （工具类，非默认）
 *
 * 也就是说 Claude 的正文左右留白是**常数 32px**，只在容器窄于 560px 时降到 16px。
 * 连续性那套论证（斜率、饱和点、逐像素扫描）是为 clamp 准备的，**对常数没有意义** ——
 * 常数天然单调，不会倒挂。
 *
 * 所以这一节改成守真正决定视觉的三件事：
 *   1. 默认值就是 32px（上游常数，不是公式算出来的）
 *   2. 窄容器下确实降到 16px（否则窄屏正文会被吃掉 64px）
 *   3. 消费点存在（定义了没人读 = 假的体系）
 */

/* 这两个值都是裸 px，没有 `var()` 需要展开 —— 传空表即可。 */
const gutterBase = evalLength(
  /\.epitaxy-root\s*\{[^}]*?--chat-gutter:\s*([^;}]+)/.exec(css)?.[1] ??
    /--chat-gutter:\s*([\d.]+px)/.exec(css)?.[1] ?? "",
  new Map<string, string>(),
);
/* 从我们自己的 styles.css 读默认值 —— 上游那份只是参照。 */
const oursGutterRaw = /\[data-chat-root\][^{]*\{[^}]*?--chat-gutter:\s*([^;}]+)/.exec(css)?.[1]
  ?? /--chat-gutter:\s*([\d.]+px)/.exec(css)?.[1] ?? "";
const oursGutter = evalLength(oursGutterRaw, new Map<string, string>());
const UP_GUTTER = 32;
const UP_GUTTER_NARROW = 16;

console.log(`
== 四、★ gutter = 上游常数（${UP_GUTTER}px / 窄容器 ${UP_GUTTER_NARROW}px）==`);

check(
  `★ 默认 gutter = 上游常数 ${UP_GUTTER}px（不是 clamp 公式）`,
  oursGutter !== null && Math.abs(oursGutter - UP_GUTTER) < 0.01,
  { ours: oursGutter, upstream: UP_GUTTER, raw: oursGutterRaw },
);
/* 窄档写成容器查询，选择器是 `[data-chat-root] *` —— 只按 `--chat-gutter: 16px`
 * 匹配正文，不要假设选择器形状。 */
check(
  `★ 窄容器（<=560px）降为 ${UP_GUTTER_NARROW}px —— 否则窄屏正文被吃掉 64px`,
  /* 用 `[ ]*` 而不是 `\\s*`：模板字符串里 `\s` 会被当成转义序列吃掉，
   * 正则剩成 `--chat-gutter:s*16px`，永远不命中（实测踩过）。 */
  new RegExp(`--chat-gutter:[ ]*${UP_GUTTER_NARROW}px`).test(css) &&
    /@container[^{]*560px/.test(css),
  { wanted: `${UP_GUTTER_NARROW}px`, hasContainerQuery: /@container[^{]*560px/.test(css) },
);
check(
  "gutter 不再写成 clamp()（上游是常数，clamp 会让宽度随 pane 漂移）",
  !/--chat-gutter:\s*clamp\(/.test(css),
  { hit: /--chat-gutter:\s*clamp\([^;}]*/.exec(css)?.[0] ?? null },
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
