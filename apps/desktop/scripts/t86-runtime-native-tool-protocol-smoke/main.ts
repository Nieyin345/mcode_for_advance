import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExternalToolCall, ExternalToolDefinition, ExternalToolHandler, ExternalToolResult, ProviderAbortSignal } from "@contracts/provider";
import {
  codexExternalToolDescriptors,
  createExternalToolDispatcher,
  dispatchCodexExternalToolCall,
  externalToolSdkName,
  piExternalToolSdkName,
  validateExternalToolDefinitions,
  validateExternalToolInput,
  validateExternalToolResultEnvelope,
} from "@main/providers/nativeToolProtocol.js";
import { buildClaudeExternalSdkTools, buildPiExternalTools } from "@main/providers/nativeToolSchemas.js";

let failures = 0;
let checks = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  checks++;
  if (condition) console.log(`  PASS ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function equal(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}
function rejected(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

const tool: ExternalToolDefinition = {
  name: "replace_selection",
  description: "Replace the current editor selection with supplied text.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1, maxLength: 1_000, description: "Replacement text." },
    },
    required: ["text"],
    additionalProperties: false,
  },
};
const tools = validateExternalToolDefinitions([tool]);
const root = resolve(process.cwd());
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

function approval(allow = true) {
  return async () => ({ allow, ...(allow ? {} : { reason: "user denied" }) });
}
function resultHandler(label: string, calls: ExternalToolCall[] = []): ExternalToolHandler {
  return async (call) => {
    calls.push(call);
    return {
      sessionId: call.sessionId,
      callId: call.callId,
      status: "success",
      result: { applied: true, label, tool: call.name, input: call.input },
    };
  };
}
function makeDispatcher(
  sessionId: string,
  controller: AbortController,
  handler: ExternalToolHandler | undefined = resultHandler(sessionId),
  ask: ((request: { requestId: string; toolName: string; input: unknown; description?: string }) => Promise<{ allow: boolean; reason?: string; updatedInput?: unknown }>) | undefined = approval(),
) {
  return createExternalToolDispatcher({
    sessionId,
    tools,
    handler,
    requestApproval: ask,
    signal: controller.signal,
  });
}

console.log("\n1. Request-local protocol validation");
{
  check("accepts a bounded object schema", validateExternalToolDefinitions([tool]).length === 1);
  check("rejects duplicate tool names", rejected(() => validateExternalToolDefinitions([tool, tool])));
  check("rejects unsupported schema keywords instead of guessing", rejected(() => validateExternalToolDefinitions([{
    ...tool, inputSchema: { type: "object", properties: {}, pattern: ".*" },
  }])));
  check("rejects a non-object root schema", rejected(() => validateExternalToolDefinitions([{
    ...tool, inputSchema: { type: "string" },
  }])));
  check("rejects oversized tool descriptions", rejected(() => validateExternalToolDefinitions([{
    ...tool, description: "x".repeat(4_001),
  }])));
  check("rejects malformed arguments", validateExternalToolInput(tool.inputSchema, { text: 17 }) !== null);
  check("rejects missing required arguments", validateExternalToolInput(tool.inputSchema, {}) !== null);
  check("rejects extra properties when additionalProperties=false", validateExternalToolInput(tool.inputSchema, { text: "ok", extra: true }) !== null);
  check("rejects oversized arguments before approval/dispatch", validateExternalToolInput(tool.inputSchema, { text: "x".repeat(70_000) })?.includes("65536") === true);
}

console.log("\n2. Pi native customTools.execute round-trip — isolated E1 positive");
{
  const controller = new AbortController();
  const calls: ExternalToolCall[] = [];
  const dispatcher = makeDispatcher("pi-session", controller, resultHandler("pi-renderer", calls));
  type PiNativeTool = {
    name: string;
    parameters: unknown;
    execute: (callId: string, params: unknown, signal?: ProviderAbortSignal) => Promise<{ content: Array<{ text: string }>; isError: boolean }>;
  };
  const piTool = buildPiExternalTools(tools, "pi-session", dispatcher.invoke, controller.signal)[0] as unknown as PiNativeTool;
  const fakePiSdkTurn = { id: "pi-turn-1", steps: ["assistant emitted native tool call"], observed: "" };
  const result = await piTool.execute("pi-call-1", { text: "Pi result" }, controller.signal);
  check("Pi registers the request-local schema as a native custom tool", piTool.name === piExternalToolSdkName("replace_selection") && !!piTool.parameters);
  check("Pi native execute awaits Host and returns success to the SDK", result.isError === false && result.content[0]?.text.includes('"applied":true'));
  check("Pi call id and request name reach Host unchanged", calls.length === 1 && calls[0]?.callId === "pi-call-1" && calls[0]?.name === "replace_selection", calls);
  if (!result.isError) {
    fakePiSdkTurn.observed = result.content[0]?.text ?? "";
    fakePiSdkTurn.steps.push("assistant continued using native tool result");
  }
  check("same Pi SDK turn can continue after tool result", fakePiSdkTurn.id === "pi-turn-1" && fakePiSdkTurn.steps.length === 2 && fakePiSdkTurn.observed.includes('"label":"pi-renderer"'));
  dispatcher.close();
}

console.log("\n3. Claude native in-process MCP handler round-trip");
{
  const controller = new AbortController();
  const calls: ExternalToolCall[] = [];
  const dispatcher = makeDispatcher("claude-session", controller, resultHandler("claude-renderer", calls));
  type ClaudeNativeTool = {
    name: string;
    inputSchema: unknown;
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError: boolean }>;
  };
  const claudeTool = buildClaudeExternalSdkTools(tools, "claude-session", dispatcher.invoke, controller.signal)[0] as unknown as ClaudeNativeTool;
  const fakeQueryTurn = { id: "claude-query-1", steps: ["assistant emitted MCP tool call"], observed: "" };
  const result = await claudeTool.handler({ text: "Claude result" });
  check("Claude registers the tool through the native MCP handler shape", claudeTool.name === externalToolSdkName("replace_selection") && !!claudeTool.inputSchema);
  check("Claude MCP handler returns the awaited Host result, not an empty success", result.isError === false && result.content[0]?.text.includes('"applied":true'));
  check("Claude generated call id is correlated with the Host result", calls.length === 1 && calls[0]?.callId.length > 8, calls);
  if (!result.isError) {
    fakeQueryTurn.observed = result.content[0]?.text ?? "";
    fakeQueryTurn.steps.push("assistant continued using MCP result");
  }
  check("same Claude query turn can continue after MCP result", fakeQueryTurn.id === "claude-query-1" && fakeQueryTurn.steps.length === 2 && fakeQueryTurn.observed.includes('"label":"claude-renderer"'));
  dispatcher.close();
}

console.log("\n4. Codex native dynamicTools / app-server request-reply round-trip");
{
  const controller = new AbortController();
  const calls: ExternalToolCall[] = [];
  const dispatcher = makeDispatcher("codex-session", controller, resultHandler("codex-renderer", calls));
  const descriptor = codexExternalToolDescriptors(tools)[0]!;
  const fakeAppServerTurn = { id: "codex-turn-1", steps: ["app-server issued item/tool/call"], observed: "" };
  const dispatched = await dispatchCodexExternalToolCall({
    sdkToolName: String(descriptor.name),
    callId: "codex-call-1",
    input: { text: "Codex result" },
    sessionId: "codex-session",
    tools,
    invokeExternalTool: dispatcher.invoke,
    signal: controller.signal,
  });
  check("Codex dynamicTools descriptor carries the JSON Schema, not prompt text", descriptor.type === "function" && JSON.stringify(descriptor.inputSchema) === JSON.stringify(tool.inputSchema));
  check("Codex item/tool/call awaits Host and returns a native success response", dispatched.matched && dispatched.response.success && dispatched.response.contentItems[0]?.text.includes('"applied":true'));
  check("Codex app-server call id reaches Host unchanged", calls.length === 1 && calls[0]?.callId === "codex-call-1", calls);
  if (dispatched.matched && dispatched.response.success) {
    fakeAppServerTurn.observed = dispatched.response.contentItems[0]?.text ?? "";
    fakeAppServerTurn.steps.push("same turn continued after item/tool/call response");
  }
  check("same Codex app-server turn can continue after tool result", fakeAppServerTurn.id === "codex-turn-1" && fakeAppServerTurn.steps.length === 2 && fakeAppServerTurn.observed.includes('"label":"codex-renderer"'));
  const staleDescriptorCall = await dispatchCodexExternalToolCall({
    sdkToolName: String(descriptor.name),
    callId: "stale-call-1",
    input: { text: "stale" },
    sessionId: "codex-session",
    tools: [],
    invokeExternalTool: dispatcher.invoke,
    signal: controller.signal,
  });
  check("Codex stale thread-scoped tool definitions are rejected on a later request", staleDescriptorCall.matched && !staleDescriptorCall.response.success && staleDescriptorCall.response.contentItems[0]?.text.includes("not allowed"), staleDescriptorCall);
  dispatcher.close();
}

console.log("\n5. Host fail-closed, approval, session/call correlation");
{
  const controller = new AbortController();
  const seen: ExternalToolCall[] = [];
  const dispatcher = makeDispatcher("negative-session", controller, resultHandler("should-not-run", seen));
  const unknown = await dispatcher.invoke({ sessionId: "negative-session", callId: "unknown-1", name: "not_in_request", input: { text: "x" } });
  check("unknown tool is rejected and never dispatched", unknown.status === "error" && seen.length === 0, unknown);

  const mismatch = await dispatcher.invoke({ sessionId: "negative-session", callId: "schema-1", name: "replace_selection", input: { text: 42 } });
  check("schema/argument mismatch is an error, never a success", mismatch.status === "error" && seen.length === 0, mismatch);

  const invalidCallId = await dispatcher.invoke({ sessionId: "negative-session", callId: "bad id", name: "replace_selection", input: { text: "x" } });
  check("invalid call id is rejected", invalidCallId.status === "error" && seen.length === 0, invalidCallId);

  const wrongSession = await dispatcher.invoke({ sessionId: "other-session", callId: "wrong-session-1", name: "replace_selection", input: { text: "x" } });
  check("cross-session invocation is rejected", wrongSession.status === "error" && wrongSession.sessionId === "other-session" && seen.length === 0, wrongSession);

  const noApproval = createExternalToolDispatcher({
    sessionId: "no-approval",
    tools,
    handler: resultHandler("must-not-run", seen),
    signal: new AbortController().signal,
  });
  const deniedByMissingApproval = await noApproval.invoke({ sessionId: "no-approval", callId: "no-approval-1", name: "replace_selection", input: { text: "x" } });
  check("missing approval channel is a hard deny", deniedByMissingApproval.status === "error" && seen.length === 0, deniedByMissingApproval);
  noApproval.close();

  let noHandlerApprovalCalls = 0;
  const noHandler = createExternalToolDispatcher({
    sessionId: "no-handler",
    tools,
    handler: undefined,
    requestApproval: async () => { noHandlerApprovalCalls++; return { allow: true }; },
    signal: new AbortController().signal,
  });
  const noHandlerResult = await noHandler.invoke({ sessionId: "no-handler", callId: "no-handler-1", name: "replace_selection", input: { text: "x" } });
  check("missing Host result handler is rejected before approval", noHandlerResult.status === "error" && noHandlerApprovalCalls === 0, noHandlerResult);
  noHandler.close();

  let dontAskApprovalCalls = 0;
  const dontAsk = createExternalToolDispatcher({
    sessionId: "dont-ask",
    tools,
    handler: resultHandler("must-not-run", seen),
    requestApproval: async () => { dontAskApprovalCalls++; return { allow: true }; },
    isDontAskMode: () => true,
    signal: new AbortController().signal,
  });
  const dontAskResult = await dontAsk.invoke({ sessionId: "dont-ask", callId: "dont-ask-1", name: "replace_selection", input: { text: "x" } });
  check("dontAsk policy denies an unapproved external tool without prompting", dontAskResult.status === "error" && dontAskApprovalCalls === 0 && seen.length === 0, dontAskResult);
  dontAsk.close();

  const denied = makeDispatcher("approval-denied", new AbortController(), resultHandler("must-not-run", seen), approval(false));
  const deniedResult = await denied.invoke({ sessionId: "approval-denied", callId: "denied-1", name: "replace_selection", input: { text: "x" } });
  check("user approval denial is a tool error", deniedResult.status === "error" && deniedResult.error.includes("denied") && seen.length === 0, deniedResult);
  denied.close();

  const duplicateController = new AbortController();
  const duplicateCalls: ExternalToolCall[] = [];
  const duplicate = makeDispatcher("duplicate-session", duplicateController, resultHandler("once", duplicateCalls));
  const first = await duplicate.invoke({ sessionId: "duplicate-session", callId: "duplicate-1", name: "replace_selection", input: { text: "first" } });
  const second = await duplicate.invoke({ sessionId: "duplicate-session", callId: "duplicate-1", name: "replace_selection", input: { text: "replay" } });
  check("duplicate/expired call id cannot execute twice", first.status === "success" && second.status === "error" && duplicateCalls.length === 1, { first, second, duplicateCalls });
  duplicate.close();

  const wrongReceipt = validateExternalToolResultEnvelope({
    sessionId: "some-other-session", callId: "wrong-call", status: "success", result: { applied: true },
  }, "expected-session", "expected-call");
  check("cross-session / wrong-call-id receipt is downgraded to error", wrongReceipt.status === "error" && wrongReceipt.sessionId === "expected-session" && wrongReceipt.callId === "expected-call", wrongReceipt);
  dispatcher.close();
}

console.log("\n6. Parallel request isolation, cancellation, late receipt and provider end");
{
  const aController = new AbortController();
  const bController = new AbortController();
  const aApprovalIds: string[] = [];
  const bApprovalIds: string[] = [];
  const a = createExternalToolDispatcher({
    sessionId: "request-A", tools, handler: resultHandler("only-A"), signal: aController.signal,
    requestApproval: async (request) => { aApprovalIds.push(request.requestId); return { allow: true }; },
  });
  const b = createExternalToolDispatcher({
    sessionId: "request-B", tools, handler: resultHandler("only-B"), signal: bController.signal,
    requestApproval: async (request) => { bApprovalIds.push(request.requestId); return { allow: true }; },
  });
  const [aResult, bResult] = await Promise.all([
    a.invoke({ sessionId: "request-A", callId: "shared-call-id", name: "replace_selection", input: { text: "A" } }),
    b.invoke({ sessionId: "request-B", callId: "shared-call-id", name: "replace_selection", input: { text: "B" } }),
  ]);
  check("parallel A/B requests with same call id stay isolated", aResult.status === "success" && bResult.status === "success" && JSON.stringify(aResult).includes("only-A") && JSON.stringify(bResult).includes("only-B"));
  check("parallel approval correlation ids are session-scoped", aApprovalIds.length === 1 && bApprovalIds.length === 1 && aApprovalIds[0] !== bApprovalIds[0] && aApprovalIds[0]?.includes("request-A") && bApprovalIds[0]?.includes("request-B"), { aApprovalIds, bApprovalIds });
  a.close();
  b.close();

  const cancelController = new AbortController();
  const providerCallController = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
  let releaseLate!: (value: ExternalToolResult) => void;
  const pendingRendererResult = new Promise<ExternalToolResult>((resolveResult) => { releaseLate = resolveResult; });
  let handlerSignalAborted = false;
  const cancelDispatcher = makeDispatcher("cancel-session", cancelController, async (_call, signal) => {
    signal.addEventListener("abort", () => { handlerSignalAborted = true; }, { once: true });
    markStarted();
    return pendingRendererResult;
  });
  const inFlight = cancelDispatcher.invoke(
    { sessionId: "cancel-session", callId: "cancel-call-1", name: "replace_selection", input: { text: "cancel me" } },
    providerCallController.signal,
  );
  let startTimeout: ReturnType<typeof setTimeout> | undefined;
  const handlerDidStart = await Promise.race([
    started.then(() => true),
    new Promise<boolean>((resolveStart) => { startTimeout = setTimeout(() => resolveStart(false), 100); }),
  ]);
  if (startTimeout) clearTimeout(startTimeout);
  if (!handlerDidStart) {
    const notStarted = await inFlight;
    check("cancellation harness reaches the renderer callback", false, notStarted);
    check("cancel interrupts an in-flight renderer callback", notStarted.status === "cancelled", notStarted);
  } else {
    cancelController.abort();
    const cancelled = await inFlight;
    check("Host turn cancellation reaches the Host callback signal", handlerSignalAborted);
    check("cancel interrupts an in-flight renderer callback", cancelled.status === "cancelled", cancelled);
    releaseLate({ sessionId: "cancel-session", callId: "cancel-call-1", status: "success", result: { applied: true, late: true } });
    await Promise.resolve();
    await Promise.resolve();
    check("late result after cancellation never changes the returned failure", cancelled.status === "cancelled" && !JSON.stringify(cancelled).includes('"late":true'), cancelled);
  }
  cancelDispatcher.close();

  const closeController = new AbortController();
  let markCloseStarted!: () => void;
  const closeStarted = new Promise<void>((resolveStarted) => { markCloseStarted = resolveStarted; });
  let releaseAfterClose!: (value: ExternalToolResult) => void;
  const pendingAfterClose = new Promise<ExternalToolResult>((resolveResult) => { releaseAfterClose = resolveResult; });
  let closeSignalAborted = false;
  const closingDispatcher = makeDispatcher("close-inflight-session", closeController, async (_call, signal) => {
    signal.addEventListener("abort", () => { closeSignalAborted = true; }, { once: true });
    markCloseStarted();
    return pendingAfterClose;
  });
  const closeInFlight = closingDispatcher.invoke({ sessionId: "close-inflight-session", callId: "close-inflight-1", name: "replace_selection", input: { text: "close me" } });
  let closeTimeout: ReturnType<typeof setTimeout> | undefined;
  const closeHandlerDidStart = await Promise.race([
    closeStarted.then(() => true),
    new Promise<boolean>((resolveStart) => { closeTimeout = setTimeout(() => resolveStart(false), 100); }),
  ]);
  if (closeTimeout) clearTimeout(closeTimeout);
  if (closeHandlerDidStart) {
    closingDispatcher.close();
    const closedResult = await closeInFlight;
    check("provider end aborts an in-flight Host callback", closedResult.status === "cancelled" && closeSignalAborted, closedResult);
    releaseAfterClose({ sessionId: "close-inflight-session", callId: "close-inflight-1", status: "success", result: { late: true } });
  } else {
    const notStarted = await closeInFlight;
    check("provider-end harness reaches the renderer callback", false, notStarted);
  }

  const endedController = new AbortController();
  let endedHandlerCalls = 0;
  const ended = makeDispatcher("ended-session", endedController, async (call) => {
    endedHandlerCalls++;
    return { sessionId: call.sessionId, callId: call.callId, status: "success", result: "should not run" };
  });
  ended.close();
  const afterEnd = await ended.invoke({ sessionId: "ended-session", callId: "after-end-1", name: "replace_selection", input: { text: "late" } });
  check("provider-ended dispatcher rejects all later calls", afterEnd.status === "cancelled" && endedHandlerCalls === 0, afterEnd);
}

console.log("\n7. Adapter wiring and no-handler negative controls");
{
  const runtime = source("src/main/claude/RuntimeManager.ts");
  const claude = source("src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts");
  const pi = source("src/main/providers/pi-sdk/PiAgentSdkProvider.ts");
  const codex = source("src/main/providers/codex-sdk/CodexAgentSdkProvider.ts");
  check("RuntimeManager passes only normalized request-local definitions and Host callback", runtime.includes("externalTools: externalTools") && runtime.includes("createExternalToolDispatcher") && runtime.includes("providerContext.invokeExternalTool"));
  check("Claude adapter uses native MCP server + per-turn handler", claude.includes("buildClaudeExternalSdkTools") && claude.includes("mcode-renderer-tools") && claude.includes("options.mcpServers"));
  check("Pi adapter uses native customTools.execute", pi.includes("buildPiExternalTools") && pi.includes("customTools"));
  check("Codex adapter uses native dynamicTools + app-server request/reply", codex.includes("codexExternalToolDescriptors") && codex.includes("dispatchCodexExternalToolCall") && codex.includes("dynamicTools: ["));

  const controller = new AbortController();
  type PiNativeTool = { execute: (callId: string, params: unknown, signal?: ProviderAbortSignal) => Promise<{ content: Array<{ text: string }>; isError: boolean }> };
  const noCallbackPi = buildPiExternalTools(tools, "no-handler-pi", undefined, controller.signal)[0] as unknown as PiNativeTool;
  const noCallbackPiResult = await noCallbackPi.execute("no-handler-call", { text: "x" }, controller.signal);
  check("Pi does not convert missing callback into empty success", noCallbackPiResult.isError && noCallbackPiResult.content[0]?.text.includes("unsupported"));

  type ClaudeNativeTool = { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError: boolean }> };
  const noCallbackClaude = buildClaudeExternalSdkTools(tools, "no-handler-claude", undefined, controller.signal)[0] as unknown as ClaudeNativeTool;
  const noCallbackClaudeResult = await noCallbackClaude.handler({ text: "x" });
  check("Claude does not convert missing callback into empty success", noCallbackClaudeResult.isError && noCallbackClaudeResult.content[0]?.text.includes("unsupported"));

  const noCallbackCodex = await dispatchCodexExternalToolCall({
    sdkToolName: externalToolSdkName("replace_selection"),
    callId: "no-handler-call",
    input: { text: "x" },
    sessionId: "no-handler-codex",
    tools,
    signal: controller.signal,
  });
  check("Codex does not convert missing callback into empty success", noCallbackCodex.matched && !noCallbackCodex.response.success && noCallbackCodex.response.contentItems[0]?.text.includes("unsupported"));
}

console.log(`\nt86-runtime-native-tool-protocol-smoke: ${checks - failures}/${checks} passed`);
if (failures > 0) process.exitCode = 1;
