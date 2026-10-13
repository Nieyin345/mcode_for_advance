/**
 * Plugin subsystem contracts (cross-process, no runtime logic).
 *
 * A plugin is a declarative capability pack (docs/plugin-feasibility.md) — a
 * directory with a manifest at `.claude-plugin/plugin.json` (the Claude-ecos
 * layout; `.zcode-plugin` / `.codex-plugin` manifests are detected as
 * compatible alternatives) carrying skills / commands / agents / hooks / MCP
 * servers. Mcode installs plugins into its own cache
 * (`~/.mcode/plugins/<name>/<version>/`), persists the enabled set in the
 * settings table, and translates per provider at turn start:
 *
 *   - Claude: SDK-native `options.plugins` (skills/commands/agents loaded by
 *     the CLI engine; `skipMcpDiscovery` keeps MCP host-managed; hooks are
 *     held OFF in v1 via `disableAllHooks` — the panel states this openly)
 *   - Codex:  skills via the `skills/extraRoots/set` RPC + MCP materialized
 *     into `<CODEX_HOME>/config.toml` under the same `<plugin>__<server>` name
 *   - Pi:     skills via the resource loader's additional skill paths only
 *
 * This module holds the manifest/marketplace zod schemas, the settings-panel
 * state types and the RPC input schemas. ipc.ts re-exports them and wires the
 * `plugins.*` channels; keep this file electron-free (pure zod + types).
 */
import { z } from "zod";
import { CapabilityDeclarationSchema } from "./capability.js";

/* ── Settings keys (settings table) ── */

/** Enabled plugin names. Value = JSON.stringify(string[]). A name whose
 *  directory vanished from disk is ignored until reinstalled (reinstalling
 *  restores the enabled state). */
export const PLUGINS_ENABLED_SETTING_KEY = "plugins.enabled";

/** User-added plugin marketplaces. Value = JSON.stringify(PluginMarketplaceRecord[]). */
export const PLUGINS_MARKETPLACES_SETTING_KEY = "plugins.marketplaces";

/** Plugin-contributed MCP servers the user turned OFF in the MCP panel
 *  (namespaced `<plugin>__<server>` names). Value = JSON.stringify(string[]). */
export const PLUGINS_MCP_DISABLED_SETTING_KEY = "plugins.mcpDisabled";

/** Per-plugin, per-engine switches — the plugin counterpart of the skill
 *  matrix (Settings → 技能). Value = JSON.stringify(Record<pluginName,
 *  Partial<PluginEngineSwitches>>). A missing plugin / missing engine key means
 *  ON, so plugins installed before this key existed keep their old delivery. The
 *  switch can only NARROW delivery: an engine the plugin has nothing for (see
 *  `PluginState.compatibleProviderIds`) never receives it, whatever is stored. */
export const PLUGINS_ENGINES_SETTING_KEY = "plugins.engines";

/** The three local engines a plugin can be delivered to. */
export const PLUGIN_ENGINE_IDS = ["claude", "codex", "pi"] as const;
export type PluginEngineId = (typeof PLUGIN_ENGINE_IDS)[number];

/** Engine id → the provider id the delivery queries filter on. */
export const PLUGIN_ENGINE_PROVIDER_IDS: Readonly<Record<PluginEngineId, string>> = {
  claude: "claude-sdk",
  codex: "codex-sdk",
  pi: "pi-sdk",
};

/** The user's per-engine switches for one plugin (all three resolved). */
export type PluginEngineSwitches = Record<PluginEngineId, boolean>;

/** Which plugin ecosystem a marketplace catalog belongs to (from where its
 *  manifest lives): `.claude-plugin/marketplace.json` → claude,
 *  `.agents/plugins/*.json` → codex; the ZCode catalog uses the Claude layout
 *  and is recognized by its built-in URL. */
export type PluginEcosystem = "claude" | "codex" | "zcode";

/* ── Built-in marketplaces ── */

