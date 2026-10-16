/**
 * 【MC-009】引擎无关的回合截断检测 —— 三个适配器消费**同一份判据**。
 *
 * 从前三种截断形态（dangling-tools / empty-response / unfinished-text）只有
 * Claude 侧挡着；同一网关症状（空补全 / finish_reason 被抹平）在 Pi / Codex
 * 下静默报完成。本套件钉两件事：
 *
 *   1. **判据本体**（`providers/turnIncomplete.ts`）：三种形态各命中、健康轮
 *      不命中、每条守卫（成功收尾 / 未中断 / 跑过工具 / 交互轮 / 末条带工具）
 *      真的挡得住 —— 备掉的守卫要能各自红。
 *   2. **三个适配器的接线**（真喂事件、看真事件流）：Claude 喂
 *      assistant(tool_use)→result(success)，Pi 喂 tool_execution_start→agent_end
 *      （末尾悬空 / 空叙述 / 断句三种），Codex 喂 item/started→turn/completed。
 *      接线断言盯的是**发出来的 turn.incomplete**（renderer 的琥珀卡直接消费
 *      的那个事件），不是内部函数名 —— 撤掉任何一侧的接线都必须红。
 *
 * 真适配器直接实例化（只 import 契约包 + fileSnapshot / 纯 fs），不起 Electron、
 * 不写数据根。
 */
// @smoke-covers src/main/providers/turnIncomplete.ts
// @smoke-covers src/main/providers/pi-sdk/PiMessageAdapter.ts
// @smoke-covers src/main/providers/codex-sdk/CodexMessageAdapter.ts
// @smoke-covers src/main/providers/claude-sdk/SdkMessageAdapter.ts
import { PiMessageAdapter } from "@main/providers/pi-sdk/PiMessageAdapter.js";
import { SdkMessageAdapter } from "@main/providers/claude-sdk/SdkMessageAdapter.js";
import { CodexMessageAdapter } from "@main/providers/codex-sdk/CodexMessageAdapter.js";
import { FileSnapshot } from "@main/lib/fileSnapshot.js";
import { detectTurnIncomplete, type TurnIncompleteFacts } from "@main/providers/turnIncomplete.js";

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

type Ev = { type: string; [k: string]: unknown };

