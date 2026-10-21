/**
 * T83 capability gate for GenOffice's renderer-owned AgentSkill tools.
 *
 * The GenOffice request contains renderer tool schemas, but RuntimeManager's
 * StartTurnRequest has no request-scoped tool definitions or renderer-result
 * callback. Provider-emitted tool.use/tool.result events describe Mcode's own
 * registered tools; they are not a safe substitute for a GenOffice tool call.
 * Until the upstream provider contract can round-trip a tool call to the same
 * renderer request, tool-bearing requests must fail closed before sendTurn.
 */
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
    status: "needs upstream",
    reason: "Claude's structured tool events are wired to Mcode-owned MCP/native tools; StartTurnRequest cannot inject this request's GenOffice schemas or return renderer tool results to the same turn.",
  }),
  "pi-sdk": Object.freeze({
    status: "needs upstream",
    reason: "Pi custom tools are assembled from Mcode-owned registrations; there is no request-scoped GenOffice tool schema and renderer-result round trip.",
  }),
  "codex-sdk": Object.freeze({
    status: "needs upstream",
    reason: "Codex dynamicTools are assembled from Mcode-owned descriptors; there is no request-scoped GenOffice tool schema and renderer-result round trip.",
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

/**
 * Return a visible, machine-searchable unsupported error when a renderer asks
 * for native tool execution that Mcode cannot safely round-trip yet.
 */
export function nativeEditorToolBridgeBlockReason(
  providerId: string,
  request: { tools?: unknown; messages?: unknown },
): string | null {
  if (!declaresTools(request.tools) && !hasStructuredToolHistory(request.messages)) return null;
  const capability = nativeEditorToolCapability(providerId);
  return [
    "unsupported: GenOffice 原生 AgentSkill 工具调用尚未接入当前 Mcode SDK 的同轮结构化工具协议。",
    `provider=${providerId}; capability=${capability.status}。`,
    capability.reason,
    "本次不会调用模型或执行编辑器工具；纯文本或 JSON 形式的工具建议不会被当作工具调用。",
  ].join(" ");
}