/** Marketplaces Mcode ships with: the canonical catalogs of the two plugin
 *  ecosystems it targets (ZCode's own, and Anthropic's official one). They are
 *  always listed — the manager materializes a record for any of these that is
 *  missing, so a fresh install (or a wiped settings row) still finds them, and
 *  adding one by hand is refused rather than duplicated.
 *
 *  Matching is by git URL, normalized (case, trailing slashes, `.git`), NOT by
 *  name: the cloned manifest's own name wins, and an existing user-added copy
 *  of the same repository is adopted as built-in instead of showing up twice.
 *  Built-ins can be refreshed but not removed; `name` here is the directory name
 *  used for the record before the first clone lands. */
export const BUILTIN_MARKETPLACES: ReadonlyArray<{ name: string; url: string }> = [
  { name: "zcode-plugins-official", url: "https://github.com/zai-org/zcode-plugins" },
  {
    name: "claude-plugins-official",
    url: "https://github.com/anthropics/claude-plugins-official",
  },
  // OpenAI's curated Codex catalog (`.agents/plugins/*.json`, local-path
  // entries). Its plugins carry skills / MCP (usable by Codex — and by Claude/Pi
  // where the component allows) plus ChatGPT "apps", which Mcode cannot run.
  { name: "codex-plugins-official", url: "https://github.com/openai/plugins" },
];

/* ── Manifest (plugin.json) ── */

/** Where a plugin's manifest is looked up, in probe order. The Claude layout
 *  is the canonical format (largest ecosystem); the other two are
 *  structurally identical, so a single parser covers all three.
 *
 *  The trailing empty string is the **agent-plugins.org** layout: `plugin.json`
 *  sitting directly at the repository root, naming its own schema with a
 *  `$schema` key (K-Dense-AI/scientific-agent-skills ships this way, and the
 *  `skills/` subdirectory it implies is already the manifest's default). It is
 *  probed LAST on purpose — a canonical manifest in a subdirectory must always
 *  win, so a stray root-level `plugin.json` can never shadow
 *  `.claude-plugin/plugin.json`. `path.join(root, "", "plugin.json")` is
 *  `<root>/plugin.json`, which is exactly the intent. */
export const PLUGIN_MANIFEST_DIRS = [
  ".claude-plugin",
  ".zcode-plugin",
  ".codex-plugin",
  "",
] as const;

/** Plugin name charset — also guards the on-disk directory name (no path
 *  separators, no leading dot). */
export const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Plugin manifest (`.claude-plugin/plugin.json` & compatible shapes).
 *  Component fields are directory/file names RELATIVE to the plugin root;
 *  component paths that escape the plugin root are rejected by the resolver
 *  (not by the schema — the schema only checks shape). Unknown fields pass
 *  through so future manifest keys survive a round-trip.
 *
 *  Component paths accept Claude's full form: a single relative path OR an
 *  array of them (official-marketplace manifests use both — rejecting arrays
 *  made such plugins uninstallable). Resolvers normalize to string[]. */
export const PluginManifestSchema = z
  .object({
    name: z.string().regex(PLUGIN_NAME_RE),
    version: z.string().optional(),
    description: z.string().optional(),
    author: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    /** Skills directory name(s) (default "skills"). */
    skills: z.union([z.string(), z.array(z.string())]).optional(),
    /** Commands directory name(s) (default "commands"). */
    commands: z.union([z.string(), z.array(z.string())]).optional(),
    /** Agents directory name(s) (default "agents"). */
    agents: z.union([z.string(), z.array(z.string())]).optional(),
    /** Hooks definition file(s), relative (default "hooks/hooks.json"), or the
     *  hooks config inline (Claude's plugin.json allows an object; Codex
     *  plugins such as superpowers ship `"hooks": {}`). */
    hooks: z
      .union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown())])
      .optional(),
    /** MCP servers definition file(s), relative (default ".mcp.json" at root),
     *  or an inline `{ "<server>": config }` map (Claude's object form). */
    mcpServers: z
      .union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown())])
      .optional(),
    /** Codex "apps" (ChatGPT connectors) definition file (default ".app.json").
     *  Counted for display only — they need a ChatGPT-account Codex login and
     *  no Mcode engine can run them. */
    apps: z.union([z.string(), z.array(z.string())]).optional(),
    /** Mcode 工作流节点类型的定义目录 (default "node-types"). Unlike the other
     *  component fields this one is consumed by **Mcode itself**, not forwarded
     *  to a provider — see packages/contracts/src/nodeType.ts for the manifest
     *  schema a file in that directory must satisfy. A plugin without the
     *  directory simply contributes no node types. */
    nodeTypes: z.union([z.string(), z.array(z.string())]).optional(),
    /** Declarative capabilities contributed by this plugin. Shape is shared
     *  with the capability descriptor model (see `@contracts/capability`) —
     *  the resolver turns each entry into a host capability descriptor. */
    capabilities: z.array(CapabilityDeclarationSchema).optional(),
  })
  .passthrough();
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/* ── Marketplace manifest (marketplace.json) ── */

