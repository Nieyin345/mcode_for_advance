/**
 * T0 E1: GenOffice native tool round-trip through the real Host seam.
 *
 * Chain under test (in-process; no Electron, no network, no real model):
 *   GenOffice T98 main boundary (registerDocsAiIpc) → real Mcode docsAiPorts.run
 *   (T98's 4th argument = the scoped renderer ACK callback) → the request-local
 *   `externalTools` + `externalToolHandler` handed to RuntimeManager.sendTurn
 *   → a scripted fake SDK tool loop calling that handler → ACK back into the
 *   SAME SDK turn.
 *
 * RuntimeManager / repositories / Electron are replaced by the isolated stub;
 * GenOffice's real main-process boundary and the real docsAiPorts are not.
 */
import {
  MCODE_DOCS_AI_EVENT,
  registerDocsAiIpc,
  type DocsAiChunk,
  type DocsAiContext,
  type DocsAiPorts,
} from "../../../../genoffice/apps/docs/src/main/mcode-ai";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import type { ExternalToolCall, ExternalToolHandler, ExternalToolResult } from "@contracts/provider";
import {
  NATIVE_EDITOR_TOOL_CAPABILITIES,
  createNativeEditorToolBridge,
  nativeEditorToolBridgeBlockReason,
  nativeEditorToolCapability,
  planNativeEditorTurn,
  type GenOfficeNativeToolDefinition,
  type GenOfficeNativeToolInvoker,
  type GenOfficeNativeToolResult,
} from "../../src/main/document/nativeEditorToolTransport";
import { dispatchDocsAiTurn, docsAiPrompt, docsAiPorts } from "../../src/main/document/docsAiPorts";
import type { FakeTurn } from "./stubs/nativeAiMcode";

type StubState = {
  runtimeState: { driver: ((turn: FakeTurn) => Promise<void>) | null };
  turnCalls: Array<{ sessionId: string; input: FakeTurn["input"] }>;
  subscriptions: { active: number; peak: number };
};
const stub = (runtimeManager as unknown as { __t0: StubState }).__t0;

