/**
 * MCP 服务器管理(设置面板):列出 / 开关 / OAuth / 增删 / 导入。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。
 */

import { z } from "zod";

/* ── MCP management (settings panel) ──
 *  The settings panel's "MCP" section lists three MCP server sources and lets
 *  the user toggle, add, remove and import them:
 *   - user scope: the `mcpServers` object of ~/.mcode/.claude.json — Mcode's
 *     redirected Claude config root (CLAUDE_CONFIG_DIR). The claude binary
 *     loads these automatically (settingSources default includes "user"), so
 *     the file is the source of truth; disabling a server moves its config
 *     out of the file into the management-state stash below, which is what
 *     keeps the binary from loading it.
 *   - project scope: <projectRoot>/.mcp.json (read-only, never rewritten).
 *     The CLI's native first-use approval dialog can't surface through our
 *     onUserDialog bridge (unknown kinds get cancelled), so this panel
 *     replaces it: project servers default to OFF and are recorded here when
 *     explicitly enabled; the provider passes per-turn
 *     enabledMcpjsonServers / disabledMcpjsonServers accordingly.
 *   - builtin: the in-process "mcode-browser" server injected by the Claude
 *     provider each turn; toggling gates that injection. */

/** Setting key for the persisted MCP management state.
 *  Value = JSON.stringify(McpManagementState). */
export const MCP_MANAGEMENT_SETTING_KEY = "mcp.management";

/** Serializable MCP server config shapes, mirroring the Claude Agent SDK's
 *  McpStdioServerConfig / McpHttpServerConfig / McpSSEServerConfig. Transport
 *  fields only; exotic fields (timeout, tools, ...) survive import round-trips
 *  via passthrough. Absent `type` means stdio, same as the SDK. */
