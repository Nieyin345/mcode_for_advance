/**
 * Custom subagent definitions for the Claude provider (Settings → 子代理).
 *
 * Persisted under `claude.subagents` as a JSON array; read fresh at every
 * claude-sdk startTurn and forwarded as the SDK's `Options.agents` (each
 * definition becomes one Agent the main agent can delegate to via the Task
 * tool). Only the Claude provider consumes these — the Settings page shows
 * the editor only for providers whose capabilities declare
 * `supportsCustomSubagents`.
 *
 * Mirrors the SDK's `AgentDefinition` (description/prompt/tools/model) but is
 * SDK-free: contracts must stay importable from renderer + main + smokes
 * without pulling in @anthropic-ai/claude-agent-sdk.
 */
export interface SubagentDefinition {
  /** Invocation name (Agent tool's subagent_type). [a-zA-Z0-9_-]{1,64}. */
  name: string;
  /** When the main agent should delegate to this subagent. */
  description: string;
  /** The subagent's system prompt. */
  prompt: string;
  /** Allowed tool names. Omitted = inherit all tools from the parent. */
  tools?: string[];
  /** Model alias ('sonnet'/'opus'/'haiku'/'inherit') or full model id.
   *  Omitted = the configured default subagent model. */
  model?: string;
}

/** Input to the `claude.saveSubagents` RPC — the whole edited list. */
export interface ClaudeSubagentsSaveInput {
  subagents: SubagentDefinition[];
}