/** One entry of a marketplace's `plugins[]`. `source` follows the Claude
 *  marketplace shape (verified against anthropics/claude-plugins-official,
 *  292 entries: 152 url / 88 git-subdir / 52 relative paths): a relative path
 *  string, a GitHub repo reference, a git URL (optionally a subdir + ref/sha),
 *  or a direct archive URL. Unknown shapes fail this schema — the manager
 *  skips such entries individually instead of dropping the whole catalog. */
export const PluginMarketEntrySourceSchema = z.union([
  z.string(),
  // Codex marketplaces (`.agents/plugins/marketplace.json`): a path relative to
  // the marketplace root, wrapped — same resolution as the bare string form.
  z
    .object({ source: z.literal("local"), path: z.string().min(1) })
    .passthrough(),
  z
    .object({ source: z.literal("github"), repo: z.string().min(1) })
    .passthrough(),
  z
    .object({ source: z.literal("git"), url: z.string().min(1), ref: z.string().optional() })
    .passthrough(),
  z
    .object({
      source: z.literal("git-subdir"),
      url: z.string().min(1),
      path: z.string().min(1),
      ref: z.string().optional(),
      /** Pinned commit; recorded but not enforced by v1 (the install-review
       *  dialog is the integrity gate). */
      sha: z.string().optional(),
    })
    .passthrough(),
  z
    .object({ source: z.literal("url"), url: z.string().min(1) })
    .passthrough(),
]);
export type PluginMarketEntrySource = z.infer<typeof PluginMarketEntrySourceSchema>;

export const PluginMarketEntrySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    version: z.string().optional(),
    source: PluginMarketEntrySourceSchema,
  })
  .passthrough();

/** `.claude-plugin/marketplace.json` (root-level `marketplace.json` is
 *  accepted as a fallback by the manager). */
export const PluginMarketplaceManifestSchema = z
  .object({
    name: z.string().optional(),
    owner: z.string().optional(),
    plugins: z.array(PluginMarketEntrySchema),
  })
  .passthrough();
export type PluginMarketplaceManifest = z.infer<typeof PluginMarketplaceManifestSchema>;

/* ── Component summaries (install review + panel display) ── */

/** One declarative capability a plugin contributes (manifest `capabilities[]`).
 *  Consumed by capability resolution (see `@contracts/capability`): the host
 *  turns each entry into a CapabilityDescriptor so node requirements can match
 *  against what installed plugins actually provide. */
export interface PluginCapabilityDeclaration {
  kind: "skill" | "mcp" | "plugin" | "executor" | "builtin" | "provider";
  id: string;
  capabilities?: string[];
  nodeTypes?: string[];
  runnerKinds?: string[];
  providers?: string[];
}

/** A skill contributed by the plugin (from SKILL.md frontmatter). */
export interface PluginSkillSummary {
  name: string;
  description: string;
}

/** A slash command contributed by the plugin (from commands/*.md frontmatter).
 *  v1: loaded natively by the Claude engine; a host-side composer expansion
 *  (provider-neutral) is planned for v2. */
export interface PluginCommandSummary {
  name: string;
  description: string;
}

/** A subagent definition (agents/*.md frontmatter) — Claude sessions only. */
export interface PluginAgentSummary {
  name: string;
  description: string;
}

