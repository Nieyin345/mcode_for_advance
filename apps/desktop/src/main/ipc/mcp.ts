/**
 * IPC handlers for the settings panel's MCP management section.
 *
 * Operations over the server sources (see lib/mcpConfig.ts for the storage
 * design): list (truth layer + builtin + plugins), toggle, enginesSet
 * (per-engine visibility), add, edit (replace), remove, scanImport (read
 * ~/.claude.json) and import. Mutations write the truth layer
 * (`McpManagementState.userServers`, settings table) and re-derive both
 * engine views — the claude file's `mcpServers` object and codex's
 * config.toml MCP section. 项目级 .mcp.json 来源已移除 —— settingSources 钉在
 * ["user"]，外部项目级 MCP 一律不继承。
 */
import type { IpcMain } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { loadNodePty } from "@main/terminal/TerminalManager.js";
import {
  IPC,
  McpListSchema,
  McpToggleSchema,
  McpEnginesSetSchema,
  McpSaveSchema,
  McpRemoveSchema,
  McpScanImportSchema,
  McpImportSchema,
  McpAuthorizeSchema,
  McpUnauthorizeSchema,
  McpProjectListSchema,
  McpProjectSaveSchema,
  McpProjectRemoveSchema,
  McpProjectTrustSchema,
  McpProjectCopySchema,
  McpMarketSourcesSchema,
  McpMarketSourceAddSchema,
  McpMarketSourceRemoveSchema,
  McpMarketSearchSchema,
  MCP_RESERVED_NAME,
  isReservedMcpServerName,
  type McpScope,
  type McpServerConfig,
  type McpServerEntry,
} from "@contracts/ipc";
import { log } from "@main/lib/logger.js";
import {
  copyUserServersToProject,
  listProjectMcp,
  removeProjectMcp,
  saveProjectMcp,
  trustProjectMcp,
} from "@main/lib/projectMcp.js";
import { maskMcpConfig, mergeMcpSecretEdits } from "@main/lib/mcpSecretEdit.js";
import {
  addMcpMarketSource,
  listMcpMarketSources,
  removeMcpMarketSource,
  searchMcpMarket,
} from "@main/lib/mcpMarket.js";
import { MCODE_CONFIG_DIR } from "@main/providers/claude-sdk/customEnv.js";
import { resolveSdkBinaryPath } from "@main/providers/claude-sdk/sdkBinaryPath.js";
import {
  listPluginMcpPanelEntries,
  getPluginMcpServerConfig,
  getPluginMcpServers,
  setPluginMcpDisabled,
} from "@main/plugins/pluginManager.js";
import {
  readUserClaudeJson,
  writeUserClaudeJson,
  mcpServersOf,
  parseMcpConfig,
  readCliMcpSources,
  getMcpTruth,
  ensureMcpTruthMigrated,
  saveMcpManagement,
  materializeAllMcpViews,
  describeMcpConfig,
} from "@main/lib/mcpConfig.js";
import {
  applyUserMcpToggle,
  readMcpEnginesMap,
  writeMcpEnginesMap,
  setMcpEnginesEntry,
  mcpEngineEnabled,
} from "@main/lib/mcpEngines.js";

/** Description line for the built-in browser server row. */
const BUILTIN_DETAIL = "browser_navigate / browser_snapshot / browser_click 等应用内浏览器工具";

/* ── OAuth needs-auth state ──
 * The CLI records remote servers that demanded OAuth but hold no stored
 * token in `<CLAUDE_CONFIG_DIR>/mcp-needs-auth-cache.json`
 * (`{ "<namespaced server name>": { timestamp } }`). Until the user completes
 * the browser login, the server's tools never reach the model — surfaced in
 * the panel as a badge + an authorize action. */

const NEEDS_AUTH_CACHE_FILE = path.join(MCODE_CONFIG_DIR, "mcp-needs-auth-cache.json");

// Every MCP mutation is a read-modify-write over shared management/config
// files. Electron may run different IPC handlers concurrently while one is
// awaiting migration or materialization; serialize them so two row actions do
// not lose each other's updates. OAuth flows join the same queue because they
// temporarily register a server in .claude.json and restore it afterwards.
let mcpMutationTail: Promise<void> = Promise.resolve();

function serializeMcpMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = mcpMutationTail.then(operation, operation);
  mcpMutationTail = run.then(() => undefined, () => undefined);
  return run;
}

/** A truth/matrix mutation is not complete until the engine views agree with
 * it. If the required Claude view write fails, restore the previous source of
 * truth and make a best-effort attempt to put both views back as well. */
async function materializeMcpViewsOrRollback(rollback: () => void | Promise<void>): Promise<void> {
  try {
    await materializeAllMcpViews();
  } catch (err) {
    try {
      await rollback();
      await materializeAllMcpViews();
    } catch (rollbackErr) {
      log.error(`mcp: rollback materialization failed: ${(rollbackErr as Error).message}`);
    }
    throw err;
  }
}

function readNeedsAuthNames(): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(NEEDS_AUTH_CACHE_FILE, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Set();
    return new Set(Object.keys(raw as Record<string, unknown>));
  } catch {
    return new Set();
  }
}

