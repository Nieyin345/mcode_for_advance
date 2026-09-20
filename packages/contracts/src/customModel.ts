/**
 * Custom model configuration — lets the user plug in their own Anthropic-
 * compatible endpoint (DeepSeek's `/anthropic`, one-api/new-api gateways,
 * self-hosted proxies, etc.) alongside the built-in model aliases.
 *
 * Persisted on disk; the API key/token is encrypted with Electron safeStorage
 * (see main/lib/secretStore.ts) and NEVER crosses to the renderer in cleartext.
 * The renderer only ever sees {@link CustomModelPublic}.
 *
 * ## Model: flat model list
 *
 * One config = one endpoint (baseUrl + token + authMode) plus a flat list of
 * gateway-side model ids — mirroring how the Pi provider form works. The user
 * picks a MODEL in the dropdown; the selected id is injected as
 * `ANTHROPIC_MODEL` (with a `[1m]` suffix when the entry declares 1M context),
 * and the same bare id is mirrored onto the binary's background-tier env vars
 * (`ANTHROPIC_DEFAULT_HAIKU/SONNET/OPUS/FABLE_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`)
 * so background requests also route to the user's gateway. See
 * main/providers/claude-sdk/customEnv.ts for the full mapping.
 *
 * (This flat shape replaced the earlier 5-tier "role binding" table — and, before
 * that, a `models[]` list + 3-key alias map. Older persisted records are
 * migrated transparently on read by `migrateMeta` in secretStore.ts.)
 *
 * ## Why so many fields besides the model list?
 *
 * Claude Code's own env contract for a custom endpoint isn't just base URL +
 * key. Third-party gateways differ from the official API in three ways that
 * matter:
 *
 * 1. **Auth scheme.** The official API uses `ANTHROPIC_API_KEY` (sent as
 *    `x-api-key`). Most gateways (DeepSeek, one-api, new-api) expect
 *    `ANTHROPIC_AUTH_TOKEN` (sent as `Authorization: Bearer …`). Setting the
 *    wrong one yields "no available channel for model X" 503s from the gateway.
 *
 * 2. **Non-essential traffic.** Claude Code phones home to Anthropic's
 *    telemetry endpoints by default; on a third-party gateway those fail.
 *    `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns them off.
 *
 * 3. **Request headers.** Some gateways want more than a bearer token — a
 *    routing hint, a tenant id, or a scheme of their own — and some (OpenCode
 *    Zen's "Go" plan) reject every request that lacks one. `customHeaders`
 *    carries those, and the delivery rules live in
 *    `apps/desktop/src/main/providers/upstreamHeaders.ts`.
 */

/** How the credential is presented to the upstream. */
export type AuthMode = "auth_token" | "api_key";

/** The wire protocol an endpoint speaks. `anthropic` (the default) means the
 *  endpoint implements Anthropic's `/v1/messages` — the binary talks to it
 *  directly via `ANTHROPIC_BASE_URL`. `openai` means the endpoint speaks
 *  OpenAI's `/v1/chat/completions`; the host runs an in-process bridge that
 *  impersonates an Anthropic endpoint and translates both directions, so the
 *  binary still thinks it's talking to Anthropic. `web` means the "endpoint"
 *  is a **web chat page driven by the app's embedded browser** (`webSiteId`
 *  picks which site) — the bridge impersonates Anthropic the same way, but
 *  instead of forwarding HTTP it types into the page and streams the answer
 *  it overheard back. */
export type Protocol = "anthropic" | "openai" | "web";

/** Default protocol when a stored config predates the `protocol` field, or when
 *  the user creates one without choosing. `anthropic` keeps every existing
 *  config behaving exactly as before. */
const DEFAULT_PROTOCOL: Protocol = "anthropic";

/** Normalize a possibly-undefined protocol to a concrete value. Mirrors
 *  {@link resolveAuthMode}'s pattern so old records upgrade transparently. */
export function resolveProtocol(p: Protocol | undefined): Protocol {
  return p ?? DEFAULT_PROTOCOL;
}

/**
 * Extra request headers sent to the endpoint on every API request, keyed by
 * header name (`{ "x-opencode-session": "…" }`).
 *
 * Needed because gateways differ in what they want beyond a bearer token: a
 * routing hint, an org/tenant id, or a non-standard auth scheme. It is also
 * how a user overrides the session id Mcode auto-supplies for endpoints known
 * to require one — see `providers/upstreamHeaders.ts` for the delivery rules
 * and the auto-injection.
 *
 * Values are NOT secrets in the credential sense (the token has its own
 * encrypted store) and they cross the IPC boundary in cleartext, so the
 * settings UI can render them for editing.
 */
