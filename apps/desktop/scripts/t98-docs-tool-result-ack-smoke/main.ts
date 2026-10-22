import {
  MCODE_DOCS_AI_EVENT,
  MCODE_DOCS_AI_HANDLERS,
  registerDocsAiIpc,
  type DocsAiChunk,
  type DocsAiContext,
  type DocsAiPorts,
  type DocsAiRequest,
  type DocsAiToolResult,
  type DocsAiToolResultHandler,
} from "../../../../genoffice/apps/docs/src/main/mcode-ai";
import {
  AgentLoop,
  type AgentRunResult,
} from "../../../../genoffice/packages/agent-core/src/loop";
import {
  createIpcTransport,
  type IpcStreamChunk,
  type IpcStreamStart,
} from "../../../../genoffice/packages/agent-core/src/electron-transport";
import type { AgentSkill } from "../../../../genoffice/packages/agent-core/src/skill";
import type {
  AgentToolCall,
  AgentToolDef,
} from "../../../../genoffice/packages/agent-core/src/types";

let checks = 0;
let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  checks++;
  if (condition) console.log("  PASS " + name);
  else {
    failures++;
    console.error(
      "  FAIL " +
        name +
        (detail === undefined ? "" : " — " + JSON.stringify(detail)),
    );
  }
}
function equal(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), {
    actual,
    expected,
  });
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const STREAM = "mcode:docs:ai-stream";
const CANCEL = "mcode:docs:ai-stream-cancel";
const ACK = "mcode:docs:ai-tool-result";
const contextA: DocsAiContext = {
  sessionId: "session-a",
  filePath: "C:/isolated/a.docx",
};
const contextB: DocsAiContext = {
  sessionId: "session-b",
  filePath: "C:/isolated/b.docx",
};
const tool: DocsAiRequest["tools"][number] = {
  name: "read_current",
  description: "Read current selection",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
type NativeCall = Parameters<DocsAiToolResultHandler>[0];
type HostToolDefinition = Parameters<DocsAiToolResultHandler>[1];
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
type RunPort = (
  request: DocsAiRequest,
  onChunk: (chunk: DocsAiChunk) => void,
  signal: AbortSignal,
  invokeRendererTool: DocsAiToolResultHandler,
) => Promise<void>;

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
      if (channel !== MCODE_DOCS_AI_EVENT)
        throw new Error("unexpected event channel " + channel);
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
function request(
  requestId: string,
  tools: DocsAiRequest["tools"] = [tool],
): Record<string, unknown> {
  return {
    requestId,
    system: "isolated test",
    messages: [{ role: "user", content: "use a tool" }],
    tools,
    // These are deliberately untrusted and must be ignored by the main boundary.
    sessionId: "renderer-forged-session",
    filePath: "C:/renderer-forged/path.docx",
  };
}
function makeHarness(
  run: RunPort,
  options: { timeoutMs?: number; approve?: boolean } = {},
) {
  const handlers = new Map<string, Handler>();
  const owners = new WeakMap<
    object,
    { context: DocsAiContext; ports: DocsAiPorts }
  >();
  const ports: DocsAiPorts = {
    describe: () => ({ ok: true, provider: "mcode-test", model: "fake-sdk" }),
    confirm: async () => options.approve !== false,
    run: (req, onChunk, signal, invokeRendererTool) => {
      if (!invokeRendererTool) throw new Error("Host callback seam missing");
      return run(req, onChunk, signal, invokeRendererTool);
    },
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
      const owner = owners.get(rawSender as object);
      return owner ? { context: owner.context, ports: owner.ports } : null;
    },
    { toolResultAckTimeoutMs: options.timeoutMs ?? 1_000 },
  );
  return {
    handlers,
    ports,
    addSender(id: number, context: DocsAiContext = contextA) {
      const sender = makeSender(id);
      owners.set(sender, { context: { ...context }, ports });
      return sender;
    },
    setContext(sender: FakeSender, context: DocsAiContext) {
      const owner = owners.get(sender);
      if (owner) {
        // Mutate the same owner object in place to prove each request snapshots
        // identity instead of retaining a mutable context reference.
        owner.context.sessionId = context.sessionId;
        owner.context.filePath = context.filePath;
      }
    },
    invalidateSender(sender: FakeSender) {
      owners.delete(sender);
    },
    invoke(channel: string, sender: FakeSender, ...args: unknown[]): unknown {
      const handler = handlers.get(channel);
      if (!handler) throw new Error("missing IPC handler " + channel);
      return handler({ sender }, ...args);
    },
    close: release,
  };
}
function toolChunk(
  sender: FakeSender,
  requestId: string,
): DocsAiChunk | undefined {
  return sender.sent.find(
    (chunk) => chunk.type === "tool-call" && chunk.requestId === requestId,
  );
}
function ack(
  requestId: string,
  callId: string,
  output: string,
  name = tool.name,
) {
  return { requestId, callId, name, status: "success", output };
}