function forgetNeedsAuth(name: string): void {
  try {
    if (!existsSync(NEEDS_AUTH_CACHE_FILE)) return;
    const raw = JSON.parse(readFileSync(NEEDS_AUTH_CACHE_FILE, "utf-8")) as Record<string, unknown>;
    if (!(name in raw)) return;
    delete raw[name];
    // Rewrite via the JSON round-trip — tiny file, atomicity is not critical
    // (a torn write just loses the flag; the CLI re-adds it on the next 401).
    writeFileSync(NEEDS_AUTH_CACHE_FILE, JSON.stringify(raw), "utf-8");
  } catch {
    /* best-effort badge cleanup */
  }
}

/** Re-add `name` to the CLI's needs-auth cache (best-effort mirror of what
 *  the CLI does on a 401). After a sign-out the server DOES require OAuth
 *  again — without this the panel badge would stay dark until the next turn
 *  happens to hit the unauthorized request. */
function markNeedsAuth(name: string): void {
  try {
    const raw = existsSync(NEEDS_AUTH_CACHE_FILE)
      ? (JSON.parse(readFileSync(NEEDS_AUTH_CACHE_FILE, "utf-8")) as Record<string, unknown>)
      : {};
    raw[name] = { timestamp: Date.now() };
    writeFileSync(NEEDS_AUTH_CACHE_FILE, JSON.stringify(raw), "utf-8");
  } catch {
    /* best-effort badge update */
  }
}

/* ── Stored OAuth credentials ──
 * The CLI keeps `{ mcpOAuth: { "<name>|<hash>": { serverName, accessToken, … } } }`
 * either in `<CLAUDE_CONFIG_DIR>/.credentials.json` (win/linux) or in the macOS
 * Keychain (darwin), and reads the Keychain by shelling out to `security` with
 * a service name derived from the config dir. Mcode reads it the same way — the
 * secret never leaves the Keychain and is never copied into Mcode's own state.
 *
 * The entry key is `sha256(stringify({ type, url, headers }))[:16]`, i.e. the
 * credential identity is the server NAME plus url AND headers. That is why
 * login/logout must re-register the server's real config verbatim (see
 * resolveRemoteServerConfig) — a header-stripped registration stores the token
 * under a key the per-turn server never looks up. */

/** Darwin Keychain service holding the CLI's credentials:
 *  `Claude Code-credentials-<sha256(configDir)[:8]>` (no hash suffix when the
 *  CLI runs without CLAUDE_CONFIG_DIR, which never applies here — Mcode always
 *  passes its own dir). Verified against the CLI's own derivation. */
function darwinCredentialsService(): string {
  const suffix = createHash("sha256").update(MCODE_CONFIG_DIR.normalize("NFC")).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}

/** Generous relative to the CLI's own 2s Keychain read timeout; a slow read
 *  degrades to "unreadable" rather than blocking the main process further. */
const KEYCHAIN_READ_TIMEOUT_MS = 2500;

/** The raw credential blob. `readable:false` means the store exists but could
 *  not be inspected (Keychain ACL prompt, timeout, corrupt JSON) — callers must
 *  read that as "unknown", never as "no token", or a successful login would be
 *  reported as a failure. */
function readCredentialsBlob(): { readable: boolean; text: string | null } {
  if (process.platform !== "darwin") {
    const file = path.join(MCODE_CONFIG_DIR, ".credentials.json");
    // Known location with nothing in it yet — readable, no tokens.
    if (!existsSync(file)) return { readable: true, text: null };
    try {
      return { readable: true, text: readFileSync(file, "utf-8") };
    } catch {
      return { readable: false, text: null };
    }
  }
  const account = process.env.USER || userInfo().username || "claude-code-user";
  const res = spawnSync(
    "security",
    ["find-generic-password", "-a", account, "-w", "-s", darwinCredentialsService()],
    { encoding: "utf-8", timeout: KEYCHAIN_READ_TIMEOUT_MS },
  );
  if (res.error) return { readable: false, text: null };
  if (res.status !== 0) {
    const stderr = String(res.stderr ?? "");
    // "The specified item could not be found in the keychain." = no creds yet;
    // anything else (denied, locked) leaves the state unknown.
    return /could not be found/i.test(stderr)
      ? { readable: true, text: null }
      : { readable: false, text: null };
  }
  return { readable: true, text: res.stdout?.trim() || null };
}

/** Server names holding a stored OAuth token (non-empty accessToken). */
function readStoredCredentials(): { names: Set<string>; readable: boolean } {
  const { readable, text } = readCredentialsBlob();
  const names = new Set<string>();
  if (text === null) return { names, readable };
  try {
    const raw = JSON.parse(text) as {
      mcpOAuth?: Record<string, { serverName?: string; accessToken?: string }>;
    };
    for (const entry of Object.values(raw.mcpOAuth ?? {})) {
      if (entry.serverName && typeof entry.accessToken === "string" && entry.accessToken.length > 0) {
        names.add(entry.serverName);
      }
    }
    return { names, readable: true };
  } catch {
    /* unparseable blob — unknown, not "no token" */
    return { names, readable: false };
  }
}

