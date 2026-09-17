/**
 * Per-engine visibility matrix for MCP servers — the MCP twin of
 * `skillEngines.ts`, sharing its pure core (missing = enabled, only `false`
 * keys persisted, broken file degrades to "all visible").
 *
 * Only claude/codex appear here: pi has no MCP support
 * (PiAgentSdkProvider.supportsMcp:false). The matrix file lives at
 * `~/.mcode/mcp-engines.json` (next to the skills one, but NOT inside it —
 * the skills root is handed to engines as a directory and a stray JSON file
 * there would be scanned as payload).
 *
 * The `name` keys match the panel rows exactly: user-scope server names, the
 * namespaced `<plugin>__<server>` form, and the built-in `mcode-browser`.
 *
 * Pure core (no electron) so headless smokes bundle this file directly.
 */
import path from "node:path";
import {
  engineEnabled,
  readEnginesMapFile,
  setEnginesEntry,
  writeEnginesMapFile,
  type SkillEnginesMap,
} from "./skillEngines.js";
import { MCODE_CONFIG_DIR } from "@main/providers/claude-sdk/customEnv.js";
import type { McpManagementState } from "@contracts/ipc";

/** Engines an MCP server can be assigned to. pi is absent on purpose. */
export const MCP_ENGINES = ["claude", "codex"] as const;
export type McpEngine = (typeof MCP_ENGINES)[number];

/** One server's raw matrix entry (only `false` keys persist). */
export type McpEnginesMap = SkillEnginesMap;

/** Central mapping file: `~/.mcode/mcp-engines.json`. */
export function mcpEnginesPath(): string {
  return path.join(MCODE_CONFIG_DIR, "mcp-engines.json");
}

/** Read the mapping. IO/parse problems → empty map (all servers visible). */
export function readMcpEnginesMap(): McpEnginesMap {
  return readEnginesMapFile(mcpEnginesPath());
}

/** Write the mapping (pretty-printed, atomic). */
export function writeMcpEnginesMap(map: McpEnginesMap): void {
  writeEnginesMapFile(mcpEnginesPath(), map);
}

/** Is `name` visible to `engine`? Entry/key absent → true. */
export function mcpEngineEnabled(map: McpEnginesMap, name: string, engine: McpEngine): boolean {
  return engineEnabled(map, name, engine);
}

/**
 * Set a server's visibility (the full desired {claude, codex} pair — the
 * renderer sends both). pi is pinned true: it never loads MCP servers, so a
 * `pi:false` key would be dead weight. Persists the minimal entry and returns
 * the same map.
 */
export function setMcpEnginesEntry(
  map: McpEnginesMap,
  name: string,
  wanted: Record<McpEngine, boolean>,
): McpEnginesMap {
  return setEnginesEntry(map, name, { ...wanted, pi: true });
}

/* ── Pure state transitions (shared by the IPC layer and the smokes) ──
 *
 * The management state lives behind the settings table (a db read), so the
 * handlers cannot be bundled headless. These two helpers carry ALL of the
 * toggle/derivation logic — the db-bound handlers reduce to load → call →
 * persist — which is what makes the behavior table smoke-testable. */

/** The user-scope servers `engine` may load: present in the truth layer, not
 *  switched off, and assigned to that engine. This IS the shape of each
 *  engine's derived view (claude's `.claude.json` mcpServers object; codex's
 *  config.toml MCP section before TOML formatting). Configs are carried
 *  verbatim — validation happens at display/edit time, never here, so an
 *  entry we can't model keeps materializing (its pre-matrix behavior). */
export function deriveMcpEngineView(
  state: Pick<McpManagementState, "userServers" | "userDisabled">,
  map: McpEnginesMap,
  engine: McpEngine,
): Record<string, unknown> {
  const disabled = state.userDisabled ?? {};
  const out: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(state.userServers ?? {})) {
    if (name in disabled) continue;
    if (!mcpEngineEnabled(map, name, engine)) continue;
    out[name] = config;
  }
  return out;
}

/** User-scope enable/disable over the truth layer — the pure core of
 *  MCP_TOGGLE's user branch. Enabling pulls the config back out of the
 *  disable stash; disabling parks it there. Refuses when neither layer has
 *  the name. Returns the new state; persistence is the caller's job. */
export function applyUserMcpToggle(
  state: McpManagementState,
  name: string,
  enabled: boolean,
): { ok: boolean; error?: string; state: McpManagementState } {
  const userServers = { ...(state.userServers ?? {}) };
  const stash = { ...(state.userDisabled ?? {}) };
  if (enabled) {
    const config = stash[name];
    if (!config) {
      // Enabling something already enabled (or unknown) — idempotent ok only
      // when the truth layer actually has it; otherwise refuse.
      if (!(name in userServers)) return { ok: false, error: "未找到该 server 的配置", state };
      return { ok: true, state };
    }
    userServers[name] = config;
    delete stash[name];
  } else {
    const config = userServers[name];
    if (!config) return { ok: false, error: "未找到该 server 的配置", state };
    stash[name] = config;
  }
  return { ok: true, state: { ...state, userServers, userDisabled: stash } };
}
