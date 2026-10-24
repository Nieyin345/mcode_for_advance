/**
 * O1 · pi-sdk 的**协议级替身**（见卡 §3.3：三份替身必须是不同的代码）。
 *
 * 真被测对象：真 `PiMessageAdapter` + 真 `buildPiExternalTools`（PinAgentSdkProvider
 * 在 `customTools` 里注册的就是它）。替身扮演 pi-agent-core 的 **AgentEvent 流**：
 *
 *  - `message_start` / `message_update`（`assistantMessageEvent.type:
 *    "text_delta" | "toolcall_start"`）/ `message_end`；
 *  - **SDK 执行工具**那一步：`tool_execution_start` → 调工具 `execute(...)` →
 *    `tool_execution_end`（`buildPiExternalTools` 返回的每个工具带 `execute`）；
 *  - `turn_end`（Pi 的轮中用量点）与 `agent_end`（终态，带 messages）。
 *
 * 与 Claude 的**形状差异**（就是本卡要抓的）：
 *  - 工具调用不是独立 envelope，而是 `assistantMessageEvent` 的一种
 *    (`toolcall_start`) + 独立的 `tool_execution_start/end` 事件对；
 *  - 工具结果走 `execute` 的返回值 `{content:[{type:"text"}], isError}`，
 *    适配器在 `tool_execution_end` 把它放进 `tool.result.content`
 *    （`result` 原样，不是 `content` 数组 —— 见 `PiMessageAdapter.dispatch` 的
 *    `tool_execution_end` 分支）；
 *  - 终态是 `agent_end`（`willRetry` 区分中间/终态），turn.done 由
 *    `handleAgentEnd` 直发（`PiMessageAdapter.ts:365-400`）。
 */
import { FileSnapshot } from "@main/lib/fileSnapshot.js";
import { buildPiExternalTools } from "@main/providers/nativeToolSchemas.js";
import { piExternalToolSdkName } from "@main/providers/nativeToolProtocol.js";
import { PiMessageAdapter } from "@main/providers/pi-sdk/PiMessageAdapter.js";
import type { HarnessTurn } from "../stubs/harnessEnv.js";
import { ERROR_MESSAGE, waitForTurnAbort, type ProviderProtocol } from "../shared.js";

const TOOL = "replace_blocks";
const CALL_ID = "call_o1_pi_1";

type PiTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: unknown,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
};

function makeAdapter(turn: HarnessTurn): PiMessageAdapter {
  return new PiMessageAdapter(
    turn.ctx,
    turn.session.id,
    () => undefined,
    new FileSnapshot(),
  );
}

function assistantMessage(stopReason: string, content: unknown[]): unknown {
  return { role: "assistant", stopReason, content };
}

async function runSdkTool(turn: HarnessTurn, input: Record<string, unknown>) {
  const tools = buildPiExternalTools(
    turn.input.externalTools ?? [],
    turn.session.id,
    turn.ctx.invokeExternalTool,
    turn.signal,
  ) as unknown as PiTool[];
  const sdkName = piExternalToolSdkName(TOOL);
  const tool = tools.find((candidate) => candidate.name === sdkName);
  if (!tool) throw new Error(`pi SDK: ${sdkName} 没有被 customTools 注册`);
  try {
    // Pi provider 传的是 (callSignal ?? turnSignal)；这里就是本轮的 provider 信号。
    return await tool.execute(CALL_ID, input, turn.signal);
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

/** narration → toolcall_start → message_end → tool_execution_* 的完整一轮。 */
async function piToolRound(
  adapter: PiMessageAdapter,
  turn: HarnessTurn,
  input: Record<string, unknown>,
): Promise<unknown[]> {
  const assistant = assistantMessage("toolUse", [{ type: "text", text: "我来替换这一段。" }]);
  adapter.dispatch({
    type: "message_update",
    message: assistant,
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "我来替换这一段。" },
  } as never);
  adapter.dispatch({
    type: "message_update",
    message: assistant,
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 2 },
  } as never);
  adapter.dispatch({ type: "message_end", message: assistant } as never);
  adapter.dispatch({
    type: "tool_execution_start",
    toolCallId: CALL_ID,
    toolName: piExternalToolSdkName(TOOL),
    args: input,
  } as never);
  const result = await runSdkTool(turn, input);
  adapter.dispatch({
    type: "tool_execution_end",
    toolCallId: CALL_ID,
    toolName: piExternalToolSdkName(TOOL),
    result,
    isError: result.isError === true,
  } as never);
  return [assistant];
}

function piTurnEnd(adapter: PiMessageAdapter): void {
  adapter.dispatch({ type: "turn_end", message: assistantMessage("toolUse", []), toolResults: [] } as never);
}

export const piProtocol: ProviderProtocol = {
  id: "pi-sdk",
  fingerprint: { toolUseName: piExternalToolSdkName(TOOL), resultKind: "pi-result-object" },

  async normal(turn, input) {
    const adapter = makeAdapter(turn);
    const transcript = await piToolRound(adapter, turn, input);
    piTurnEnd(adapter);
    const final = assistantMessage("stop", [{ type: "text", text: "已按请求替换。" }]);
    adapter.dispatch({
      type: "message_update",
      message: final,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "已按请求替换。" },
    } as never);
    adapter.dispatch({ type: "message_end", message: final } as never);
    adapter.dispatch({
      type: "agent_end",
      willRetry: false,
      messages: [...transcript, final],
    } as never);
    await adapter.flushFinal();
  },

  async error(turn) {
    const adapter = makeAdapter(turn);
    const failed = { role: "assistant", stopReason: "error", errorMessage: ERROR_MESSAGE, content: [] };
    // 传输中途失败：Pi 以错误 assistant 消息收尾（`terminalErrorFromMessages`）。
    adapter.dispatch({ type: "agent_end", willRetry: false, messages: [failed] } as never);
    await adapter.flushFinal();
  },

  async lateWriteAfterAbort(turn, input) {
    const adapter = makeAdapter(turn);
    const assistant = assistantMessage("toolUse", [{ type: "text", text: "我开始改。" }]);
    adapter.dispatch({
      type: "message_update",
      message: assistant,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "我开始改。" },
    } as never);
    // 用户停止：provider 的 session.prompt() 会抛出，随后 finalizeTurn("interrupted")。
    // 这里模拟的竞争是「SDK 一边收到 abort、一边已经把工具调用发出去了」。
    await waitForTurnAbort(turn.signal, 1_500);
    adapter.dispatch({
      type: "message_update",
      message: assistant,
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 2 },
    } as never);
    adapter.dispatch({
      type: "tool_execution_start",
      toolCallId: CALL_ID,
      toolName: piExternalToolSdkName(TOOL),
      args: input,
    } as never);
    const result = await runSdkTool(turn, input);
    adapter.dispatch({
      type: "tool_execution_end",
      toolCallId: CALL_ID,
      toolName: piExternalToolSdkName(TOOL),
      result,
      isError: result.isError === true,
    } as never);
    adapter.finalizeTurn("interrupted");
    await adapter.flushFinal();
  },
};