/** The config the CLI loads for a remote server, matched by the OAuth
 *  credential identity it hashes (name + `{type, url, headers}`). `claude mcp
 *  login`/`logout` resolve the server from the config file, so the temporary
 *  registration MUST reproduce the runtime's own config — headers included.
 *  Registering a stripped `{type, url}` stores the token under a different key
 *  than the per-turn server looks up, leaving the server unauthenticated (401
 *  every turn) while the credential store holds a perfectly good token. */
async function resolveRemoteServerConfig(
  name: string,
  fallback: { kind: "http" | "sse"; url: string },
  scope?: McpScope,
): Promise<{ type: "http" | "sse"; url: string; headers?: Record<string, string> }> {
  type Remote = { type: "http" | "sse"; url: string; headers?: Record<string, string> };
  const asRemote = (raw: unknown): Remote | null => {
    const config = parseMcpConfig(raw);
    if (!config || (config.type !== "http" && config.type !== "sse")) return null;
    return { type: config.type, url: config.url, ...(config.headers ? { headers: config.headers } : {}) };
  };

  // User scope: the truth layer (every user-scope config, enabled or not),
  // then the derived claude view, then the disable stash (legacy leftovers).
  const fromTruth = async () => asRemote((await getMcpTruth()).userServers?.[name]);
  const fromUserFile = async () => asRemote(mcpServersOf(await readUserClaudeJson())[name]);
  const fromStash = async () => asRemote((await getMcpTruth()).userDisabled?.[name]);
  // Plugin scope: `<plugin>__<server>`, including servers on the per-server
  // disable list (the panel keeps showing their OAuth row).
  const fromPlugin = async () => asRemote(await getPluginMcpServerConfig(name));

  // The clicked row's own source wins; the rest follow in a fixed order. Names
  // are only unique within a source, and a wrong pick silently misfiles the
  // token, so try the row's own scope first.
  const loaders: Array<() => Promise<Remote | null>> = [];
  if (scope === "user") loaders.push(fromTruth, fromStash);
  if (scope === "plugin") loaders.push(fromPlugin);
  loaders.push(fromTruth, fromUserFile, fromStash, fromPlugin);

  const tried = new Set<() => Promise<Remote | null>>();
  for (const load of loaders) {
    if (tried.has(load)) continue;
    tried.add(load);
    const found = await load();
    if (found) return found;
  }

  // Unknown server (external edit, renamed project): the caller's url/kind is
  // all we have. Crude, but no worse than the pre-existing behavior.
  return { type: fallback.kind, url: fallback.url };
}

/* ── Proactive OAuth detection ──
 * A remote server that demands OAuth only tells the CLI so when a turn actually
 * connects (401 → needs-auth cache → the panel's badge, one turn too late and
 * only if the model happened to use that server). A streamable-HTTP MCP
 * endpoint instead answers an UNAUTHENTICATED `initialize` with 401/403 plus
 * `WWW-Authenticate: Bearer …` (MCP authorization spec), so a cheap probe can
 * front-run the first 401 and show the 去授权 entry up front. Only that precise
 * signal counts — any other response, or a network failure, yields no verdict
 * rather than a guessed badge. */

const AUTH_PROBE_TIMEOUT_MS = 5_000;
/** Probes answer in a few hundred ms; a server that needs OAuth now will still
 *  need it later, so verdicts are reused instead of re-requested on every load. */
const AUTH_PROBE_TTL_MS = 5 * 60_000;
/** How long a listing waits for verdicts before returning what it already
 *  knows. Slower probes still fill the cache for the next load — the panel must
 *  never hang on an unresponsive server. */
const AUTH_PROBE_BUDGET_MS = 2_500;

const authProbeCache = new Map<string, { requiresAuth: boolean; at: number }>();

/** Cache key: the server's credential identity minus the headers hash (a URL
 *  change invalidates, which is what matters). */
function authProbeKey(name: string, url: string): string {
  return `${name}|${url}`;
}

/** Probe one server. `null` = no verdict (unreachable, timed out, or a reply
 *  that says nothing about OAuth). The server's own configured headers ride
 *  along, so a server carrying a static credential in a header answers
 *  normally and is correctly NOT reported as needing OAuth. */
async function probeRequiresAuth(config: {
  url: string;
  headers?: Record<string, string>;
}): Promise<boolean | null> {
  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(config.headers ?? {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mcode", version: "1.0" },
        },
      }),
      signal: AbortSignal.timeout(AUTH_PROBE_TIMEOUT_MS),
    });
    try {
      // Status carries the answer; don't buffer the body.
      await res.body?.cancel();
    } catch {
      /* body already consumed/closed */
    }
    if (res.status !== 401 && res.status !== 403) return false;
    return /^bearer\b/i.test(res.headers.get("www-authenticate") ?? "");
  } catch {
    return null;
  }
}

/** Run `probeRequiresAuth` for every entry, populating the cache. Awaits at
 *  most AUTH_PROBE_BUDGET_MS: late answers keep running (fire-and-forget) so
 *  the next listing picks them up, but the current one is never held up. */
