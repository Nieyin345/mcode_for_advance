/**
 * `renderer/lib/contentTag.ts` 的回归网 —— 2026-09-24 立。
 *
 * ## 为什么单开一套
 *
 * 这个文件管**用户引用/粘贴进来的东西在提示词里长什么样**，而它此前**零覆盖**。
 * 今天加「引用」（`makeQuoteTag`）时踩到的正是这类坑：块的抬头、来源行、
 * `composePromptWithTags` 分到哪一支 —— 全都只在真机点一遍才看得出来，而真机点
 * 一遍的成本远高于这里跑 30 条断言。
 *
 * ## 它守的三条规矩
 *
 * 1. **引用要自报"我是引用、不是用户输入"**（用户原话）。没有抬头的话，模型分不清
 *    「用户说的话」和「用户从别处摘的材料」。
 * 2. **文件引用必须带上文件在哪**（用户原话：「说清楚文件在哪里」）。
 * 3. **别的对话引用只给标题 + id，不给正文** —— 用户明确否掉了"把别的对话全文插
 *    进来"，要的是让模型自己用 `session_read_log` 去查。
 *
 * 纯模块（不 import electron / store），所以直接 bundle 就能跑。
 *
 * Run: scripts/content-tag-smoke/run.sh
 */
import {
  composePromptWithTags,
  makeContentTag,
  makeFileTag,
  makeQuoteTag,
  TAG_PREVIEW_CHARS,
} from "@renderer/lib/contentTag.js";

let checks = 0;
let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    passed++;
    return;
  }
  failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { expected, got: actual });
}

/* ── 1. 引用块自报类型（用户要求的那句「很简短的解释」）────────────────── */

const chatQuote = makeQuoteTag({
  text: "这行是我从历史里摘的",
  origin: { kind: "chat", sessionTitle: "当前这条" },
});
eq("对话引用的 kind 是 quote", chatQuote.kind, "quote");
check("…抬头写明这是**用户的引用**", chatQuote.content.startsWith("--- user's quote"), chatQuote.content);
check("…抬头点明类型是「当前对话的历史记录」", chatQuote.content.includes("current conversation history"), chatQuote.content);
check("…正文原样保留（不压缩）", chatQuote.content.includes("这行是我从历史里摘的"), chatQuote.content);

const fileQuote = makeQuoteTag({
  text: "文件里的那段话",
  origin: { kind: "file", filePath: "D:/proj/notes/a.md", name: "a.md" },
});
check("文件引用点明类型是「文件中的一段」", fileQuote.content.includes("a passage from a file"), fileQuote.content);
check(
  "⚠️ 文件引用**带上了绝对路径**（用户要求「说清楚文件在哪里」）",
  fileQuote.content.includes("D:/proj/notes/a.md"),
  fileQuote.content,
);
check("…source 行走 `source:` 约定（与 makeElementTag 同一套，不混语法）", fileQuote.content.includes("source: D:/proj/notes/a.md"), fileQuote.content);
check("…chip 上显示的是文件名", fileQuote.preview === "a.md", fileQuote.preview);
const rangeQuote = makeQuoteTag({
  text: "第 12 到 14 行",
  origin: { kind: "file", filePath: "D:/proj/x.ts", name: "x.ts", lines: { start: 12, end: 14 } },
});
check("编辑器里选的引用带上行号范围", rangeQuote.content.includes("source: D:/proj/x.ts (lines 12-14)"), rangeQuote.content);
const lineQuote = makeQuoteTag({
  text: "就一行",
  origin: { kind: "file", filePath: "D:/proj/x.ts", name: "x.ts", lines: { start: 7, end: 7 } },
});
check("…单行写成 line N", lineQuote.content.includes("source: D:/proj/x.ts (line 7)"), lineQuote.content);

/* ── 2. 别的对话：只给标题 + id，**不给正文** ─────────────────────────── */

const otherQuote = makeQuoteTag({
  text: "这段文本不该出现（调用方传了也不该用它）",
  origin: { kind: "otherSession", sessionTitle: "上周那条调研", sessionId: "sess_abc123" },
});
check("别的对话引用点明类型是「另一条对话」", otherQuote.content.includes("another conversation"), otherQuote.content);
check("…带上了对话标题", otherQuote.content.includes("上周那条调研"), otherQuote.content);
check("…带上了对话 id（模型手边有读对话工具时才用得上）", otherQuote.content.includes("sess_abc123"), otherQuote.content);
check(
  "⚠️ **不带正文** —— 用户明确要求让模型自己查，不要插全文",
  !otherQuote.content.includes("这段文本不该出现"),
  otherQuote.content,
);
check(
  "…指引模型去读（有按 id 读对话的工具就用）",
  otherQuote.content.includes("reads") || otherQuote.content.includes("conversation logs"),
  otherQuote.content,
);
check(
  "⚠️ **不点名 session_read_log** —— 网页模型那条路的工具表里没有它，点名会诱导幻觉调用",
  !otherQuote.content.includes("session_read_log"),
  otherQuote.content,
);

/* ── 3. 展示名截断（chip 宽度有上限）───────────────────────────────────── */

const longTitle = "很".repeat(TAG_PREVIEW_CHARS + 10);
const longQuote = makeQuoteTag({ text: "x", origin: { kind: "chat", sessionTitle: longTitle } });
check(
  "过长的展示名被截断并加省略号",
  longQuote.preview.length === TAG_PREVIEW_CHARS + 1 && longQuote.preview.endsWith("…"),
  longQuote.preview,
);

/* ── 4. 拼进提示词：引用是**原样发出**，不再包一层 paste ─────────────────── */

const promptWithQuote = composePromptWithTags("我的问题", [chatQuote]);
check(
  "引用块原样进提示词（保留自己的抬头）",
  promptWithQuote.includes("--- user's quote"),
  promptWithQuote,
);
check(
  "⚠️ **不再被包一层 `--- pasted content ---`** —— 那会让模型以为这是用户粘贴的正文",
  !promptWithQuote.includes("pasted content"),
  promptWithQuote,
);
check("用户打的字排在前面", promptWithQuote.startsWith("我的问题"), promptWithQuote);

// 对照：粘贴进来的**仍然**走 pasted content 那一支（别把 paste 也改坏了）。
const pasted = makeContentTag("一段很长的粘贴内容");
const promptWithPaste = composePromptWithTags("我的问题", [pasted]);
check(
  "粘贴内容仍然包 `--- pasted content ---`（没被这次改动带偏）",
  promptWithPaste.includes("pasted content"),
  promptWithPaste,
);

// 对照：文件 tag 仍然只是一行 `@路径`。
const fileTag = makeFileTag("D:/proj/x.ts");
const promptWithFile = composePromptWithTags("", [fileTag]);
eq("文件 tag 进提示词就是一行 @路径", promptWithFile, "@D:/proj/x.ts");

/* ── 5. 混在一起时的顺序与分隔 ───────────────────────────────────────── */

const mixed = composePromptWithTags("问题", [chatQuote, fileTag, pasted]);
check("混排时引用在前（按 tags 数组序）", mixed.indexOf("user's quote") < mixed.indexOf("@D:/proj/x.ts"), mixed);
check("…文件引用在粘贴之前", mixed.indexOf("@D:/proj/x.ts") < mixed.indexOf("pasted content"), mixed);

/* ── 收尾 ── */

if (failures.length > 0) {
  console.error(`\n失败 ${failures.length} 条:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`${passed}/${checks} 通过`);
