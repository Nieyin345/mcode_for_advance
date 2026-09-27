/**
 * MCP config file IO + management state for the settings panel's MCP section.
 *
 * Server sources (see contracts/ipc/mcp.ts "MCP management"):
 *  - user scope: the `mcpServers` object of ~/.mcode/.claude.json. This is the
 *    CLI's own user-level config location (CLAUDE_CONFIG_DIR is always set to
 *    ~/.mcode), so whatever sits in the file is loaded automatically by the
 *    claude binary — the file itself is the enable mechanism. Disabling a
 *    server means moving its config OUT of the file into the settings-table
 *    stash (MCP_MANAGEMENT_SETTING_KEY), re-enabling moves it back. All three
 *    engines share this enable set, so a server is configured once and shows
 *    up everywhere. (Project-level .mcp.json inheritance was deliberately cut:
 *    the app manages context centrally instead of per-workspace files.)
 *  - builtin: the in-process mcode-browser server; only its disabled flag
 *    lives in the management state.
 *
 * The user config file is a big grab-bag the CLI rewrites frequently (project
 * state, approval caches, onboarding flags...), so every write is a
 * read-modify-write that preserves all unknown keys, and entries we don't
 * recognize (configs that fail our schema) are left untouched rather than
 * dropped — they simply stay enabled and outside the panel's control.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  McpServerConfigSchema,
  MCP_MANAGEMENT_SETTING_KEY,
  type McpKind,
  type McpManagementState,
  type McpImportOrigin,
  type McpServerConfig,
} from "@contracts/ipc";
import { MCODE_CONFIG_DIR } from "@main/providers/claude-sdk/customEnv.js";
import { awaitDb } from "@main/store/db.js";
import { SettingRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import {
  deriveMcpEngineView,
  readMcpEnginesMap,
} from "@main/lib/mcpEngines.js";

/** Mcode's own ~/.mcode/.claude.json — the CLI's user-level config file under
 *  the redirected CLAUDE_CONFIG_DIR. User-scope MCP servers live in its
 *  top-level `mcpServers` object. */
const USER_CLAUDE_JSON = path.join(MCODE_CONFIG_DIR, ".claude.json");

/** The real Claude CLI's config file — scanned (read-only) by the import
 *  feature. Never written. */
const CLI_CLAUDE_JSON = path.join(homedir(), ".claude.json");

/** Narrow an unknown JSON value to a plain string-keyed record, or null. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Read and JSON.parse a file; null on any error (missing, unreadable,
 *  invalid JSON). Never throws. */
async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    return null;
  }
}

/** Write JSON atomically-ish: tmp file + rename, falling back to a direct
 *  write when rename fails (Windows can refuse renames over an existing file
 *  held by another process). Creates parent dirs as needed. */
