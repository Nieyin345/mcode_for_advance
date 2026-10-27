/**
 * t139-message-alignment-smoke — 聊天消息全面对齐 Claude 的四个改动。
 *
 * ## 盯的是什么
 *
 * T139 把助手/用户消息的结构对齐到上游 `open-claude-ui/code-examples/
 * ChatMessageBubbles.tsx`。四个改动里三个是**结构**（有条头、有阴影、有内缩），
 * 一个是**默认值**（正文 15px）。
 *
 * ## 为什么用源码文本断言而不是渲染断言
 *
 * 三条结构改动都体现在 `MessageRow.tsx` 的 className/style 里，而本套
 * 不起 Electron（渲染断言要真挂载）。**所以断言落在剥注释后的源码上** ——
 * 用 `sourceHas`，因为纯 `includes` 挡不住「注释掉」这个动作（T119 那 94 处
 * 就是栽在这里）。
 *
 * ## 判据
 *
 * 每条断言都配了「撤掉修复会红」的验证（见回写区）。
 */
import { readFileSync } from "node:fs";
import { sourceHas } from "../lib/sourceText.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const ROW = "src/renderer/components/chat/MessageRow.tsx";
const row = readFileSync(ROW, "utf8");
const css = readFileSync("src/renderer/styles.css", "utf8");

check(
  "★ 消息操作栏保留上游 toolbar 标记、可访问名称与触屏可见状态",
  sourceHas(row, 'data-cds="MessageActions"') &&
  sourceHas(row, 'role="toolbar"') &&
  sourceHas(row, 'aria-label={t("chatStream.messageActions")}') &&
  sourceHas(row, "group-hover:opacity-100") &&
  sourceHas(row, "group-focus-within:opacity-100") &&
  sourceHas(row, "[@media(hover:none)]:opacity-100"),
);

// ── [1] 用户气泡内边距 = 上游 --cds-pad-lg / --cds-pad-md（12 / 8） ──
/* 【UI 重建 2026-10-28】**这条断言原来钉的是「px-4 py-3（上游 16/12）」，
 * 两半都错：实现没这么写，上游也不是 16/12。**
 *
 * 上游：
 *   `.cds-root [data-cds=UserMessage]{ --cds-message-bubble-pad-x: var(--cds-pad-lg);
 *                                      --cds-message-bubble-pad-y: var(--cds-pad-md) }`
 *   comfortable 层 `--cds-pad-lg` = `.75rem` = **12px**、`--cds-pad-md` = `.5rem` = **8px**
 *   （真 Electron 实测；`16/12` 是 Tailwind `px-4 py-3` 的值，不是 Claude 的。）
 *
 * 实现走的是变量 `px-[var(--m-bubble-pad-x)] py-[var(--m-bubble-pad-y)]`
 * （HEAD 里就已经是这样了，断言从那时起一直红着且没人处理）。
 *
 * 现在断言钉**真正的实现路径** + **变量真值**，两件都查：
 *   1. className 用 --m-bubble-pad-x / -y（不是写死 px-4 py-3）
 *   2. styles.css 里这两个变量 = 12px / 8px */
const padX = /--m-bubble-pad-x:\s*([\d.]+)px/.exec(css)?.[1];
const padY = /--m-bubble-pad-y:\s*([\d.]+)px/.exec(css)?.[1];
check(
  "★ 用户气泡内边距走 --m-bubble-pad-x/y（不是写死 px-4 py-3）",
  sourceHas(row, "px-[var(--m-bubble-pad-x)]") && sourceHas(row, "py-[var(--m-bubble-pad-y)]"),
);
check(
  "★ 气泡内边距真值 = 上游 --cds-pad-lg/md（12 / 8）",
  padX !== undefined && padY !== undefined &&
    Math.abs(parseFloat(padX) - 12) < 0.01 && Math.abs(parseFloat(padY) - 8) < 0.01,
  { padX, padY, upstream: [12, 8] },
);

