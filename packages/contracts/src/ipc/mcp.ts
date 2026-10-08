/**
 * MCP 服务器管理(设置面板):列出 / 开关 / OAuth / 增删 / 导入。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。
 */

import { z } from "zod";

/* ── MCP management (settings panel) ──
 *  The settings panel's "MCP" section lists the MCP server sources and lets
 *  the user toggle, add, edit, remove and import them:
 *   - user scope: the source of truth lives in the management state
 *     (`userServers` below, persisted under MCP_MANAGEMENT_SETTING_KEY); the
 *     `mcpServers` object of ~/.mcode/.claude.json is a **derived view** the
 *     claude binary loads automatically (settingSources is pinned to ["user"]).
 *     Disabling a server moves it onto the userDisabled stash; enabling moves
 *     it back. Both files are re-materialized after every mutation as
 *     "enabled ∧ assigned to that engine" subsets (see McpEnginesSetSchema).
 *   - builtin: the in-process "mcode-browser" server injected by the Claude
 *     provider each turn; toggling gates that injection.
 *
 *  项目级（<projectRoot>/.mcp.json）来源已整体移除：settingSources 钉在
 *  ["user"] 后二进制不再读项目 .mcp.json，Mcode 也不做项目白名单 —— 外部
 *  项目级 MCP 一律不继承，用户可在面板里把需要的服务器录成用户级。 */

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
  /** Source of truth for user-scope server configs, keyed by name — present
   *  whether enabled or not. The `.claude.json` mcpServers object is a
   *  derived view materialized from this + the engines map, never the other
   *  way round. Written by save/import; read by list/materialization. */
  userServers?: Record<string, McpServerConfig>;
  /** User-scope servers the user turned OFF. Their full configs are stashed
   *  here (keyed by name) so re-enabling restores them exactly; the derived
   *  view meanwhile stays free of them, which is what keeps the binary from
   *  loading them. */
  userDisabled?: Record<string, McpServerConfig>;
}

/** Per-engine visibility for an MCP server — the engines that may load it.
 *  pi has no MCP support (PiAgentSdkProvider.supportsMcp:false), so there are
 *  only two switches. Absent = both true (missing = enabled, same semantics
 *  as the skill engines map). */
export interface McpEngineState {
  claude: boolean;
  codex: boolean;
}

/** Assign an MCP server to engines. `name` is the panel's row name — the
 *  user-scope server name, the namespaced `<plugin>__<server>` form, or the
 *  built-in `mcode-browser`. Takes the full boolean pair (no partial
 *  updates) so a stale panel can't silently drop one engine's flag. */
export const McpEnginesSetSchema = z.object({
  name: z.string().min(1),
  claude: z.boolean(),
  codex: z.boolean(),
});
export type McpEnginesSetInput = z.infer<typeof McpEnginesSetSchema>;

/** Which source a listed MCP server comes from. "plugin" = contributed by an
 *  enabled plugin (namespaced `<plugin>__<server>`); toggling it flips the
 *  per-server entry on the plugins.mcpDisabled list without touching the
 *  plugin's own enable state. */
export type McpScope = "user" | "builtin" | "plugin";

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
  /** Editable transport config for user-scope rows. Env/header key names are
   *  included but their values are blank; secrets never enter the renderer. */
  config?: McpServerConfig;
  /** Which engines may load this server. Absent on builtin rows (they follow
   *  the browserDisabled toggle only); user/plugin rows always carry it —
   *  absent flags mean enabled (missing = enabled). */
  perEngine?: McpEngineState;
  /** Plugin rows only: the owning plugin (the `<plugin>` of `<plugin>__<server>`). */
  pluginName?: string;
  /** Plugin rows only: the plugin-level engine switches (Plugins panel). An
   *  engine switched off there never sees this server, whatever `perEngine`
   *  says — the panel greys that chip and points at the Plugins panel. */
  pluginEngines?: McpEngineState;
}

/** List MCP servers for the settings panel. */
export const McpListSchema = z.object({});
export type McpListInput = z.infer<typeof McpListSchema>;

/** Toggle a server. Scope "plugin" toggles one plugin-contributed server
 *  (plugins.mcpDisabled). */