/** One hook command as declared by the plugin. v1 parses and SHOWS these but
 *
 *  never executes them (see pluginManager docs) — the panel labels them
 *  explicitly so users don't assume the automation is live.
 *
 *  【MC-061】`execution` 把「到底跑不跑」变成**显式状态**,而不是让用户以为 hooks
 *  装了就是活的:
 *   - `unsupported` —— v1 明确不执行插件 hooks。带 command 的钩子先当作**声明性能力**
 *     展示(command 来源可见),但要执行得先经用户授信产生独立的主机 hook 授权(尚未实现);
 *   - `unmappable` —— 该事件名映射不到 Mcode 的统一 `RuntimeEvent`(见
 *     `pluginHookEventSupport`),即使将来接上执行通道也该明确报不可用,不得静默不跑。 */
export interface PluginHookSummary {
  event: string;
  matcher?: string;
  command: string;
  /** 「这个钩子到底跑不跑」的显式状态;缺省由面板按 UNSUPPORTED 呈现。 */
  execution?: PluginHookExecution;
}

/** 插件 hook 的执行状态(见 {@link PluginHookSummary})。 */
export type PluginHookExecution = "unsupported" | "unmappable";

/** Transport kind of a plugin MCP server, mirroring the MCP panel. */
export type PluginMcpKind = "stdio" | "http" | "sse";

/** One MCP server contributed by the plugin. `detail` is secret-free
 *  (command line or URL) — env values never enter it. */
export interface PluginMcpServerSummary {
  name: string;
  kind: PluginMcpKind;
  detail: string;
}

/** Everything the install-review dialog and the plugin row expand needs. */
export interface PluginComponents {
  skills: PluginSkillSummary[];
  commands: PluginCommandSummary[];
  agents: PluginAgentSummary[];
  hooks: PluginHookSummary[];
  mcpServers: PluginMcpServerSummary[];
  /** Codex "apps" (ChatGPT connectors) declared by the plugin — names only.
   *  Never delivered: they need a ChatGPT-account Codex login. Optional so older
   *  summaries (and test fixtures) stay valid. */
  apps?: string[];
}

/* ── Panel state ── */

/** Where an installed plugin came from (recorded in .mcode-install.json). */
export type PluginSourceKind = "local-dir" | "local-zip" | "git" | "marketplace" | "unknown";

export interface PluginSourceInfo {
  kind: PluginSourceKind;
  /** Path / URL / `marketplace:<name>` — display + future update checks. */
  ref: string;
}

/** One installed plugin row. `rootDir` is the versioned install directory. */
export interface PluginState {
  name: string;
  version: string;
  description: string;
  rootDir: string;
  /** Enabled plugins are delivered to providers at the NEXT turn start
   * (each turn rebuilds provider options — no live reload needed). */
  enabled: boolean;
  installedAt: string;
  source: PluginSourceInfo;
  components: PluginComponents;
  /** Built-in provider ids that can consume at least one executable component
   * of this plugin. Missing means an older host that did not expose this
   * metadata; clients must keep the row visible for compatibility. */
  compatibleProviderIds?: string[];
  /** The user's per-engine switches (PLUGINS_ENGINES_SETTING_KEY), all three
   *  resolved — missing in storage means on. Missing here means an older host. */
  engines?: PluginEngineSwitches;
  /** What is actually delivered when the plugin is enabled:
   *  `compatibleProviderIds` ∩ the engines switched on. */
  deliveredProviderIds?: string[];
  /** 【ARC-014】逐引擎的**组件就绪(ALL 语义)** —— 键是 providerId(`claude-sdk`
   *  等),值是「这个引擎是否收到该插件的**全部**声明组件」的判定结果。
   *
   *  为什么要它:`compatibleProviderIds` 是 **ANY**(至少一个组件能投递),而一个场景
   *  真正要的是 **ALL**(所需组件全部就绪)—— 二者语义不同,单一兼容列表会误放行。这份
   *  逐引擎结果由契约函数 {@link sceneComponentReadiness} 对「该插件声明的每一个组件 id」
   *  与「该引擎的逐组件交付报告」做 ALL 判定得出,面板据此把「部分兼容」与「全部就绪」
   *  分成两件事。缺省 = 老宿主,客户端按旧逻辑(仅看兼容列表)显示。 */
  componentReadiness?: Record<string, SceneComponentReadiness>;
}