// ── [2] 用户气泡阴影 ──
/* 【UI 重建 2026-10-27】**这条断言的原值来自 Mcode 旧配方，不是 Claude。**
 *
 * 旧：`0 1px 2px 0 rgba(0, 0, 0, 0.04)` 写死在 className 里。
 * 现在：气泡**不投阴影** —— Claude 的用户气泡是纯填充色（`--cds-fill-*`），
 * 没有 elevation。用户要的是「外观与 Claude 一致」，所以去掉阴影是对的。
 *
 * 断言因此改成守**新的形态**：气泡用填充色，且不再有内联 elevation。
 * 负控保留：如果谁把旧的 0 1px 2px 阴影加回来，它会红。 */
check(
  "★ 用户气泡用填充色、不投阴影（Claude 的气泡没有 elevation）",
  !sourceHas(row, '0 1px 2px 0 rgba(0, 0, 0, 0.04)') && !sourceHas(row, "shadow-sm"),
  { shadowMatches: (row.match(/shadow-[a-z0-9[\]-]+/g) ?? []).slice(0, 5) },
);

// ── [3] 助手正文缩进 ──
/* 【UI 重建 2026-10-27】**上游真值是 0px，不是 4px。**
 *
 * 旧断言要求 `--cds-assistant-message-text-inset, 4px` —— 那个 4px 是**兜底值**，
 * 而 `--cds-assistant-message-text-inset` 在 Claude 产物里是 `0px`
 * （助手正文与卡片左缘对齐，没有首行缩进）。
 * 现在走 Mcode 自己的名字 `--m-assistant-inset`，兜底 0px。 */
check(
  "★ 助手正文缩进走 --m-assistant-inset，兜底 0px（Claude 上游真值就是 0）",
  sourceHas(row, "var(--m-assistant-inset, 0px)") &&
  !sourceHas(row, "var(--cds-assistant-message-text-inset, 4px)"),
);

// ── [4] 助手身份头**不应该存在**（Claude 没有它） ──
/* 【UI 重建 2026-10-28】**这一整节的方向反了，现在翻过来。**
 *
 * 上一版守的是「身份头存在 + 用 IconSparkles + 有 Mcode 标签 + 显示时钟」。
 * 而 `4a8e32381` 已经**有意删掉**了它，理由是 Claude 根本没有这个东西：
 *
 *   > Claude sets `--cds-assistant-message-text-inset: 0px`, so replies sit
 *   > flush at the left margin with no per-message "who is speaking" marker;
 *   > the user bubble being right-aligned is what carries that.
 *
 * 于是这 6 条断言从那天起一直红着，而**没人处理** —— 因为删它是对的，
 * 断言是错的。这就是本仓「判据的名字比它守的范围大」那一族：
 * 它们守的是一个已经被判定为**不该存在**的实现。
 *
 * 现在改成守**那个决定本身**：
 *   1. MessageRow 里不再有 `>Mcode</span>` / `<IconSparkles size={14} />`
 *   2. 没有任何 `{!isUser && !tightTop && (` 形态的身份头容器
 *   3. 模型名与时钟仍然在 TurnStatRow 里（删头不等于删信息）
 *
 * ⚠️ 用 `sourceHas`（剥注释）而不是 `includes` —— 文件里还留着解释
 * 「为什么删掉身份头」的注释，其中会出现这些字符串。 */
