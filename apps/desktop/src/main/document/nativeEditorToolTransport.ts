/**
 * T0: Host-side planning and bridge for GenOffice's renderer-owned AgentSkill
 * tools.
 *
 * T83 kept tool-bearing requests fail-closed because there was no safe
 * round-trip. T86 added the request-scoped external-tool contract
 * (`externalTools` + `externalToolHandler`) and T98 added the Docs-hosted
 * request/call-scoped renderer ACK. This module is the seam between them: it
 * turns a GenOffice request's renderer tool schemas into a request-local
 * contract, plans text vs tool turns, and maps each native SDK call onto the
 * bound renderer's `AgentSkill.executeTool` result. Executable handlers never
 * cross into serializable definitions; unknown, malformed, duplicate, denied,
 * cancelled or late calls fail closed — never as an empty success.
 */
import { Buffer } from "node:buffer";
import type {
  ExternalToolCall,
  ExternalToolDefinition,
  ExternalToolHandler,
  ExternalToolResult,
  ProviderAbortSignal,
} from "@contracts/provider";
import { validateExternalToolDefinitions } from "@main/providers/nativeToolProtocol.js";

export type NativeEditorToolCapabilityStatus = "supported" | "unsupported" | "needs upstream";

export interface NativeEditorToolCapability {
  status: NativeEditorToolCapabilityStatus;
  reason: string;
}

export const NATIVE_EDITOR_TOOL_CAPABILITIES: Readonly<Record<
  "claude-sdk" | "pi-sdk" | "codex-sdk",
  NativeEditorToolCapability
>> = Object.freeze({
  "claude-sdk": Object.freeze({
    status: "supported",
    reason: "T86 registers this request's tools as an in-process MCP server; the handler awaits the Host callback, and T98 returns the bound renderer's result to the same query turn.",
  }),
  "pi-sdk": Object.freeze({
    status: "supported",
    reason: "T86 registers this request's tools as Pi customTools; execute() awaits the Host callback, and T98 returns the bound renderer's result to the same turn.",
  }),
  "codex-sdk": Object.freeze({
    status: "supported",
    reason: "T86 registers this request's tools as Codex dynamicTools; item/tool/call awaits the Host callback, and T98 returns the bound renderer's result to the same turn.",
  }),
});

const UNKNOWN_PROVIDER: NativeEditorToolCapability = Object.freeze({
  status: "unsupported",
  reason: "The provider is not one of the three verified Mcode SDK adapters.",
});

export function nativeEditorToolCapability(providerId: string): NativeEditorToolCapability {
  if (providerId === "claude-sdk" || providerId === "pi-sdk" || providerId === "codex-sdk") {
    return NATIVE_EDITOR_TOOL_CAPABILITIES[providerId];
  }
  return UNKNOWN_PROVIDER;
}

/** The renderer-owned shape (structurally identical to GenOffice's AgentToolDef). */
export interface GenOfficeNativeToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
/** The renderer-owned call shape (structurally identical to GenOffice's AgentToolCall). */
export interface GenOfficeNativeToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export type GenOfficeNativeToolStatus = "success" | "error" | "cancelled";
/** Structurally identical to GenOffice's `DocsAiToolResult`. */
export interface GenOfficeNativeToolResult {
  status: GenOfficeNativeToolStatus;
  output: string;
}
/** T98's per-request callback: execute in the bound renderer and await its ACK. */
export type GenOfficeNativeToolInvoker = (
  call: GenOfficeNativeToolCall,
  hostToolDefinition: GenOfficeNativeToolDefinition,
) => Promise<GenOfficeNativeToolResult>;

/** Host limits mirrored from the request-scoped provider contract. */
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_ERROR_CHARS = 2_000;

export interface WithheldNativeTool {
  name: string;
  reason: string;
}

export type NativeEditorTurnPlan =
  | { kind: "text" }
  | {
      kind: "tools";
      /** Validated request-local definitions handed to RuntimeManager. */
      tools: ExternalToolDefinition[];
      /** Original renderer definitions, echoed back for the ACK schema check. */
      definitions: Map<string, GenOfficeNativeToolDefinition>;
      /** Renderer tools this turn cannot carry; never silently executed. */
      withheld: WithheldNativeTool[];
    }
  | { kind: "refuse"; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Detect protocol-shaped tool history only. Plain text such as
 * `{"tool":"replace_selection"}` is deliberately not parsed or promoted into
 * an executable call.
 */
function hasStructuredToolHistory(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    if (!isRecord(message)) return false;
    if (message.role === "tool") return true;
    for (const key of ["toolCalls", "tool_calls"]) {
      if (Array.isArray(message[key]) && (message[key] as unknown[]).length > 0) return true;
    }
    if (!Array.isArray(message.content)) return false;
    return (message.content as unknown[]).some((part) =>
      isRecord(part) && ["tool_use", "tool_result", "tool_call", "function_call", "function_call_output"].includes(String(part.type)),
    );
  });
}