/** A marketplace added by the user (or materialized from BUILTIN_MARKETPLACES).
 *  The cloned/copied tree lives under `~/.mcode/plugins/marketplaces/<name>/`. */
export interface PluginMarketplaceRecord {
  name: string;
  source: { kind: "git" | "local"; ref: string };
  addedAt: string;
  /** True for the catalogs in BUILTIN_MARKETPLACES: refreshable, not removable. */
  builtin?: boolean;
}

/** A marketplace listing entry for the Discover tab. `installed` is computed
 *  against the installed plugin set (matched by name). */
export interface PluginMarketEntry {
  marketplace: string;
  name: string;
  description: string;
  version: string;
  installed: boolean;
  /** Provider ids the entry would be usable by, when it could be inspected
   *  before install (local-path entries whose tree is in the cloned catalog).
   *  Missing = unknown until installed (remote git / url sources). */
  compatibleProviderIds?: string[];
  /** True when the inspected entry carries ONLY Codex apps (ChatGPT
   *  connectors) — nothing any Mcode engine can use. */
  appsOnly?: boolean;
}

/** Marketplace panel state (records joined with their parsed manifests). */
export interface PluginMarketplaceState {
  name: string;
  sourceKind: "git" | "local";
  sourceRef: string;
  addedAt: string;
  /** Shipped with Mcode (see BUILTIN_MARKETPLACES) — the panel badges it and
   *  drops the remove action. */
  builtin: boolean;
  /** False until the tree has been fetched into the marketplaces directory. A
   *  built-in is listed before its first clone, so the panel can say "拉取中 /
   *  待拉取" instead of the misleading "清单为空或无法解析". */
  cloned: boolean;
  /** Plugin ecosystem of the catalog (manifest layout); missing until cloned
   *  for catalogs that are not built-in. */
  ecosystem?: PluginEcosystem;
  plugins: PluginMarketEntry[];
}

/* ── RPC input schemas ── */

export const PluginsListSchema = z.object({});
export type PluginsListInput = z.infer<typeof PluginsListSchema>;

/** Install from a user-picked local path (plugin directory or .zip archive).
 *  The install lands DISABLED; the renderer shows the component-review dialog
 *  on success and calls setEnabled when the user approves. */
export const PluginsInstallLocalSchema = z.object({
  localPath: z.string().min(1),
});
export type PluginsInstallLocalInput = z.infer<typeof PluginsInstallLocalSchema>;

/** Install by cloning a git repository (shallow). `ref` selects a branch/tag. */
export const PluginsInstallGitSchema = z.object({
  url: z.string().min(1),
  ref: z.string().optional(),
});
export type PluginsInstallGitInput = z.infer<typeof PluginsInstallGitSchema>;

/** Install an entry of a user-added marketplace (resolved from its manifest
 *  source: relative path / github repo / git url). */
export const PluginsInstallMarketplaceSchema = z.object({
  marketplace: z.string().min(1),
  name: z.string().min(1),
});
export type PluginsInstallMarketplaceInput = z.infer<typeof PluginsInstallMarketplaceSchema>;

export const PluginsSetEnabledSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_RE),
  enabled: z.boolean(),
});
export type PluginsSetEnabledInput = z.infer<typeof PluginsSetEnabledSchema>;

/** Per-engine switches of one plugin (the skill matrix's `enginesSet`
 *  counterpart). Omitted engines keep their current value. */
export const PluginsEnginesSetSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_RE),
  claude: z.boolean().optional(),
  codex: z.boolean().optional(),
  pi: z.boolean().optional(),
});
export type PluginsEnginesSetInput = z.infer<typeof PluginsEnginesSetSchema>;