export type CustomHeaders = Record<string, string>;

/** RFC 7230 `token` — the only shape an HTTP header name may take. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Longest value we forward. Generous for a JWT-ish routing token, short
 *  enough that a pasted wall of text reads as a config mistake.
 *  Exported for the settings form, which mirrors the same limit in its
 *  validation message. */
export const MAX_CUSTOM_HEADER_VALUE_LEN = 4096;

/** Whether `name` may be used as a request-header name. Lives here rather than
 *  in the main-process delivery code because the settings form validates with
 *  the very same rule — a mismatch would let the form accept a row that the
 *  request path then drops. */
export function isValidHeaderName(name: string): boolean {
  return HEADER_NAME_RE.test(name.trim());
}

/** Whether `value` may be used as a request-header value. CR/LF are rejected
 *  outright: the value is written straight into a header, so an embedded
 *  newline could forge additional headers (or a body). */
export function isValidHeaderValue(value: string): boolean {
  return !/[\r\n]/.test(value) && value.length <= MAX_CUSTOM_HEADER_VALUE_LEN;
}

/** One selectable model on a custom endpoint. Mirrors the Pi side's flat
 *  per-provider model list: just the gateway-side model id plus a 1M-context
 *  declaration — no display name, no per-tier role. */
export interface CustomModelEntry {
  /** The actual model id the gateway routes to, e.g. "deepseek-v4-pro".
   *  Injected as ANTHROPIC_MODEL when selected; mirrored onto the background
   *  tier env vars (bare, without the `[1m]` suffix). */
  id: string;
  /** Declare 1M-token context support. When the session selects this model,
   *  ANTHROPIC_MODEL carries the `[1m]` suffix (the DeepSeek-style gateway
   *  convention). */
  supports1m?: boolean;
}

/** Fully-resolved config passed to the provider at turn time (main-process
 *  only — carries the cleartext credential, never crosses IPC). */
export interface ApiConfig {
  baseUrl: string;
  /** Cleartext credential. */
  authToken: string;
  authMode: AuthMode;
  /** Wire protocol of the upstream endpoint. `anthropic` (default) talks to it
   *  directly; `openai` and `web` activate the in-process protocol bridge. */
  protocol: Protocol;
  /** 仅 `protocol: "web"` 有意义：驱动哪个网页版站点（取站点适配器的 id，
   *  如 "deepseek"）。其他协议下不存在。 */
  webSiteId?: string;
  /** The model id the session has selected for this turn (one of
   *  `models[].id`). It becomes ANTHROPIC_MODEL (with the `[1m]` suffix when
   *  the entry declares it). Falls back to the first entry. */
  selectedModel: string;
  /** The config's flat model list. The selected model's bare id is mirrored
   *  onto the background-tier env vars so background requests also route to
   *  the user's gateway. */
  models: CustomModelEntry[];
  /** Model id (one of `models[].id`) pinned for Task-tool subagents in
   *  sessions using this config — injected per-turn as
   *  CLAUDE_CODE_SUBAGENT_MODEL, overriding the default mirror of the
   *  selected model. Absent = follow the main session's model. */
  subagentModel?: string;
  /** Disable Claude Code's non-essential (telemetry) traffic. Default true
   *  for custom endpoints — almost always what you want on a gateway. */
  disableNonEssentialTraffic: boolean;
  /** Per-request timeout in ms (passed through as API_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Extra headers for the endpoint, sent on both delivery paths (the direct
   *  Anthropic one via ANTHROPIC_CUSTOM_HEADERS, the bridge one merged into the
   *  upstream request). See {@link CustomHeaders}. */
  customHeaders?: CustomHeaders;
}

/** Credential storage shape (encrypted at rest, decrypted in main only). */
export interface StoredCredential {
  authToken: string;
  authMode: AuthMode;
}

/** A stored custom-model config (main-process side; holds the cleartext token).
 *  One config = one endpoint + a flat model list. */
export interface CustomModel {
  id: string;
  /** User-facing name, e.g. "DeepSeek 中转". */
  name: string;
  baseUrl: string;
  /** Cleartext token. Only exists in main memory; persisted encrypted. */
  authToken: string;
  authMode: AuthMode;
  protocol: Protocol;
  /** 仅 `protocol: "web"`：驱动哪个网页版站点（站点适配器 id，如 "deepseek"）。 */
  webSiteId?: string;
  models: CustomModelEntry[];
  disableNonEssentialTraffic: boolean;
  timeoutMs?: number;
  customHeaders?: CustomHeaders;
  createdAt: number;
}