function makeCtx(events: Ev[]): never {
  return {
    emit: (e: Ev) => events.push(e),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as never;
}

/* ──────────────── 1. 判据本体（纯函数） ──────────────── */

console.log("\n1. 判据本体：三种形态");
{
  const base: TurnIncompleteFacts = {
    endedSuccessfully: true,
    aborted: false,
    danglingToolCalls: [],
    textEmitted: true,
    toolUseCount: 2,
    interactionToolSeen: false,
    lastAssistantText: "做完了，结果是 3。",
    lastAssistantHadToolUse: false,
  };

  // 健康轮不命中。
  check("健康收尾的轮 → 无判定", detectTurnIncomplete(base) === null);

  // 形态一：悬空工具。
  const dangling = detectTurnIncomplete({
    ...base,
    danglingToolCalls: [{ toolCallId: "t1", toolName: "Read" }],
  });
  check("悬空工具 → dangling-tools 且点名工具", dangling?.kind === "dangling-tools" && dangling.pendingToolCalls.length === 1, dangling);

  // 形态二：跑了工具但一个字没说。
  const empty = detectTurnIncomplete({ ...base, textEmitted: false });
  check("跑过工具、零叙述 → empty-response", empty?.kind === "empty-response", empty);

  // 形态三：末条断在继续性标点上。
  const cut = detectTurnIncomplete({ ...base, lastAssistantText: "先读当前完整 onSplitConfirm：" });
  check("末条断在冒号 → unfinished-text", cut?.kind === "unfinished-text", cut);

  // 形态三之二：代码围栏没关。
  const fence = detectTurnIncomplete({ ...base, lastAssistantText: "```ts\nconst x = 1;" });
  check("代码围栏没关 → unfinished-text", fence?.kind === "unfinished-text", fence);

  // 优先级：悬空工具盖过其余两种。
  const both = detectTurnIncomplete({
    ...base,
    danglingToolCalls: [{ toolCallId: "t1", toolName: "Bash" }],
    lastAssistantText: "等等：",
  });
  check("悬空工具与断句同时出现 → 报 dangling-tools（先取证）", both?.kind === "dangling-tools", both);
}

console.log("\n2. 判据本体：每条守卫都要挡得住");
{
  const base: TurnIncompleteFacts = {
    endedSuccessfully: true,
    aborted: false,
    danglingToolCalls: [{ toolCallId: "t1", toolName: "Read" }],
    textEmitted: false,
    toolUseCount: 2,
    interactionToolSeen: false,
    lastAssistantText: "",
    lastAssistantHadToolUse: false,
  };

  check("守卫：非成功收尾（错误子类）→ 不报", detectTurnIncomplete({ ...base, endedSuccessfully: false }) === null);
  check("守卫：用户中断 → 不报（悬空工具是预期行为）", detectTurnIncomplete({ ...base, aborted: true }) === null);
  check(
    "守卫：交互工具驱动的无叙述轮 → 不报 empty-response",
    detectTurnIncomplete({ ...base, danglingToolCalls: [], interactionToolSeen: true }) === null,
  );
  check(
    "守卫：纯聊天轮末条一个冒号 → 不报（跑过工具才查断句）",
    detectTurnIncomplete({
      ...base,
      danglingToolCalls: [],
      textEmitted: true,
      toolUseCount: 0,
      lastAssistantText: "你希望我怎么做：",
    }) === null,
  );
  check(
    "守卫：末条挂着工具派发 → 断句不可推断，不报",
    detectTurnIncomplete({
      ...base,
      danglingToolCalls: [],
      textEmitted: true,
      lastAssistantText: "接下来：",
      lastAssistantHadToolUse: true,
    }) === null,
  );
  check(
    "守卫：零内容轮（没工具没文本）→ 不报（error 卡覆盖那种情形）",
    detectTurnIncomplete({
      ...base,
      danglingToolCalls: [],
      textEmitted: false,
      toolUseCount: 0,
    }) === null,
  );
}

/* ──────────────── 3. Claude 适配器接线 ──────────────── */

console.log("\n3. Claude 侧：真喂消息，看真事件");
{
  const events: Ev[] = [];
  const adapter = new SdkMessageAdapter(makeCtx(events), "s-claude", false, process.cwd(), new FileSnapshot());

  // 模型派发一个 Read，网关用空补全收尾 → dangling-tools。
  await adapter.dispatch({
    type: "assistant",
    parent_tool_use_id: null,
    session_id: "s-claude",
    uuid: "a1",
    message: { id: "m1", model: "x", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
  } as never);
  await adapter.dispatch({ type: "result", subtype: "success", is_error: false, result: "" } as never);
  await adapter.flushFinal();
  const inc = events.filter((e) => e.type === "turn.incomplete");
  check("★ Claude：悬空 Read + success 收尾 → 发 turn.incomplete", inc.length === 1, events.map((e) => e.type));
  check("★ Claude：kind=dangling-tools 且点名 Read", inc[0]?.kind === "dangling-tools" && (inc[0]?.pendingToolCalls as Ev[] | undefined)?.[0]?.toolName === "Read", inc[0]);
}

/* ──────────────── 4. Pi 适配器接线 ──────────────── */

console.log("\n4. Pi 侧：同一判据接到真事件流");
{
  // 形态一：工具在飞，轮正常结束（agent_end stopReason=stop）。
  const events: Ev[] = [];
  const adapter = new PiMessageAdapter(makeCtx(events), "s-pi", () => undefined, { async freeze() { return []; } } as never);
  adapter.dispatch({
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "read_file",
    args: {},
  } as never);
  adapter.dispatch({
    type: "agent_end",
    willRetry: false,
    messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "reply" }] }],
  } as never);
  const inc = events.filter((e) => e.type === "turn.incomplete");
  check("★ Pi：悬空工具 + 正常收尾 → 发 turn.incomplete", inc.length === 1, events.map((e) => e.type));
  check("★ Pi：kind=dangling-tools", inc[0]?.kind === "dangling-tools", inc[0]);
  check("★ Pi：turn.incomplete 在 turn.done 之前（琥珀卡盖得过「回合完成」那条 toast）", events.findIndex((e) => e.type === "turn.incomplete") < events.findIndex((e) => e.type === "turn.done"), events.map((e) => e.type));
}
{
  // 形态二：工具跑完、一个字没说。
  const events: Ev[] = [];
  const adapter = new PiMessageAdapter(makeCtx(events), "s-pi2", () => undefined, { async freeze() { return []; } } as never);
  adapter.dispatch({ type: "tool_execution_start", toolCallId: "c1", toolName: "read_file", args: {} } as never);
  adapter.dispatch({ type: "tool_execution_end", toolCallId: "c1", toolName: "read_file", isError: false, result: "ok" } as never);
  adapter.dispatch({
    type: "agent_end",
    willRetry: false,
    messages: [{ role: "assistant", stopReason: "stop", content: [] }],
  } as never);
  const inc = events.filter((e) => e.type === "turn.incomplete");
  check("★ Pi：工具跑完零叙述 → empty-response", inc.length === 1 && inc[0]?.kind === "empty-response", inc);
}
{
  // 形态三：末条断在冒号。
  const events: Ev[] = [];
  const adapter = new PiMessageAdapter(makeCtx(events), "s-pi3", () => undefined, { async freeze() { return []; } } as never);
  adapter.dispatch({ type: "tool_execution_start", toolCallId: "c1", toolName: "read_file", args: {} } as never);
  adapter.dispatch({ type: "tool_execution_end", toolCallId: "c1", toolName: "read_file", isError: false, result: "ok" } as never);
  adapter.dispatch({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "先读当前完整 onSplitConfirm：" },
  } as never);
  adapter.dispatch({
    type: "agent_end",
    willRetry: false,
    messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "先读当前完整 onSplitConfirm：" }] }],
  } as never);
  const inc = events.filter((e) => e.type === "turn.incomplete");
  check("★ Pi：末条断在冒号 → unfinished-text", inc.length === 1 && inc[0]?.kind === "unfinished-text", inc);
}
{
  // 健康轮：工具配对、有叙述、正常结束 → 不发。
  const events: Ev[] = [];
  const adapter = new PiMessageAdapter(makeCtx(events), "s-pi4", () => undefined, { async freeze() { return []; } } as never);
  adapter.dispatch({ type: "tool_execution_start", toolCallId: "c1", toolName: "read_file", args: {} } as never);
  adapter.dispatch({ type: "tool_execution_end", toolCallId: "c1", toolName: "read_file", isError: false, result: "ok" } as never);
  adapter.dispatch({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "做完了，结果是 3。" },
  } as never);
  adapter.dispatch({
    type: "agent_end",
    willRetry: false,
    messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "做完了，结果是 3。" }] }],
  } as never);
  check("★ Pi：健康轮（配对+叙述+正常收尾）→ 不发", events.every((e) => e.type !== "turn.incomplete"), events.map((e) => e.type));
}
{
  // 用户中断：悬空工具是预期 → 不发。
  const events: Ev[] = [];
  const adapter = new PiMessageAdapter(makeCtx(events), "s-pi5", () => undefined, { async freeze() { return []; } } as never);
  adapter.dispatch({ type: "tool_execution_start", toolCallId: "c1", toolName: "read_file", args: {} } as never);
  adapter.dispatch({
    type: "agent_end",
    willRetry: false,
    messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
  } as never);
  check("★ Pi：用户中断（悬空工具预期）→ 不发", events.every((e) => e.type !== "turn.incomplete"), events.map((e) => e.type));
}