/* ── 项目级插件开关 ──
 *  插件只在总库装一次;每个项目可以单独决定启用哪些、对哪个引擎启用。项目里没设的插件
 *  跟随总库。存储:PLUGINS_PROJECT_SETTING_KEY = { [项目路径]: { [插件名]: 覆盖 } }。
 *  会话的 cwd 落在某个项目目录里(取最长匹配)时按该项目的覆盖投递。 */
export const PLUGINS_PROJECT_SETTING_KEY = "plugins.projectOverrides";

/** One plugin's per-project override. Absent field = follow the global value. */
export interface PluginProjectOverride {
  enabled?: boolean;
  engines?: Partial<PluginEngineSwitches>;
}

/** One installed plugin as seen from a project. */
export interface PluginProjectRow {
  name: string;
  description: string;
  globalEnabled: boolean;
  globalEngines: PluginEngineSwitches;
  override?: PluginProjectOverride;
  /** Effective state in this project (override ∘ global). */
  enabled: boolean;
  engines: PluginEngineSwitches;
  compatibleProviderIds: string[];
  /** compatible ∩ effective engines (empty when not enabled here). */
  deliveredProviderIds: string[];
}

export const PluginsProjectListSchema = z.object({ projectPath: z.string().min(1) });
export type PluginsProjectListInput = z.infer<typeof PluginsProjectListSchema>;

/** Set / clear one plugin's override in a project. `enabled`/`engines`:
 *  undefined = unchanged, null = back to following the global value;
 *  `engines` merges into the stored override. */
export const PluginsProjectSetSchema = z.object({
  projectPath: z.string().min(1),
  name: z.string().regex(PLUGIN_NAME_RE),
  enabled: z.boolean().nullable().optional(),
  engines: z
    .object({ claude: z.boolean().optional(), codex: z.boolean().optional(), pi: z.boolean().optional() })
    .nullable()
    .optional(),
});
export type PluginsProjectSetInput = z.infer<typeof PluginsProjectSetSchema>;

/** Uninstall: deletes every installed version + clears enable/disable state.
 *  Rejected while any turn is running (a live turn may reference the files). */
export const PluginsRemoveSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_RE),
});
export type PluginsRemoveInput = z.infer<typeof PluginsRemoveSchema>;

export const PluginsMarketplaceListSchema = z.object({});
export type PluginsMarketplaceListInput = z.infer<typeof PluginsMarketplaceListSchema>;

/** Add a marketplace by git URL or local directory (cloned/copied under
 *  `~/.mcode/plugins/marketplaces/`). `name` overrides the manifest's own
 *  name when provided. */
export const PluginsMarketplaceAddSchema = z.object({
  requestId: z.string().uuid().optional(),
  kind: z.enum(["git", "local"]),
  /** git URL, or absolute local directory path. */
  ref: z.string().min(1),
  name: z.string().regex(PLUGIN_NAME_RE).optional(),
});
export type PluginsMarketplaceAddInput = z.infer<typeof PluginsMarketplaceAddSchema>;

export const PluginsMarketplaceRemoveSchema = z.object({
  name: z.string().min(1),
});
export type PluginsMarketplaceRemoveInput = z.infer<typeof PluginsMarketplaceRemoveSchema>;

/** Re-fetch a marketplace (git: fresh shallow clone; local: re-copy). */
export const PluginsMarketplaceRefreshSchema = z.object({
  requestId: z.string().uuid().optional(),
  name: z.string().min(1),
});
export type PluginsMarketplaceRefreshInput = z.infer<typeof PluginsMarketplaceRefreshSchema>;

/**
 * 【ARC-014】一个声明组件**对某个 provider** 的交付状态。
 *
 * 为什么需要它:`compatibleProviderIdsForPlugin` 给的是 **ANY**(至少一个组件能投递),
 * 而场景依赖通常是 **ALL**(所需组件全部就绪)。两个量词语义不同 —— 一个"同时含通用 Skill
 * 与 Claude 专用 Command"的插件,兼容列表里有 Pi,但 Pi **收不到**那个 Command。用单一的
 * `compatibleProviderIds` 判断整个场景是否 ready 就会误放行。这份逐组件表补上缺口。
 */