export const McpToggleSchema = z.object({
  name: z.string().min(1),
  scope: z.enum(["user", "builtin", "plugin"]),
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
   *  name shared by two sources resolves to the config that row actually
   *  points at — picking the other one's url/headers would file the token
   *  under a key the server never looks up. */
  scope: z.enum(["user", "builtin", "plugin"]).optional(),
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
 *  staying conservative costs nothing. **导出**:设置页新增/编辑前的即时校验
 *  引用这一份,别再抄一份字面量 —— 抄的那份一旦与这里分家,用户会看到"界面
 *  允许、保存却被拒"(或反过来)。 */
export const MCP_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Reserved server name — collides with the built-in in-process server. */
export const MCP_RESERVED_NAME = "mcode-browser";

/**
 * 「保留名」判定 —— 所有以 `mcode-` / `mcode_` 开头的名字都是 Mcode 自带服务器的身份。
 *
 * **为什么是整段前缀而不是单个字面名**:内置服务器不止 `mcode-browser` —— 还有
 * `mcode-app` / `mcode-library` / `mcode-workflow` / `mcode-memory`(见
 * {@link MCP_ALWAYS_ON_SERVERS} 与内置浏览器 server),而且 Claude provider 对其中几个
 * **按前缀自动放行**
 * (`mcp__mcode-app__app_*`)。用户(或经审批的 AI)若在用户级 config 里注册一个同名
 * server,面板与引擎矩阵就会显示一个与内置身份重名的伪造项。项目级 `.mcp.json` 一直
 * 挡的是整段 `mcode[-_]` 前缀(见 `projectMcp.isReservedProjectServerName`),用户级这条
 * 路必须与它一致 —— 两条路规矩相反正是漏洞的来源。 */
export function isReservedMcpServerName(name: string): boolean {
  return /^mcode[-_]/i.test(name);
}

/**
 * 应用自带的**骨干** MCP 服务器(库操作 / 工作流操作 / 记忆操作)的注册名。
 *
 * 它们的定义放在契约层而不是各自的主进程文件里,是因为**渲染端也要认这几个名字**:
 * 工作流节点的「MCP 服务器」参数要把它们从候选表里滤掉(见 `NODE_MCP_PARAM_KEY`)——
 * 它们不是用户装的东西,始终挂着,列出来只会让人以为自己关得掉。名字有两份定义就会
 * 漂移,而漂移的表现是"那个服务器又能被选了,选了却不生效"。
 *
 * `mcp/libraryServer.ts` / `mcp/mcodeServer.ts` / `mcp/memoryServer.ts` 各自 export 一个
 * 同名常量指向这里,主进程那一侧的既有引用不必改。
 */
export const MCP_LIBRARY_SERVER = "mcode-library";
export const MCP_WORKFLOW_SERVER = "mcode-workflow";
export const MCP_MEMORY_SERVER = "mcode-memory";

/** 骨干服务器名的清单 —— 「始终挂着、不进候选表」的那一组。 */
export const MCP_ALWAYS_ON_SERVERS = [
  MCP_LIBRARY_SERVER,
  MCP_WORKFLOW_SERVER,
  MCP_MEMORY_SERVER,
] as const;

/** Add a user-scope server, or overwrite an existing one when `replace` is
 *  set (the edit path). Without `replace` a name that already exists — enabled
 *  in the truth layer or stashed as disabled — is rejected. The config is
 *  written into the management state (`userServers`) and both engine views
 *  are re-materialized. */
export const McpSaveSchema = z.object({
  name: z.string().regex(MCP_NAME_RE, "invalid MCP server name"),
  config: McpServerConfigSchema,
  /** Edit mode: overwrite the existing entry (truth layer or stash) instead
   *  of rejecting a duplicate name. */
  replace: z.boolean().optional(),
});
export type McpSaveInput = z.infer<typeof McpSaveSchema>;

/** Remove a user-scope server — from both the config file and the disabled
 *  stash (whichever holds it). Project/builtin entries have no delete. */
export const McpRemoveSchema = z.object({
  name: z.string().regex(MCP_NAME_RE, "invalid MCP server name"),
});
export type McpRemoveInput = z.infer<typeof McpRemoveSchema>;

/** Where an importable server came from: the global scope, or a project path.
 *
 *  The global case is a **tag, not a path** — it used to be the Chinese word
 *  "全局" travelling over the wire as the discriminator, which meant the
 *  renderer compared against a display string (`origin === "全局"`) and had
 *  to strip it back out for the English UI. A tagged union keeps the
 *  discriminator untranslatable and unambiguous: a project whose directory
 *  happens to be named "全局" is now just a path, as it should be. */
export type McpImportOrigin = { kind: "global" } | { kind: "project"; path: string };

/** A server discovered in the local Claude CLI config (~/.claude.json),
 *  offered by the import dialog without any credential values. */
export interface McpImportSource {
  name: string;
  kind: McpKind;
  detail: string;
  origin: McpImportOrigin;
}

/** Scan the local Claude CLI config for importable MCP servers. Read-only;
 *  never writes to ~/.claude.json. */
export const McpScanImportSchema = z.object({});
export type McpScanImportInput = z.infer<typeof McpScanImportSchema>;

/** Main resolves full config by scan source identity. Legacy callers may
 * still supply a config directly (same authority as mcp.save); scanImport no
 * longer sends one to the renderer. */
const McpImportSourceItemSchema = z.object({
  name: z.string().min(1),
  origin: z.union([z.object({ kind: z.literal("global") }), z.object({ kind: z.literal("project"), path: z.string() })]),
});
export const McpImportItemSchema = z.union([
  McpImportSourceItemSchema,
  z.object({ name: z.string().min(1), config: McpServerConfigSchema }),
]);

/** Import selected servers into the user scope (Mcode's own config file).
 *  Already-existing names are skipped. Returns per-server lists. */
export const McpImportSchema = z.object({
  servers: z.array(McpImportItemSchema),
});
export type McpImportInput = z.infer<typeof McpImportSchema>;


/* ── 项目级 MCP(<项目>/.mcp.json)──
 *  与项目技能(<项目>/.claude/skills)同一个思路:服务器写进项目目录,跟着项目走、能分享
 *  给同事。文件格式是 Claude Code 的标准 `.mcp.json`({ "mcpServers": { 名: 配置 } }),
 *  值里的 `${VAR}` / `${VAR:-默认}` 按本机环境变量展开 —— 密钥别直接写进去。
 *
 *  ⚠️ 信任:stdio 服务器 = 在本机跑一条命令。克隆来的仓库自带 .mcp.json 时不能自动跑,
 *  所以只有**被信任过**的条目才会投递给引擎。信任按「名字 + 配置内容」的指纹记
 *  (MCP_PROJECT_TRUST_SETTING_KEY),配置一改指纹就变、要重新信任;在 Mcode 里新增 /
 *  编辑 / 从总库复制的条目自动信任。投递:Claude 每轮注入、Codex 每轮 `-c` 覆盖;Pi 没有
 *  MCP。项目级条目不进引擎矩阵(同项目技能)。 */

/** Settings key: JSON string[] of trusted project-server fingerprints. */
export const MCP_PROJECT_TRUST_SETTING_KEY = "mcp.projectTrust";

/** One server of a project's `.mcp.json`. `config` is the file content as-is
 *  (a plain project file, not a secret store — it is shown for editing). */
export interface McpProjectServer {
  name: string;
  kind: Exclude<McpKind, "builtin">;
  detail: string;
  config: McpServerConfig;
  /** Delivered to the engines only when trusted (fingerprint matches). */
  trusted: boolean;
}

export const McpProjectListSchema = z.object({ projectPath: z.string().min(1) });
export type McpProjectListInput = z.infer<typeof McpProjectListSchema>;
export interface McpProjectListResult {
  /** Absolute path of the project's .mcp.json. */
  file: string;
  exists: boolean;
  servers: McpProjectServer[];
  /** Entry names present in the file whose config is not a valid server. */
  invalid: string[];
  /** File unreadable / not JSON — the panel shows it instead of an empty list. */
  error?: string;
}

/** Add (or with `replace`, overwrite) one server in `<project>/.mcp.json`.
 *  Other keys of the file are preserved; the saved entry becomes trusted. */
export const McpProjectSaveSchema = z.object({
  projectPath: z.string().min(1),
  name: z.string().regex(MCP_NAME_RE, "invalid MCP server name"),
  config: McpServerConfigSchema,
  replace: z.boolean().optional(),
});
export type McpProjectSaveInput = z.infer<typeof McpProjectSaveSchema>;

export const McpProjectRemoveSchema = z.object({
  projectPath: z.string().min(1),
  name: z.string().regex(MCP_NAME_RE, "invalid MCP server name"),
});
export type McpProjectRemoveInput = z.infer<typeof McpProjectRemoveSchema>;

/** Trust / untrust one project server as it is currently written. */
export const McpProjectTrustSchema = z.object({
  projectPath: z.string().min(1),
  name: z.string().regex(MCP_NAME_RE, "invalid MCP server name"),
  trusted: z.boolean(),
});
export type McpProjectTrustInput = z.infer<typeof McpProjectTrustSchema>;

/** Copy user-scope servers (总库) into the project file. Existing names are
 *  skipped, never overwritten. Values are copied verbatim — the panel warns
 *  that secrets in env/headers then live in the project file. */
export const McpProjectCopySchema = z.object({
  projectPath: z.string().min(1),
  names: z.array(z.string().regex(MCP_NAME_RE, "invalid MCP server name")).min(1).max(200),
});
export type McpProjectCopyInput = z.infer<typeof McpProjectCopySchema>;
export interface McpProjectCopyResult {
  copied: string[];
  skipped: string[];
  failed: Array<{ name: string; reason: string }>;
}

/* ── MCP market (settings panel, 「市场」tab) ──
 *  Sources are MCP registries speaking the official registry API
 *  (`GET <base>/v0.1/servers?search=&cursor=&version=latest`). The official
 *  registry ships built in; users can add their own (company sub-registries,
 *  mirrors). Entries are fetched live (the official registry holds thousands
 *  of servers — no local catalog); each entry carries ready-made install
 *  options (npm → npx, PyPI → uvx, OCI → docker, remote http/sse) plus the
 *  inputs the user has to fill in (env vars, headers, required arguments).
 *  Installing = `mcp.save` of the built config into the user scope. */

export interface McpMarketSource {
  id: string;
  label: string;
  /** Registry base URL (no trailing slash, no `/v0.1`). */
  url: string;
  builtin: boolean;
}

export const McpMarketSourcesSchema = z.object({});
export type McpMarketSourcesInput = z.infer<typeof McpMarketSourcesSchema>;

export const McpMarketSourceAddSchema = z.object({
  url: z.string().min(1).max(500),
  label: z.string().max(80).optional(),
});
export type McpMarketSourceAddInput = z.infer<typeof McpMarketSourceAddSchema>;

export const McpMarketSourceRemoveSchema = z.object({ id: z.string().min(1).max(200) });
export type McpMarketSourceRemoveInput = z.infer<typeof McpMarketSourceRemoveSchema>;

export const McpMarketSearchSchema = z.object({
  source: z.string().min(1).max(200),
  query: z.string().max(200).optional(),
  cursor: z.string().max(500).optional(),
});
export type McpMarketSearchInput = z.infer<typeof McpMarketSearchSchema>;

/** A value the user supplies before installing. */
export interface McpMarketInput {
  /** Unique within the option. */
  key: string;
  kind: "env" | "header" | "arg";
  /** Env var / header name, or the flag of a named argument ("" for positional). */
  name: string;
  description?: string;
  required: boolean;
  secret: boolean;
  /** Pre-filled value (registry default / template such as "Bearer {token}"). */
  default?: string;
}

/** One argv element of a stdio option: a literal, or a user input
 *  (`flag` = named argument, emitted as `flag value`). */
export type McpMarketArg = { value: string } | { input: string; flag?: string };

export interface McpMarketOption {
  id: string;
  kind: "stdio" | "http" | "sse";
  /** "npm · npx", "PyPI · uvx", "Docker", "远程 HTTP" … */
  label: string;
  command?: string;
  args?: McpMarketArg[];
  url?: string;
  inputs: McpMarketInput[];
}

export interface McpMarketEntry {
  /** Registry name, e.g. `io.github.owner/server`. */
  id: string;
  title: string;
  description: string;
  version: string;
  repositoryUrl?: string;
  websiteUrl?: string;
  /** A valid local server name derived from the registry name. */
  suggestedName: string;
  options: McpMarketOption[];
}

export interface McpMarketSearchResult {
  ok: boolean;
  error?: string;
  entries: McpMarketEntry[];
  nextCursor?: string;
}

/** Build the server config for one option from the user's values. Pure —
 *  shared by the install dialog and the smoke. `missing` lists required
 *  inputs left empty (config is then undefined). */
export function buildMcpMarketConfig(
  option: McpMarketOption,
  values: Readonly<Record<string, string>>,
): { config?: McpServerConfig; missing: string[] } {
  const val = (key: string): string => (values[key] ?? "").trim();
  const missing = option.inputs.filter((i) => i.required && !val(i.key)).map((i) => i.key);
  if (missing.length > 0) return { missing };
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  for (const input of option.inputs) {
    const v = val(input.key);
    if (!v) continue;
    if (input.kind === "env") env[input.name] = v;
    else if (input.kind === "header") headers[input.name] = v;
  }
  if (option.kind === "stdio") {
    const args: string[] = [];
    for (const a of option.args ?? []) {
      if ("value" in a) {
        args.push(a.value);
        continue;
      }
      const v = val(a.input);
      if (!v) continue;
      if (a.flag) args.push(a.flag);
      args.push(v);
    }
    return {
      missing,
      config: {
        command: option.command ?? "",
        ...(args.length ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      },
    };
  }
  return {
    missing,
    config: {
      type: option.kind,
      url: option.url ?? "",
      ...(Object.keys(headers).length ? { headers } : {}),
    },
  };
}