/**
 * Renderer-facing (desensitized) view of a custom model. The token is masked
 * (e.g. "sk-***ab12"); the cleartext never leaves the main process.
 */
export interface CustomModelPublic {
  id: string;
  name: string;
  baseUrl: string;
  authMode: AuthMode;
  /** Wire protocol (resolved to a concrete value, never undefined). */
  protocol: Protocol;
  /** 仅 `protocol: "web"`：驱动哪个网页版站点（站点适配器 id，如 "deepseek"）。 */
  webSiteId?: string;
  /** Masked token, e.g. "sk-***ab12". For display only. */
  authTokenMasked: string;
  models: CustomModelEntry[];
  /** Task-subagent model pinned for this config (one of `models[].id`), or
   *  undefined = follow the main session's model. See ApiConfig.subagentModel. */
  subagentModel?: string;
  disableNonEssentialTraffic: boolean;
  timeoutMs?: number;
  customHeaders?: CustomHeaders;
  createdAt: number;
}

/** Persisted metadata record (everything except the credential, which lives
 *  in the encrypted secret store keyed by id). Stored as JSON under the
 *  settings key `customModels`. */
export interface CustomModelMeta {
  id: string;
  name: string;
  baseUrl: string;
  authMode: AuthMode;
  /** Wire protocol. Absent on legacy records; resolve via {@link resolveProtocol}. */
  protocol?: Protocol;
  /** 仅 `protocol: "web"`：驱动哪个网页版站点（站点适配器 id，如 "deepseek"）。 */
  webSiteId?: string;
  models: CustomModelEntry[];
  /** Task-subagent model pinned for this config, or undefined = follow the
   *  main session's model. See ApiConfig.subagentModel. */
  subagentModel?: string;
  disableNonEssentialTraffic: boolean;
  timeoutMs?: number;
  customHeaders?: CustomHeaders;
  createdAt: number;
}

/** Input for creating or updating a custom model. `authToken` is optional on
 *  update so the user can edit other fields without re-entering the secret
 *  (omitting it = keep the existing stored token). */
export interface CustomModelInput {
  /** Omit on create; present on update to target an existing record. */
  id?: string;
  name: string;
  baseUrl: string;
  authMode?: AuthMode;
  /** Wire protocol. Optional for backward compat; defaults to "anthropic". */
  protocol?: Protocol;
  /** 仅 `protocol: "web"` 需要：驱动哪个网页版站点（站点适配器 id）。 */
  webSiteId?: string;
  /** Cleartext. Required on create; optional on update (omit = keep existing). */
  authToken?: string;
  /** The flat model list (≥1 entry, enforced by the IPC schema). */
  models: CustomModelEntry[];
  /** Task-subagent model to pin for this config. Must be one of
   *  `models[].id`; a value not in the list is dropped by the store (falls
   *  back to following the main model). Empty/undefined = no pin. */
  subagentModel?: string;
  disableNonEssentialTraffic?: boolean;
  timeoutMs?: number;
  /** Extra request headers for the endpoint; an empty map clears them. See
   *  {@link CustomHeaders}. */
  customHeaders?: CustomHeaders;
}

/** Result of a connection probe using the user-supplied (not-yet-saved) values. */
export interface TestCustomModelResult {
  ok: boolean;
  /** claude's version string or model echo, when available. */
  detail?: string;
  /** Error message on failure (auth / network / timeout / bad model). */
  error?: string;
}

/* ─────────────────────────── 网页版站点与扩展桥 ─────────────────────────── */

/**
 * 一个网页版站点。
 *
 * 站点目录住在契约层（而不是 main 侧的适配器模块）是因为**两端都要用**：主进程
 * 用它校验 `webSiteId`、出错时写出可读站点名；渲染端的设置页用它渲染站点下拉。
 * 曾经这份清单在 `main/providers/web-agent/adapters/`，那份实现（内嵌浏览器 +
 * CDP 注入）已拆除 —— 现在"驱动网页"这件事发生在用户自己浏览器里的扩展中，
 * mcode 只剩这份目录。
 */