function declaresTools(tools: unknown): boolean {
  // An absent or empty list is a text-only request. Malformed non-array values
  // are treated as requiring the unsupported tool protocol, never as no tools.
  return tools !== undefined && (!Array.isArray(tools) || tools.length > 0);
}

const refuse = (error: string): NativeEditorTurnPlan => ({ kind: "refuse", error });

/**
 * Decide how one GenOffice request reaches the Mcode SDK. Text-only requests
 * keep the plain-text bridge. Tool-bearing requests only proceed for a
 * verified SDK adapter **and** a scoped renderer ACK channel; every tool must
 * be representable in the request-scoped JSON Schema subset, and anything the
 * Host cannot carry is reported as withheld instead of silently disappearing.
 */
export function planNativeEditorTurn(
  providerId: string,
  request: { tools?: unknown; messages?: unknown },
  options: { invokerAvailable: boolean },
): NativeEditorTurnPlan {
  const capability = nativeEditorToolCapability(providerId);
  const toolHistory = hasStructuredToolHistory(request.messages);
  if (!declaresTools(request.tools) && !toolHistory) return { kind: "text" };
  if (capability.status !== "supported") {
    return refuse(
      `unsupported: GenOffice 原生 AgentSkill 工具调用未接入当前 Mcode SDK（provider=${providerId}; capability=${capability.status}）。` +
      ` ${capability.reason} 本次不会调用模型或执行编辑器工具；纯文本或 JSON 形式的工具建议不会被当作工具调用。`,
    );
  }
  if (!declaresTools(request.tools)) {
    return refuse(
      "unsupported: 本轮携带了结构化工具历史但没有可核验的渲染端工具表；拒绝在无法校验工具身份时执行。",
    );
  }
  if (!Array.isArray(request.tools)) {
    return refuse("unsupported: 渲染端工具表格式无效；拒绝执行未经校验的工具调用。");
  }
  if (!options.invokerAvailable) {
    return refuse(
      "unsupported: 当前 GenOffice 视图没有受信的渲染端工具结果 ACK 通道（仅 Docs 已接入）；本轮不会执行编辑器工具。",
    );
  }

  const tools: ExternalToolDefinition[] = [];
  const definitions = new Map<string, GenOfficeNativeToolDefinition>();
  const withheld: WithheldNativeTool[] = [];
  for (const raw of request.tools) {
    if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.description !== "string" || !isRecord(raw.inputSchema)) {
      return refuse("unsupported: 渲染端工具表包含畸形条目（缺少 name/description/inputSchema）；拒绝执行未经校验的工具调用。");
    }
    if (definitions.has(raw.name)) {
      return refuse(`unsupported: 渲染端工具表包含重复工具名 ${raw.name}；拒绝执行。`);
    }
    const definition: GenOfficeNativeToolDefinition = {
      name: raw.name,
      description: raw.description,
      inputSchema: raw.inputSchema,
    };
    try {
      tools.push(validateExternalToolDefinitions([definition])[0]!);
      definitions.set(definition.name, definition);
    } catch (error) {
      withheld.push({
        name: definition.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (tools.length === 0) {
    return refuse(
      `unsupported: 本轮渲染端工具均无法用 Mcode 请求级工具契约表达（${withheld.map((item) => item.name).join(", ")}）；拒绝执行。`,
    );
  }
  // Array-level limits (tool count, total schema bytes) live in the shared
  // request-scoped validator only — never re-declared here. Trim the tail until
  // it accepts, reporting every dropped tool instead of silently shrinking.
  for (;;) {
    try {
      validateExternalToolDefinitions(tools);
      break;
    } catch (error) {
      if (tools.length <= 1) {
        return refuse(
          `unsupported: 本轮渲染端工具集超出 Mcode 请求级契约限制（${error instanceof Error ? error.message : String(error)}）；拒绝执行。`,
        );
      }
      const dropped = tools.pop()!;
      definitions.delete(dropped.name);
      withheld.push({ name: dropped.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { kind: "tools", tools, definitions, withheld };
}

/**
 * T83's compatibility projection for callers that only need the old verdict.
 */
export function nativeEditorToolBridgeBlockReason(
  providerId: string,
  request: { tools?: unknown; messages?: unknown },
): string | null {
  const plan = planNativeEditorTurn(providerId, request, { invokerAvailable: true });
  return plan.kind === "refuse" ? plan.error : null;
}

function errorResult(sessionId: string, callId: string, error: string): ExternalToolResult {
  return { sessionId, callId, status: "error", error: error.slice(0, MAX_ERROR_CHARS) };
}
function cancelledResult(sessionId: string, callId: string, error: string): ExternalToolResult {
  return { sessionId, callId, status: "cancelled", error: error.slice(0, MAX_ERROR_CHARS) };
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Resolve when the renderer call settles or the turn's signal aborts. */
function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: ProviderAbortSignal,
): Promise<{ aborted: true } | { aborted: false; value: T } | { aborted: false; failure: unknown }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { aborted: true } | { aborted: false; value: T } | { aborted: false; failure: unknown }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ aborted: true });
    if (signal.aborted) {
      finish({ aborted: true });
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish({ aborted: false, value }),
      (failure: unknown) => finish({ aborted: false, failure }),
    );
  });
}

/**
 * Request-local handler: every SDK call is bound to this request's tool table
 * and its session, forwarded to the bound renderer once, and mapped back into
 * the SDK's explicit success/error/cancelled envelope. Duplicate call ids and
 * late results after cancellation fail closed.
 */
export function createNativeEditorToolBridge(args: {
  sessionId: string;
  tools: ExternalToolDefinition[];
  definitions: Map<string, GenOfficeNativeToolDefinition>;
  invokeRendererTool: GenOfficeNativeToolInvoker;
  signal: ProviderAbortSignal;
}): ExternalToolHandler {
  const allowed = new Set(args.tools.map((tool) => tool.name));
  const seenCallIds = new Set<string>();
  return async (call: ExternalToolCall, callSignal: ProviderAbortSignal): Promise<ExternalToolResult> => {
    const record: Record<string, unknown> = isRecord(call) ? call : {};
    const callId = typeof record.callId === "string" && record.callId.length <= 128 ? record.callId : "invalid-call-id";
    const sessionId = args.sessionId;
    if (record.sessionId !== sessionId) {
      return errorResult(sessionId, callId, "native editor tool call belongs to a different session");
    }
    if (typeof record.callId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(record.callId)) {
      return errorResult(sessionId, callId, "native editor tool call has an invalid call id");
    }
    if (seenCallIds.has(record.callId)) {
      return errorResult(sessionId, record.callId, "duplicate or late native editor tool call id");
    }
    seenCallIds.add(record.callId);
    if (typeof record.name !== "string" || !allowed.has(record.name)) {
      return errorResult(sessionId, record.callId, `native editor tool is not allowed in this request: ${String(record.name)}`);
    }
    const definition = args.definitions.get(record.name);
    if (!definition) {
      return errorResult(sessionId, record.callId, `native editor tool has no renderer definition: ${record.name}`);
    }
    if (!isRecord(record.input)) {
      return errorResult(sessionId, record.callId, `native editor tool input for ${record.name} must be a JSON object`);
    }
    let inputBytes: number;
    try {
      inputBytes = utf8Bytes(JSON.stringify(record.input));
    } catch {
      return errorResult(sessionId, record.callId, `native editor tool input for ${record.name} is not JSON-serializable`);
    }
    if (inputBytes > MAX_INPUT_BYTES) {
      return errorResult(sessionId, record.callId, `native editor tool input for ${record.name} exceeds ${MAX_INPUT_BYTES} bytes`);
    }
    if (args.signal.aborted || callSignal?.aborted) {
      return cancelledResult(sessionId, record.callId, "native editor tool call cancelled before renderer execution");
    }
    const rendererCall: GenOfficeNativeToolCall = {
      id: record.callId,
      name: record.name,
      input: record.input,
    };
    const raced = await awaitWithAbort(
      Promise.resolve().then(() => args.invokeRendererTool(rendererCall, definition)),
      args.signal,
    );
    if (raced.aborted || callSignal?.aborted) {
      return cancelledResult(sessionId, record.callId, "native editor tool call cancelled before the renderer ACK");
    }
    if ("failure" in raced) {
      const message = raced.failure instanceof Error ? raced.failure.message : String(raced.failure);
      return errorResult(sessionId, record.callId, `renderer tool ${record.name} failed: ${message}`);
    }
    const result = raced.value;
    if (!isRecord(result) || typeof result.output !== "string") {
      return errorResult(sessionId, record.callId, `renderer returned an invalid tool result for ${record.name}`);
    }
    if (result.status === "success") {
      return { sessionId, callId: record.callId, status: "success", result: result.output };
    }
    if (result.status === "error") {
      return errorResult(sessionId, record.callId, result.output || `renderer tool ${record.name} failed`);
    }
    if (result.status === "cancelled") {
      return cancelledResult(sessionId, record.callId, result.output || `renderer tool ${record.name} was cancelled`);
    }
    return errorResult(sessionId, record.callId, `renderer returned unknown status for ${record.name}`);
  };
}
