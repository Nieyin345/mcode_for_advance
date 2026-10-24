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
// 关键：身份头的渲染条件里不能出现 turnMeta —— 否则没有回合元数据的消息就没有头。
// 取**渲染表达式本身**（从 `{!isUser && !tightTop && (` 到它闭合的 `)}`），
// 不含紧随其后的 TurnStatRow 注释与渲染。
const headCondRe = /\{!isUser && !tightTop && \([\s\S]*?\)\}/;
const headCond = headCondRe.exec(row)?.[0] ?? "";
check(
  "★ 身份头的条件不依赖 turnMeta（否则无元数据的消息看不到头）",
  headCond.length > 0 && !headCond.includes("turnMeta"),
  { found: headCond.length > 0, hasTurnMeta: headCond.includes("turnMeta") },
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
const statRowStart = row.indexOf("export function TurnStatRow");
const statRowEnd = row.indexOf("export const MessageRow", statRowStart);
const statRow = statRowStart >= 0 ? row.slice(statRowStart, statRowEnd) : "";
check(
  "负控：TurnStatRow 内不再有 Mcode 标签（避免双份/局部可见）",
  statRow.length > 0 && !sourceHas(statRow, ">Mcode</span>"),
  { statRowLen: statRow.length },
);

console.log(`\nt139-message-alignment-smoke:${total - failures}/${total} 通过`);
process.exit(failures > 0 ? 1 : 0);