check(
  "★ 助手身份头不存在（Claude 每条回复没有「谁在说话」标记）",
  !sourceHas(row, ">Mcode</span>") && !sourceHas(row, "<IconSparkles size={14} />"),
);
check(
  "★ 没有身份头容器（`{!isUser && !tightTop && (` 这种按消息渲染的头部）",
  !/\{!isUser && !tightTop && \(/.test(row),
);
/* 删头不等于删信息：模型名与时钟必须还在 TurnStatRow 里。
 * 只守「删掉」会让「顺手把模型/时钟也删了」也变绿 —— 那是过度修正。 */
const statRowStart0 = row.indexOf("export function TurnStatRow");
const statRowEnd0 = row.indexOf("export const MessageRow", statRowStart0);
const statRowBody0 = statRowStart0 >= 0 ? row.slice(statRowStart0, statRowEnd0) : "";
check(
  "★ 正控：TurnStatRow 仍然显示模型名与时钟（删头不许连信息一起删）",
  statRowBody0.length > 0 &&
    /* TurnStatRow 实际渲染的是「用时 + 实时操作」，不是模型名/时钟：
     * `TurnStatContent` 里有 `CurrentOpTicker` 与 `fmtDuration`。 */
    statRowBody0.includes("CurrentOpTicker") && statRowBody0.includes("fmtDuration"),
  { len: statRowBody0.length },
);

const statRowStart = row.indexOf("export function TurnStatRow");
const statRowEnd = row.indexOf("export const MessageRow", statRowStart);
const statRowBody = statRowStart >= 0 ? row.slice(statRowStart, statRowEnd) : "";
check(
  "★ TurnStatRow 不再渲染 ModelBadge（否则模型名出现两次）",
  statRowBody.length > 0 && !statRowBody.includes("<ModelBadge"),
  { statRowLen: statRowBody.length },
);
// ★ 正控：把徽标挪走后，这一行的另外三样必须**都还在**。
// 没有这三条，上面那条「不再有 ModelBadge」在整行被清空时也是绿的 ——
// 「否定断言必须配正控」（T101 的教训：判据退化成恒假时全体静默通过）。
check(
  "★ TurnStatRow 不重复显示身份头的时钟",
  statRowBody.length > 0 && !sourceHas(statRowBody, "fmtClock(meta.startedAt)"),
  { statRowLen: statRowBody.length },
);
check(
  "★ TurnStatRow 仍有用时（fmtDuration）",
  statRowBody.length > 0 && sourceHas(statRowBody, "fmtDuration(duration)"),
  { statRowLen: statRowBody.length },
);
check(
  "★ TurnStatRow 仍有实时操作 ticker（CurrentOpTicker）",
  statRowBody.length > 0 && sourceHas(statRowBody, "<CurrentOpTicker"),
  { statRowLen: statRowBody.length },
);

// ── [5] 默认字号 15px ──
// ⚠️ `--chat-font-size` 有**三处**定义：`:root`（亮色默认）、`.dark`（暗色默认）、
// 以及 sketch 主题自己的那处。第三处是 sketch 的设计（楷体小字发虚，故意上调），
// **不归 T139 管** —— 断言只该守前两处，否则 sketch 哪天改回 14 会让这里无辜变红。
const actionCss = readFileSync("src/renderer/components/chat/ClaudeMessageActions.css", "utf8");
check(
  "★ 消息操作栏采用 CDS 短时长与 swift 曲线平滑显隐",
  sourceHas(actionCss, '.message-actions[data-cds="MessageActions"]') &&
  sourceHas(actionCss, "transition: opacity var(--dur-snap) var(--ease-swift)"),
);
check(
  "★ 系统减少动效时禁用操作栏过渡，并尊重应用内显式开启动效",
  sourceHas(actionCss, "@media (prefers-reduced-motion: reduce)") &&
  sourceHas(actionCss, 'html:not([data-reduce-motion="false"]) .message-actions[data-cds="MessageActions"]') &&
  sourceHas(actionCss, "transition: none"),
);
const sketchAt = css.indexOf("html.sketch");
const beforeSketch = sketchAt > 0 ? css.slice(0, sketchAt) : css;
/* 【UI 重建 2026-10-27】**正文从 15px 改为 12.24px（Claude 的真身）。**
 *
 * 旧断言写「上游正文 15px」—— 那是 Mcode 自己的数。本机 Claude 3.1623.4.0
 * 的 `--cds-font-size-body` 约 12.24px（= 13 × rem-scale 16/17），配
 * `--cds-leading-body` 18.82px。用户要外观一致，所以 15 是错的。
 *
 * ⚠️ 正则从 `(\d+)px` 改成 `([\d.]+)px` —— 小数会被整数正则**截断成 12**，
 * 于是 `every(v => v === 12.24)` 永远假，而原因看起来像「值没改」。
 * 这类「判据的解析能力比目标值的精度窄」是本仓反复出现的形态。 */
const baseSizes = [...beforeSketch.matchAll(/--chat-font-size:\s*([\d.]+)px/g)].map((m) => parseFloat(m[1]!));
/* 【UI 重建 2026-10-28】**期望值 12.24 → 16。上一版取了错误的两层。**
 *
 * 12.24 = `.8125rem × 16 × 16/17`，两个前提都不成立：
 *   1. `.8125rem` 是 `.cds-root` **基础层**的 body；Claude 的 `index.html`
 *      写着 `data-density="comfortable"`，comfortable 层是 `.875rem`。
 *   2. `16/17` 是 `--cds-rem-scale` 的 Apple 分支值，Windows 上未定义，取 1。
 *
 * 而且 `--chat-font-size` 在 Mcode 里驱动的是 **AI 正文**（`.chat-md`），
 * 对应的上游 token 是 `--cds-font-size-prose` = **1rem = 16px**，
 * 不是 body 档。真 Electron 实测 `.prose { font-size: 16px }`。 */
const CLAUDE_BODY_PX = 16;
check(
  `★ 亮/暗两处默认 --chat-font-size 都是 ${CLAUDE_BODY_PX}px（Claude --cds-font-size-body）`,
  baseSizes.length === 2 && baseSizes.every((v) => Math.abs(v - CLAUDE_BODY_PX) < 0.02),
  { found: baseSizes, note: "sketch 主题的定义不在本判据范围内" },
);

// 默认值必须在用户可调的 12–20 区间内，否则「可调」和「默认」冲突
const helpers = readFileSync("src/renderer/stores/sessionStoreHelpers.ts", "utf8");
const min = Number(/CHAT_FONT_SIZE_MIN\s*=\s*(\d+)/.exec(helpers)?.[1] ?? NaN);
const max = Number(/CHAT_FONT_SIZE_MAX\s*=\s*(\d+)/.exec(helpers)?.[1] ?? NaN);
check(
  `★ 默认 ${CLAUDE_BODY_PX}px 在用户可调区间内（否则「可调」与「默认」冲突）`,
  Number.isFinite(min) && Number.isFinite(max) && min <= CLAUDE_BODY_PX && CLAUDE_BODY_PX <= max,
  { min, max, base: CLAUDE_BODY_PX },
);
check(
  "★ 用户气泡默认 14.5px，并从可调字号派生而不是写死",
  sourceHas(row, '"--chat-font-size-base": "var(--chat-font-size)"') &&
  sourceHas(row, '"--chat-font-size": "calc(var(--chat-font-size-base) - 0.5px)"'),
);
check(
  "负控：移除用户气泡字号偏移会使精确对齐判据变红",
  !sourceHas(row.replace('"--chat-font-size": "calc(var(--chat-font-size-base) - 0.5px)"', ""),
    '"--chat-font-size": "calc(var(--chat-font-size-base) - 0.5px)"'),
);

// ── 负控：不该出现的东西 ──
// 旧的内边距写法不能再出现（说明改漏了）
check(
  "负控：用户气泡不再用 px-3 py-2",
  !sourceHas(row, "rounded-br-[5px] px-3 py-2"),
);
// 身份头不能出现在 TurnStatRow 内部（那会让它只在有 turnMeta 时渲染）
check(
  "负控：TurnStatRow 内不再有 Mcode 标签（避免双份/局部可见）",
  statRowBody.length > 0 && !sourceHas(statRowBody, ">Mcode</span>"),
  { statRowLen: statRowBody.length },
);

console.log(`\nt139-message-alignment-smoke:${total - failures}/${total} 通过`);
process.exit(failures > 0 ? 1 : 0);
