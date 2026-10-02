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
 *  never executes them (see pluginManager docs) — the panel labels them
 *  explicitly so users don't assume the automation is live. */
export interface PluginHookSummary {
  event: string;
  matcher?: string;
  command: string;
}

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
  name: z.string().min(1),
});
export type PluginsMarketplaceRefreshInput = z.infer<typeof PluginsMarketplaceRefreshSchema>;