export interface WebSite {
  /** 稳定 id，存在配置的 `webSiteId` 里，如 "deepseek"。 */
  id: string;
  /** UI 上显示的站点名。 */
  label: string;
  /** 站点首页 —— 扩展在浏览器里驱动的那一页。 */
  homeUrl: string;
  /**
   * 浏览器扩展有没有实现这个站点的驱动。
   *
   * 目录与驱动是**两件事**:桌面侧把站点列出来(用户能选、配置能存),驱动那一段
   * 住在扩展仓库里(`mcode-bridge-ext` 的 `core/<site>/`)。站点先于驱动落地时,
   * 这里写 `false` —— 配置照存,但选中它开跑会得到一句明确的"扩展还不支持"，
   * 而不是一句来自 DeepSeek 解析器的、牛头不对马嘴的报错。
   *
   * 扩展把驱动补齐后把这里翻成 `true`(或直接删掉这个字段的 false 写法)。
   */
  driver: boolean;
}

/** **顺序即 UI 顺序**，第一项是默认站点。 */
export const WEB_SITES: readonly WebSite[] = [
  { id: "deepseek", label: "DeepSeek", homeUrl: "https://chat.deepseek.com", driver: true },
  // ChatGPT 网页版：驱动已落在扩展仓库 `core/chatgpt/`（chatgpt-client.ts +
  // sentinel.ts + page-context.ts），driver 翻 true —— 选中即可开跑。
  { id: "chatgpt", label: "ChatGPT", homeUrl: "https://chatgpt.com", driver: true },
];

/** 该站点在浏览器扩展里有没有可用的驱动。未知 id 一律 false（快速失败，
 *  不假装能跑）。 */
export function webSiteDriven(id: string | undefined): boolean {
  return webSiteById(id)?.driver === true;
}


/** 默认站点 id（新配置未选择时用它）。表恒非空，但取值为 undefined 时仍走兜底。 */
export function defaultWebSiteId(): string {
  return WEB_SITES[0]?.id ?? "deepseek";
}

/** 按 id 取站点；未知 id 返回 undefined（调用方负责快速失败）。 */
export function webSiteById(id: string | undefined): WebSite | undefined {
  if (!id) return undefined;
  return WEB_SITES.find((s) => s.id === id);
}

/** 站点名，未知 id 时退回 id 本身（用于日志与报错文案，绝不抛）。 */
export function webSiteLabel(id: string | undefined): string {
  return webSiteById(id)?.label ?? (id || "(未选择)");
}

/**
 * 扩展桥状态 —— 渲染端设置页显示的那一屏。
 *
 * `paired` 由主进程实时维护（扩展的 SSE 长连接挂着即视为已配对），所以这个对象
 * 是**查询时快照**，不是持久化记录。`token` 明文：它要显示给用户复制进扩展，
 * 且服务只绑 127.0.0.1（见 main/providers/bridge/extensionBridge.ts）。
 */
export interface ExtensionBridgeStatus {
  /** 扩展要连的地址，如 `http://127.0.0.1:53124`。服务未起时为空串。 */
  url: string;
  /** 配对令牌。 */
  token: string;
  /** 扩展此刻是否挂着 SSE 连接。 */
  paired: boolean;
  /** 本次配对建立的时间戳（ms）；未配对为 null。 */
  pairedAt: number | null;
}

/**
 * 「这次工具调用属于哪次对话」的请求头名。
 *
 * ## 为什么住在契约层
 *
 * 它是**跨进程的线协议字面量**：主进程写它（把会话 id 交给 CLI 子进程，见
 * `main/providers/claude-sdk/customEnv.ts`）、主进程读它（从扩展发来的 `/mcp`
 * 请求里认出会话）、扩展那个仓库里也照抄同一个名字（它镜像的是 mcode 定下的线
 * 协议）。所以它和上面的站点目录一样属于"两端都要用的常量"。
 *
 * 具体地，它**不能**住在 `main/providers/bridge/mcpEndpoint.ts` 里 —— 那份 import
 * 了 logger，而 logger 拉 electron；任何引它的纯模块都会把 electron 带进无头
 * smoke（`agent-env-smoke` / `plugins-smoke` 就这么红过一次）。
 *
 * ## ⚠️ 这是唯一能说清"哪次对话"的东西
 *
 * 别指望从别处推：`/v1/messages` 那条路上唯一能拿到的身份是 CLI 塞在 body 里的
 * `metadata.user_id`（`user_…_account__session_…`），而没有任何可信证据表明它尾巴上
 * 那截等于 mcode 的会话 id —— 靠猜一次，将来某次升级就会让「挂到这次对话」挂错人，
 * 而且是静默的。
 *
 * 所以显式带：值是**裸的 mcode 会话 id**（不加前缀 —— 这条头只在 mcode 与扩展之间
 * 转一圈，不会发到任何上游）。
 */
export const MCODE_SESSION_HEADER = "x-mcode-session";