async function writeJson(file: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.mcode-tmp`;
  try {
    await fs.writeFile(tmp, text, "utf-8");
    await fs.rename(tmp, file);
  } catch {
    try {
      await fs.rm(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    await fs.writeFile(file, text, "utf-8");
  }
}

/** Read the whole ~/.mcode/.claude.json object. Returns {} when the file is
 *  missing or unparseable (the CLI creates/populates it on first run; a
 *  missing file simply means "no user-scope servers yet"). */
export async function readUserClaudeJson(): Promise<Record<string, unknown>> {
  const parsed = await readJson(USER_CLAUDE_JSON);
  return asRecord(parsed) ?? {};
}

/** Overwrite ~/.mcode/.claude.json. Callers must pass a value derived from
 *  readUserClaudeJson() (read-modify-write) so unknown keys survive. */
export async function writeUserClaudeJson(cfg: Record<string, unknown>): Promise<void> {
  await writeJson(USER_CLAUDE_JSON, cfg);
}

/** Validate an unknown config object against the contract schema. Returns the
 *  narrowed config, or null for anything we don't model (left untouched in
 *  the file, not listed, not toggleable). */
export function parseMcpConfig(raw: unknown): McpServerConfig | null {
  const res = McpServerConfigSchema.safeParse(raw);
  return res.success ? res.data : null;
}

/** Extract the `mcpServers` record from a config file object ({} when the
 *  key is absent or not a record). */
export function mcpServersOf(cfg: Record<string, unknown>): Record<string, unknown> {
  return asRecord(cfg.mcpServers) ?? {};
}

/** A server found in the local Claude CLI config, offered for import. */
export interface CliMcpSource {
  name: string;
  config: McpServerConfig;
  /** Global scope or the project path it was scoped to. See
   *  `McpImportOrigin` — a tag, never a display string. */
  origin: McpImportOrigin;
}

/** Scan the real Claude CLI's ~/.claude.json (read-only) for importable MCP
 *  servers: the top-level global `mcpServers` plus every
 *  `projects[path].mcpServers` entry. Same-name entries across scopes are all
 *  returned (the dialog lets the user pick); configs failing the schema are
 *  skipped. Never throws — degrades to []. */
export async function readCliMcpSources(): Promise<CliMcpSource[]> {
  const parsed = asRecord(await readJson(CLI_CLAUDE_JSON));
  if (!parsed) return [];
  const out: CliMcpSource[] = [];
  const globalServers = mcpServersOf(parsed);
  for (const [name, raw] of Object.entries(globalServers)) {
    const config = parseMcpConfig(raw);
    if (config) out.push({ name, config, origin: { kind: "global" } });
  }
  const projects = asRecord(parsed.projects);
  if (projects) {
    for (const [projectPath, rawProject] of Object.entries(projects)) {
      const projectCfg = asRecord(rawProject);
      if (!projectCfg) continue;
      for (const [name, raw] of Object.entries(mcpServersOf(projectCfg))) {
        const config = parseMcpConfig(raw);
        if (config) out.push({ name, config, origin: { kind: "project", path: projectPath } });
      }
    }
  }
  return out;
}

/** Read the persisted MCP management state (settings table). AwaitDb-guarded
 *  because the provider's startTurn also calls this outside an IPC context.
 *
 *  A row that is not valid JSON (torn write, an external tool that edited the
 *  db, an older format) degrades to "no management state" — the same contract
 *  every other reader in this module already honours (`readJson`,
 *  `readUserClaudeJson`). It used to `JSON.parse` the row bare, so one bad row
 *  threw out of `getMcpTruth()` and took `MCP_LIST` **and every turn's
 *  `materializeAllMcpViews()`** down with it. Degrading instead lets the truth
 *  migration lift `.claude.json` back up and persist it, which overwrites the
 *  unreadable row — nothing is lost, because nothing could be read from it.
 *  (The bare version also parsed the same text twice.) */
export async function getMcpManagement(): Promise<McpManagementState> {
  await awaitDb();
  const raw = SettingRepo.get(MCP_MANAGEMENT_SETTING_KEY);
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(`mcp: management state is not valid JSON, treating it as empty: ${(err as Error).message}`);
    return {};
  }
  return asRecord(parsed) ? (parsed as McpManagementState) : {};
}

/** Persist the MCP management state. */
export function saveMcpManagement(state: McpManagementState): void {
  SettingRepo.set(MCP_MANAGEMENT_SETTING_KEY, JSON.stringify(state));
}

/* ── Truth layer migration + derived views ──
 *
 * Historically the enable mechanism WAS the `.claude.json` mcpServers object
 * (the binary reads it via settingSources). With per-engine visibility that
 * file becomes a derived view ("enabled ∧ assigned to claude"), so the source
 * of truth moves into the management state's `userServers`. One idempotent
 * migration lifts the pre-existing file/stash contents up; every mutation
 * afterwards writes the truth layer and re-derives both engine views.
 */

let migrationPromise: Promise<void> | null = null;

/** Lift `.claude.json` mcpServers + the disable stash into `userServers`
 *  (once; a no-op when the truth layer already exists). Raw file entries are
 *  carried over verbatim — configs failing our schema stay in the truth layer
 *  and keep materializing, exactly their pre-migration behavior. */
async function doMcpTruthMigration(): Promise<void> {
  const state = await getMcpManagement();
  if (state.userServers) return;
  const cfg = await readUserClaudeJson();
  const fileServers = mcpServersOf(cfg);
  // File wins on a name present in both (the pre-migration list semantics).
  // Raw file entries are carried verbatim (NOT schema-narrowed): an entry we
  // can't model keeps materializing into the engine views, exactly its
  // pre-migration behavior.
  const merged = {
    ...(state.userDisabled ?? {}),
    ...fileServers,
  } as Record<string, McpServerConfig>;
  state.userServers = merged;
  saveMcpManagement(state);
  log.info(`mcp: truth layer migrated (${Object.keys(merged).length} user servers)`);
}

/** Await the (cached, idempotent) truth-layer migration. Every reader of the
 *  truth layer goes through this — a turn-time materialization must never see
 *  an unmigrated (empty) truth layer. */
export function ensureMcpTruthMigrated(): Promise<void> {
  migrationPromise ??= doMcpTruthMigration().catch((err) => {
    // Reset so a later caller can retry (e.g. db briefly unavailable at boot).
    migrationPromise = null;
    throw err;
  });
  return migrationPromise;
}

/** The management state with the truth layer guaranteed to be migrated. */
export async function getMcpTruth(): Promise<McpManagementState> {
  await ensureMcpTruthMigrated();
  return getMcpManagement();
}

/** Rewrite the claude engine's derived view: `.claude.json` mcpServers becomes
 *  exactly the enabled∧assigned subset. Read-modify-write over the whole file
 *  (the CLI keeps its own keys there — only `mcpServers` is ours to write). */
export async function materializeClaudeMcpView(): Promise<void> {
  const state = await getMcpTruth();
  const view = deriveMcpEngineView(state, readMcpEnginesMap(), "claude");
  const cfg = await readUserClaudeJson();
  cfg.mcpServers = view;
  await writeUserClaudeJson(cfg);
}

/** Re-derive both engine views: the claude config file and codex's
 *  config.toml (whose materializer reads this module's truth layer). */
export async function materializeAllMcpViews(): Promise<void> {
  await materializeClaudeMcpView();
  try {
    const { CodexModelsStore } = await import("@main/lib/codexModelsStore.js");
    await CodexModelsStore.ensureConfigMaterialized();
  } catch (err) {
    // Codex materialization is best-effort (its own body already swallows IO
    // errors); a claude-view write must not be reported as a failure because
    // codex could not follow.
    log.warn(`mcp: codex view re-materialization failed: ${(err as Error).message}`);
  }
}

/** Transport kind + secret-free one-line summary for display. Env and header
 *  values are intentionally excluded (they routinely hold tokens).
 *  Narrowing must go through the `type` discriminant — `"command" in config`
 *  is useless here because passthrough's index signature makes every key
 *  `unknown` on every union member. */
export function describeMcpConfig(config: McpServerConfig): { kind: McpKind; detail: string } {
  if (config.type === "http" || config.type === "sse") {
    return { kind: config.type, detail: config.url };
  }
  // Absent `type` = stdio (same default as the SDK).
  const parts = [config.command, ...(config.args ?? [])];
  const envCount = config.env ? Object.keys(config.env).length : 0;
  return {
    kind: "stdio",
    detail: envCount > 0 ? `${parts.join(" ")} · ${envCount} 个环境变量` : parts.join(" "),
  };
}