/* ──────────────── 5. Codex 适配器接线 ──────────────── */

console.log("\n5. Codex 侧：同一判据接到真事件流");
const MAIN = "main-thread", SUB = "sub-thread";
function codexHarness(): { adapter: CodexMessageAdapter; events: Ev[]; send: (method: string, params: Record<string, unknown>) => void } {
  const events: Ev[] = [];
  const adapter = new CodexMessageAdapter(makeCtx(events), "s-codex", { async freeze() { return []; } } as never, undefined);
  adapter.setMainThreadId(MAIN);
  const send = (method: string, params: Record<string, unknown>) => adapter.handleNotification({ method, params } as never);
  return { adapter, events, send };
}
{
  // 形态一：命令在飞（commandExecution started 无 completed），轮 completed。
  const h = codexHarness();
  h.send("item/started", { threadId: MAIN, item: { type: "commandExecution", id: "cmd1", command: "ls" } });
  h.send("turn/completed", { threadId: MAIN, turn: { id: "t1", status: "completed" } });
  const inc = h.events.filter((e) => e.type === "turn.incomplete");
  check("★ Codex：命令悬空 + turn completed → 发 turn.incomplete", inc.length === 1, h.events.map((e) => e.type));
  check("★ Codex：kind=dangling-tools 且点名 Bash", inc[0]?.kind === "dangling-tools" && (inc[0]?.pendingToolCalls as Ev[] | undefined)?.[0]?.toolName === "Bash", inc[0]);
  check("★ Codex：turn.incomplete 在 turn.done 之前", h.events.findIndex((e) => e.type === "turn.incomplete") < h.events.findIndex((e) => e.type === "turn.done"), h.events.map((e) => e.type));
}
{
  // 形态二：命令跑完、一个字没说。
  const h = codexHarness();
  h.send("item/started", { threadId: MAIN, item: { type: "commandExecution", id: "cmd1", command: "ls" } });
  h.send("item/completed", { threadId: MAIN, item: { type: "commandExecution", id: "cmd1", command: "ls", status: "completed", exitCode: 0, aggregatedOutput: "ok" } });
  h.send("turn/completed", { threadId: MAIN, turn: { id: "t1", status: "completed" } });
  const inc = h.events.filter((e) => e.type === "turn.incomplete");
  check("★ Codex：命令跑完零叙述 → empty-response", inc.length === 1 && inc[0]?.kind === "empty-response", inc);
}
{
  // 形态三：末条 agentMessage 断在冒号。
  const h = codexHarness();
  h.send("item/started", { threadId: MAIN, item: { type: "commandExecution", id: "cmd1", command: "ls" } });
  h.send("item/completed", { threadId: MAIN, item: { type: "commandExecution", id: "cmd1", command: "ls", status: "completed", exitCode: 0, aggregatedOutput: "ok" } });
  h.send("item/agentMessage/delta", { threadId: MAIN, itemId: "msg1", delta: "先读当前完整 onSplitConfirm：" });
  h.send("item/completed", { threadId: MAIN, item: { type: "agentMessage", id: "msg1", text: "先读当前完整 onSplitConfirm：" } });
  h.send("turn/completed", { threadId: MAIN, turn: { id: "t1", status: "completed" } });
  const inc = h.events.filter((e) => e.type === "turn.incomplete");
  check("★ Codex：末条断在冒号 → unfinished-text", inc.length === 1 && inc[0]?.kind === "unfinished-text", inc);
}
{
  // 健康轮 → 不发。
  const h = codexHarness();
  h.send("item/started", { threadId: MAIN, item: { type: "commandExecution", id: "cmd1", command: "ls" } });
  h.send("item/completed", { threadId: MAIN, item: { type: "commandExecution", id: "cmd1", command: "ls", status: "completed", exitCode: 0, aggregatedOutput: "ok" } });
  h.send("item/agentMessage/delta", { threadId: MAIN, itemId: "msg1", delta: "做完了，结果是 3。" });
  h.send("item/completed", { threadId: MAIN, item: { type: "agentMessage", id: "msg1", text: "做完了，结果是 3。" } });
  h.send("turn/completed", { threadId: MAIN, turn: { id: "t1", status: "completed" } });
  check("★ Codex：健康轮 → 不发", h.events.every((e) => e.type !== "turn.incomplete"), h.events.map((e) => e.type));
}
{
  // collab 工具（背景子代理）悬空不算 —— 登记排除，对应 Claude 的 Task 排除。
  // ⚠️ 必须带叙述文本：排除项失效时唯一会命中的是 dangling-tools；若无文本，
  // 「只跑了一次工具、零叙述」会命中 empty-response（**与 Claude 侧同判据**：
  // 那边的背景 Task 同样这么判，见 SdkMessageAdapter 的 empty-response 注释），
  // 就分不出排除项到底有没有生效。
  const h = codexHarness();
  h.send("item/agentMessage/delta", { threadId: MAIN, itemId: "msg0", delta: "派了一个后台代理去查。" });
  h.send("item/started", { threadId: MAIN, item: { type: "collabAgentToolCall", id: "cc1", tool: "spawnAgent", receiverThreadIds: ["agent-1"], prompt: "do work" } });
  h.send("turn/completed", { threadId: MAIN, turn: { id: "t1", status: "completed" } });
  check("★ Codex：背景 collab 悬空 → 不算截断（对应 Claude 的 Task 排除）", h.events.every((e) => e.type !== "turn.incomplete"), h.events.map((e) => e.type));
}
{
  // 对照组（判别力证明）：**同样形状但工具不是 collab**（普通 commandExecution
  // 悬空、带叙述）→ 必须命中 dangling-tools。它在上面那条绿的同时红，才说明
  // 上面测的是「登记排除」而不是「什么都没查」。
  const h = codexHarness();
  h.send("item/agentMessage/delta", { threadId: MAIN, itemId: "msg0", delta: "跑个命令看看。" });
  h.send("item/started", { threadId: MAIN, item: { type: "commandExecution", id: "cmd1", command: "ls" } });
  h.send("turn/completed", { threadId: MAIN, turn: { id: "t1", status: "completed" } });
  const inc = h.events.filter((e) => e.type === "turn.incomplete");
  check("★ 对照：普通命令悬空（带叙述）→ 必须报 dangling-tools", inc.length === 1 && inc[0]?.kind === "dangling-tools", inc);
}
{
  // 用户中断 → 不发（turn/completed status=interrupted → reason=interrupted）。
  const h = codexHarness();
  h.send("item/started", { threadId: MAIN, item: { type: "commandExecution", id: "cmd1", command: "ls" } });
  h.send("turn/completed", { threadId: MAIN, turn: { id: "t1", status: "interrupted" } });
  check("★ Codex：用户中断 → 不发", h.events.every((e) => e.type !== "turn.incomplete"), h.events.map((e) => e.type));
}
{
  // 子代理线程的悬空命令不影响主线程判定。
  const h = codexHarness();
  h.send("item/started", { threadId: SUB, item: { type: "commandExecution", id: "cmd-sub", command: "ls" } });
  h.send("item/agentMessage/delta", { threadId: MAIN, itemId: "msg1", delta: "做完了。" });
  h.send("item/completed", { threadId: MAIN, item: { type: "agentMessage", id: "msg1", text: "做完了。" } });
  h.send("turn/completed", { threadId: MAIN, turn: { id: "t1", status: "completed" } });
  check("★ Codex：子代理线程的悬空命令不污染主线程判定", h.events.every((e) => e.type !== "turn.incomplete"), h.events.map((e) => e.type));
}

console.log(`\nturn-incomplete-smoke:${total - failures}/${total} 通过`);
process.exit(failures ? 1 : 0);
