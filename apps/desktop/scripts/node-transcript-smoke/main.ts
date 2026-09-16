/**
 * Headless smoke for 「看这一步的过程」的折叠逻辑(`main/claude/nodeTranscript.ts`)。
 *
 * ## 为什么这一段值得单测
 *
 * 它是"用户能不能看见子代理干了什么"的**唯一**一处逻辑,而且全是"看着像对、细看不对"
 * 的分支:流式文本要不要并、工具结果配不配得回那次调用、乱序/重复的要不要安静丢掉、
 * 什么时候该往界面推。这些错了**不会报错**,只会让那张卡片显示成一段缺斤少两的过程。
 *
 * ## 为什么能无头跑
 *
 * `nodeTranscript.ts` 只 import **类型**(`@contracts/runtime`),没有 electron、没有
 * 文件系统、没有 SDK —— 纯函数。所以这个 suite 一个桩都不用换。
 *
 * **没覆盖的**:事件到底有没有从 `RuntimeManager` 流到渲染端(那是接线,要跑真的应用),
 * 以及卡片长什么样(要真的看界面)。
 *
 * Run: scripts/node-transcript-smoke/run.sh
 */
import type { RuntimeEvent, TranscriptBlock } from "@contracts/runtime";
import { foldTranscript } from "@main/claude/nodeTranscript.js";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

const SID = "sess_node";

function text(t: string): RuntimeEvent {
  return { type: "text.delta", sessionId: SID, messageId: "m1", text: t };
}
function thinking(t: string): RuntimeEvent {
  return { type: "thinking", sessionId: SID, messageId: "m1", text: t };
}
function toolUse(id: string, name: string, input: unknown = {}): RuntimeEvent {
  return { type: "tool.use", sessionId: SID, toolCallId: id, toolName: name, input, requiresApproval: false };
}
function toolResult(id: string, content: unknown, isError = false): RuntimeEvent {
  return { type: "tool.result", sessionId: SID, toolCallId: id, isError, content };
}
/** 折一串事件,断言每一步都有结果(这个 suite 里没有"不该管"的事件)。 */
function foldAll(events: RuntimeEvent[], start: TranscriptBlock[] = []): TranscriptBlock[] {
  let blocks = start;
  for (const e of events) {
    const r = foldTranscript(blocks, e);
    if (!r) throw new Error(`预期 ${e.type} 会被折进来,却返回了 null`);
    blocks = r.blocks;
  }
  return blocks;
}

