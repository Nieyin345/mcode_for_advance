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

// ── [1] 用户气泡内边距 px-4 py-3（上游 16/12） ──
check(
  "★ 用户气泡内边距 = px-4 py-3（上游 16/12）",
  sourceHas(row, "px-4 py-3 text-content"),
);

// ── [2] 用户气泡阴影 ──
check(
  "★ 用户气泡有 0 1px 2px rgba(0,0,0,0.04) 投影（上游同值）",
  sourceHas(row, '0 1px 2px 0 rgba(0, 0, 0, 0.04)'),
);

// ── [3] 助手正文 4px 左缩进 ──
check(
  "★ 助手正文有 --cds-assistant-message-text-inset 4px 缩进",
  sourceHas(row, "var(--cds-assistant-message-text-inset, 4px)"),
);

// ── [4] 助手身份头（✦ + Mcode），且**不依赖 turnMeta** ──
check(
  "★ 助手身份头存在（Mcode 标签）",
  sourceHas(row, ">Mcode</span>"),
);
check(
  "★ 身份头用 IconSparkles 图标",
  sourceHas(row, "<IconSparkles size={10} />"),
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
  "★ 模型徽标在身份头里（上游 [✦] Claude [model] 的形状）",
  headBlock.length > 0 && headBlock.includes("<ModelBadge"),
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
  "★ TurnStatRow 仍有时钟（fmtClock）",
  statRowBody.length > 0 && sourceHas(statRowBody, "fmtClock(meta.startedAt)"),
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
const sketchAt = css.indexOf("html.sketch");
const beforeSketch = sketchAt > 0 ? css.slice(0, sketchAt) : css;
const baseSizes = [...beforeSketch.matchAll(/--chat-font-size:\s*(\d+)px/g)].map((m) => Number(m[1]));
check(
  "★ 亮/暗两处默认 --chat-font-size 都是 15px（上游正文 15px）",
  baseSizes.length === 2 && baseSizes.every((v) => v === 15),
  { found: baseSizes, note: "sketch 主题的定义不在本判据范围内" },
);

// 15 必须在用户可调的 12–20 区间内，否则「可调」和「默认」冲突
const helpers = readFileSync("src/renderer/stores/sessionStoreHelpers.ts", "utf8");
const min = Number(/CHAT_FONT_SIZE_MIN\s*=\s*(\d+)/.exec(helpers)?.[1] ?? NaN);
const max = Number(/CHAT_FONT_SIZE_MAX\s*=\s*(\d+)/.exec(helpers)?.[1] ?? NaN);
check(
  "★ 默认 15px 在用户可调区间内（否则「可调」与「默认」冲突）",
  Number.isFinite(min) && Number.isFinite(max) && min <= 15 && 15 <= max,
  { min, max },
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
