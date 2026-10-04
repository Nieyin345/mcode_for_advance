/**
 * Local type definitions for the Anthropic↔OpenAI protocol bridge.
 *
 * These are NOT the SDK's own types — they're deliberately loose,
 * field-subset views of the two wire protocols, scoped to exactly what the
 * translator reads or writes. Keeping them local (rather than importing from
 * `@anthropic-ai/sdk` or an `openai` package) keeps the bridge free of a hard
 * dependency on either client library and immune to unrelated SDK churn.
 *
 * Unknown / extra fields on the incoming request body are ignored (forward-
 * compatible), and only the fields the Claude binary actually consumes are
 * emitted on the Anthropic side of the response.
 */

/* ───────────────────────── Anthropic (what the bridge RECEIVES) ───────────────────────── */

/** A text block — the simplest content element, in either messages or system. */
export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

/** A tool_use block emitted by the assistant (carried back in request history). */
export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/** A tool_result block carried in a user message, replying to a tool_use. */
export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  /** string or an array of text/image blocks — we only forward the text. */
  content?: string | (AnthropicTextBlock | AnthropicImageBlock)[];
  is_error?: boolean;
}

/** A thinking block — present on extended-thinking turns. DeepSeek tool
 *  conversations carry it back as reasoning_content; never as ordinary text. */
export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

/** An image block in a user message — the Claude binary sends user-attached
 *  images inline as base64 content blocks (never as file paths). Also appears
 *  inside tool_result content when a tool returns an image (e.g. Read on an
 *  image file). */
export interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicImageBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  /** JSON Schema (the input contract for the tool). */
  input_schema: { type: "object"; [k: string]: unknown };
}

export type AnthropicToolChoice =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean }
  | { type: "none" };

/** The POST /v1/messages body the Claude binary sends to the bridge.
 *  Only the fields we translate are declared; anything else is ignored. */
export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  max_tokens: number;
  thinking?: { type: "enabled" | "disabled" | "adaptive"; budget_tokens?: number };
  output_config?: { effort?: string; [key: string]: unknown };
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  /** Anthropic's request metadata. Claude Code carries a `user_id` of the shape
   *  `user_…_account__session_…` here — the web upstream uses it to give each
   *  mcode session its own page view (see webUpstream.ts). Declared optional
   *  because the field is not part of the translation path we mirror. */
  metadata?: { user_id?: string; [k: string]: unknown };
}

/* ───────────────────────── OpenAI (what the bridge SENDS / RECEIVES) ───────────────────────── */

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: { type: "object"; [k: string]: unknown };
  };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** One content part of an OpenAI user message. Text parts and image parts
 *  (data-URL images) can be mixed in a single `content` array — the vision
 *  input format for OpenAI-protocol endpoints. */
export interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** string (plain text), a parts array (text + image_url mixed), or null. */
  content?: string | null | OpenAIContentPart[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  reasoning_effort?: string;
  thinking?: { type: "enabled" | "disabled" };
  stream?: boolean;
  /** OpenAI only emits `usage` in a streaming response when this is set to
   *  `{ include_usage: true }`. Without it the token ring shows nothing. */
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  top_p?: number;
  stop?: string[];
  tools?: OpenAITool[];
  tool_choice?: string | { type: "function"; function: { name: string } };
}

/** A streaming delta's tool_call fragment. `index` identifies which tool_call
 *  across chunks; id/name arrive on the first chunk, arguments dribble in. */
export interface OpenAIDeltaToolCall {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface OpenAIChoiceDelta {
  role?: string;
  content?: string | null;
  tool_calls?: OpenAIDeltaToolCall[];
  /** Reasoning content from some providers (e.g. DeepSeek). Forwarded as a
   *  thinking block when present, with an empty signature. */
  reasoning?: string | null;
  reasoning_content?: string | null;
  reasoning_details?: Array<{ type: string; text?: string; summary?: string }>;
}

export interface OpenAIChoice {
  index: number;
  delta: OpenAIChoiceDelta;
  finish_reason?: string | null;
}

export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Cache-read tokens, OpenAI-style (automatic prefix caching). Unlike
   *  Anthropic, `prompt_tokens` INCLUDES this count. */
  prompt_tokens_details?: { cached_tokens?: number };
  /** Cache-hit tokens, DeepSeek-style. Gateways that don't implement
   *  `prompt_tokens_details` report hits here instead. */
  prompt_cache_hit_tokens?: number;
}

/** One SSE chunk from OpenAI's streaming response. */
export interface OpenAIChunk {
  id?: string;
  model?: string;
  choices?: OpenAIChoice[];
  usage?: OpenAIUsage;
}

/* ───────────────────────── Anthropic SSE (what the bridge EMITS) ───────────────────────── */
//
// These mirror the event shapes the `@anthropic-ai/sdk` streaming parser
// expects (see node_modules/.../resources/messages/messages.d.ts,
// RawMessageStreamEvent). Field-by-field they match what the Claude binary
// produces natively.

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export type AnthropicContentBlockStart =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, never> }
  | { type: "thinking"; thinking: string; signature: string };

export type AnthropicContentBlockDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string };

export type AnthropicSseEvent =
  | { type: "message_start"; message: { id: string; type: "message"; role: "assistant"; content: never[]; model: string; stop_reason: null; stop_sequence: null; usage: AnthropicUsage } }
  | { type: "content_block_start"; index: number; content_block: AnthropicContentBlockStart }
  | { type: "content_block_delta"; index: number; delta: AnthropicContentBlockDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: string; stop_sequence: null }; usage: AnthropicUsage }
  | { type: "message_stop" }
  | { type: "error"; error: { type: "api_error"; message: string } };

/** The upstream endpoint the bridge forwards to. Extracted from an ApiConfig —
 *  only the fields the bridge needs; everything else (model list, selected
 *  model, non-essential-traffic flags) is for the Claude binary's env, not
 *  the bridge. */
export interface UpstreamConfig {
  baseUrl: string;
  authToken: string;
  authMode: "auth_token" | "api_key";
  timeoutMs?: number;
  /** Extra headers to send upstream (the config's `customHeaders`). Merged by
   *  `upstreamHeaders()` so both delivery paths send one header set. */
  customHeaders?: Record<string, string>;
  /** Where this upstream actually is. Absent/`"openai"` → a real HTTP endpoint
   *  (the original behaviour). `"web"` → **not an endpoint at all**: the browser
   *  extension bridge sends the prompt into a web chat page in the user's own
   *  browser and the answer is re-framed as an Anthropic stream (see
   *  webUpstream.ts + extensionBridge.ts). In that mode `baseUrl`/`authToken`
   *  are unused and `webSiteId` decides which site to drive. */
  protocol?: "anthropic" | "openai" | "web";
  /** Which site to drive when `protocol` is `"web"` (an id from `WEB_SITES`
   *  in @contracts/customModel). */
  webSiteId?: string;
}