async function probeAll(entries: Array<{ key: string; config: { url: string; headers?: Record<string, string> } }>): Promise<void> {
  if (entries.length === 0) return;
  const work = entries.map(async ({ key, config }) => {
    const requiresAuth = await probeRequiresAuth(config);
    if (requiresAuth !== null) authProbeCache.set(key, { requiresAuth, at: Date.now() });
  });
  await Promise.race([
    Promise.all(work),
    new Promise<void>((resolve) => setTimeout(resolve, AUTH_PROBE_BUDGET_MS)),
  ]);
  // A rejection here would be an unhandled-rejection crash later on; the
  // helpers already swallow their own errors, this is belt-and-suspenders.
  void Promise.allSettled(work);
}

interface CapturedRun {
  ok: boolean;
  /** Trailing combined output (ANSI stripped) — user-presentable error
   *  context. */
  message: string;
  /** True when the process never launched (bad path), as opposed to
   *  launching and exiting non-zero. */
  spawnFailed: boolean;
}

const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][^\x07]*(?:\x07|\x1B\\)/g;

/** Run a short-lived CLI process inside a pseudo-TTY, capturing trailing
 *  output. Used by the OAuth login flow: `claude mcp login` REFUSES to
 *  authenticate when stdin isn't a terminal (probed live), so a plain spawn
 *  is a dead end — a PTY satisfies the check and the CLI opens the system
 *  browser itself; the localhost callback completes the flow. */
function runCaptured(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CapturedRun> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (r: CapturedRun) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    let pty: import("node-pty").IPty;
    try {
      pty = loadNodePty().spawn(cmd, args, {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: MCODE_CONFIG_DIR,
        // node-pty's env type wants strings; drop undefined values.
        env: Object.fromEntries(
          Object.entries(opts.env ?? process.env).filter(([, v]) => v !== undefined),
        ) as Record<string, string>,
      });
    } catch (err) {
      finish({ ok: false, message: (err as Error).message, spawnFailed: true });
      return;
    }
    let tail = "";
    pty.onData((d) => {
      tail = (tail + d).slice(-2000);
    });
    pty.onExit(({ exitCode }) =>
      finish(
        exitCode === 0
          ? { ok: true, message: "", spawnFailed: false }
          : {
              ok: false,
              message: `退出码 ${exitCode}:${tail.replace(ANSI_RE, "").trim().slice(-400) || "(无输出)"}`,
              spawnFailed: false,
            },
      ),
    );
    // Defensive nudge: some CLI auth flows sit behind an "Press Enter …"
    // prompt; a lone Enter is a no-op when there isn't one.
    setTimeout(() => {
      try {
        pty.write("\r");
      } catch {
        /* process may have exited already */
      }
    }, 2_000);
    timer = setTimeout(() => {
      try {
        pty.kill();
      } catch {
        /* already gone */
      }
      finish({
        ok: false,
        message: `授权超时(${Math.round(opts.timeoutMs / 1000)}s):请确认已在浏览器中完成登录`,
        spawnFailed: false,
      });
    }, opts.timeoutMs);
  });
}