async function runSuite(): Promise<void> {
  console.log("\n1. Same-turn renderer result ACK");
  {
    const sdkResults = new Map<string, DocsAiToolResult>();
    const run: RunPort = async (req, onChunk, _signal, invoke) => {
      const result = await invoke(
        { id: "call-" + req.requestId, name: tool.name, input: {} },
        tool,
      );
      sdkResults.set(req.requestId, result);
      onChunk({ requestId: req.requestId, type: "done" });
    };
    const h = makeHarness(run);
    const sender = h.addSender(1);
    const pending = h.invoke(
      STREAM,
      sender,
      request("req-one"),
    ) as Promise<void>;
    await flush();
    const chunk = toolChunk(sender, "req-one");
    check(
      "Host issues a typed tool-call with its requestId, callId and schema",
      !!chunk?.toolCall && chunk.toolDefinition?.name === tool.name,
      chunk,
    );
    check(
      "SDK remains waiting until the renderer returns a result",
      !sdkResults.has("req-one"),
    );
    const response = h.invoke(
      ACK,
      sender,
      ack("req-one", "call-req-one", "native result"),
    ) as { ok: boolean };
    check("matching ACK is accepted", response.ok === true, response);
    await pending;
    equal(
      "same SDK turn receives the exact success result",
      sdkResults.get("req-one"),
      { status: "success", output: "native result" },
    );
    equal(
      "done is emitted only after the ACK",
      sender.sent.map((item) => item.type),
      ["tool-call", "done"],
    );
    h.close();
  }

  console.log("\n1b. Real AgentLoop + IPC transport same-turn integration");
  {
    let listener: ((chunk: IpcStreamChunk) => void) | undefined;
    const started: IpcStreamStart<{ provider: string }>[] = [];
    const acknowledgements: Array<{
      requestId: string;
      callId: string;
      name: string;
      status: string;
      output: string;
    }> = [];
    let resolveAck!: () => void;
    const ackSeen = new Promise<void>((resolve) => {
      resolveAck = resolve;
    });
    const transport = createIpcTransport<{ provider: string }>({
      onStream: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      start: (startRequest) => {
        started.push(startRequest);
      },
      cancel: () => {},
      getSettings: () => ({ provider: "mcode-test" }),
      unknownErrorText: () => "unknown",
      toolResultAck: async (value) => {
        acknowledgements.push(value);
        resolveAck();
        return { ok: true };
      },
    });
    const executed: AgentToolCall[] = [];
    const skill: AgentSkill = {
      id: "t98-native-tool",
      systemPrompt: "Use native tool",
      tools: [tool as AgentToolDef],
      buildContext: () => "isolated context",
      executeTool: (call) => {
        executed.push(call);
        return {
          output: "renderer-native-result",
          summary: "read selection",
          mutated: false,
        };
      },
    };
    let doneResult: AgentRunResult | undefined;
    let resolveDone!: (result: AgentRunResult) => void;
    const done = new Promise<AgentRunResult>((resolve) => {
      resolveDone = resolve;
    });
    const loop = new AgentLoop({
      transport,
      skill,
      events: {
        onDone: (result) => {
          doneResult = result;
          resolveDone(result);
        },
      },
    });
    loop.run("read the selection");
    await flush();
    const requestId = started[0]?.requestId;
    check(
      "AgentLoop starts exactly one SDK turn",
      started.length === 1 && !!requestId,
      started.length,
    );
    listener?.({
      requestId: requestId!,
      type: "tool-call",
      toolCall: { id: "same-turn-call", name: tool.name, input: {} },
      toolDefinition: tool as AgentToolDef,
    });
    await ackSeen;
    equal(
      "native AgentSkill executor runs once before ACK",
      executed.map((call) => call.id),
      ["same-turn-call"],
    );
    equal(
      "transport ACK contains the real native result",
      acknowledgements.map(({ requestId: id, callId, status, output }) => ({
        requestId: id,
        callId,
        status,
        output,
      })),
      [
        {
          requestId: requestId!,
          callId: "same-turn-call",
          status: "success",
          output: "renderer-native-result",
        },
      ],
    );
    listener?.({
      requestId: requestId!,
      type: "delta",
      text: "Final answer after tool",
    });
    listener?.({ requestId: requestId!, type: "done" });
    await done;
    equal(
      "same SDK turn completes with final text",
      doneResult?.text,
      "Final answer after tool",
    );
    check(
      "hosted tool is not executed again in a native follow-up turn",
      started.length === 1 && executed.length === 1,
      { turns: started.length, executions: executed.length },
    );
    equal(
      "hosted exchange does not synthesize a second local tool-history turn",
      loop.messages.map((message) => message.role),
      ["user", "assistant"],
    );
  }

  console.log(
    "\n1c. Standalone transport keeps its original post-done tool loop",
  );
  {
    let listener: ((chunk: IpcStreamChunk) => void) | undefined;
    const started: IpcStreamStart<{ provider: string }>[] = [];
    const transport = createIpcTransport<{ provider: string }>({
      onStream: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      start: (startRequest) => {
        started.push(startRequest);
      },
      cancel: () => {},
      getSettings: () => ({ provider: "standalone-test" }),
      unknownErrorText: () => "unknown",
    });
    const executed: AgentToolCall[] = [];
    const skill: AgentSkill = {
      id: "t98-standalone-tool",
      systemPrompt: "Use native tool",
      tools: [tool as AgentToolDef],
      buildContext: () => "isolated context",
      executeTool: (call) => {
        executed.push(call);
        return {
          output: "standalone-native-result",
          summary: "read selection",
          mutated: false,
        };
      },
    };
    let doneResult: AgentRunResult | undefined;
    let resolveDone!: (result: AgentRunResult) => void;
    const done = new Promise<AgentRunResult>((resolve) => {
      resolveDone = resolve;
    });
    const loop = new AgentLoop({
      transport,
      skill,
      events: {
        onDone: (result) => {
          doneResult = result;
          resolveDone(result);
        },
      },
    });
    loop.run("standalone read");
    await flush();
    const firstId = started[0]?.requestId;
    check(
      "standalone transport does not opt into hosted ACK",
      (transport as unknown as { supportsInTurnToolResultAck?: boolean })
        .supportsInTurnToolResultAck === false,
    );
    listener?.({
      requestId: firstId!,
      type: "tool-call",
      toolCall: { id: "standalone-call", name: tool.name, input: {} },
    });
    check(
      "standalone native tool remains deferred until done",
      executed.length === 0,
    );
    listener?.({ requestId: firstId!, type: "done" });
    for (let i = 0; i < 5 && started.length < 2; i++) await flush();
    check(
      "standalone still executes after done and opens its native follow-up turn",
      executed.length === 1 && started.length === 2,
      { executions: executed.length, turns: started.length },
    );
    const secondId = started[1]?.requestId;
    listener?.({
      requestId: secondId!,
      type: "delta",
      text: "Standalone final",
    });
    listener?.({ requestId: secondId!, type: "done" });
    await done;
    equal(
      "standalone follow-up turn completes normally",
      doneResult?.text,
      "Standalone final",
    );
  }

  console.log("\n2. Concurrent requests and strict sender/document binding");
  {
    const sdkResults = new Map<string, DocsAiToolResult>();
    const run: RunPort = async (req, onChunk, _signal, invoke) => {
      const result = await invoke(
        { id: "call-" + req.requestId, name: tool.name, input: {} },
        tool,
      );
      sdkResults.set(req.requestId, result);
      onChunk({ requestId: req.requestId, type: "done" });
    };
    const h = makeHarness(run);
    const senderA = h.addSender(2, contextA);
    const senderB = h.addSender(3, contextA);
    const pendingA = h.invoke(
      STREAM,
      senderA,
      request("req-A"),
    ) as Promise<void>;
    const pendingB = h.invoke(
      STREAM,
      senderB,
      request("req-B"),
    ) as Promise<void>;
    await flush();
    const forgedSameIdSender = h.addSender(2, contextA);
    const crossSender = h.invoke(
      ACK,
      forgedSameIdSender,
      ack("req-A", "call-req-A", "forged"),
    ) as { ok: boolean };
    check(
      "a different sender cannot ACK even when it forges the same sender id",
      crossSender.ok === false,
      crossSender,
    );
    const responseB = h.invoke(
      ACK,
      senderB,
      ack("req-B", "call-req-B", "result-B"),
    ) as { ok: boolean };
    const responseA = h.invoke(
      ACK,
      senderA,
      ack("req-A", "call-req-A", "result-A"),
    ) as { ok: boolean };
    check(
      "request B can be ACKed before request A",
      responseB.ok && responseA.ok,
    );
    await Promise.all([pendingA, pendingB]);
    equal(
      "out-of-order ACKs remain bound to request B",
      sdkResults.get("req-B"),
      { status: "success", output: "result-B" },
    );
    equal(
      "out-of-order ACKs remain bound to request A",
      sdkResults.get("req-A"),
      { status: "success", output: "result-A" },
    );
    h.close();
  }

  {
    let sdkResult: DocsAiToolResult | undefined;
    const run: RunPort = async (req, onChunk, _signal, invoke) => {
      sdkResult = await invoke(
        { id: "call-revoked", name: tool.name, input: {} },
        tool,
      );
      onChunk({ requestId: req.requestId, type: "done" });
    };
    const h = makeHarness(run);
    const sender = h.addSender(41, contextA);
    const pending = h.invoke(
      STREAM,
      sender,
      request("req-revoked"),
    ) as Promise<void>;
    await flush();
    h.invalidateSender(sender);
    const response = h.invoke(
      ACK,
      sender,
      ack("req-revoked", "call-revoked", "revoked"),
    ) as { ok: boolean };
    check(
      "ACK from a no-longer-authorized pane is rejected",
      response.ok === false,
      response,
    );
    await pending;
    equal(
      "revoked pane cancels the pending SDK result",
      sdkResult?.status,
      "cancelled",
    );
    h.close();
  }

  console.log("\n3. Changed document, unknown tool and schema mismatch");
  {
    let sdkResult: DocsAiToolResult | undefined;
    const run: RunPort = async (req, onChunk, _signal, invoke) => {
      sdkResult = await invoke(
        { id: "call-doc", name: tool.name, input: {} },
        tool,
      );
      onChunk({ requestId: req.requestId, type: "done" });
    };
    const h = makeHarness(run);
    const sender = h.addSender(4, contextA);
    const pending = h.invoke(
      STREAM,
      sender,
      request("req-doc"),
    ) as Promise<void>;
    await flush();
    h.setContext(sender, contextB);
    const response = h.invoke(
      ACK,
      sender,
      ack("req-doc", "call-doc", "cross-document"),
    ) as { ok: boolean };
    check(
      "ACK from a changed session/document is rejected",
      response.ok === false,
      response,
    );
    await pending;
    equal("document switch cancels the pending tool result", sdkResult, {
      status: "cancelled",
      output: "Host request was cancelled before tool-result ACK",
    });
    const late = h.invoke(ACK, sender, ack("req-doc", "call-doc", "late")) as {
      ok: boolean;
    };
    check(
      "ACK after cancellation/cleanup is rejected",
      late.ok === false,
      late,
    );
    h.close();
  }
  {
    let unknownResult: DocsAiToolResult | undefined;
    const run: RunPort = async (req, onChunk, _signal, invoke) => {
      unknownResult = await invoke(
        { id: "unknown-call", name: "admin_delete", input: {} },
        {
          name: "admin_delete",
          description: "not allowlisted",
          inputSchema: { type: "object" },
        } as HostToolDefinition,
      );
      onChunk({ requestId: req.requestId, type: "done" });
    };
    const h = makeHarness(run);
    const sender = h.addSender(5);
    await h.invoke(STREAM, sender, request("req-unknown"));
    equal(
      "unknown Host tool returns an explicit error",
      unknownResult?.status,
      "error",
    );
    check(
      "unknown tool is never dispatched to renderer",
      !sender.sent.some((item) => item.type === "tool-call"),
    );
    h.close();
  }
  {
    let mismatchResult: DocsAiToolResult | undefined;
    const run: RunPort = async (req, onChunk, _signal, invoke) => {
      mismatchResult = await invoke(
        { id: "schema-call", name: tool.name, input: {} },
        {
          ...tool,
          inputSchema: {
            type: "object",
            properties: { forbidden: { type: "string" } },
          },
        } as HostToolDefinition,
      );
      onChunk({ requestId: req.requestId, type: "done" });
    };
    const h = makeHarness(run);
    const sender = h.addSender(6);
    await h.invoke(STREAM, sender, request("req-schema"));
    equal(
      "Host/renderer schema mismatch fails closed",
      mismatchResult?.status,
      "error",
    );
    check(
      "schema mismatch is not dispatched to renderer",
      !sender.sent.some((item) => item.type === "tool-call"),
    );
    h.close();
  }

  console.log("\n4. Malformed/oversized payloads and unsolicited ACKs");
  {
    let sdkResult: DocsAiToolResult | undefined;
    const run: RunPort = async (req, onChunk, _signal, invoke) => {
      sdkResult = await invoke(
        { id: "call-large", name: tool.name, input: {} },
        tool,
      );
      onChunk({ requestId: req.requestId, type: "done" });
    };
    const h = makeHarness(run);
    const sender = h.addSender(7);
    const pending = h.invoke(
      STREAM,
      sender,
      request("req-large"),
    ) as Promise<void>;
    await flush();
    const malformed = h.invoke(ACK, sender, {
      ...ack("req-large", "call-large", "ignored"),
      extra: true,
    }) as { ok: boolean };
    check(
      "ACK with extra envelope fields is rejected",
      malformed.ok === false,
      malformed,
    );
    const boxedStatus = h.invoke(ACK, sender, {
      ...ack("req-large", "call-large", "ignored"),
      status: new String("success"),
    }) as { ok: boolean };
    check(
      "non-string ACK status is rejected",
      boxedStatus.ok === false,
      boxedStatus,
    );
    const oversized = h.invoke(
      ACK,
      sender,
      ack("req-large", "call-large", "x".repeat(64 * 1024 + 1)),
    ) as { ok: boolean; error?: string };
    check(
      "oversized result is rejected and replaced by a bounded Host error",
      oversized.ok === true && !!oversized.error,
      oversized,
    );
    await pending;
    equal(
      "oversized output reaches the SDK as an error, never success",
      sdkResult,
      {
        status: "error",
        output:
          "Host rejected the renderer tool result because its payload exceeded 64 KiB",
      },
    );
    const duplicate = h.invoke(
      ACK,
      sender,
      ack("req-large", "call-large", "second"),
    ) as { ok: boolean };
    check(
      "duplicate ACK after settlement is rejected",
      duplicate.ok === false,
      duplicate,
    );
    h.close();
  }
  for (const status of ["error", "cancelled"] as const) {
    let sdkResult: DocsAiToolResult | undefined;
    const run: RunPort = async (req, onChunk, _signal, invoke) => {
      sdkResult = await invoke(
        { id: "call-status", name: tool.name, input: {} },
        tool,
      );
      onChunk({ requestId: req.requestId, type: "done" });
    };
    const h = makeHarness(run);
    const sender = h.addSender(status === "error" ? 70 : 71);
    const pending = h.invoke(
      STREAM,
      sender,
      request("req-status-" + status),
    ) as Promise<void>;
    await flush();
    const resultText =
      status === "error"
        ? "renderer tool failed"
        : "renderer cancelled the tool";
    const response = h.invoke(ACK, sender, {
      ...ack("req-status-" + status, "call-status", resultText),
      status,
    }) as { ok: boolean };
    check(
      "renderer " + status + " result is accepted as a typed state",
      response.ok === true,
      response,
    );
    await pending;
    equal(
      "renderer " + status + " state reaches the SDK unchanged",
      sdkResult,
      { status, output: resultText },
    );
    h.close();
  }
  {
    let sdkResult: DocsAiToolResult | undefined;
    const run: RunPort = async (req, onChunk, _signal, invoke) => {
      sdkResult = await invoke(
        {
          id: "call-big-input",
          name: tool.name,
          input: { value: "x".repeat(70 * 1024) },
        },
        tool,
      );
      onChunk({ requestId: req.requestId, type: "done" });
    };
    const h = makeHarness(run);
    const sender = h.addSender(8);
    await h.invoke(STREAM, sender, request("req-big-input"));
    equal(
      "oversized native tool arguments are rejected",
      sdkResult?.status,
      "error",
    );
    check(
      "oversized arguments are not dispatched to renderer",
      !sender.sent.some((item) => item.type === "tool-call"),
    );
    h.close();
  }
  {
    const h = makeHarness(async (req, onChunk) => {
      onChunk({ requestId: req.requestId, type: "done" });
    });
    const sender = h.addSender(9);
    const pending = h.invoke(
      STREAM,
      sender,
      request("req-no-host-callback"),
    ) as Promise<void>;
    await flush();
    const unsolicited = h.invoke(
      ACK,
      sender,
      ack("req-no-host-callback", "not-pending", "fake success"),
    ) as { ok: boolean };
    check(
      "ACK without a matching Host callback is rejected",
      unsolicited.ok === false,
      unsolicited,
    );
    await pending;
    check(
      "arbitrary ai:* IPC is not registered",
      !h.handlers.has("mcode:docs:ai-execute") &&
        !h.handlers.has("mcode:docs:ai-tool-result-any"),
    );
    h.close();
  }

  console.log("\n5. Cancellation, timeout, approval and renderer teardown");
  {
    let sdkResult: DocsAiToolResult | undefined;
    const run: RunPort = async (req, onChunk, _signal, invoke) => {
      sdkResult = await invoke(
        { id: "call-cancel", name: tool.name, input: {} },
        tool,
      );
      onChunk({ requestId: req.requestId, type: "done" });
    };
    const h = makeHarness(run);
    const sender = h.addSender(10);
    const pending = h.invoke(
      STREAM,
      sender,
      request("req-cancel"),
    ) as Promise<void>;
    await flush();
    const cancelled = h.invoke(CANCEL, sender, "req-cancel") as { ok: boolean };
    check(
      "active request cancellation is acknowledged",
      cancelled.ok === true,
      cancelled,
    );
    await pending;
    equal(
      "cancellation resolves pending SDK tool call as cancelled",
      sdkResult?.status,
      "cancelled",
    );
    const late = h.invoke(
      ACK,
      sender,
      ack("req-cancel", "call-cancel", "late success"),
    ) as { ok: boolean };
    check("cancelled request rejects late ACK", late.ok === false, late);
    h.close();
  }
  {
    let sdkResult: DocsAiToolResult | undefined;
    const run: RunPort = async (req, onChunk, _signal, invoke) => {
      sdkResult = await invoke(
        { id: "call-timeout", name: tool.name, input: {} },
        tool,
      );
      onChunk({ requestId: req.requestId, type: "done" });
    };
    const h = makeHarness(run, { timeoutMs: 15 });
    const sender = h.addSender(11);
    await h.invoke(STREAM, sender, request("req-timeout"));
    equal(
      "missing renderer ACK times out as an error",
      sdkResult?.status,
      "error",
    );
    check(
      "timeout does not produce an empty or successful result",
      !!sdkResult?.output && sdkResult?.output.includes("Timed out"),
    );
    const late = h.invoke(
      ACK,
      sender,
      ack("req-timeout", "call-timeout", "late"),
    ) as { ok: boolean };
    check("timed-out ACK is rejected", late.ok === false, late);
    h.close();
  }
  {
    let sdkResult: DocsAiToolResult | undefined;
    let runCount = 0;
    const run: RunPort = async (req, onChunk, _signal, invoke) => {
      runCount++;
      sdkResult = await invoke(
        { id: "call-denied", name: tool.name, input: {} },
        tool,
      );
      onChunk({ requestId: req.requestId, type: "done" });
    };
    const h = makeHarness(run, { approve: false });
    const sender = h.addSender(12);
    await h.invoke(STREAM, sender, request("req-denied"));
    equal("approval denial prevents Host tool execution", runCount, 0);
    check(
      "approval denial emits no tool-call event",
      !sender.sent.some((item) => item.type === "tool-call"),
    );
    const late = h.invoke(
      ACK,
      sender,
      ack("req-denied", "call-denied", "fake"),
    ) as { ok: boolean };
    check("approval denial leaves no ACK capability", late.ok === false, late);
    h.close();
  }
  {
    let sdkResult: DocsAiToolResult | undefined;
    const run: RunPort = async (req, onChunk, _signal, invoke) => {
      sdkResult = await invoke(
        { id: "call-destroy", name: tool.name, input: {} },
        tool,
      );
      onChunk({ requestId: req.requestId, type: "done" });
    };
    const h = makeHarness(run);
    const sender = h.addSender(13);
    const pending = h.invoke(
      STREAM,
      sender,
      request("req-destroy"),
    ) as Promise<void>;
    await flush();
    sender.destroy();
    await pending;
    equal(
      "renderer destruction resolves pending call as cancelled",
      sdkResult?.status,
      "cancelled",
    );
    const late = h.invoke(
      ACK,
      sender,
      ack("req-destroy", "call-destroy", "fake success"),
    ) as { ok: boolean };
    check(
      "destroyed renderer cannot ACK after teardown",
      late.ok === false,
      late,
    );
    h.close();
  }

  console.log("\n6. Exact channel registration and handler cleanup");
  {
    const h = makeHarness(async (req, onChunk) => {
      onChunk({ requestId: req.requestId, type: "done" });
    });
    check(
      "tool-result route is in the explicit allowlist",
      MCODE_DOCS_AI_HANDLERS.includes("tool-result" as never),
    );
    check(
      "generic/open-ended ai IPC routes are absent",
      !MCODE_DOCS_AI_HANDLERS.includes("execute" as never),
    );
    h.close();
    check("release removes the dedicated ACK handler", !h.handlers.has(ACK));
  }

  console.log(
    "t98-docs-tool-result-ack-smoke:" +
      (checks - failures) +
      "/" +
      checks +
      " passed",
  );
  if (failures) process.exitCode = 1;
}
runSuite().catch((error) => {
  console.error("T98 smoke crashed:", error);
  process.exitCode = 1;
});