export type ComponentDeliveryStatus =
  | "DELIVERED"
  | "INCOMPATIBLE"      // 该组件类型不被这个 provider 支持
  | "DISABLED"          // 插件被用户禁用
  | "DENIED"            // 授信被撤销(MCP trust 等)
  | "MISSING_DEPENDENCY";

export interface ComponentDeliveryEntry {
  componentId: string;
  type: "skill" | "command" | "agent" | "hook" | "mcp" | "app" | "nodeType";
  /** 来源摘要(文件/名字),敏感内容不外泄。 */
  source: string;
  status: ComponentDeliveryStatus;
  reason?: string;
}

/** 【ARC-014】一个插件对某个 provider 的逐组件交付报告。 */
export interface ComponentDeliveryReport {
  pluginId: string;
  version?: string;
  providerId: string;
  /** 插件是否被用户启用。false 时所有组件为 DISABLED。 */
  pluginEnabled: boolean;
  entries: ComponentDeliveryEntry[];
  /** 逐组件 ALL 判定:是否**每一个**组件都 DELIVERED。场景"需要某组件"用它,不用 compatibleProviderIds。 */
  allDelivered: boolean;
}

/**
 * 【ARC-003 / ARC-014】**唯一一份** 组件类型 → 能原生投递它的 provider 集合。
 *
 * 「哪些引擎收得到哪类组件」是一个事实,只应有**一处**权威表达:
 *   - `compatibleProviderIdsForPlugin`(ANY 语义的兼容列表,喂市场预览与 ARC-003 能力目录)
 *   - `componentDeliveryReport`(逐组件 ALL 语义的交付报告)
 * 二者都从这里取。此前各写一遍,已实测漂移:兼容列表漏了 `apps`(Codex 专用),于是
 * 一个 app-only 插件被谎报成 Claude/Pi 也能用 —— 两处规则分家的典型后果。
 *
 * 值即 schema 里的 providerId(`claude-sdk` / `codex-sdk` / `pi-sdk`)。`nodeType` 是
 * **宿主侧**(工作流引擎)的概念,不由某个引擎投递,故对所有引擎列示(它从不经
 * componentDeliveryReport / 兼容列表产生条目,这里只是保持 Record 完备)。
 */
export const COMPONENT_PROVIDER_DELIVERY: Readonly<
  Record<ComponentDeliveryEntry["type"], readonly string[]>
> = {
  skill: ["claude-sdk", "codex-sdk", "pi-sdk"],
  command: ["claude-sdk"],
  agent: ["claude-sdk"],
  hook: ["claude-sdk"],
  mcp: ["claude-sdk", "codex-sdk"],
  app: ["codex-sdk"],
  nodeType: ["claude-sdk", "codex-sdk", "pi-sdk"],
};

/** 能原生投递某一类组件的 provider 集合 —— 见 {@link COMPONENT_PROVIDER_DELIVERY}。 */
export function providersDeliveringComponent(
  type: ComponentDeliveryEntry["type"],
): readonly string[] {
  return COMPONENT_PROVIDER_DELIVERY[type];
}

/** 【ARC-014】场景必需组件的一个缺口:某个 requiredComponentId 没被任何报告交付。 */
export interface SceneComponentGap {
  componentId: string;
  /** 缺口类别:MISSING = 没有任何交付报告提到它;其余取报告里命中的那条状态。 */
  status: "MISSING" | ComponentDeliveryStatus;
  /** 报告给出的原因(命中多条时按 SCENE_GAP_STATUS_PRIORITY 取)。 */
  reason?: string;
  /** 哪些插件的报告提到了这个 id(便于定位是哪个插件的问题)。 */
  reportedBy: string[];
}

/** 【ARC-014】场景组件就绪判定结果 —— **ALL**(全部必需组件)语义,不是 ANY。 */
export interface SceneComponentReadiness {
  /** 整体:所有 requiredComponentIds 都被某个报告以 DELIVERED 交付。 */
  ready: boolean;
  /** 已就绪的 required id(去重后,按输入顺序)。 */
  satisfied: string[];
  /** 逐项缺口(只列没就绪的,按输入顺序去重)。ready 为 false 时至少一条。 */
  gaps: SceneComponentGap[];
  /** 被检查的 providerId(取首份报告;混用 provider 属调用方错误)。 */
  providerId?: string;
}

