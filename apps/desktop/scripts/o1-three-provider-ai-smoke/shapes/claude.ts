/**
 * O1 · claude-sdk 的**协议级替身**（不是通用 mock —— 见卡 §3.3）。
 *
 * 它喂给的是**真** `SdkMessageAdapter`（生产适配器），工具粘合是**真**
 * `buildClaudeExternalSdkTools`（`ClaudeAgentSdkProvider.startTurn` 在
 * 1486–1504 行用的就是它）。替身只扮演两件事：
 *
 *  1. **SDK 的 stdio 消息流**（`SDKMessage` 序列）：system/init →
 *     stream_event（message_start / content_block_start / content_block_delta /
 *     content_block_stop）→ assistant(tool_use) → user(tool_result) →
 *     assistant(text) → result；
 *  2. **SDK 执行 in-process MCP 工具**那一步：真实 SDK 收到 tool_use 后调用
 *     工具注册的 `handler`，本文件照做（`tool.handler(args)`），然后把返回值
 *     包成 `user` 消息里的 `tool_result` 块送回适配器。
 *
 * 原生形状依据（都读过源码，不是猜的）：
 *  - `SdkMessageAdapter.dispatch`：按 `m.type` 分派 system/stream_event/
 *    assistant/user/result（467–557 行）；
 *  - `handleAssistant`：tool_use 块的 `name`/`id` 原样进 `tool.use`（1291–1329 行）；
 *  - `handleUser`：`tool_result` 块的 `content` 原样进 `tool.result`
 *    （1565–1587 行）——这是 Claude 与另外两家**形状不同**的地方；
 *  - `handleResult`：subtype=success 记 stop_reason，非 success 发 `error`
 *    事件（1674–1817 行）；
 *  - `flushFinal`：turn.done 由它收尾（571–642 行）。
 */
import { FileSnapshot } from "@main/lib/fileSnapshot.js";
import { buildClaudeExternalSdkTools } from "@main/providers/nativeToolSchemas.js";
import { externalToolSdkName } from "@main/providers/nativeToolProtocol.js";
import { SdkMessageAdapter } from "@main/providers/claude-sdk/SdkMessageAdapter.js";
import type { HarnessTurn } from "../stubs/harnessEnv.js";
import { ERROR_MESSAGE, waitForTurnAbort, type ProviderProtocol } from "../shared.js";

const TOOL = "replace_blocks";
const CALL_ID = "toolu_o1_claude_1";

type ClaudeSdkTool = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
};

function makeAdapter(turn: HarnessTurn): SdkMessageAdapter {
  // askUserQuestionAvailable=false / query=null / 默认 initialTodos —— 文档 AI
  // 的生产构造（ClaudeAgentSdkProvider.ts:1541-1553）在这三项上同值。
  return new SdkMessageAdapter(
    turn.ctx,
    turn.session.id,
    false,
    turn.input.cwd,
    new FileSnapshot(),
    turn.signal,
  );
}

/** 一段真实的流式文本（message_start → content_block_start → delta → stop）。 */
async function streamText(adapter: SdkMessageAdapter, text: string): Promise<void> {
  await adapter.dispatch({
    type: "stream_event",
    event: { type: "message_start", message: { id: "msg_o1_claude" } },
  } as never);
  await adapter.dispatch({
    type: "stream_event",
    event: { type: "content_block_start", index: 0 },
  } as never);
  await adapter.dispatch({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  } as never);
  await adapter.dispatch({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
  } as never);
}

function assistantToolUse(): unknown {
  return {
    type: "assistant",
    message: {
      id: "msg_o1_claude_tool",
      role: "assistant",
      model: "mock-claude",
      content: [{ type: "tool_use", id: CALL_ID, name: externalToolSdkName(TOOL), input: {} }],
    },
  };
}

/**
 * 扮演 SDK 执行工具：按 SDK 注册名找工具，调它的 handler（真实粘合层），
 * 返回值原样包进 tool_result —— 与 `buildClaudeExternalSdkTools` 的
 * `{content:[{type:"text"}], isError}` 形状一致。
 */
async function runSdkTool(turn: HarnessTurn, input: Record<string, unknown>) {
  const tools = buildClaudeExternalSdkTools(
    turn.input.externalTools ?? [],
    turn.session.id,
    turn.ctx.invokeExternalTool,
    turn.signal,
  ) as unknown as ClaudeSdkTool[];
  const sdkName = externalToolSdkName(TOOL);
  const tool = tools.find((candidate) => candidate.name === sdkName);
  if (!tool) throw new Error(`claude SDK: ${sdkName} 没有被 provider 的粘合层注册`);
  try {
    return await tool.handler(input);
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

function userToolResult(result: Awaited<ReturnType<typeof runSdkTool>>): unknown {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: CALL_ID,
          is_error: result.isError === true,
          content: result.content,
        },
      ],
    },
  };
}

function assistantText(text: string): unknown {
  return {
    type: "assistant",
    message: {
      id: "msg_o1_claude_text",
      role: "assistant",
      model: "mock-claude",
      content: [{ type: "text", text }],
    },
  };
}

export const claudeProtocol: ProviderProtocol = {
  id: "claude-sdk",
  fingerprint: { toolUseName: externalToolSdkName(TOOL), resultKind: "claude-content-array" },

  async normal(turn, input) {
    const adapter = makeAdapter(turn);
    await adapter.dispatch({
      type: "system",
      subtype: "init",
      session_id: "sdk-o1-claude",
      model: "mock-claude",
      permissionMode: "default",
      slash_commands: [],
    } as never);
    await streamText(adapter, "我来替换这一段。");
    await adapter.dispatch(assistantToolUse() as never);
    const result = await runSdkTool(turn, input);
    await adapter.dispatch(userToolResult(result) as never);
    await adapter.dispatch(assistantText("已按请求替换。") as never);
    await adapter.dispatch({
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
      usage: { input_tokens: 42, output_tokens: 9 },
      total_cost_usd: 0,
    } as never);
    await adapter.flushFinal();
  },

  async error(turn) {
    const adapter = makeAdapter(turn);
    await streamText(adapter, "我正在处理");
    // SDK 的失败信封：subtype≠success 的 result（适配器在 1803–1817 行发 error）。
    await adapter.dispatch({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: ERROR_MESSAGE,
      usage: { input_tokens: 41, output_tokens: 3 },
    } as never);
    await adapter.flushFinal();
  },

  async lateWriteAfterAbort(turn, input) {
    const adapter = makeAdapter(turn);
    await streamText(adapter, "我开始改");
    // 用户此刻按下停止（docsAiPorts 的 abort → handle.interrupt → 本轮的
    // provider 信号 aborted）。SDK 仍会竞争性地把已生成的 tool_use 送过来。
    await waitForTurnAbort(turn.signal, 1_500);
    await adapter.dispatch(assistantToolUse() as never);
    const result = await runSdkTool(turn, input);
    await adapter.dispatch(userToolResult(result) as never);
    await adapter.flushFinal();
  },
};
