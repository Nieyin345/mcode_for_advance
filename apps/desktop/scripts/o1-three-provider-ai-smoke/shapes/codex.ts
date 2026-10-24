/**
 * O1 · codex-sdk 的**协议级替身**（见卡 §3.3：三份替身必须是不同的代码）。
 *
 * 真被测对象：真 `CodexMessageAdapter` + 真 `dispatchCodexExternalToolCall`
 * （`CodexAgentSdkProvider.invokeDynamicTool` 的第一跳就是它）。替身扮演
 * **app-server 的 JSON-RPC 通知流**（`NotificationFrame{method, params}`）：
 *
 *  - `item/agentMessage/delta`（`{delta, itemId, threadId}`）；
 *  - `item/started` / `item/completed`（`item.type === "dynamicToolCall"`，带
 *    `tool` 的全名 `mcode_renderer__replace_blocks`、`arguments`、`contentItems`）；
 *  - `turn/completed`（`{threadId, turn:{id,status}}`）。
 *
 * 与另外两家的**形状差异**（本卡要抓的）：
 *  - 工具在 Codex 里是 **dynamicToolCall item**，结果不是从 SDK 回调值落进
 *    `tool.result.content`，而是由 provider 把 `{success, contentItems}` 回给
 *    app-server，再以 `item/completed` 的 `contentItems` **文本拼接**回来
 *    （`CodexMessageAdapter.emitDynamicToolResult`，679–712 行）；
 *  - 终态是 `turn/completed` 通知（`finishTurn`，438–451 行），turn.done 由
 *    `finishTurn` 直发；
 *  - `mainThreadId` 必须先由 thread/start 响应设上，否则带 threadId 的通知
 *    会被排队（197–210 行）。
 */
import { FileSnapshot } from "@main/lib/fileSnapshot.js";
import { dispatchCodexExternalToolCall, externalToolSdkName } from "@main/providers/nativeToolProtocol.js";
import { CodexMessageAdapter } from "@main/providers/codex-sdk/CodexMessageAdapter.js";
import { CodexFileSnapshot } from "@main/providers/codex-sdk/CodexFileSnapshot.js";
import type { HarnessTurn } from "../stubs/harnessEnv.js";
import { ERROR_MESSAGE, waitForTurnAbort, type ProviderProtocol } from "../shared.js";

const TOOL = "replace_blocks";
const CALL_ID = "dyn_o1_codex_1";
const THREAD = "thread-o1-codex";
const ITEM = "item-o1-codex-tool";

function makeAdapter(turn: HarnessTurn): CodexMessageAdapter {
  const adapter = new CodexMessageAdapter(
    turn.ctx,
    turn.session.id,
    new CodexFileSnapshot(turn.input.cwd),
    undefined,
    undefined,
    "mock-gpt-codex",
  );
  adapter.setMainThreadId(THREAD);
  return adapter;
}

function delta(text: string, itemId: string): unknown {
  return { method: "item/agentMessage/delta", params: { threadId: THREAD, itemId, delta: text } };
}

/**
 * 扮演 app-server 的 dynamic-tool 调用：
 *  1. 发 `item/started`（适配器发 tool.use）；
 *  2. 用真实 `dispatchCodexExternalToolCall` 执行（带本请求的工具表与 host 回调）；
 *  3. 发 `item/completed`（带 server 回给它的 contentItems）。
 */
async function codexToolItem(
  adapter: CodexMessageAdapter,
  turn: HarnessTurn,
  input: Record<string, unknown>,
): Promise<void> {
  const sdkName = externalToolSdkName(TOOL);
  adapter.handleNotification({
    method: "item/started",
    params: {
      threadId: THREAD,
      item: { type: "dynamicToolCall", id: ITEM, tool: sdkName, arguments: input },
    },
  } as never);

  const dispatched = await dispatchCodexExternalToolCall({
    sdkToolName: sdkName,
    callId: CALL_ID,
    input,
    sessionId: turn.session.id,
    tools: turn.input.externalTools ?? [],
    invokeExternalTool: turn.ctx.invokeExternalTool,
    signal: turn.signal,
  });
  if (!dispatched.matched) throw new Error(`codex: ${sdkName} 不在本请求的工具表里`);
  const response = dispatched.response;

  adapter.handleNotification({
    method: "item/completed",
    params: {
      threadId: THREAD,
      item: {
        type: "dynamicToolCall",
        id: ITEM,
        tool: sdkName,
        arguments: input,
        success: response.success,
        status: response.success ? "completed" : "failed",
        contentItems: response.contentItems,
      },
    },
  } as never);
}

function turnCompleted(adapter: CodexMessageAdapter, status: string): void {
  adapter.handleNotification({
    method: "turn/completed",
    params: { threadId: THREAD, turn: { id: "turn-o1-codex", status } },
  } as never);
}

export const codexProtocol: ProviderProtocol = {
  id: "codex-sdk",
  fingerprint: { toolUseName: externalToolSdkName(TOOL), resultKind: "codex-joined-text" },

  async normal(turn, input) {
    const adapter = makeAdapter(turn);
    adapter.handleNotification(delta("我来替换这一段。", "agent-msg-1") as never);
    adapter.handleNotification({
      method: "item/completed",
      params: { threadId: THREAD, item: { type: "agentMessage", id: "agent-msg-1", text: "我来替换这一段。" } },
    } as never);
    await codexToolItem(adapter, turn, input);
    adapter.handleNotification(delta("已按请求替换。", "agent-msg-2") as never);
    adapter.handleNotification({
      method: "item/completed",
      params: { threadId: THREAD, item: { type: "agentMessage", id: "agent-msg-2", text: "已按请求替换。" } },
    } as never);
    turnCompleted(adapter, "completed");
    await adapter.flushFinal();
  },

  async error(turn) {
    const adapter = makeAdapter(turn);
    adapter.handleNotification(delta("我正在处理", "agent-msg-err") as never);
    // app-server 的终态错误通知（willRetry=false 才进 error 事件，401–432 行）。
    adapter.handleNotification({
      method: "error",
      params: { threadId: THREAD, willRetry: false, error: { message: ERROR_MESSAGE } },
    } as never);
    turnCompleted(adapter, "failed");
    await adapter.flushFinal();
  },

  async lateWriteAfterAbort(turn, input) {
    const adapter = makeAdapter(turn);
    adapter.handleNotification(delta("我开始改。", "agent-msg-late") as never);
    // 用户停止。Codex provider 的 abort 路径：markAborted()（丢后续通知）+
    // finalizeAborted()。这里故意**不** markAborted —— 模拟通知在途竞争，
    // 验证的是 host 的取消闸，不是适配器自己的丢弃逻辑。
    await waitForTurnAbort(turn.signal, 1_500);
    await codexToolItem(adapter, turn, input);
    adapter.finalizeAborted();
    await adapter.flushFinal();
  },
};