export const McpServerConfigSchema = z.union([
  z
    .object({
      type: z.literal("stdio").optional(),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("http"),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("sse"),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .passthrough(),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** Persisted MCP management state (MCP_MANAGEMENT_SETTING_KEY). */
export interface McpManagementState {
  /** Built-in mcode-browser server disabled. Absent/false = enabled. */
  browserDisabled?: boolean;
  /** User-scope servers the user turned OFF. Their full configs are stashed
   *  here (keyed by name) so re-enabling restores them exactly; the config
   *  file meanwhile stays free of them, which is what keeps the binary from
   *  loading them. */
  userDisabled?: Record<string, McpServerConfig>;
  /** Project .mcp.json servers the user explicitly turned ON. Project servers
   *  default to OFF (this panel replaces the CLI's first-use approval dialog),
   *  so an allowlist — not a denylist — is persisted. Matched against the
   *  turn's cwd at startTurn. */
  projectEnabled?: Array<{ projectPath: string; name: string }>;
}

/** Which source a listed MCP server comes from. "plugin" = contributed by an
 *  enabled plugin (namespaced `<plugin>__<server>`); toggling it flips the
 *  per-server entry on the plugins.mcpDisabled list without touching the
 *  plugin's own enable state. */
export type McpScope = "user" | "project" | "builtin" | "plugin";

/** Transport kind shown in the panel badges; "builtin" = in-process server. */
export type McpKind = "stdio" | "http" | "sse" | "builtin";

/** One row of the MCP panel's server list. `detail` is a secret-free summary
 *  ("node server.js --foo" / "https://example.com/mcp") — env and header
 *  values are never included. */
export interface McpServerEntry {
  name: string;
  scope: McpScope;
  kind: McpKind;
  detail: string;
  enabled: boolean;
  /** Remote (http/sse) server that requires an OAuth login and holds no
   *  usable token, so its tools stay unavailable until the user completes the
   *  browser login — surfaced as an amber badge + a 去授权 action.
   *
   *  Two sources: the CLI's mcp-needs-auth-cache.json (written on an actual
   *  401 while connecting) and a proactive probe of the endpoint, so the entry
   *  appears before the first turn stumbles into it. Beats `authorized`. */
  needsAuth?: boolean;
  /** Remote server holding a stored OAuth token (the CLI's credential store —
   *  `.credentials.json` on win/linux, the macOS Keychain on darwin). Shows an
   *  "authorized" badge + a sign-out action in the panel. Mutually exclusive
   *  with needsAuth, and loses to it: needsAuth is written on a real 401 while
   *  connecting, so a stored token the runtime can't use (wrong credential
   *  key, expired, revoked) must not mask an unauthenticated server. */
  authorized?: boolean;
}

/** List MCP servers for the settings panel. `projectPath` scopes the project
 *  .mcp.json group and must match a persisted Project.path when present; the
 *  group is simply omitted when absent. */
export const McpListSchema = z.object({
  projectPath: z.string().optional(),
});
export type McpListInput = z.infer<typeof McpListSchema>;

/** Toggle a server. `projectPath` is required for scope "project". Scope
 *  "plugin" toggles one plugin-contributed server (plugins.mcpDisabled). */
export const McpToggleSchema = z.object({
  name: z.string().min(1),
  scope: z.enum(["user", "project", "builtin", "plugin"]),
  projectPath: z.string().optional(),
  enabled: z.boolean(),
});
export type McpToggleInput = z.infer<typeof McpToggleSchema>;

/** Run the OAuth browser login for a remote (http/sse) MCP server via the
 *  Claude CLI (`claude mcp login`). The server is registered under exactly
 *  `name` (the namespaced `<plugin>__<server>` form for plugin servers) for
 *  the duration of the flow and restored afterwards; the token itself persists
 *  in the CLI's credential store.
 *
 *  `url`/`kind` are only a fallback identity. The CLI keys OAuth credentials by
 *  a hash of the server NAME plus its `{ type, url, headers }`, so the main
 *  process resolves the server's real config by name across every source
 *  (user file / disable stash / plugin / project .mcp.json) and re-registers it
 *  verbatim — headers included. Registering a stripped config would store the
 *  token under a key the per-turn injected server never looks up. */
export const McpAuthorizeSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  kind: z.enum(["http", "sse"]),
  /** Source the clicked row came from. Scopes the main-side config lookup so a
   *  name shared by two sources (a user and a project server both called
   *  "github") resolves to the config that row actually points at — picking the
   *  other one's url/headers would file the token under a key the server never
   *  looks up. */
  scope: z.enum(["user", "project", "builtin", "plugin"]).optional(),
  /** Project whose .mcp.json the row came from (scope "project"). */
  projectPath: z.string().optional(),
});
export type McpAuthorizeInput = z.infer<typeof McpAuthorizeSchema>;

/** Clear the stored OAuth token (`claude mcp logout`). Same identity shape as
 *  authorize — the CLI resolves the server from the config file and keys the
 *  credentials by name + url + headers, so the same real-config registration
 *  applies. */
export const McpUnauthorizeSchema = McpAuthorizeSchema;
export type McpUnauthorizeInput = McpAuthorizeInput;

/** MCP server name charset — same family as skill names (letters, digits,
 *  underscore, hyphen). The name becomes a JSON object key, not a path, but
 *  staying conservative costs nothing. */
const MCP_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Reserved server name — collides with the built-in in-process server. */
export const MCP_RESERVED_NAME = "mcode-browser";

/**
 * 应用自带的两个**骨干** MCP 服务器(库操作 / 工作流操作)的注册名。
 *
 * 它们的定义放在契约层而不是各自的主进程文件里,是因为**渲染端也要认这两个名字**:
 * 工作流节点的「MCP 服务器」参数要把它们从候选表里滤掉(见 `NODE_MCP_PARAM_KEY`)——
 * 它们不是用户装的东西,始终挂着,列出来只会让人以为自己关得掉。名字有两份定义就会
 * 漂移,而漂移的表现是"那个服务器又能被选了,选了却不生效"。
 *
 * `mcp/libraryServer.ts` 与 `mcp/mcodeServer.ts` 各自 export 一个同名常量指向这里,
 * 主进程那一侧的既有引用不必改。
 */
export const MCP_LIBRARY_SERVER = "mcode-library";
export const MCP_WORKFLOW_SERVER = "mcode-workflow";

/** 骨干服务器名的清单 —— 「始终挂着、不进候选表」的那一组。 */
export const MCP_ALWAYS_ON_SERVERS = [MCP_LIBRARY_SERVER, MCP_WORKFLOW_SERVER] as const;

/** Add a user-scope server. Rejected when the name already exists (enabled in
 *  the config file or stashed as disabled). The config is written into
 *  ~/.mcode/.claude.json. */
export const McpSaveSchema = z.object({
  name: z.string().regex(MCP_NAME_RE, "invalid MCP server name"),
  config: McpServerConfigSchema,
});
export type McpSaveInput = z.infer<typeof McpSaveSchema>;

/** Remove a user-scope server — from both the config file and the disabled
 *  stash (whichever holds it). Project/builtin entries have no delete. */
export const McpRemoveSchema = z.object({
  name: z.string().regex(MCP_NAME_RE, "invalid MCP server name"),
});
export type McpRemoveInput = z.infer<typeof McpRemoveSchema>;

/** A server discovered in the local Claude CLI config (~/.claude.json),
 *  offered by the import dialog. `origin` labels where it came from: the
 *  global scope or the project path it was configured for. */
export interface McpImportSource {
  name: string;
  kind: McpKind;
  detail: string;
  origin: string;
  config: McpServerConfig;
}

/** Scan the local Claude CLI config for importable MCP servers. Read-only;
 *  never writes to ~/.claude.json. */
export const McpScanImportSchema = z.object({});
export type McpScanImportInput = z.infer<typeof McpScanImportSchema>;

/** A single server to import (name + full config, from a scanImport result). */
export const McpImportItemSchema = z.object({
  name: z.string().min(1),
  config: McpServerConfigSchema,
});

/** Import selected servers into the user scope (Mcode's own config file).
 *  Already-existing names are skipped. Returns per-server lists. */
export const McpImportSchema = z.object({
  servers: z.array(McpImportItemSchema),
});
export type McpImportInput = z.infer<typeof McpImportSchema>;