function main(): void {
  console.log("\n流式文本:要并,而且不许原地改");
  const first = foldTranscript([], text("用户要"))!;
  eq("第一段起一个新块", first.blocks.length, 1);
  eq("内容是原样", first.blocks[0].kind === "text" ? first.blocks[0].text : "", "用户要");
  eq("逐字的那种**不推**给界面", first.broadcast, false);

  const second = foldTranscript(first.blocks, text("一篇综述"))!;
  eq("连着来的第二段并进同一个块", second.blocks.length, 1);
  eq(
    "拼起来是完整的一句",
    second.blocks[0].kind === "text" ? second.blocks[0].text : "",
    "用户要一篇综述",
  );
  // 渲染端拿引用做相等判断 —— 原地改会让它以为"没变"从而不重渲染。
  check("原数组没被就地改掉", first.blocks[0].kind === "text" && first.blocks[0].text === "用户要");
  check("返回的是新数组", second.blocks !== first.blocks);

  const empty = foldTranscript(second.blocks, text(""))!;
  check("空 delta 不产生新数组(引用不变,调用方可以跳过)", empty.blocks === second.blocks);

  console.log("\n思考:和文本同一条规矩,但**不与文本混**");
  const withThinking = foldAll([text("先说一句"), thinking("我想想"), thinking("……好了")]);
  eq("三种块:文本 + 一个合并后的思考", withThinking.length, 2);
  eq("思考并成一个", withThinking[1].kind === "thinking" ? withThinking[1].text : "", "我想想……好了");
  const textAfterThinking = foldAll([thinking("想"), text("说")]);
  eq("换种了就另起一块", textAfterThinking.length, 2);

  console.log("\n工具调用:一发生就推,结果配回它那次调用");
  const use = foldTranscript([], toolUse("t1", "Read", { path: "a.md" }))!;
  eq("推一个工具块", use.blocks.length, 1);
  eq("状态是 running", use.blocks[0].kind === "tool_use" ? use.blocks[0].status : "", "running");
  eq("工具调用**马上推**(这才是用户想实时看的)", use.broadcast, true);
  eq("工具名带上了", use.blocks[0].kind === "tool_use" ? use.blocks[0].toolName : "", "Read");

  const done = foldTranscript(use.blocks, toolResult("t1", "文件内容"))!;
  eq("结果配回同一个块(块数不变)", done.blocks.length, 1);
  eq("状态变 done", done.blocks[0].kind === "tool_use" ? done.blocks[0].status : "", "done");
  eq("结果挂上了", done.blocks[0].kind === "tool_use" ? done.blocks[0].result : undefined, "文件内容");
  eq("结果也马上推", done.broadcast, true);
  check("原块没被就地改掉", use.blocks[0].kind === "tool_use" && use.blocks[0].status === "running");

  const errored = foldAll([toolUse("t2", "Bash"), toolResult("t2", "炸了", true)]);
  eq("报错的工具标 error", errored[0].kind === "tool_use" ? errored[0].status : "", "error");

  console.log("\n工具调用:重复和配不上的要安静丢掉");
  eq(
    "结果找不到对应调用 → 不理会(凭空多一个块更让人困惑)",
    foldTranscript(done.blocks, toolResult("t9", "谁的?")),
    null,
  );
  eq(
    "同一次调用再来一条结果(重放)→ 不理会",
    foldTranscript(done.blocks, toolResult("t1", "又一条")),
    null,
  );
  const dup = foldTranscript(use.blocks, toolUse("t1", "Read"))!;
  eq("同一个 toolCallId 再来一次调用 → 不叠一个块", dup.blocks.length, 1);
  eq("而且不推", dup.broadcast, false);

  console.log("\n边界事件:块没变,但攒着的文本要冲出去");
  for (const [name, e] of [
    ["message.complete", { type: "message.complete", sessionId: SID, messageId: "m1" }],
    ["turn.done", { type: "turn.done", sessionId: SID, endedAt: 1, reason: "end_turn" }],
    [
      "turn.incomplete",
      { type: "turn.incomplete", sessionId: SID, kind: "unfinished-text", pendingToolCalls: [] },
    ],
  ] as Array<[string, RuntimeEvent]>) {
    const r = foldTranscript(second.blocks, e);
    check(`${name} 会被折(返回结果)`, r !== null);
    eq(`${name} 不改块(引用不变)`, r?.blocks, second.blocks);
    eq(`${name} **要推** —— 逐字攒下的那一整段在这里一次出去`, r?.broadcast, true);
  }

  console.log("\n不是这个过程该管的事件:一律 null");
  for (const [name, e] of [
    ["token-usage.updated", { type: "token-usage.updated", sessionId: SID, snapshot: {} }],
    ["subagent.update", { type: "subagent.update", sessionId: SID, agents: [] }],
    ["todo.update", { type: "todo.update", sessionId: SID, todos: [] }],
    ["workflow.node.result", { type: "workflow.node.result", sessionId: SID, runId: "r", nodeId: "n", nodeType: "mcode.agent", title: "t", status: "success", summary: "" }],
  ] as Array<[string, RuntimeEvent]>) {
    eq(`${name} → 不管`, foldTranscript(second.blocks, e), null);
  }

  console.log("\n串起来跑一遍:一次像样的节点回合");
  const run = foldAll([
    thinking("先想想要查什么"),
    text("我去查一下"),
    toolUse("t1", "mcp__mcode-library__library_search", { query: "量子密钥" }),
    toolResult("t1", "命中 3 条"),
    text("查到了,再读一篇"),
    toolUse("t2", "Read", { path: "paper.md" }),
    toolResult("t2", "正文……"),
    { type: "message.complete", sessionId: SID, messageId: "m2" },
    text("结论是……"),
    { type: "turn.done", sessionId: SID, endedAt: 2, reason: "end_turn" },
  ]);
  eq("最后是:思考 + 文本 + 工具 + 文本 + 工具 + 文本", run.length, 6);
  const kinds = run.map((b) => b.kind).join(",");
  eq("形状对得上", kinds, "thinking,text,tool_use,text,tool_use,text");
  eq(
    "两段工具后的文本各自成块(没被合成一段)",
    run.filter((b) => b.kind === "text").length,
    3,
  );
  check(
    "两次工具调用都拿到了结果",
    run.filter((b) => b.kind === "tool_use").every((b) => b.kind === "tool_use" && b.status === "done"),
    run.filter((b) => b.kind === "tool_use"),
  );

  console.log(`\n${checks - failures}/${checks} 通过`);
  if (failures > 0) {
    console.log(`${failures} 条失败`);
    process.exitCode = 1;
  }
}

main();
