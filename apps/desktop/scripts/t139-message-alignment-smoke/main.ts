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

check(
  "★ 消息操作栏保留上游 toolbar 标记、可访问名称与触屏可见状态",
  sourceHas(row, 'data-cds="MessageActions"') &&
  sourceHas(row, 'role="toolbar"') &&
  sourceHas(row, 'aria-label={t("chatStream.messageActions")}') &&
  sourceHas(row, "group-hover:opacity-100") &&
  sourceHas(row, "group-focus-within:opacity-100") &&
  sourceHas(row, "[@media(hover:none)]:opacity-100"),
);

// ── [1] 用户气泡内边距 px-4 py-3（上游 16/12） ──
check(
  "★ 用户气泡内边距 = px-4 py-3（上游 16/12）",
  sourceHas(row, "px-4 py-3 text-content"),
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

// ── [4] 助手身份头（✦ + Mcode），且**不依赖 turnMeta** ──
check(
  "★ 助手身份头存在（Mcode 标签）",
  sourceHas(row, ">Mcode</span>"),
);
check(
  "★ 身份头用 IconSparkles 图标（14px，Claude 小号头部规格）",
  sourceHas(row, "<IconSparkles size={14} />"),
);
// 关键：身份头**本身**的渲染条件里不能出现 turnMeta —— 否则没有回合元数据的
// 消息整条头都没有。只取条件表达式 `{!isUser && !tightTop && (` 本身，
// 不含块内的 `{msg.turnMeta && <ModelBadge/>}` —— 模型徽标**可以**依赖它，
// 因为那只是「这个回合有没有记录模型」，不是「整条头存不存在」。
const headCondExpr = /\{!isUser && !tightTop && \(/.exec(row)?.[0] ?? "";
check(
  "★ 身份头的渲染条件不依赖 turnMeta（否则无元数据的消息整条头都没有）",
  headCondExpr.length > 0 && !headCondExpr.includes("turnMeta"),
  { cond: headCondExpr },
);

// ── [4b] 模型徽标归身份头，不归 TurnStatRow ──
// 上游的头部是 `[✦] Claude [model]` —— 模型属于「谁在说话」。而 TurnStatRow
// 是运行状态（时钟/用时/实时操作），两者同屏但职责不同。
//
// 取整块的边界用**下一行的注释/条件**做锚，而不是靠正则括号配平
// （JSX 里嵌套的 `)}` 会让贪婪正则吃过头）。
const headStart = row.indexOf("{!isUser && !tightTop && (");
const headEnd = row.indexOf("{!isUser && msg.turnMeta && !hideTurnStat", headStart);
const headBlock = headStart >= 0 && headEnd > headStart ? row.slice(headStart, headEnd) : "";
check(
  "★ 身份头使用纯文字模型药丸，而不是第二个模型头像",
  headBlock.length > 0 && headBlock.includes("modelName &&") &&
  headBlock.includes("font-mono text-[10px]") && !headBlock.includes("<ModelBadge"),
  { headLen: headBlock.length },
);
/* 【UI 重建 2026-10-27】**几何从「20px 圆角底盘」改成「无底盘的小图标」。**
 *
 * 旧的 `size-5 rounded-md shadow-2xs` 是 Mcode 自己给图标加的一层底板 ——
 * Claude 的身份头没有底盘，就是一颗 14px 的 sparkle 直接排在名字前面。
 * 所以断言改守新形态：**有** `data-cds="AssistantAvatar"` 这个稳定挂点，
 * **没有**那层底盘（`rounded-md` / `shadow-2xs`）。
 * 负控在下面：把底盘加回来，这条会红。 */
check(
  "★ 身份头图标无底盘（Claude 的 sparkle 直接排在名字前，不套圆角方块）",
  headBlock.includes('data-cds="AssistantAvatar"') &&
  headBlock.includes("size-4") &&
  !headBlock.includes("shadow-2xs"),
  { headLen: headBlock.length },
);
check(
  "★ 身份头显示时钟；TurnPanel 已拥有时钟时不重复显示",
  headBlock.includes("!hideTurnStat") &&
  headBlock.includes("fmtClock(msg.turnMeta?.startedAt ?? msg.createdAt)"),
  { headLen: headBlock.length },
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
const css = readFileSync("src/renderer/styles.css", "utf8");
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
const CLAUDE_BODY_PX = 12.24;
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