let total = 0;
let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  total++;
  if (condition) console.log("  ok   " + name);
  else {
    failures++;
    console.error("  FAIL " + name + (detail === undefined ? "" : " — " + JSON.stringify(detail)));
  }
}
function equal(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const STREAM = "mcode:docs:ai-stream";
const CANCEL = "mcode:docs:ai-stream-cancel";
const ACK = "mcode:docs:ai-tool-result";
const contextA: DocsAiContext = { sessionId: "session-a", filePath: "C:/sandbox/doc.docx" };
const contextB: DocsAiContext = { sessionId: "session-b", filePath: "C:/sandbox/other.docx" };

const readTool: GenOfficeNativeToolDefinition = {
  name: "read_blocks",
  description: "Read a block range from the open document.",
  inputSchema: {
    type: "object",
    properties: { startBlockIndex: { type: "integer" }, endBlockIndex: { type: "integer" } },
    required: ["startBlockIndex", "endBlockIndex"],
  },
};
const editTool: GenOfficeNativeToolDefinition = {
  name: "replace_selection",
  description: "Replace the selected text with restricted HTML.",
  inputSchema: { type: "object", properties: { html: { type: "string" } }, required: ["html"] },
};
/** A real Docs schema shape (`type: [X, 'null']`) the request-scoped subset cannot carry. */
const unionTool: GenOfficeNativeToolDefinition = {
  name: "insert_picture",
  description: "Insert a picture with an optional width.",
  inputSchema: { type: "object", properties: { width: { type: ["number", "string"] } } },
};
const deepSchema: Record<string, unknown> = (() => {
  let schema: Record<string, unknown> = { type: "object", properties: {} };
  for (let i = 0; i < 14; i++) schema = { type: "object", properties: { child: schema } };
  return schema;
})();
const deepTool: GenOfficeNativeToolDefinition = {
  name: "generate_mindmap",
  description: "Generate a mind map.",
  inputSchema: deepSchema,
};

// ---- scripted fake SDK tool loop -------------------------------------------
type ScriptedCall = { name: string; input?: Record<string, unknown>; callId?: string; sessionId?: string };
const scripts = new Map<string, ScriptedCall[][]>();
const recorded: Array<{ sessionId: string; call: ExternalToolCall; result: ExternalToolResult }> = [];
function script(sessionId: string, ...turns: ScriptedCall[][]) {
  const queue = scripts.get(sessionId) ?? [];
  queue.push(...turns);
  scripts.set(sessionId, queue);
}
function resetSdk(): number {
  scripts.clear();
  return recorded.length;
}
stub.runtimeState.driver = async (turn) => {
  const queue = scripts.get(turn.session.id) ?? [];
  const calls = queue.shift() ?? [];
  turn.emit({ type: "text.delta", sessionId: turn.session.id, text: "working" });
  for (const [index, item] of calls.entries()) {
    const handler = turn.input.externalToolHandler as ExternalToolHandler | undefined;
    if (!handler) throw new Error("scripted SDK turn saw no request-scoped handler");
    const call: ExternalToolCall = {
      sessionId: item.sessionId ?? turn.session.id,
      callId: item.callId ?? `${turn.session.id}-call-${index + 1}`,
      name: item.name,
      input: item.input ?? {},
    };
    const controller = new AbortController();
    if (turn.signal.aborted) controller.abort();
    const result = await handler(call, controller.signal);
    recorded.push({ sessionId: turn.session.id, call, result });
  }
};
const resultsSince = (mark: number) => recorded.slice(mark);

// ---- hosted Docs main boundary + real Mcode docsAiPorts ---------------------
type FakeSender = {
  id: number;
  sent: DocsAiChunk[];
  destroyed: boolean;
  destroyListeners: Array<() => void>;
  isDestroyed(): boolean;
  send(channel: string, chunk: DocsAiChunk): void;
  once(event: string, listener: () => void): FakeSender;
  destroy(): void;
};
type Handler = (event: { sender: FakeSender }, ...args: unknown[]) => unknown;
function makeSender(id: number): FakeSender {
  return {
    id,
    sent: [],
    destroyed: false,
    destroyListeners: [],
    isDestroyed() {
      return this.destroyed;
    },
    send(channel, chunk) {
      if (channel !== MCODE_DOCS_AI_EVENT) throw new Error("unexpected event channel " + channel);
      this.sent.push(chunk);
    },
    once(event, listener) {
      if (event === "destroyed") this.destroyListeners.push(listener);
      return this;
    },
    destroy() {
      this.destroyed = true;
      for (const listener of this.destroyListeners.splice(0)) listener();
    },
  };
}
function makeDocsHost(options: {
  ackTimeoutMs?: number;
  confirm?: () => Promise<boolean>;
  run?: DocsAiPorts["run"];
} = {}) {
  const handlers = new Map<string, Handler>();
  const owners = new WeakMap<object, { context: DocsAiContext; ports: DocsAiPorts }>();
  const ports: DocsAiPorts = {
    describe: () => ({ ok: true, provider: "mcode-test", model: "fake-sdk" }),
    confirm: options.confirm ?? (async () => true),
    run: (request, onChunk, signal, invokeRendererTool) =>
      (options.run ?? docsAiPorts.run)(request, onChunk, signal, invokeRendererTool),
  };
  const fakeIpc = {
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
  };
  const release = registerDocsAiIpc(
    fakeIpc as never,
    (rawSender) => {
      if (!rawSender || typeof rawSender !== "object") return null;
      return owners.get(rawSender as object) ?? null;
    },
    { toolResultAckTimeoutMs: options.ackTimeoutMs ?? 1_000 },
  );
  return {
    handlers,
    addSender(id: number, context: DocsAiContext) {
      const sender = makeSender(id);
      owners.set(sender, { context: { ...context }, ports });
      return sender;
    },
    invoke(channel: string, sender: FakeSender, ...args: unknown[]): unknown {
      const handler = handlers.get(channel);
      if (!handler) throw new Error("missing IPC handler " + channel);
      return handler({ sender }, ...args);
    },
    close: release,
  };
}
function docsRequest(requestId: string, tools: GenOfficeNativeToolDefinition[], text = "edit my selection") {
  return {
    requestId,
    system: "isolated t0 test",
    messages: [{ role: "user", content: text }],
    tools,
    // Deliberately untrusted renderer-supplied identity; the Host must ignore it.
    sessionId: "renderer-forged-session",
    filePath: "C:/renderer-forged/evil.docx",
  };
}
const toolChunks = (sender: FakeSender, requestId: string) =>
  sender.sent.filter((chunk) => chunk.requestId === requestId && chunk.type === "tool-call");
const nextUnacked = (sender: FakeSender, requestId: string, acked: Set<string>) =>
  toolChunks(sender, requestId).find((chunk) => chunk.toolCall && !acked.has(chunk.toolCall.id));
const ack = (
  requestId: string,
  callId: string,
  name: string,
  output: string,
  status: "success" | "error" | "cancelled" = "success",
) => ({ requestId, callId, name, status, output });

async function runSuite(): Promise<void> {
  console.log("\n1. Positive: renderer executes each call and the result returns to the same SDK turn");
  {
    const mark = resetSdk();
    script("session-a", [
      { name: "read_blocks", input: { startBlockIndex: 0, endBlockIndex: 2 } },
      { name: "replace_selection", input: { html: "<p>edited</p>" } },
    ]);
    const host = makeDocsHost();
    const sender = host.addSender(1, contextA);
    const pending = host.invoke(STREAM, sender, docsRequest("req-pos", [readTool, editTool])) as Promise<void>;
    await flush();
    const first = toolChunks(sender, "req-pos");
    check("Host issues a typed tool-call with requestId, callId and the renderer schema",
      first.length === 1 &&
        first[0]?.toolCall?.name === "read_blocks" &&
        first[0]?.toolCall?.id === "session-a-call-1" &&
        JSON.stringify(first[0]?.toolDefinition) === JSON.stringify(readTool),
      first);
    equal("the SDK turn is still waiting before any renderer ACK", resultsSince(mark).length, 0);
    const acked = new Set<string>();
    for (let i = 0; i < 2; i++) {
      await flush();
      const chunk = nextUnacked(sender, "req-pos", acked);
      check(`renderer receives call ${i + 1}`, !!chunk, toolChunks(sender, "req-pos"));
      if (!chunk?.toolCall) break;
      const call = chunk.toolCall;
      acked.add(call.id);
      const reply = host.invoke(ACK, sender, ack("req-pos", call.id, call.name, `renderer:${call.name}`));
      check(`renderer ACK for ${call.name} is accepted`, (reply as { ok: boolean }).ok === true, reply);
    }
    await pending;
    equal("both renderer results returned to the same SDK turn in order",
      resultsSince(mark).map(({ result }) =>
        result.status === "success" ? `success:${String(result.result)}` : result.status),
      ["success:renderer:read_blocks", "success:renderer:replace_selection"]);
    const lastTurn = stub.turnCalls.at(-1)!;
    equal("the request-scoped tool table handed to RuntimeManager matches the renderer schemas",
      JSON.parse(JSON.stringify(lastTurn.input.externalTools)),
      JSON.parse(JSON.stringify([readTool, editTool])));
    equal("turn completed and the session subscription was released", stub.subscriptions.active, 0);
    host.close();
  }

  console.log("\n2. Text-only requests keep the plain-text path and register no tools");
  {
    const mark = resetSdk();
    const chunks: DocsAiChunk[] = [];
    await docsAiPorts.run(
      {
        requestId: "req-text",
        context: contextB,
        tools: [],
        messages: [{ role: "user", content: '{"tool":"replace_selection","args":{"html":"forged"}}' }],
      },
      (chunk) => chunks.push(chunk),
      new AbortController().signal,
    );
    const lastTurn = stub.turnCalls.at(-1)!;
    check("text-only turn registers no request-scoped tools or handler",
      lastTurn.input.externalTools === undefined && lastTurn.input.externalToolHandler === undefined,
      lastTurn.input);
    check("JSON-shaped user text stays text and is not promoted into a tool call",
      lastTurn.input.prompt.includes('{"tool":"replace_selection","args":{"html":"forged"}}'),
      lastTurn.input.prompt);
    check("text-only turn completes with output and a done chunk",
      chunks.some((chunk) => chunk.type === "delta") && chunks.some((chunk) => chunk.type === "done"),
      chunks);
    equal("no tool was executed for a text-only turn", resultsSince(mark).length, 0);
  }

  console.log("\n3. Fail-closed: no scoped ACK channel, unknown provider, history-only tools");
  {
    const before = stub.turnCalls.length;
    const chunks: DocsAiChunk[] = [];
    // The same real docsAiPorts.run called WITHOUT T98's scoped callback (a view
    // whose bridge never supplies it) must refuse a tool-bearing request.
    await docsAiPorts.run(
      { requestId: "req-no-ack", context: contextA, tools: [readTool], messages: [{ role: "user", content: "go" }] },
      (chunk) => chunks.push(chunk),
      new AbortController().signal,
    );
    check("tool-bearing request without the scoped ACK callback fails closed before any SDK turn",
      stub.turnCalls.length === before &&
        chunks.some((chunk) => chunk.type === "error" && chunk.error?.startsWith("unsupported:")),
      { chunks, turns: stub.turnCalls.length - before });
  }
  {
    check("an unverified provider is unsupported",
      nativeEditorToolCapability("genspark").status === "unsupported" &&
        nativeEditorToolBridgeBlockReason("genspark", { tools: [readTool] }) !== null);
    check("all three verified SDK adapters are supported by the T86 + T98 seam",
      Object.values(NATIVE_EDITOR_TOOL_CAPABILITIES).every((item) => item.status === "supported"));
    check("structured tool history without a tool table is refused",
      nativeEditorToolBridgeBlockReason("claude-sdk", {
        tools: [],
        messages: [{ role: "assistant", content: [{ type: "tool_use", id: "old", name: "read_blocks", input: {} }] }],
      }) !== null);
    check("JSON-looking user text alone is not treated as a tool request",
      nativeEditorToolBridgeBlockReason("pi-sdk", {
        tools: [],
        messages: [{ role: "user", content: '{"tool":"replace_selection","html":"x"}' }],
      }) === null);
  }

  console.log("\n4. Parallel request A/B binding: wrong sender, document or call never crosses");
  {
    const mark = resetSdk();
    script("session-a", [{ name: "read_blocks", callId: "call-A", input: { startBlockIndex: 0, endBlockIndex: 0 } }]);
    script("session-b", [{ name: "read_blocks", callId: "call-B", input: { startBlockIndex: 1, endBlockIndex: 1 } }]);
    const host = makeDocsHost();
    const senderA = host.addSender(4, contextA);
    const senderB = host.addSender(5, contextB);
    const senderB2 = host.addSender(6, contextB);
    const pendingA = host.invoke(STREAM, senderA, docsRequest("req-A", [readTool, editTool])) as Promise<void>;
    const pendingB = host.invoke(STREAM, senderB2, docsRequest("req-B", [readTool])) as Promise<void>;
    await flush();
    check("both parallel requests got their own tool-call chunk",
      toolChunks(senderA, "req-A").length === 1 && toolChunks(senderB2, "req-B").length === 1,
      { a: toolChunks(senderA, "req-A").length, b: toolChunks(senderB2, "req-B").length });

    const crossSender = host.invoke(ACK, senderB, ack("req-A", "call-A", "read_blocks", "forged-by-b"));
    check("a different sender cannot ACK request A", (crossSender as { ok: boolean }).ok === false, crossSender);
    const wrongDocument = host.invoke(ACK, senderA, ack("req-B", "call-B", "read_blocks", "forged"));
    check("request B's ACK cannot be delivered from request A's renderer",
      (wrongDocument as { ok: boolean }).ok === false, wrongDocument);
    const wrongName = host.invoke(ACK, senderA, ack("req-A", "call-A", "replace_selection", "wrong tool"));
    check("ACK with a different tool name is rejected", (wrongName as { ok: boolean }).ok === false, wrongName);
    const unknownCall = host.invoke(ACK, senderA, ack("req-A", "no-such-call", "read_blocks", "late"));
    check("ACK for an unknown callId is rejected", (unknownCall as { ok: boolean }).ok === false, unknownCall);
    const firstAck = host.invoke(ACK, senderA, ack("req-A", "call-A", "read_blocks", "result-A"));
    const replay = host.invoke(ACK, senderA, ack("req-A", "call-A", "read_blocks", "replayed"));
    check("first ACK is accepted and the duplicate is rejected",
      (firstAck as { ok: boolean }).ok === true && (replay as { ok: boolean }).ok === false, { firstAck, replay });
    await pendingA;
    equal("only the first ACK reached request A's SDK turn",
      resultsSince(mark).filter((entry) => entry.sessionId === "session-a").map(({ result }) => result.status === "success" ? result.result : result.status),
      ["result-A"]);
    // Request B still waits; its own renderer teardown must not borrow A's result.
    senderB2.destroy();
    await pendingB;
    equal("request B's renderer destruction resolves B as cancelled, not success",
      resultsSince(mark).filter((entry) => entry.sessionId === "session-b").map(({ result }) => result.status),
      ["cancelled"]);
    host.close();
  }

  console.log("\n5. Bridge-level fail-closed: session, allowlist, call id, cancellation, late results");
  {
    const ackLog: string[] = [];
    const invoker: GenOfficeNativeToolInvoker = async (call) => {
      ackLog.push(`${call.name}:${call.id}:${JSON.stringify(call.input)}`);
      return { status: "success", output: `ok-${call.id}` };
    };
    const plan = planNativeEditorTurn("claude-sdk", { tools: [readTool, editTool] }, { invokerAvailable: true });
    if (plan.kind !== "tools") throw new Error("expected a tools plan");
    const bridge = createNativeEditorToolBridge({
      sessionId: "session-a",
      tools: plan.tools,
      definitions: plan.definitions,
      invokeRendererTool: invoker,
      signal: new AbortController().signal,
    });
    const ok = await bridge({ sessionId: "session-a", callId: "c1", name: "read_blocks", input: {} }, new AbortController().signal);
    check("bridge forwards a valid call once and returns success", ok.status === "success" && ackLog.length === 1, { ok, ackLog });
    const crossed = await bridge({ sessionId: "session-b", callId: "c2", name: "read_blocks", input: {} }, new AbortController().signal);
    check("bridge rejects a call bound to another session", crossed.status === "error" && ackLog.length === 1, crossed);
    const unknown = await bridge({ sessionId: "session-a", callId: "c3", name: "write_document", input: {} }, new AbortController().signal);
    check("bridge rejects a tool outside the request allowlist", unknown.status === "error" && ackLog.length === 1, unknown);
    const badId = await bridge({ sessionId: "session-a", callId: "bad id", name: "read_blocks", input: {} }, new AbortController().signal);
    check("bridge rejects an invalid call id", badId.status === "error" && ackLog.length === 1, badId);
    const dupe = await bridge({ sessionId: "session-a", callId: "c1", name: "read_blocks", input: {} }, new AbortController().signal);
    check("bridge rejects a repeated call id", dupe.status === "error" && ackLog.length === 1, dupe);
    const notObject = await bridge({ sessionId: "session-a", callId: "c4", name: "read_blocks", input: "x" as never }, new AbortController().signal);
    check("bridge rejects non-object tool input", notObject.status === "error" && ackLog.length === 1, notObject);

    const throwingBridge = createNativeEditorToolBridge({
      sessionId: "session-a",
      tools: [{ name: readTool.name, description: readTool.description, inputSchema: readTool.inputSchema }],
      definitions: new Map([[readTool.name, readTool]]),
      invokeRendererTool: async () => {
        throw new Error("renderer transport exploded");
      },
      signal: new AbortController().signal,
    });
    const thrown = await throwingBridge({ sessionId: "session-a", callId: "c4b", name: "read_blocks", input: {} }, new AbortController().signal);
    check("a throwing renderer channel becomes an explicit error carrying its message",
      thrown.status === "error" && /renderer transport exploded/.test(thrown.error ?? ""), thrown);

    const cancelledController = new AbortController();
    cancelledController.abort();
    const cancelled = await bridge({ sessionId: "session-a", callId: "c5", name: "read_blocks", input: {} }, cancelledController.signal);
    check("bridge reports cancellation, never success", cancelled.status === "cancelled" && ackLog.length === 1, cancelled);

    const microtaskAbort = new AbortController();
    let queuedRendererCalls = 0;
    const queuedBridge = createNativeEditorToolBridge({
      sessionId: "session-a",
      tools: [{ name: editTool.name, description: editTool.description, inputSchema: editTool.inputSchema }],
      definitions: new Map([[editTool.name, editTool]]),
      invokeRendererTool: async () => {
        queuedRendererCalls++;
        return { status: "success", output: "bad queued edit" };
      },
      signal: microtaskAbort.signal,
    });
    const queuedCall = queuedBridge(
      { sessionId: "session-a", callId: "microtask-race", name: "replace_selection", input: { html: "<p>no edit</p>" } },
      new AbortController().signal,
    );
    // A real Stop event may arrive after synchronous validation but before
    // the renderer invocation queued by Promise.resolve().then() is dispatched.
    microtaskAbort.abort();
    const queuedReply = await queuedCall;
    check("Stop between validation and microtask dispatch prevents the editor call entirely",
      queuedReply.status === "cancelled" && queuedRendererCalls === 0,
      { status: queuedReply.status, queuedRendererCalls });

    // A provider may cancel only one tool use, leaving the rest of the SDK
    // turn alive. A hung renderer ACK must not hold that cancelled tool call
    // indefinitely. This checks cancellation BEFORE the renderer resolves.
    const toolOnlyAbort = new AbortController();
    let releaseToolAck: ((result: GenOfficeNativeToolResult) => void) | undefined;
    let toolStarted = 0;
    const toolAck = new Promise<GenOfficeNativeToolResult>((resolve) => { releaseToolAck = resolve; });
    const callOnlyBridge = createNativeEditorToolBridge({
      sessionId: "session-a",
      tools: [{ name: editTool.name, description: editTool.description, inputSchema: editTool.inputSchema }],
      definitions: new Map([[editTool.name, editTool]]),
      invokeRendererTool: async () => {
        toolStarted++;
        return toolAck;
      },
      signal: new AbortController().signal,
    });
    const toolOnlyPending = callOnlyBridge(
      { sessionId: "session-a", callId: "call-only-abort", name: editTool.name, input: { html: "<p>no late edit</p>" } },
      toolOnlyAbort.signal,
    );
    await flush();
    check("call-only cancellation test genuinely reached the awaited renderer ACK", toolStarted === 1, { toolStarted });
    toolOnlyAbort.abort();
    let cancelTimeout: ReturnType<typeof setTimeout> | undefined;
    const earlyReply = await Promise.race([
      toolOnlyPending.then((reply) => ({ kind: "settled" as const, reply })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        cancelTimeout = setTimeout(() => resolve({ kind: "timeout" }), 120);
      }),
    ]);
    if (cancelTimeout) clearTimeout(cancelTimeout);
    check("SDK call-only abort returns cancelled promptly without waiting for renderer ACK",
      earlyReply.kind === "settled" && earlyReply.reply.status === "cancelled",
      earlyReply);
    // Let the detached renderer promise eventually complete. Its old success
    // must not replace the already cancelled SDK tool result.
    releaseToolAck?.({ status: "success", output: "stale renderer success" });
    const afterAck = await toolOnlyPending;
    check("late ACK cannot revive a call-only cancelled SDK result",
      afterAck.status === "cancelled", afterAck);

    // T98's real pending-ACK handler must receive the individual signal,
    // rather than only observing it locally in Mcode's Promise.race.
    let observedCallSignal: unknown = null;
    const forwardBridge = createNativeEditorToolBridge({
      sessionId: "session-a",
      tools: [{ name: readTool.name, description: readTool.description, inputSchema: readTool.inputSchema }],
      definitions: new Map([[readTool.name, readTool]]),
      invokeRendererTool: async (_call, _definition, signal) => {
        observedCallSignal = signal;
        return { status: "success", output: "ok" };
      },
      signal: new AbortController().signal,
    });
    const sdkCallSignal = new AbortController();
    const forwardResult = await forwardBridge(
      { sessionId: "session-a", callId: "forward-call-signal", name: readTool.name, input: {} },
      sdkCallSignal.signal,
    );
    check("Mcode forwards SDK call AbortSignal to the trusted renderer ACK adapter",
      forwardResult.status === "success" && observedCallSignal === sdkCallSignal.signal,
      { status: forwardResult.status, forwarded: observedCallSignal === sdkCallSignal.signal });

    const turnAbort = new AbortController();
    let lateSettled = false;
    const lateBridge = createNativeEditorToolBridge({
      sessionId: "session-a",
      tools: [{ name: readTool.name, description: readTool.description, inputSchema: readTool.inputSchema }],
      definitions: new Map([[readTool.name, readTool]]),
      invokeRendererTool: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        lateSettled = true;
        return { status: "success", output: "too late" };
      },
      signal: turnAbort.signal,
    });
    const pendingLate = lateBridge({ sessionId: "session-a", callId: "c6", name: "read_blocks", input: {} }, new AbortController().signal);
    await flush();
    turnAbort.abort();
    const late = await pendingLate;
    check("a result that arrives after cancellation is not a success", late.status === "cancelled", late);
    await new Promise((resolve) => setTimeout(resolve, 40));
    check("the late renderer worker still settles without reviving the call", lateSettled);
  }

  console.log("\n6. Withheld tools: unrepresentable schemas are reported, never silently executed");
  {
    const plan = planNativeEditorTurn("pi-sdk", { tools: [readTool, unionTool, deepTool] }, { invokerAvailable: true });
    check("a plan with some representable tools proceeds", plan.kind === "tools", plan);
    if (plan.kind === "tools") {
      equal("only representable tools are registered", plan.tools.map((tool) => tool.name), ["read_blocks"]);
      equal("unrepresentable tools are explicitly withheld",
        plan.withheld.map((item) => item.name), ["insert_picture", "generate_mindmap"]);
    }
    const allBad = planNativeEditorTurn("pi-sdk", { tools: [unionTool] }, { invokerAvailable: true });
    check("a turn whose every tool is unrepresentable is refused", allBad.kind === "refuse", allBad);
    const malformed = planNativeEditorTurn("pi-sdk", { tools: [{ name: "x" }] }, { invokerAvailable: true });
    check("malformed tool tables are refused", malformed.kind === "refuse", malformed);
    const duplicate = planNativeEditorTurn("pi-sdk", { tools: [readTool, readTool] }, { invokerAvailable: true });
    check("duplicate tool names are refused", duplicate.kind === "refuse", duplicate);
    const nonArray = planNativeEditorTurn("pi-sdk", { tools: "nope" }, { invokerAvailable: true });
    check("non-array tool tables are refused instead of treated as text-only", nonArray.kind === "refuse", nonArray);
    const many = Array.from({ length: 35 }, (_, index) => ({
      name: `tool_${index}`,
      description: `tool number ${index}`,
      inputSchema: { type: "object", properties: {} },
    }));
    const trimmed = planNativeEditorTurn("codex-sdk", { tools: many }, { invokerAvailable: true });
    check("more tools than the request-scoped limit are trimmed and reported",
      trimmed.kind === "tools" && trimmed.tools.length === 32 && trimmed.withheld.length === 3,
      trimmed.kind === "tools" ? { kept: trimmed.tools.length, withheld: trimmed.withheld.length } : trimmed);
    const prompt = docsAiPrompt(
      { requestId: "r", context: contextA, tools: [readTool, unionTool], messages: [{ role: "user", content: "go" }] },
      true,
      [{ name: "insert_picture", reason: "unsupported type union" }],
    );
    check("the prompt tells the model which tools are withheld this turn",
      !!prompt && prompt.includes("insert_picture") && !prompt.includes("host will never execute"), prompt);
  }

  console.log("\n7. Approval, denial, cancellation, teardown and missing ACK in the hosted turn");
  {
    const host = makeDocsHost({ confirm: async () => false });
    const sender = host.addSender(7, contextA);
    const before = stub.turnCalls.length;
    await host.invoke(STREAM, sender, docsRequest("req-denied", [readTool]));
    check("hosted approval denial runs no SDK turn and issues no tool call",
      stub.turnCalls.length === before && toolChunks(sender, "req-denied").length === 0,
      { turns: stub.turnCalls.length - before, sent: sender.sent.map((chunk) => chunk.type) });
    host.close();
  }
  {
    // Mcode's own approval prompt denial arrives as an explicit renderer error.
    const denyInvoker: GenOfficeNativeToolInvoker = async () => ({
      status: "error",
      output: "external tool call was denied by the user",
    });
    const bridge = createNativeEditorToolBridge({
      sessionId: "session-a",
      tools: [{ name: editTool.name, description: editTool.description, inputSchema: editTool.inputSchema }],
      definitions: new Map([[editTool.name, editTool]]),
      invokeRendererTool: denyInvoker,
      signal: new AbortController().signal,
    });
    const denied = await bridge({ sessionId: "session-a", callId: "d1", name: "replace_selection", input: { html: "<p>x</p>" } }, new AbortController().signal);
    check("user denial travels back to the SDK as an explicit error, never success",
      denied.status === "error" && /denied/.test(denied.error ?? ""), denied);
  }
  {
    const mark = resetSdk();
    script("session-a", [{ name: "read_blocks", callId: "call-cancel", input: { startBlockIndex: 0, endBlockIndex: 0 } }]);
    const host = makeDocsHost({ ackTimeoutMs: 5_000 });
    const sender = host.addSender(8, contextA);
    const pending = host.invoke(STREAM, sender, docsRequest("req-cancel", [readTool])) as Promise<void>;
    await flush();
    const cancelReply = host.invoke(CANCEL, sender, "req-cancel");
    check("cancel is accepted for the live request", (cancelReply as { ok: boolean }).ok === true, cancelReply);
    await pending;
    equal("the SDK turn learns the tool was cancelled, not completed",
      resultsSince(mark).map(({ result }) => result.status), ["cancelled"]);
    const lateAck = host.invoke(ACK, sender, ack("req-cancel", "call-cancel", "read_blocks", "too late"));
    check("an ACK after cancellation is rejected", (lateAck as { ok: boolean }).ok === false, lateAck);
    host.close();
  }
  {
    const mark = resetSdk();
    script("session-a", [{ name: "read_blocks", callId: "call-gone", input: { startBlockIndex: 0, endBlockIndex: 0 } }]);
    const host = makeDocsHost({ ackTimeoutMs: 5_000 });
    const sender = host.addSender(9, contextA);
    const pending = host.invoke(STREAM, sender, docsRequest("req-gone", [readTool])) as Promise<void>;
    await flush();
    sender.destroy();
    await pending;
    equal("renderer destruction resolves the pending call as cancelled",
      resultsSince(mark).map(({ result }) => result.status), ["cancelled"]);
    host.close();
  }
  {
    const mark = resetSdk();
    script("session-a", [{ name: "read_blocks", callId: "call-timeout", input: { startBlockIndex: 0, endBlockIndex: 0 } }]);
    const host = makeDocsHost({ ackTimeoutMs: 20 });
    const sender = host.addSender(10, contextA);
    await host.invoke(STREAM, sender, docsRequest("req-timeout", [readTool]));
    const results = resultsSince(mark);
    check("a missing renderer ACK becomes an explicit tool error, never an empty success",
      results.length === 1 && results[0]!.result.status === "error" &&
        /ACK/.test((results[0]!.result as { error?: string }).error ?? ""),
      results);
    host.close();
  }

  console.log("\n7a. Call-local cancellation cleans trusted Docs ACKs and rejects stale renderer results");
  {
    const toolAbort = new AbortController();
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let sdkResult: string | undefined;
    const host = makeDocsHost({
      ackTimeoutMs: 1_000,
      run: async (_req, _chunk, _requestSignal, invoke) => {
        if (!invoke) throw new Error("trusted renderer tool invoker absent");
        const pendingTool = invoke(
          { id: "individual-stop", name: readTool.name, input: { startBlockIndex: 0, endBlockIndex: 0 } },
          readTool,
          toolAbort.signal,
        );
        notifyStarted?.();
        sdkResult = (await pendingTool).status;
      },
    });
    const sender = host.addSender(77, contextA);
    const pendingTurn = host.invoke(STREAM, sender, docsRequest("req-individual-stop", [readTool])) as Promise<void>;
    await started;
    check("trusted host forwarded one renderer call before a call-local stop",
      toolChunks(sender, "req-individual-stop").length === 1);
    toolAbort.abort();
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const rapid = await Promise.race([
      pendingTurn.then(() => "settled"),
      new Promise<string>((resolve) => { expiry = setTimeout(() => resolve("timeout"), 120); }),
    ]);
    if (expiry) clearTimeout(expiry);
    check("call-only abort releases the T98 pending ACK immediately (no 60s slot leak)",
      rapid === "settled" && sdkResult === "cancelled", { rapid, sdkResult });
    const stale = host.invoke(ACK, sender, ack("req-individual-stop", "individual-stop", readTool.name, "unexpected late success"));
    check("late renderer ACK after call-only abort is never accepted by T98",
      (stale as { ok: boolean }).ok === false, stale);
    // On the old code this ACK releases the otherwise stuck pending request.
    await pendingTurn;
    host.close();
  }

  {
    // Cancellation must be call-scoped: a second tool in the SAME SDK turn
    // can still complete with a trusted ACK after the first one is cancelled.
    const firstAbort = new AbortController();
    let notifyReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { notifyReady = resolve; });
    let firstStatus: string | undefined;
    let secondStatus: string | undefined;
    const host = makeDocsHost({
      ackTimeoutMs: 1_000,
      run: async (_req, _chunk, _signal, invoke) => {
        if (!invoke) throw new Error("expected trusted native tool callback");
        const first = invoke(
          { id: "one-cancelled", name: readTool.name, input: { startBlockIndex: 0, endBlockIndex: 0 } },
          readTool,
          firstAbort.signal,
        );
        const second = invoke(
          { id: "two-survives", name: readTool.name, input: { startBlockIndex: 1, endBlockIndex: 1 } },
          readTool,
          new AbortController().signal,
        );
        notifyReady?.();
        firstStatus = (await first).status;
        secondStatus = (await second).status;
      },
    });
    const sender = host.addSender(78, contextA);
    const turn = host.invoke(STREAM, sender, docsRequest("req-two-native-calls", [readTool])) as Promise<void>;
    await ready;
    check("two renderer tools were dispatched in one Mcode SDK turn",
      toolChunks(sender, "req-two-native-calls").length === 2);
    firstAbort.abort();
    const secondAck = host.invoke(ACK, sender, ack("req-two-native-calls", "two-survives", readTool.name, "approved result"));
    check("the uncancelled call can still receive a trusted ACK",
      (secondAck as { ok: boolean }).ok === true, secondAck);
    const staleFirst = host.invoke(ACK, sender, ack("req-two-native-calls", "one-cancelled", readTool.name, "not approved"));
    check("the cancelled sibling's late ACK is rejected without cancelling the whole turn",
      (staleFirst as { ok: boolean }).ok === false, staleFirst);
    await turn;
    check("one cancelled tool does not poison its sibling SDK result",
      firstStatus === "cancelled" && secondStatus === "success",
      { firstStatus, secondStatus });
    host.close();
  }

  console.log("\n7b. Host abort immediately closes a pending SDK native-tool bridge");
  {
    // An SDK may still emit tool calls after interrupt() is requested, before
    // the provider's done promise settles. Aborting the hosted *request* must
    // close its renderer tool bridge immediately, not only in finally.
    const requestAbort = new AbortController();
    let releaseDone: (() => void) | null = null;
    let externalHandler: ExternalToolHandler | undefined;
    let interrupted = 0;
    let rendererInvocations = 0;
    const env = {
      lookup: () => ({
        session: { id: "session-a", providerId: "claude-sdk" },
        cwd: "C:/sandbox",
      }),
      subscribe: () => () => {},
      sendTurn: async (_session: unknown, input: { externalToolHandler?: ExternalToolHandler }) => {
        externalHandler = input.externalToolHandler;
        return {
          interrupt: () => { interrupted++; },
          done: new Promise<void>((resolve) => { releaseDone = resolve; }),
        };
      },
    } as unknown as Parameters<typeof dispatchDocsAiTurn>[3];
    const pending = dispatchDocsAiTurn(
      { requestId: "req-abort-host", user: "read blocks", tools: [readTool], context: contextA },
      () => {},
      requestAbort.signal,
      env,
      async () => {
        rendererInvocations++;
        return { status: "success", output: "should not run" };
      },
    );
    await flush();
    if (!externalHandler) throw new Error("SDK handler not installed in host abort test");
    requestAbort.abort();
    const reply = await externalHandler(
      { sessionId: "session-a", callId: "host-abort-late", name: readTool.name, input: {} },
      new AbortController().signal,
    );
    check("host abort cancels a tool call before SDK done and prevents renderer edits",
      reply.status === "cancelled" && rendererInvocations === 0 && interrupted === 1,
      { status: reply.status, rendererInvocations, interrupted });
    if (!releaseDone) throw new Error("SDK done resolver missing");
    (releaseDone as () => void)();
    await pending;
  }

  console.log("\n8. Text-only hosted turns never touch the tool bridge");
  {
    const mark = resetSdk();
    const host = makeDocsHost();
    const sender = host.addSender(11, contextA);
    await host.invoke(STREAM, sender, { ...docsRequest("req-plain", []), tools: undefined });
    const lastTurn = stub.turnCalls.at(-1)!;
    check("no external tools or handler leak into a text-only turn",
      lastTurn.input.externalTools === undefined && lastTurn.input.externalToolHandler === undefined,
      lastTurn.input);
    check("no renderer tool-call chunk is emitted for a text-only turn",
      toolChunks(sender, "req-plain").length === 0, sender.sent);
    equal("no tool execution happened", resultsSince(mark).length, 0);
    host.close();
  }

  console.log("\nt0-genoffice-native-tool-roundtrip-smoke:" + (total - failures) + "/" + total + " 通过");
  if (failures) process.exitCode = 1;
}

runSuite().catch((error) => {
  console.error("T0 smoke crashed:", error);
  process.exitCode = 1;
});