/** 多条报告对同一 id 给出不同「未交付」状态时的取值优先级:先看用户要动手改的插件级
 *  状态(授信被撤 / 插件被禁用),再看组件级原因(缺依赖 / 引擎不支持)。这个顺序是
 *  **契约的一部分**,测试把它钉死。 */
const SCENE_GAP_STATUS_PRIORITY: readonly ComponentDeliveryStatus[] = [
  "DENIED",
  "DISABLED",
  "MISSING_DEPENDENCY",
  "INCOMPATIBLE",
];

/**
 * 【ARC-014】场景组件就绪 —— 把「一个场景声明需要的组件 id 集合」与「各插件的逐组件
 * 交付报告」合起来做 **ALL** 判定:每一个必需组件都必须在某份报告里 DELIVERED。
 *
 * 这是给将来 ScenePlanner 的**可测落点**:Planner 不再靠 `compatibleProviderIds`
 * (那是 ANY 语义)判断场景能否部署,而是拿这份逐项结果决定「部署 / 换引擎 / 显式降级 /
 * 要求装替代插件」。本函数**只判定** —— 不做副作用、不读盘、不撮合安装、不重写 Provider。
 *
 * 语义(判据窄,别扩容):
 *   - required 去重(保首见顺序);空列表 → ready=true(真空满足),gaps=[]。
 *   - 某个 required id:任一份报告里有一条同 `componentId` 且 `DELIVERED` → 就绪。
 *   - 没有任何报告提到该 id → 缺口 status=MISSING。
 *   - 有报告提到但没一条 DELIVERED → 缺口 status 按 SCENE_GAP_STATUS_PRIORITY 取。
 *   - 只按 `componentId` **字面**匹配;跨插件的 id 唯一化由调用方负责,本函数不猜插件身份。
 */
export function sceneComponentReadiness(
  requiredComponentIds: readonly string[],
  reports: readonly ComponentDeliveryReport[],
): SceneComponentReadiness {
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const id of requiredComponentIds) {
    if (!seen.has(id)) {
      seen.add(id);
      orderedIds.push(id);
    }
  }

  const satisfied: string[] = [];
  const gaps: SceneComponentGap[] = [];

  for (const id of orderedIds) {
    const hits: ComponentDeliveryEntry[] = [];
    const reportedBy: string[] = [];
    for (const rep of reports) {
      let matched = false;
      for (const entry of rep.entries) {
        if (entry.componentId === id) {
          hits.push(entry);
          matched = true;
        }
      }
      if (matched) reportedBy.push(rep.pluginId);
    }

    if (hits.some((e) => e.status === "DELIVERED")) {
      satisfied.push(id);
      continue;
    }

    if (hits.length === 0) {
      gaps.push({
        componentId: id,
        status: "MISSING",
        reason: "没有任何插件交付报告提到这个组件 id",
        reportedBy: [],
      });
      continue;
    }

    let chosen = hits[0];
    let bestRank = rankGapStatus(chosen.status);
    for (const candidate of hits) {
      const rank = rankGapStatus(candidate.status);
      if (rank < bestRank) {
        chosen = candidate;
        bestRank = rank;
      }
    }

    gaps.push({
      componentId: id,
      status: chosen.status,
      ...(chosen.reason ? { reason: chosen.reason } : {}),
      reportedBy,
    });
  }

  return {
    ready: gaps.length === 0,
    satisfied,
    gaps,
    ...(reports.length > 0 ? { providerId: reports[0].providerId } : {}),
  };
}

/** 未交付状态的优先级名次(越小越先被选中);不在表里的排最后。 */
function rankGapStatus(status: ComponentDeliveryStatus): number {
  const i = SCENE_GAP_STATUS_PRIORITY.indexOf(status);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}