export function registerMcpHandlers(ipcMain: IpcMain): void {
  // ── List servers across all sources ──
  ipcMain.handle(IPC.MCP_LIST, async (_evt, raw) => {
    McpListSchema.parse(raw);
    const state = await getMcpTruth();
    const servers: McpServerEntry[] = [];

    // Remote rows carry their parsed config alongside, so the OAuth pass below
    // probes exactly the config the runtime injects. Keyed by scope + name: the
    // same name can legitimately exist in two scopes with different URLs.
    const remoteConfigs = new Map<string, { type: "http" | "sse"; url: string; headers?: Record<string, string> }>();
    const rowKey = (scope: McpScope, name: string): string => `${scope}:${name}`;
    const rememberRemote = (scope: McpScope, name: string, config: McpServerConfig): void => {
      if (config.type !== "http" && config.type !== "sse") return;
      remoteConfigs.set(rowKey(scope, name), {
        type: config.type,
        url: config.url,
        ...(config.headers ? { headers: config.headers } : {}),
      });
    };

    // User scope: rows come from the truth layer (`userServers`), enabled =
    // not on the disable stash. Each row carries its full config so the
    // panel's edit dialog can prefill, and its per-engine visibility from the
    // mcp-engines matrix. Configs failing our schema stay unlisted (their
    // pre-migration behavior) but keep materializing into the engine views.
    const enginesMap = readMcpEnginesMap();
    const truthServers = state.userServers ?? {};
    const disabled = state.userDisabled ?? {};
    for (const [name, rawConfig] of Object.entries(truthServers)) {
      const config = parseMcpConfig(rawConfig);
      if (!config) continue;
      const { kind, detail } = describeMcpConfig(config);
      rememberRemote("user", name, config);
      servers.push({
        name,
        scope: "user",
        kind,
        detail,
        enabled: !(name in disabled),
        config: maskMcpConfig(config),
        perEngine: {
          claude: mcpEngineEnabled(enginesMap, name, "claude"),
          codex: mcpEngineEnabled(enginesMap, name, "codex"),
        },
      });
    }

    // Plugin-contributed servers: entries of ENABLED plugins, namespaced
    // "<plugin>__<server>". The per-server toggle flips the denylist in the
    // plugins settings; the plugin's own enable switch is the master gate.
    // One scan for every plugin server's config (the per-row lookup would
    // re-walk the plugin tree once per row). Visibility switches ride the
    // same matrix — plugin rows stay read-only apart from them.
    const pluginConfigs = new Map(await getPluginMcpServers());
    for (const entry of await listPluginMcpPanelEntries()) {
      // pluginManager's row type predates perEngine — spread into the full
      // contract shape so the visibility chips can ride the same code path as
      // user-scope rows.
      servers.push({
        ...entry,
        perEngine: {
          claude: mcpEngineEnabled(enginesMap, entry.name, "claude"),
          codex: mcpEngineEnabled(enginesMap, entry.name, "codex"),
        },
      });
      const config = pluginConfigs.get(entry.name);
      if (config) rememberRemote("plugin", entry.name, config);
    }

    // Built-in in-process browser server.
    servers.push({
      name: MCP_RESERVED_NAME,
      scope: "builtin",
      kind: "builtin",
      detail: BUILTIN_DETAIL,
      enabled: !state.browserDisabled,
      // This in-process MCP transport is mounted by Claude only. Codex cannot
      // connect to it; Pi exposes equivalent browser tools outside MCP.
      perEngine: { claude: true, codex: false },
    });

    // Remote servers' OAuth state. The CLI's needs-auth flag is a live signal
    // (written on an actual 401 while connecting), so it BEATS a stored token:
    // a token can sit under a credential key the runtime never looks up, or be
    // expired/revoked. Reporting 已授权 in that state would hide a server that
    // cannot authenticate.
    const needsAuth = readNeedsAuthNames();
    const stored = readStoredCredentials();
    const probes: Array<{ key: string; config: { url: string; headers?: Record<string, string> } }> = [];
    for (const s of servers) {
      if (s.kind !== "http" && s.kind !== "sse") continue;
      if (needsAuth.has(s.name)) {
        s.needsAuth = true;
        continue;
      }
      if (stored.names.has(s.name)) {
        s.authorized = true;
        continue;
      }
      // Nothing on record: ask the server itself, so a server that needs OAuth
      // shows its 去授权 entry before the first turn stumbles into the 401.
      // Only enabled rows are probed — a switched-off server is not injected
      // into any turn, so there is no state to front-run and no reason to send
      // it a request the user did not ask for.
      const config = remoteConfigs.get(rowKey(s.scope, s.name));
      if (!s.enabled || !config) continue;
      const key = authProbeKey(s.name, config.url);
      const cached = authProbeCache.get(key);
      if (cached && Date.now() - cached.at < AUTH_PROBE_TTL_MS) {
        if (cached.requiresAuth) s.needsAuth = true;
        continue;
      }
      probes.push({ key, config });
    }
    await probeAll(probes);
    for (const s of servers) {
      // 第一遍只探**已启用**的行(理由见上);这一遍回填也得按同一条判 —— 否则一个
      // 曾经启用过、缓存里留着 requiresAuth 的 server,被停用之后仍会顶着「待授权」
      // 徽章(OBS-M14-02)。停用的行不注入任何回合,没有“待授权”可言。
      if (!s.enabled || s.needsAuth || s.authorized) continue;
      const config = remoteConfigs.get(rowKey(s.scope, s.name));
      if (config && authProbeCache.get(authProbeKey(s.name, config.url))?.requiresAuth) s.needsAuth = true;
    }

    servers.sort((a, b) =>
      a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === "user" ? -1 : b.scope === "user" ? 1 : a.scope === "plugin" ? -1 : 1,
    );
    return { servers };
  });

  // ── Toggle a server (scope-specific semantics) ──
  ipcMain.handle(IPC.MCP_TOGGLE, (_evt, raw) => serializeMcpMutation(async () => {
    const input = McpToggleSchema.parse(raw);
    try {
      if (input.scope === "builtin") {
        const state = await getMcpTruth();
        state.browserDisabled = !input.enabled;
        saveMcpManagement(state);
        return { ok: true };
      }

      if (input.scope === "plugin") {
        // Plugin-contributed server: flip its entry on the plugins.mcpDisabled
        // denylist. The config itself lives in the plugin tree and is never
        // rewritten here; the codex view re-derives from the denylist.
        const res = setPluginMcpDisabled(input.name, !input.enabled);
        if (!res.ok) return res;
        await materializeMcpViewsOrRollback(() => {
          setPluginMcpDisabled(input.name, res.previousDisabled === true);
        });
        return { ok: true };
      }

      // User scope: flip the name between the truth layer and the disable
      // stash (applyUserMcpToggle carries the behavior), then re-derive both
      // engine views (the claude file is a derived view now — it is never
      // edited in place).
      const state = await getMcpTruth();
      const previous = structuredClone(state);
      const applied = applyUserMcpToggle(state, input.name, input.enabled);
      if (!applied.ok) return { ok: false, error: applied.error };
      saveMcpManagement(applied.state);
      await materializeMcpViewsOrRollback(() => saveMcpManagement(previous));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }));

  // ── Set a server's per-engine visibility (claude / codex) ──
  // pi has no MCP support, so there is no third switch. Both engine views
  // re-derive after the write; each engine picks the change up on its next
  // turn (the claude binary reads the file at turn start, codex reads
  // config.toml when its app-server spawns).
  ipcMain.handle(IPC.MCP_ENGINES_SET, (_evt, raw) => serializeMcpMutation(async () => {
    const input = McpEnginesSetSchema.parse(raw);
    try {
      const map = readMcpEnginesMap();
      const previous = structuredClone(map);
      setMcpEnginesEntry(map, input.name, { claude: input.claude, codex: input.codex });
      writeMcpEnginesMap(map);
      await materializeMcpViewsOrRollback(() => writeMcpEnginesMap(previous));
      const updated = readMcpEnginesMap();
      return {
        ok: true,
        perEngine: {
          claude: mcpEngineEnabled(updated, input.name, "claude"),
          codex: mcpEngineEnabled(updated, input.name, "codex"),
        },
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }));

  // ── OAuth authorize a remote server (browser login via the Claude CLI) ──
  ipcMain.handle(IPC.MCP_AUTHORIZE, (_evt, raw) => serializeMcpMutation(async () => {
    const input = McpAuthorizeSchema.parse(raw);
    // Spawn-safe guards: the name lands in argv and as a config key, the URL
    // in argv (a cmd /c fallback re-quotes them) — keep both to a
    // conservative charset.
    if (!/^[A-Za-z0-9_-]+$/.test(input.name)) return { ok: false, error: "非法 server 名" };
    if (!/^https?:\/\/[^\s"'`<>^|]*$/.test(input.url)) {
      return { ok: false, error: "仅支持 http(s) 地址" };
    }
    const claudeBin = resolveSdkBinaryPath();
    if (!claudeBin) {
      return { ok: false, error: "未找到 Claude CLI 运行时:请到「设置 → Agent」安装后再试。" };
    }

    const cfg = await readUserClaudeJson();
    const fileServers = mcpServersOf(cfg);
    const existed = fileServers[input.name];
    const target = await resolveRemoteServerConfig(input.name, { kind: input.kind, url: input.url }, input.scope);
    try {
      // `claude mcp login` resolves the server from the config file, so
      // register it (user scope, exactly the namespaced name + url + headers
      // the runtime injects per-turn — the CLI keys OAuth tokens by all three)
      // for the duration of the flow. The finally-block restores what was
      // there.
      fileServers[input.name] = target;
      cfg.mcpServers = fileServers;
      await writeUserClaudeJson(cfg);

      const env = { ...process.env, CLAUDE_CONFIG_DIR: MCODE_CONFIG_DIR };
      const res = await runCaptured(claudeBin, ["mcp", "login", input.name], { env, timeoutMs: 300_000 });
      if (!res.ok) {
        return { ok: false, error: res.message || "claude mcp login 失败" };
      }
      // Exit code 0 alone isn't trustworthy (the CLI prints some failures
      // while exiting 0), so where the credential store is readable require a
      // token for this server. Unreadable (Keychain denied on darwin) means
      // unknown — trust the CLI rather than block a login that worked.
      const stored = readStoredCredentials();
      if (stored.readable && !stored.names.has(input.name)) {
        return { ok: false, error: res.message || "CLI 报告成功,但未找到已存储的授权令牌" };
      }
      // Success: clear the stale flag so the panel badge goes away now (the
      // CLI re-adds it if the token ever expires and a 401 recurs), and drop
      // the cached probe verdict so the next listing re-derives it.
      forgetNeedsAuth(input.name);
      authProbeCache.delete(authProbeKey(input.name, target.url));
      return { ok: true };
    } finally {
      try {
        const restore = await readUserClaudeJson();
        const servers = mcpServersOf(restore);
        if (existed) servers[input.name] = existed;
        else delete servers[input.name];
        restore.mcpServers = servers;
        await writeUserClaudeJson(restore);
      } catch {
        /* best-effort config restore */
      }
    }
  }));

  // ── OAuth sign-out: clear a remote server's stored token ──
  ipcMain.handle(IPC.MCP_UNAUTHORIZE, (_evt, raw) => serializeMcpMutation(async () => {
    const input = McpUnauthorizeSchema.parse(raw);
    // Same spawn-safe guards as authorize.
    if (!/^[A-Za-z0-9_-]+$/.test(input.name)) return { ok: false, error: "非法 server 名" };
    if (!/^https?:\/\/[^\s"'`<>^|]*$/.test(input.url)) {
      return { ok: false, error: "仅支持 http(s) 地址" };
    }
    // Nothing to clear — but only where the credential store is readable
    // (darwin's Keychain can deny a read; unknown must not block the CLI).
    const before = readStoredCredentials();
    if (before.readable && !before.names.has(input.name)) {
      return { ok: false, error: "该 server 没有已存储的授权" };
    }
    const claudeBin = resolveSdkBinaryPath();
    if (!claudeBin) {
      return { ok: false, error: "未找到 Claude CLI 运行时:请到「设置 → Agent」安装后再试。" };
    }

    const cfg = await readUserClaudeJson();
    const fileServers = mcpServersOf(cfg);
    const existed = fileServers[input.name];
    const target = await resolveRemoteServerConfig(input.name, { kind: input.kind, url: input.url }, input.scope);
    try {
      // `claude mcp logout` also resolves the server from the config file —
      // same temporary registration (name + url + headers, the credential
      // identity the CLI hashes) + restore as the login flow.
      fileServers[input.name] = target;
      cfg.mcpServers = fileServers;
      await writeUserClaudeJson(cfg);

      const env = { ...process.env, CLAUDE_CONFIG_DIR: MCODE_CONFIG_DIR };
      const res = await runCaptured(claudeBin, ["mcp", "logout", input.name], { env, timeoutMs: 60_000 });
      if (!res.ok) return { ok: false, error: res.message || "claude mcp logout 失败" };
      // A token still filed under this name is reported, not fatal: it can be a
      // legacy entry left under a credential key this server no longer uses
      // (see resolveRemoteServerConfig), which the CLI legitimately does not
      // touch. Failing here would leave the panel stuck on 已授权 after a
      // logout that did work; markNeedsAuth below makes it truthful either way.
      const after = readStoredCredentials();
      if (after.readable && after.names.has(input.name)) {
        log.warn(`mcp logout: ${input.name} still has a stored token after a successful CLI logout`);
      }
      // The server does require OAuth (it had a token) — flip the panel to
      // 待授权 immediately instead of waiting for the next 401 to re-add it.
      markNeedsAuth(input.name);
      return { ok: true };
    } finally {
      try {
        const restore = await readUserClaudeJson();
        const servers = mcpServersOf(restore);
        if (existed) servers[input.name] = existed;
        else delete servers[input.name];
        restore.mcpServers = servers;
        await writeUserClaudeJson(restore);
      } catch {
        /* best-effort config restore */
      }
    }
  }));

  // ── Add a user-scope server (or overwrite when input.replace is set) ──
  ipcMain.handle(IPC.MCP_SAVE, (_evt, raw) => serializeMcpMutation(async () => {
    const input = McpSaveSchema.parse(raw);
    // 保留名:整段 `mcode-`/`mcode_` 前缀都是内置身份,不能注册成用户 server
    // (见 isReservedMcpServerName)。项目级 .mcp.json 一直这么挡,这里与它对齐。
    if (isReservedMcpServerName(input.name)) {
      return { ok: false, error: `「${input.name}」是 Mcode 内置服务器的保留名(mcode- 开头)` };
    }
    try {
      const state = await getMcpTruth();
      const previous = structuredClone(state);
      const userServers = state.userServers ?? {};
      const inTruth = input.name in userServers;
      const inStash = Boolean(state.userDisabled?.[input.name]);
      if (!input.replace && (inTruth || inStash)) {
        return { ok: false, error: "同名 server 已存在" };
      }
      const oldConfig = userServers[input.name] ?? state.userDisabled?.[input.name];
      userServers[input.name] = input.replace && oldConfig
        ? mergeMcpSecretEdits(oldConfig, input.config)
        : input.config;
      // Edit on a disabled server re-enables it: the config lives in the truth
      // layer either way, so clear any stash copy to keep the two in sync.
      if (inStash && state.userDisabled) {
        delete state.userDisabled[input.name];
      }
      state.userServers = userServers;
      saveMcpManagement(state);
      await materializeMcpViewsOrRollback(() => saveMcpManagement(previous));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }));

  // ── Remove a user-scope server (truth layer + stash) ──
  ipcMain.handle(IPC.MCP_REMOVE, (_evt, raw) => serializeMcpMutation(async () => {
    const input = McpRemoveSchema.parse(raw);
    try {
      const state = await getMcpTruth();
      const previous = structuredClone(state);
      const userServers = state.userServers ?? {};
      const stash = state.userDisabled ?? {};
      const inTruth = input.name in userServers;
      const inStash = input.name in stash;
      if (!inTruth && !inStash) return { ok: false, error: "未找到该 server" };
      if (inTruth) delete userServers[input.name];
      if (inStash) delete stash[input.name];
      state.userServers = userServers;
      state.userDisabled = stash;
      saveMcpManagement(state);
      await materializeMcpViewsOrRollback(() => saveMcpManagement(previous));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }));

  // ── Scan the local Claude CLI config for importable servers ──
  ipcMain.handle(IPC.MCP_SCAN_IMPORT, async (_evt, raw) => {
    McpScanImportSchema.parse(raw);
    const sources = (await readCliMcpSources()).map((s) => ({
      name: s.name,
      origin: s.origin,
      ...describeMcpConfig(s.config),
    }));
    return { sources };
  });

  // ── Import selected servers into the user scope ──
  ipcMain.handle(IPC.MCP_IMPORT, (_evt, raw) => serializeMcpMutation(async () => {
    const input = McpImportSchema.parse(raw);
    const imported: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];
    try {
      const state = await getMcpTruth();
      const previous = structuredClone(state);
      const userServers = state.userServers ?? {};
      const stash = state.userDisabled ?? {};
      let changed = false;
      // Resolve on the trusted main side: scan results never return tokens to
      // the renderer, so it cannot echo secrets back as import payloads.
      const available = await readCliMcpSources();
      for (const item of input.servers) {
        // 保留名直接拒 —— 导入路径过去完全没挡,用户能塞进一个 mcode-app 之类的伪造内置身份。
        if (isReservedMcpServerName(item.name)) {
          errors.push({ name: item.name, error: "mcode- 开头是 Mcode 内置服务器的保留名" });
          continue;
        }
        if (item.name in userServers || item.name in stash) {
          skipped.push(item.name);
          continue;
        }
        const source = "origin" in item ? available.find((s) => s.name === item.name &&
          JSON.stringify(s.origin) === JSON.stringify(item.origin)) : undefined;
        const config = "config" in item ? item.config : source?.config;
        if (!config) {
          errors.push({ name: item.name, error: "导入来源已变更，请重新扫描" });
          continue;
        }
        userServers[item.name] = config;
        imported.push(item.name);
        changed = true;
      }
      if (changed) {
        state.userServers = userServers;
        saveMcpManagement(state);
        await materializeMcpViewsOrRollback(() => saveMcpManagement(previous));
      }
      return { imported, skipped, errors };
    } catch (err) {
      imported.length = 0;
      return {
        imported,
        skipped,
        errors: [...errors, { name: "(批量写入)", error: (err as Error).message }],
      };
    }
  }));

  // ── Project scope: <project>/.mcp.json (see lib/projectMcp.ts) ──
  // Plain project-file edits: no engine view to re-materialize (each engine
  // reads the file at its next turn start), so no serializeMcpMutation needed
  // beyond keeping writes ordered.
  ipcMain.handle(IPC.MCP_PROJECT_LIST, (_evt, raw) => {
    const input = McpProjectListSchema.parse(raw);
    return listProjectMcp(input.projectPath);
  });

  ipcMain.handle(IPC.MCP_PROJECT_SAVE, (_evt, raw) => serializeMcpMutation(async () => {
    const input = McpProjectSaveSchema.parse(raw);
    try {
      return await saveProjectMcp(input.projectPath, input.name, input.config, input.replace === true);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }));

  ipcMain.handle(IPC.MCP_PROJECT_REMOVE, (_evt, raw) => serializeMcpMutation(async () => {
    const input = McpProjectRemoveSchema.parse(raw);
    try {
      return await removeProjectMcp(input.projectPath, input.name);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }));

  ipcMain.handle(IPC.MCP_PROJECT_TRUST, (_evt, raw) => serializeMcpMutation(async () => {
    const input = McpProjectTrustSchema.parse(raw);
    try {
      return trustProjectMcp(input.projectPath, input.name, input.trusted);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }));

  ipcMain.handle(IPC.MCP_PROJECT_COPY, (_evt, raw) => serializeMcpMutation(async () => {
    const input = McpProjectCopySchema.parse(raw);
    try {
      // Truth layer (enabled + stashed) holds the real values — the renderer
      // only ever sees masked configs, so the copy must resolve them here.
      const state = await getMcpTruth();
      const configs: Record<string, McpServerConfig> = { ...(state.userDisabled ?? {}), ...(state.userServers ?? {}) };
      return await copyUserServersToProject(input.projectPath, input.names, configs);
    } catch (err) {
      return { copied: [], skipped: [], failed: input.names.map((name) => ({ name, reason: (err as Error).message })) };
    }
  }));

  // ── MCP market (「市场」tab): registry API sources, see lib/mcpMarket.ts.
  // Read-only towards the config — installing goes through MCP_SAVE.
  ipcMain.handle(IPC.MCP_MARKET_SOURCES, (_evt, raw) => {
    McpMarketSourcesSchema.parse(raw ?? {});
    return { sources: listMcpMarketSources() };
  });
  ipcMain.handle(IPC.MCP_MARKET_SOURCE_ADD, (_evt, raw) => addMcpMarketSource(McpMarketSourceAddSchema.parse(raw)));
  ipcMain.handle(IPC.MCP_MARKET_SOURCE_REMOVE, (_evt, raw) => removeMcpMarketSource(McpMarketSourceRemoveSchema.parse(raw).id));
  ipcMain.handle(IPC.MCP_MARKET_SEARCH, (_evt, raw) => searchMcpMarket(McpMarketSearchSchema.parse(raw)));

  // Warm the truth-layer migration so the first panel open / codex turn never
  // pays for it (idempotent; also pins the derived views at boot).
  void serializeMcpMutation(async () => {
    await ensureMcpTruthMigrated();
    await materializeAllMcpViews();
  })
    .catch((err) => log.warn(`mcp: boot migration failed: ${(err as Error).message}`));
}
