import { cloneMarketRepository, promoteMarketCatalog, type MarketProgressSink } from "@main/lib/marketClone.js";
/**
 * Plugin lifecycle manager (docs/plugin-feasibility.md §3/v1).
 *
 * Owns `~/.mcode/plugins/`:
 *
 *   plugins/<name>/<version>/          installed plugin payloads (v1 keeps a
 *                                      single version per name — reinstalling
 *                                      prunes the old tree)
 *   plugins/marketplaces/<name>/       cloned/copied marketplace trees
 *   plugins/.staging-<ts>-<rand>/      transient install scratch (removed on
 *                                      success AND failure)
 *
 * Lifecycle rules:
 *   - Installs land DISABLED. The renderer's component-review dialog then
 *     calls setEnabled — the "review before activation" gate lives in the UI,
 *     the state lives here.
 *   - Enable/disable takes effect at the NEXT turn start (each turn rebuilds
 *     provider options; no live reload needed).
 *   - Hooks are parsed for display but NEVER executed in v1: the Claude
 *     provider sets `disableAllHooks` for the session, and Codex/Pi have no
 *     hook channel at all. The panel states this openly (静默 no-op 比明示
 *     不完整更糟 — feasibility §3.4).
 *   - Uninstall is refused while any turn is running (the IPC handler checks
 *     runtimeManager, mirroring runtimes.remove).
 *
 * Delivery queries at the bottom are the ONLY entry points providers touch:
 * getEnabledPlugins / getEnabledPluginSkillRoots / getPluginMcpServers.
 *
 * Electron-free except for SettingRepo (SQL settings table) — same headless
 * smoke-test posture as main/runtimes/*.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { matchProjectKey, sameProjectKey } from "@main/lib/projectScope.js";
import { isTarRemoteHostFailure } from "@main/lib/tarHostWorkaround.js";
import { mapClaudeHookEvent } from "@contracts/hook";
import { decidePluginHookExecution, hostHookSourceOf, revokeHostHookGrants } from "@main/hooks/hostHookGrants.js";
import type { EnabledPluginHookDeclaration } from "@main/hooks/pluginHooks.js";
import {
  BUILTIN_MARKETPLACES,
  PLUGINS_ENABLED_SETTING_KEY,
  PLUGINS_ENGINES_SETTING_KEY,
  PLUGINS_PROJECT_SETTING_KEY,
  PLUGIN_ENGINE_IDS,
  PLUGIN_ENGINE_PROVIDER_IDS,
  PLUGINS_MARKETPLACES_SETTING_KEY,
  PLUGINS_MCP_DISABLED_SETTING_KEY,
  PLUGIN_NAME_RE,
  PluginManifestSchema,
  PluginMarketEntrySchema,
  PluginMarketplaceManifestSchema,
  McpServerConfigSchema,
  type McpServerConfig,
  type PluginComponents,
  type PluginEcosystem,
  type PluginEngineSwitches,
  type PluginProjectOverride,
  type ComponentDeliveryEntry,
  type ComponentDeliveryReport,
  type PluginHookSummary,
  COMPONENT_PROVIDER_DELIVERY,
  sceneComponentReadiness,
  type SceneComponentReadiness,
  type PluginProjectRow,
  type PluginManifest,
  type PluginMarketEntry,
  type PluginMarketEntrySource,
  type PluginMarketplaceRecord,
  type PluginMarketplaceState,
  type PluginSourceInfo,
  type PluginState,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { classifyMarketRegistry, marketRegistryCorruptMessage, recheckMarketRegistryBeforeWrite, type MarketRegistryRead } from "@main/lib/marketRegistry.js";
import { MCODE_CONFIG_DIR } from "@main/providers/claude-sdk/customEnv.js";
import {
  findPluginManifest,
  findPluginManifestDeep,
  findMarketplaceManifestFile,
  pluginSkillsDirs,
  pluginNodeTypesDirs,
  pluginMcpFiles,
  pluginInlineMcpServers,
  pluginVersionOf,
  summarizeComponents,
  describePluginMcp,
} from "./pluginManifest.js";

export const PLUGINS_ROOT = path.join(MCODE_CONFIG_DIR, "plugins");
const MARKETPLACES_DIR = path.join(PLUGINS_ROOT, "marketplaces");
const INSTALL_RECORD_FILE = ".mcode-install.json";
/** Archive downloads are one shot per install and can be tens of MB on a slow
 *  link — generous, but bounded so a stalled socket cannot hold the install
 *  (and the panel's busy state) forever. */
const DOWNLOAD_TIMEOUT_MS = 300_000;

/** Directory names under PLUGINS_ROOT that the manager owns itself. Compared
 *  case-insensitively: Windows and macOS file systems usually are. */
function isReservedPluginName(name: string): boolean {
  return name.toLowerCase() === "marketplaces";
}

/* ── Settings-table helpers ── */

function readJsonSetting<T>(key: string, fallback: T): T {
  try {
    const raw = SettingRepo.get(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonSetting(key: string, value: unknown): void {
  SettingRepo.set(key, JSON.stringify(value));
}

/* 【MC-019】插件策略配置的**健康度** —— 把「真没配过」与「读不懂」分开。
 * 与 publicMcpSession.classifyProjectLinks / hostHookGrantFile.classify*Archive 同判据:
 * absent(键不存在,照旧当没配过)/ valid / corrupt(存在但读不懂 → 调用侧必须 fail-closed)。 */
type PluginConfigHealth = "absent" | "valid" | "corrupt";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** plugins.engines 的合法形状:{ [插件名]: { claude?/codex?/pi?: boolean } }。
 *  叶子写坏的(非布尔)条目会让**整键**进损坏态 —— 布尔翻转方向恰是"禁用变开启"。 */
function isPluginEnginesMapShape(parsed: unknown): boolean {
  if (!isPlainObject(parsed)) return false;
  for (const entry of Object.values(parsed)) {
    if (!isPlainObject(entry)) return false;
    for (const id of PLUGIN_ENGINE_IDS) {
      if (id in entry && typeof entry[id] !== "boolean") return false;
    }
  }
  return true;
}

/** plugins.projectOverrides 的合法形状 —— 同款严格到叶子(见上)。 */
function isPluginProjectMapShape(parsed: unknown): boolean {
  if (!isPlainObject(parsed)) return false;
  for (const rows of Object.values(parsed)) {
    if (!isPlainObject(rows)) return false;
    for (const ov of Object.values(rows)) {
      if (!isPlainObject(ov)) return false;
      if ("enabled" in ov && typeof ov.enabled !== "boolean") return false;
      if ("engines" in ov) {
        const e = ov.engines;
        if (!isPlainObject(e)) return false;
        for (const id of PLUGIN_ENGINE_IDS) {
          if (id in e && typeof e[id] !== "boolean") return false;
        }
      }
    }
  }
  return true;
}

/** plugins.enabled / plugins.mcpDisabled 的合法形状:字符串数组(名单)。
 *  叶子里出现非字符串 → 损坏:旧读法会把该条**静默过滤掉**,禁用名单因此悄悄少人。 */
function isPluginNameListShape(parsed: unknown): boolean {
  return Array.isArray(parsed) && parsed.every((n) => typeof n === "string");
}

/**
 * 【MC-019】读一个 JSON 设置键并给出健康度。`absent` = 键不存在(或空串,与
 * {@link readJsonSetting} 的 `!raw` 同义)—— 照旧当"没配过";`corrupt` = 存在但
 * 读不懂(JSON 语法坏 / 形状不对 / 读都读不动)—— 调用侧必须拒绝投递,不能再拿
 * 兜底值继续算:这四个键的兜底值(空表 / 全开)恰好都是**放宽**方向,
 * "坏 JSON → 禁用规则变默认开启"。
 */
function classifyJsonSetting(
  key: string,
  isValidShape: (parsed: unknown) => boolean,
): { health: PluginConfigHealth; error?: string } {
  let raw: string | null;
  try {
    raw = SettingRepo.get(key);
  } catch (err) {
    // 库故障 / 磁盘拒读:无法区分「没配过」,按损坏 fail-closed(不是回退兜底值)。
    return { health: "corrupt", error: err instanceof Error ? err.message : String(err) };
  }
  if (!raw) return { health: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { health: "corrupt", error: err instanceof Error ? err.message : String(err) };
  }
  return isValidShape(parsed) ? { health: "valid" } : { health: "corrupt", error: "形状不符合预期" };
}

/** 损坏即**显式报告**(硬规矩 3)。本模块不 import `@main/lib/logger`(它依赖 electron)
 *  —— 走与本文件既有 MC-030 同款的 console.warn 出口,点名设置键与原因,绝不静默。 */
function reportCorruptPluginSetting(key: string, error: string | undefined): void {
  console.warn(
    `[plugins] 插件配置「${key}」损坏(读不懂:${error ?? "未知原因"})—— 本轮拒绝投递,绝不当"没配过"把已禁用的插件/引擎重新放开;请修复或清除该设置。`,
  );
}

/** 损坏只报一次(直到该键恢复)—— enabledPluginsNow 挂在宿主每事件的分发路径上
 *  (见 HookRunner),不节流会把同一条损坏刷成日志洪水。键恢复后清位,再损坏会再报。 */
const corruptSettingReported = new Set<string>();

/** 键损坏 → 显式报告并返回 true(调用方据此 fail-closed 拒绝投递)。 */
function isCorruptPluginSetting(key: string, isValidShape: (parsed: unknown) => boolean): boolean {
  const health = classifyJsonSetting(key, isValidShape);
  if (health.health !== "corrupt") {
    corruptSettingReported.delete(key);
    return false;
  }
  if (!corruptSettingReported.has(key)) {
    corruptSettingReported.add(key);
    reportCorruptPluginSetting(key, health.error);
  }
  return true;
}

/** 四个投递策略键里,三个在 {@link enabledPluginsNow} 这道总闸上把关
 *  (启用名单 / 项目覆盖 / 引擎开关);mcpDisabled 由 {@link getPluginMcpServers}
 *  自己把(它是唯一直通 MCP 投递的那把闸,不管插件的启用与否)。 */
const PLUGIN_DELIVERY_POLICY_KEYS: ReadonlyArray<readonly [string, (parsed: unknown) => boolean]> = [
  [PLUGINS_ENABLED_SETTING_KEY, isPluginNameListShape],
  [PLUGINS_PROJECT_SETTING_KEY, isPluginProjectMapShape],
  [PLUGINS_ENGINES_SETTING_KEY, isPluginEnginesMapShape],
];

/** 【MC-019】写侧守卫:键损坏时**拒绝写入**(读侧同一判据)。修复前 setter 拿兜底值
 *  当基准读-改-写,把「坏了」洗成「合法」,方向还是放宽 —— 引擎表兜底是空表(=全开),
 *  用户动一个引擎就会把原禁用整表按全开基准写回;mcpDisabled 兜底是空名单,动一个
 *  服务就会把别的插件已关的服务静默放开。返回 setter 既有的 {ok:false,error} 形状。 */
function refuseIfCorrupt(
  key: string,
  isValidShape: (parsed: unknown) => boolean,
): { ok: false; error: string } | null {
  if (!isCorruptPluginSetting(key, isValidShape)) return null;
  return {
    ok: false,
    error: `插件配置「${key}」损坏(读不懂)—— 拒绝写入,以免拿兜底值把损坏洗成合法并放宽投递;请先修复或清除该设置。`,
  };
}

/** Enabled plugin names (empty when never configured). */
export function readEnabledPlugins(): string[] {
  const names = readJsonSetting<string[]>(PLUGINS_ENABLED_SETTING_KEY, []);
  return Array.isArray(names) ? names.filter((n) => typeof n === "string") : [];
}

function writeEnabledPlugins(names: string[]): void {
  writeJsonSetting(PLUGINS_ENABLED_SETTING_KEY, names);
}

/** 【MC-037】插件市场记录三态 —— 与技能/MCP 市场共用分类核(`lib/marketRegistry.ts`)。 */
function readMarketplaceRecordsState(): MarketRegistryRead<PluginMarketplaceRecord> {
  let raw: string | null;
  try {
    raw = SettingRepo.get(PLUGINS_MARKETPLACES_SETTING_KEY);
  } catch (err) {
    return { kind: "corrupt", reason: `读取失败(${(err as Error).message})` };
  }
  return classifyMarketRegistry(raw, (value) => (Array.isArray(value) ? (value as PluginMarketplaceRecord[]) : null), "插件市场");
}

/** 读侧降级出口:损坏 → 空表(列表展示出厂市场,`ensureBuiltin` 的落盘在损坏时被拒)。 */
function readMarketplaceRecords(): PluginMarketplaceRecord[] {
  const state = readMarketplaceRecordsState();
  return state.kind === "ok" ? state.records : [];
}

/** 给 `plugins.marketplaceList` 附的损坏诊断。 */
export function pluginMarketplacesCorrupt(): { reason: string } | null {
  const state = readMarketplaceRecordsState();
  return state.kind === "corrupt" ? { reason: state.reason } : null;
}

function readMcpDisabled(): Set<string> {
  const names = readJsonSetting<string[]>(PLUGINS_MCP_DISABLED_SETTING_KEY, []);
  return new Set(Array.isArray(names) ? names.filter((n) => typeof n === "string") : []);
}

/* ── Per-engine switches (plugins.engines) ──
 * The plugin counterpart of the skill matrix: per plugin, which of the three
 * local engines receive it. Stored sparse — only plugins with at least one
 * engine OFF have an entry, and a missing engine key reads as ON — so plugins
 * installed before this existed keep delivering exactly as before. */

type PluginEnginesMap = Record<string, Partial<PluginEngineSwitches>>;

function readPluginEnginesMap(): PluginEnginesMap {
  const raw = readJsonSetting<unknown>(PLUGINS_ENGINES_SETTING_KEY, {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as PluginEnginesMap) : {};
}

/** The user's switches for one plugin, all three resolved (missing = on). */
export function pluginEngineSwitches(
  name: string,
  map: PluginEnginesMap = readPluginEnginesMap(),
): PluginEngineSwitches {
  const stored = map[name];
  const e = stored && typeof stored === "object" ? stored : {};
  return { claude: e.claude !== false, codex: e.codex !== false, pi: e.pi !== false };
}

/** `compatible` narrowed to the engines switched on. Provider ids outside the
 *  three local engines (none today) pass through untouched. */
function narrowToEngines(compatible: string[], switches: PluginEngineSwitches): string[] {
  return compatible.filter((providerId) => {
    const engine = PLUGIN_ENGINE_IDS.find((id) => PLUGIN_ENGINE_PROVIDER_IDS[id] === providerId);
    return engine ? switches[engine] : true;
  });
}

/** Update one plugin's engine switches (omitted engines keep their value).
 *  Lands on the next turn start, like enable/disable. */
export function setPluginEngines(
  name: string,
  patch: Partial<PluginEngineSwitches>,
): { ok: boolean; error?: string } {
  if (!PLUGIN_NAME_RE.test(name) || isReservedPluginName(name)) return { ok: false, error: "非法插件名" };
  // 【MC-030】读不了 ≠ 未安装(否则用户会去重装一个还在的插件);读不了时也不写。
  const probe = probeInstalledDir(name);
  if (isUnreadableProbe(probe)) {
    return { ok: false, error: `插件 ${name} 的目录读不了(ACL/磁盘错误?),无法读取安装信息:${probe.error.message}` };
  }
  if (!installedRootFrom(probe)) return { ok: false, error: `插件 ${name} 未安装` };
  // 【MC-019】引擎表损坏时拒绝写 — 否则这次读-改-写会拿兜底空表当基准,
  // 把「坏了」洗成「合法」,而空表语义恰是**全开**:原禁用条目全部消失。
  const refuse = refuseIfCorrupt(PLUGINS_ENGINES_SETTING_KEY, isPluginEnginesMapShape);
  if (refuse) return refuse;
  const map = readPluginEnginesMap();
  const next = pluginEngineSwitches(name, map);
  for (const id of PLUGIN_ENGINE_IDS) {
    if (typeof patch[id] === "boolean") next[id] = patch[id] as boolean;
  }
  if (PLUGIN_ENGINE_IDS.every((id) => next[id])) delete map[name];
  else map[name] = next;
  writeJsonSetting(PLUGINS_ENGINES_SETTING_KEY, map);
  return { ok: true };
}

/* ── Per-project overrides (plugins.projectOverrides) ──
 * 插件只在总库装一次;项目可以单独决定启用哪些、对哪个引擎启用。项目里没设的字段跟随
 * 总库。会话按 cwd 找项目(matchProjectKey,最长前缀)。 */

type PluginProjectMap = Record<string, Record<string, PluginProjectOverride>>;

function cleanOverride(raw: unknown): PluginProjectOverride | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: PluginProjectOverride = {};
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  if (r.engines && typeof r.engines === "object" && !Array.isArray(r.engines)) {
    const e: Partial<PluginEngineSwitches> = {};
    for (const id of PLUGIN_ENGINE_IDS) {
      const v = (r.engines as Record<string, unknown>)[id];
      if (typeof v === "boolean") e[id] = v;
    }
    if (Object.keys(e).length > 0) out.engines = e;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function readPluginProjectMap(): PluginProjectMap {
  const raw = readJsonSetting<unknown>(PLUGINS_PROJECT_SETTING_KEY, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: PluginProjectMap = {};
  for (const [project, plugins] of Object.entries(raw as Record<string, unknown>)) {
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) continue;
    const rows: Record<string, PluginProjectOverride> = {};
    for (const [name, ov] of Object.entries(plugins as Record<string, unknown>)) {
      const clean = cleanOverride(ov);
      if (clean) rows[name] = clean;
    }
    if (Object.keys(rows).length > 0) out[project] = rows;
  }
  return out;
}

/** The overrides that apply to a session running in `cwd` (none = {}). */
function projectOverridesFor(cwd: string | undefined, map: PluginProjectMap = readPluginProjectMap()): Record<string, PluginProjectOverride> {
  const key = matchProjectKey(cwd, Object.keys(map));
  return key ? map[key] : {};
}

/** Effective switches of one plugin under an override (missing = global). */
function effectiveEngines(name: string, enginesMap: PluginEnginesMap, ov?: PluginProjectOverride): PluginEngineSwitches {
  const g = pluginEngineSwitches(name, enginesMap);
  const e = ov?.engines;
  if (!e) return g;
  return {
    claude: typeof e.claude === "boolean" ? e.claude : g.claude,
    codex: typeof e.codex === "boolean" ? e.codex : g.codex,
    pi: typeof e.pi === "boolean" ? e.pi : g.pi,
  };
}

/** Set / clear one plugin's override in a project. `enabled`/`engines`:
 *  undefined = unchanged, null = follow the global value again. */
export function setPluginProjectOverride(
  projectPath: string,
  name: string,
  patch: { enabled?: boolean | null; engines?: Partial<PluginEngineSwitches> | null },
): { ok: boolean; error?: string } {
  if (!PLUGIN_NAME_RE.test(name) || isReservedPluginName(name)) return { ok: false, error: "非法插件名" };
  // 【MC-030】读不了 ≠ 未安装:读不了时如实报读不了,也不碰覆盖表。
  const probe = probeInstalledDir(name);
  if (isUnreadableProbe(probe)) {
    return { ok: false, error: `插件 ${name} 的目录读不了(ACL/磁盘错误?),无法读取安装信息:${probe.error.message}` };
  }
  if (!installedRootFrom(probe)) return { ok: false, error: `插件 ${name} 未安装` };
  if (!path.isAbsolute(projectPath)) return { ok: false, error: "项目路径必须是绝对路径" };
  // 【MC-019】覆盖表损坏时拒绝写 — 不然这次写把坏表洗成只含本项目的"合法"表,
  // 其他项目的覆盖(多半是"关")被静默丢弃,那些项目按全局状态重新投递。
  const refuse = refuseIfCorrupt(PLUGINS_PROJECT_SETTING_KEY, isPluginProjectMapShape);
  if (refuse) return refuse;
  const map = readPluginProjectMap();
  const key = sameProjectKey(projectPath, Object.keys(map)) ?? path.resolve(projectPath);
  const rows = { ...(map[key] ?? {}) };
  const cur: PluginProjectOverride = { ...(rows[name] ?? {}) };
  if (patch.enabled === null) delete cur.enabled;
  else if (typeof patch.enabled === "boolean") cur.enabled = patch.enabled;
  if (patch.engines === null) delete cur.engines;
  else if (patch.engines) {
    const e: Partial<PluginEngineSwitches> = { ...(cur.engines ?? {}) };
    for (const id of PLUGIN_ENGINE_IDS) {
      const v = patch.engines[id];
      if (typeof v === "boolean") e[id] = v;
    }
    cur.engines = e;
  }
  const clean = cleanOverride(cur);
  if (clean) rows[name] = clean;
  else delete rows[name];
  if (Object.keys(rows).length > 0) map[key] = rows;
  else delete map[key];
  writeJsonSetting(PLUGINS_PROJECT_SETTING_KEY, map);
  return { ok: true };
}

/** Installed plugins as seen from one project (override ∘ global). */
export function listPluginProjectRows(projectPath: string): PluginProjectRow[] {
  const map = readPluginProjectMap();
  const key = sameProjectKey(projectPath, Object.keys(map));
  const ov = key ? map[key] : {};
  const enginesMap = readPluginEnginesMap();
  return listPlugins().map((p) => {
    const o = ov[p.name];
    const globalEngines = pluginEngineSwitches(p.name, enginesMap);
    const engines = effectiveEngines(p.name, enginesMap, o);
    const enabled = typeof o?.enabled === "boolean" ? o.enabled : p.enabled;
    const compatible = p.compatibleProviderIds ?? [...Object.values(PLUGIN_ENGINE_PROVIDER_IDS)];
    return {
      name: p.name,
      description: p.description,
      globalEnabled: p.enabled,
      globalEngines,
      ...(o ? { override: o } : {}),
      enabled,
      engines,
      compatibleProviderIds: compatible,
      deliveredProviderIds: enabled ? narrowToEngines(compatible, engines) : [],
    };
  });
}

/* ── Process helpers (git / unzip) ── */

interface SpawnResult {
  ok: boolean;
  message: string;
  output?: string;
  errorOutput?: string;
}

interface RunOpts {
  cwd?: string;
  timeoutMs?: number;
  /** Spawn WITHOUT the proxy env vars (http(s)_proxy / ALL_PROXY) — used by
   *  gitClone's proxy-bypass retry so curl can't fall back to them. */
  noProxyEnv?: boolean;
  /** Capture complete output for security-sensitive archive inspection. */
  captureOutput?: boolean;
  maxOutputBytes?: number;
}

const PROXY_ENV_RE = /^(https?_proxy|all_proxy)$/i;

function runCommand(
  cmd: string,
  args: string[],
  opts: RunOpts = {},
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const env = opts.noProxyEnv
      ? Object.fromEntries(
          Object.entries(process.env).filter(([k]) => !PROXY_ENV_RE.test(k)),
        )
      : undefined;
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env });
    let tail = "";
    let output = "";
    let errorOutput = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (r: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, message: `${cmd} 超时(${Math.round((opts.timeoutMs ?? 30_000) / 1000)}s)` });
    }, opts.timeoutMs ?? 30_000);
    const feed = (buf: Buffer, stderr: boolean) => {
      tail = (tail + buf.toString("utf-8")).slice(-2000);
      if (!opts.captureOutput || settled) return;
      outputBytes += buf.length;
      if (outputBytes > (opts.maxOutputBytes ?? 8 * 1024 * 1024)) {
        child.kill("SIGKILL");
        finish({ ok: false, message: `${cmd} 输出过大,已拒绝处理` });
        return;
      }
      if (stderr) errorOutput += buf.toString("utf-8");
      else output += buf.toString("utf-8");
    };
    child.stdout?.on("data", (buf: Buffer) => feed(buf, false));
    child.stderr?.on("data", (buf: Buffer) => feed(buf, true));
    child.on("error", (err) => finish({ ok: false, message: `${cmd} 无法启动:${err.message}` }));
    child.on("close", (code) =>
      finish(
        code === 0
          ? { ok: true, message: "", ...(opts.captureOutput ? { output, errorOutput } : {}) }
          : { ok: false, message: `${cmd} 退出码 ${code}:${tail.trim().slice(-400) || "(无输出)"}` },
      ),
    );
  });
}

/** curl's message when a configured proxy refuses the connection — the
 *  "proxy app is configured but not running" signature. Only this failure
 *  justifies bypassing the user's proxy: a RUNNING proxy that fails for
 *  auth/DNS/timeout reasons must stay in the path (it may be the only route
 *  to GitHub, and bypassing it would silently leak the request direct). */
const PROXY_REFUSED_RE = /Failed to connect to (?:127\.0\.0\.1|localhost|\[?::1\]?)\s*port/i;

/** Shallow-clone a git repo into `dest` (which must not exist).
 *
 *  Proxy fallback: Mcode spawns git with the inherited environment, so a
 *  machine whose git config / shell env points at a currently-dead local
 *  proxy (Clash/v2ray off — "Failed to connect to 127.0.0.1 port 7897") fails
 *  on the very first hop. When — and only when — the failure is a proxy
 *  connect-refused, retry once with proxies stripped: command-line `-c
 *  http.proxy=` overrides git config files, and the cleaned env stops curl's
 *  env-var fallback. */
async function gitClone(url: string, dest: string, ref?: string, progress?: MarketProgressSink): Promise<void> {
  await cloneMarketRepository(url, dest, ref, progress);
}

/** Node's fetch/undici collapses EVERY network failure into the bare string
 *  "fetch failed" — the actionable part (ECONNREFUSED to a proxy port,
 *  ENOTFOUND, TLS/cert errors) hangs off `cause`. Walk the chain so the panel
 *  shows something a user can act on. */
function describeFetchError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur instanceof Error; depth++) {
    if (cur.message) parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" ← ") || String(err);
}

/** Last-resort transport when the platform has no curl: node's fetch. Ignores
 *  the proxy environment entirely (undici does not read it), which is exactly
 *  why curl goes first. */
async function downloadViaFetch(url: string, dest: string): Promise<void> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    throw new Error(
      `下载失败:${describeFetchError(err)}(${url})。若该地址需要代理访问,请先开启代理软件再重试。`,
    );
  }
}

/** Download `url` into `dest` (marketplace zip entries: `{source:"url"}` —
 *  152 of the official catalog's 292 entries, so this path is not exotic).
 *
 *  Transport is curl for the same reason gitClone uses git: it resolves
 *  proxies the way the rest of the machine does, and — the part undici's fetch
 *  cannot do — it can be re-run with the proxy env stripped. On a machine whose
 *  shell/git point at a currently-dead local proxy, `fetch` dies on the first
 *  hop (as the useless "fetch failed") while a git clone of the SAME host
 *  succeeds via the bypass; zip installs must not be the one path that fails
 *  there. Same rule as gitClone for when to bypass: only a proxy
 *  connect-refused, never a running proxy that failed for auth/DNS reasons.
 *
 *  Order: curl (inherited env) → curl (proxies stripped) → node fetch (only
 *  when curl is missing, e.g. a minimal Linux image). */
async function downloadFile(url: string, dest: string): Promise<void> {
  const args = [
    "-fL",
    "--silent",
    "--show-error",
    "--retry",
    "2",
    "--connect-timeout",
    "15",
    "-o",
    dest,
    url,
  ];
  const first = await runCommand("curl", args, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
  if (first.ok) return;
  // runCommand reports a missing binary as "<cmd> 无法启动: …" (spawn ENOENT).
  if (/无法启动/.test(first.message)) return downloadViaFetch(url, dest);
  if (!PROXY_REFUSED_RE.test(first.message)) throw new Error(`下载失败:${first.message}`);
  const bypass = await runCommand("curl", args, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    noProxyEnv: true,
  });
  if (bypass.ok) return;
  throw new Error(
    `下载失败(代理不可用,绕过代理直连也失败):${bypass.message}。若该地址需要代理访问,请先开启代理软件再重试。`,
  );
}

/** GNU tar 把 `C:\...` 当成远端 `host:file` 的判据 —— **共享一份**
 *  (见 `@main/lib/tarHostWorkaround.js`,rg 安装那条解压路也用它)。 */

/** Reject archive members that can resolve outside the fresh staging folder.
 * Platform tar/unzip versions disagree on whether such names are rejected,
 * stripped, or only warned about, so this boundary cannot be delegated. */
export function assertSafeArchiveEntryNames(entries: string[]): void {
  for (const raw of entries) {
    if (!raw) continue;
    const name = raw.replace(/\\/g, "/");
    if (
      name.startsWith("/") ||
      /^[A-Za-z]:/.test(name) ||
      name.split("/").some((part) => part === "..")
    ) {
      throw new Error(`zip 包含越界路径,已拒绝安装:${raw}`);
    }
  }
}

async function inspectArchive(zipPath: string, tarBin: string): Promise<void> {
  let names = await runCommand(tarBin, ["-tf", zipPath], {
    timeoutMs: 60_000,
    captureOutput: true,
  });
  let verbose: SpawnResult | null = null;
  if (names.ok) {
    verbose = await runCommand(tarBin, ["-tvf", zipPath], {
      timeoutMs: 60_000,
      captureOutput: true,
    });
  } else if (process.platform === "linux") {
    // GNU tar cannot read zip archives; unzip is extractZip's Linux fallback.
    names = await runCommand("unzip", ["-Z1", zipPath], {
      timeoutMs: 60_000,
      captureOutput: true,
    });
  }
  if (!names.ok) throw new Error(`zip 目录读取失败:${names.message}`);
  if (names.errorOutput?.trim()) {
    throw new Error(`zip 目录包含不安全或异常路径,已拒绝安装:${names.errorOutput.trim().slice(-400)}`);
  }
  assertSafeArchiveEntryNames((names.output ?? "").split(/\r?\n/));
  if (verbose?.ok) {
    const link = (verbose.output ?? "")
      .split(/\r?\n/)
      .find((line) => /^[lh]/i.test(line.trimStart()));
    if (link) throw new Error("zip 包含符号链接或硬链接,已拒绝安装");
  }
}
/** Extract a .zip via the platform tool. bsdtar (macOS / Windows 10+) reads
 *  zip natively; Linux GNU tar doesn't, so unzip is the fallback there.
 *
 *  win32 discipline: PATH can surface an MSYS/Git Bash GNU tar before the
 *  system bsdtar, and GNU tar misreads `C:\...` as a remote target — so prefer
 *  the System32 bsdtar explicitly, and when a PATH tar fails with exactly that
 *  remote-host signature, retry once with `--force-local` (GNU tar's own
 *  opt-in for colon paths; a healthy bsdtar never needs the retry). */
async function extractZip(zipPath: string, dest: string): Promise<void> {
  if (process.platform === "win32") {
    const systemTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const tarBin = existsSync(systemTar) ? systemTar : "tar";
    await inspectArchive(zipPath, tarBin);
    let viaTar = await runCommand(tarBin, ["-xf", zipPath, "-C", dest], { timeoutMs: 60_000 });
    if (!viaTar.ok && isTarRemoteHostFailure(viaTar.message)) {
      viaTar = await runCommand(tarBin, ["--force-local", "-xf", zipPath, "-C", dest], { timeoutMs: 60_000 });
    }
    if (viaTar.ok) return;
    throw new Error(`zip 解压失败:${viaTar.message}`);
  }
  await inspectArchive(zipPath, "tar");
  const viaTar = await runCommand("tar", ["-xf", zipPath, "-C", dest], { timeoutMs: 60_000 });
  if (viaTar.ok) return;
  if (process.platform === "linux") {
    const viaUnzip = await runCommand("unzip", ["-oq", zipPath, "-d", dest], { timeoutMs: 60_000 });
    if (viaUnzip.ok) return;
    throw new Error(`zip 解压失败:${viaUnzip.message}`);
  }
  throw new Error(`zip 解压失败:${viaTar.message}`);
}

/* ── Installed-plugin scan ── */

interface InstallRecord {
  source: PluginSourceInfo;
  installedAt: string;
}

function readInstallRecord(pluginRoot: string): InstallRecord | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(pluginRoot, INSTALL_RECORD_FILE), "utf-8")) as InstallRecord;
    if (raw && raw.source && typeof raw.source.kind === "string") return raw;
  } catch {
    /* no/invalid record */
  }
  return null;
}

/** 【MC-030】判"这个插件没装"之前**先要能证明真没有**:一次 `readdir` 定生死。
 *  - `absent`      = 目录不存在(ENOENT):真没装,调用方照旧当"未安装";
 *  - `unreadable`  = 目录存在但**读不了**(EACCES/EPERM/磁盘错误):不能折叠成
 *    "没有" —— 否则已启用插件会静默消失、`setPluginEnabled/removePlugin` 还会谎报
 *    "未安装"。调用方必须显式报告并拒绝把状态说成"没装"。
 *  readdir 的结果回传给 {@link installedRootFrom} 复用,免得"检查时读得动、扫描时
 *  读不动"的 TOCTOU 分叉出两种说法。 */
type InstalledDirProbe =
  | { kind: "ok"; base: string; entries: string[] }
  | { kind: "absent" }
  | { kind: "unreadable"; base: string; error: Error };

function probeInstalledDir(name: string): InstalledDirProbe {
  const base = path.join(PLUGINS_ROOT, name);
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", base, error: err as Error };
  }
  return { kind: "ok", base, entries };
}

/** 同一个 "要打开的路径自己读不了" 判断的**唯一一份**。 */
function isUnreadableProbe(probe: InstalledDirProbe): probe is Extract<InstalledDirProbe, { kind: "unreadable" }> {
  return probe.kind === "unreadable";
}

function installedRootFrom(probe: InstalledDirProbe): string | null {
  if (probe.kind !== "ok") return null;
  const { base, entries } = probe;
  // ⚠️ 安装时的临时目录(`<版本>.swapping-*` / `<版本>.backup-*`)就落在同一层,删不掉
  // (Windows 上文件被插件的 MCP 进程占着)时会留下来;按字符串取最大值的话
  // `1.0.0.backup-…` 比 `1.0.0` 大,于是加载的是**旧的备份**。所以跳过这些目录,
  // 并优先按安装记录的时间挑(剩下多个版本时,最后装的那个才是用户要的;
  // 「1.10.0」按字符串还比「1.9.0」小),没有记录再按数字感知的版本号比较。
  let best: { entry: string; at: number } | null = null;
  for (const entry of entries) {
    if (entry.includes(".swapping-") || entry.includes(".backup-")) continue;
    const dir = path.join(base, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const at = Date.parse(readInstallRecord(dir)?.installedAt ?? "") || 0;
    if (
      !best ||
      at > best.at ||
      (at === best.at && entry.localeCompare(best.entry, undefined, { numeric: true }) > 0)
    ) {
      best = { entry, at };
    }
  }
  return best ? path.join(base, best.entry) : null;
}

/** Newest-version directory of an installed plugin (v1's single-version model
 *  makes "newest" a plain lexicographic max — semver-ish strings sort well
 *  enough for the 0.x world this ships in). A directory that exists but cannot
 *  be read scans as `null` here; callers that must not confuse that with
 *  "not installed" go through {@link probeInstalledDir} instead. */
function installedRootOf(name: string): string | null {
  if (isReservedPluginName(name)) return null;
  return installedRootFrom(probeInstalledDir(name));
}

/** Providers that can consume at least one executable component. An explicit
 * `kind: plugin` declaration wins; legacy ecosystem manifests are inferred
 * from the delivery paths documented in @contracts/plugin.
 *
 * ANY 语义:列表 = **至少**能投递一个声明组件的 provider 之并。每类组件能投递的引擎
 * 来自 `COMPONENT_PROVIDER_DELIVERY`(唯一权威),不再各写一遍 —— 此前这里漏了 `apps`,
 * 一个 app-only(Codex 专用)插件被谎报成 Claude/Pi 也能用。顺序固定按引擎序
 * (claude→codex→pi),保证返回数组稳定可断言。 */
export function compatibleProviderIdsForPlugin(
  manifest: PluginManifest,
  components: PluginComponents,
): string[] {
  const declared = manifest.capabilities?.find(
    (capability) => capability.kind === "plugin" && capability.id === manifest.name,
  )?.providers;
  if (declared && declared.length > 0) return [...new Set(declared)];

  const presentTypes: Array<ComponentDeliveryEntry["type"]> = [];
  if (components.skills.length > 0) presentTypes.push("skill");
  if (components.commands.length > 0) presentTypes.push("command");
  if (components.agents.length > 0) presentTypes.push("agent");
  if (components.hooks.length > 0) presentTypes.push("hook");
  if (components.mcpServers.length > 0) presentTypes.push("mcp");
  if ((components.apps?.length ?? 0) > 0) presentTypes.push("app");

  // A component-free plugin can still contribute host-side node types or future
  // fields. Do not hide it merely because this summary cannot see those.
  if (presentTypes.length === 0) return ["claude-sdk", "codex-sdk", "pi-sdk"];

  const union = new Set<string>();
  for (const type of presentTypes) {
    for (const providerId of COMPONENT_PROVIDER_DELIVERY[type]) union.add(providerId);
  }
  // 固定引擎序,而非依赖 Set 插入序(与 presentTypes 的声明顺序无关)。
  return PLUGIN_ENGINE_IDS.map((engine) => PLUGIN_ENGINE_PROVIDER_IDS[engine]).filter((id) =>
    union.has(id),
  );
}

/**
 * 【ARC-014】逐组件交付报告 —— 补上 `compatibleProviderIdsForPlugin` 的 ANY/ALL 语义差。
 *
 * 那份兼容列表给的是 **ANY**(至少一个组件能投递);场景依赖通常是 **ALL**。这个纯函数
 * 对**每个**声明组件问「这个 provider 收不收得到」,给场景 Planner 一个可判 ALL 的事实,
 * 而不是靠"兼容列表里有 Pi"就放行一个需要 Claude Command 的 Pi 场景。
 *
 * 交付规则**唯一权威**在 `COMPONENT_PROVIDER_DELIVERY`(@contracts/plugin)—— 与
 * `compatibleProviderIdsForPlugin` 取同一份, 不再各自硬编码一遍。以 providerId 是否在
 * 该类组件的投递集合里判 DELIVERED / INCOMPATIBLE。
 *
 * `pluginEnabled=false` 时全部 DISABLED。这是**只读**报告,不改变任何真实投递路径。
 */
const COMPONENT_INCOMPATIBLE_REASON: Readonly<Record<ComponentDeliveryEntry["type"], string>> = {
  skill: "该引擎不投递技能",
  command: "命令只有 Claude 引擎投递",
  agent: "子代理定义只有 Claude 引擎投递",
  hook: "插件 hooks 只有 Claude 引擎通道",
  mcp: "Pi 不原生挂 MCP",
  app: "Codex apps 只在 Codex 有意义",
  nodeType: "宿主侧能力,与引擎无关",
};

export function componentDeliveryReport(
  pluginId: string,
  version: string | undefined,
  providerId: string,
  components: PluginComponents,
  pluginEnabled: boolean,
): ComponentDeliveryReport {
  const entries: ComponentDeliveryEntry[] = [];
  const add = (
    componentId: string,
    type: ComponentDeliveryEntry["type"],
    source: string,
    supported: boolean,
    why: string,
  ): void => {
    if (!pluginEnabled) {
      entries.push({ componentId, type, source, status: "DISABLED", reason: "插件已被禁用" });
    } else if (!supported) {
      entries.push({ componentId, type, source, status: "INCOMPATIBLE", reason: why });
    } else {
      entries.push({ componentId, type, source, status: "DELIVERED" });
    }
  };
  const supported = (type: ComponentDeliveryEntry["type"]): boolean =>
    COMPONENT_PROVIDER_DELIVERY[type].includes(providerId);
  const why = (type: ComponentDeliveryEntry["type"]): string => COMPONENT_INCOMPATIBLE_REASON[type];
  components.skills.forEach((s, i) => add(`skill:${i}`, "skill", s.name, supported("skill"), why("skill")));
  components.commands.forEach((c, i) => add(`command:${i}`, "command", c.name, supported("command"), why("command")));
  components.agents.forEach((a, i) => add(`agent:${i}`, "agent", a.name, supported("agent"), why("agent")));
  components.hooks.forEach((h, i) => add(`hook:${i}`, "hook", h.event, supported("hook"), why("hook")));
  components.mcpServers.forEach((m, i) => add(`mcp:${i}`, "mcp", m.name, supported("mcp"), why("mcp")));
  (components.apps ?? []).forEach((name, i) => add(`app:${i}`, "app", name, supported("app"), why("app")));
  return {
    pluginId,
    ...(version ? { version } : {}),
    providerId,
    pluginEnabled,
    entries,
    allDelivered: entries.every((e) => e.status === "DELIVERED"),
  };
}

/**
 * 【ARC-014】一个插件对**每个引擎**的逐组件就绪判定(**ALL** 语义),喂 `PluginState.componentReadiness`。
 *
 * 判据是「这个引擎收不收得到该插件的**全部**声明组件」,而不是兼容列表的 ANY(至少一个)。
 * 每个引擎的 required 组件集**直接读自 {@link componentDeliveryReport} 自己的条目**
 * (={`${type}:${index}`})—— 不另写一套 id 方案,两个量词因此不可能漂移(共享实现只有一份)。
 * 判定本身走契约的 {@link sceneComponentReadiness},不是这里再手写一遍 ALL 逻辑。
 *
 * 引擎取自 `PLUGIN_ENGINE_PROVIDER_IDS`(与面板、投递链同一份引擎序)。
 *
 * ⚠️ 与 `deliveredProviderIds` 不同,这里**不折叠用户的逐引擎开关** —— 它是「能力上收不收
 * 得到」的事实,开关是用户在该事实之上的收窄。面板两者一起读,别混成一个数。
 */
export function pluginComponentReadiness(
  pluginId: string,
  version: string | undefined,
  components: PluginComponents,
  pluginEnabled: boolean,
): Record<string, SceneComponentReadiness> {
  const out: Record<string, SceneComponentReadiness> = {};
  for (const engine of PLUGIN_ENGINE_IDS) {
    const providerId = PLUGIN_ENGINE_PROVIDER_IDS[engine];
    const report = componentDeliveryReport(pluginId, version, providerId, components, pluginEnabled);
    // required = 该插件声明的**每一个**组件 id,读自报告自身 → 与投递判据同源。
    const requiredIds = report.entries.map((entry) => entry.componentId);
    out[providerId] = sceneComponentReadiness(requiredIds, [report]);
  }
  return out;
}

/** Build one PluginState row; null when the directory holds no valid
 *  manifest (orphans from interrupted installs are invisible by design).
 *  Installed directories that are **unreadable** (ACL / disk error) never
 *  reach here — {@link listPlugins} turns them into a problem row first (MC-030). */
function toPluginState(
  rootDir: string,
  enabled: Set<string>,
  enginesMap: PluginEnginesMap = readPluginEnginesMap(),
): PluginState | null {
  let resolved;
  try {
    resolved = findPluginManifest(rootDir);
  } catch {
    return null;
  }
  if (!resolved) return null;
  return pluginStateOf(resolved, rootDir, enabled, enginesMap);
}

/** MC-030: an installed plugin directory that cannot be read, as a row that
 *  keeps its identity and carries the reason. `enabled` reflects the user's
 *  stored list — the configuration did not change just because the disk said no. */
function unreadablePluginState(
  problem: { name: string; base: string; error: Error },
  enabled: Set<string>,
): PluginState {
  return {
    name: problem.name,
    version: "",
    description: `插件目录读不了:${problem.error.message}`,
    rootDir: problem.base,
    enabled: enabled.has(problem.name),
    installedAt: "",
    source: { kind: "unknown", ref: "" },
    components: { skills: [], commands: [], agents: [], hooks: [], mcpServers: [] },
    compatibleProviderIds: [],
    deliveredProviderIds: [],
    problems: [`读不了插件目录(${problem.base}):${problem.error.message}`],
  };
}

function pluginStateOf(
  resolved: NonNullable<ReturnType<typeof findPluginManifest>>,
  rootDir: string,
  enabled: Set<string>,
  enginesMap: PluginEnginesMap,
): PluginState {
  const record = readInstallRecord(rootDir);
  const components = summarizeComponents(rootDir, resolved.manifest);
  const compatibleProviderIds = compatibleProviderIdsForPlugin(resolved.manifest, components);
  const engines = pluginEngineSwitches(resolved.manifest.name, enginesMap);
  const version = pluginVersionOf(resolved.manifest);
  // 【MC-061】把每条 hook 的「到底跑不跑」从写死的 `unsupported` 换成**真判定** ——
  // 走唯一判定落点 `decidePluginHookExecution`(默认拒绝:没有有效 HostHookGrant 就不跑)。
  // 只有用户经宿主授信签发了覆盖这份来源的授权,该条才标 `granted`(面板据此说「已授信、会执行」);
  // 映射不到统一事件的照旧 `unmappable`(即便有授权也不投)。**默认空表 = 默认全 unsupported**,
  // 与旧行为逐字一致(v1 本就不执行)。
  //
  // 来源身份走**唯一构造点** `hostHookSourceOf` —— 与宿主 HookRunner 执行时判的**同一份**
  // (含 `commandDigest` 的命令摘要)。此前这里传的是 `commandDigest: ""`(不绑命令),
  // 而执行通道一律按真摘要绑定 —— 两份来源一旦分家,面板会显示「已授信」而执行时却 denied。
  const hooksWithExecution = components.hooks.map((h) => {
    const mapped = mapClaudeHookEvent(h.event);
    const source = hostHookSourceOf({
      pluginId: resolved.manifest.name,
      version,
      nativeEvent: h.event,
      command: h.command,
      // 【MC-061 复审】matcher 纳入来源身份(与执行通道同一份)—— 面板与执行不再分家。
      ...(h.matcher !== undefined ? { matcher: h.matcher } : {}),
    });
    const decision = decidePluginHookExecution(source, mapped, Date.now());
    const execution: PluginHookSummary["execution"] =
      decision.decide === "allowed" ? "granted" : decision.decide === "unmappable" ? "unmappable" : "unsupported";
    return { ...h, execution };
  });
  return {
    name: resolved.manifest.name,
    version,
    description: resolved.manifest.description ?? "",
    rootDir,
    enabled: enabled.has(resolved.manifest.name),
    installedAt: record?.installedAt ?? "",
    source: record?.source ?? { kind: "unknown", ref: "" },
    components: { ...components, hooks: hooksWithExecution },
    compatibleProviderIds,
    engines,
    deliveredProviderIds: narrowToEngines(compatibleProviderIds, engines),
    componentReadiness: pluginComponentReadiness(
      resolved.manifest.name,
      version,
      components,
      enabled.has(resolved.manifest.name),
    ),
  };
}

/** List every installed plugin with component summaries + enable state. */
export function listPlugins(): PluginState[] {
  const enabled = new Set(readEnabledPlugins());
  if (!existsSync(PLUGINS_ROOT)) return [];
  const enginesMap = readPluginEnginesMap();
  const out: PluginState[] = [];
  let entries: string[];
  try {
    entries = readdirSync(PLUGINS_ROOT);
  } catch (err) {
    // 【MC-030】从前这里**完全没守卫**:`readdirSync` 抛 EACCES 会让整个 `plugins.list`
    //   炸掉(一个坏根 → 面板/能力目录全空)。更坏的是它**看起来像"一个插件都没装"**。
    //   现在如实记错误再返回空列表 —— 至少可诊断,不是静默的空。
    //   (完整修复要给 `plugins.list` 加 problems 字段并贯通 contracts/preload/面板,另切。)
    console.warn(`[plugins] 读不了插件根目录(${PLUGINS_ROOT}),本次按空列表返回: ${(err as Error).message}`);
    return [];
  }
  for (const entry of entries) {
    // Skip housekeeping dirs (marketplaces / staging / dotfiles).
    if (entry.startsWith(".") || entry === "marketplaces") continue;
    if (!PLUGIN_NAME_RE.test(entry)) continue;
    const probe = probeInstalledDir(entry);
    // 【MC-030】目录存在但读不了 = 这个插件**在**,只是这一轮读不出来。老实产出一行
    //   带 `problems` 的诊断行 —— 从前这里 `continue`,面板上它就像"从没装过"。
    if (isUnreadableProbe(probe)) {
      console.warn(`[plugins] 已安装插件「${entry}」的目录读不了,面板按诊断行列出: ${probe.error.message}`);
      out.push(unreadablePluginState({ name: entry, base: probe.base, error: probe.error }, enabled));
      continue;
    }
    const rootDir = installedRootFrom(probe);
    if (!rootDir) continue;
    const state = toPluginState(rootDir, enabled, enginesMap);
    if (state) out.push(state);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ── Install pipeline ── */

const installing = new Set<string>();
// Different sources (marketplace URL vs local directory, for example) may
// resolve to the same plugin name. Source-level de-duplication cannot prevent
// those installs from swapping the same live directory concurrently.
const finalizingPluginNames = new Set<string>();

/** What stagePluginSource/finalizePluginInstall need to know about where the
 *  payload comes from. `git`/`local-*` come from the RPCs; `marketplace-path`
 *  is a resolved marketplace-relative directory; `git-subdir` clones a repo
 *  and takes a subdirectory of it; `remote-zip` downloads an ARCHIVE.
 *
 *  Marketplace `{source:"url"}` entries split across `git` and `remote-zip` by
 *  URL shape (see urlLooksLikeArchive) — the official catalog's 152 of them are
 *  all `https://github.com/<owner>/<repo>.git`. */
type StageKind = "git" | "git-subdir" | "local-dir" | "local-zip" | "marketplace-path" | "remote-zip";

interface StageSource {
  kind: StageKind;
  ref: string;
  /** Branch/tag for git sources. */
  gitRef?: string;
  /** Subdirectory inside the cloned tree (git-subdir sources only). */
  subPath?: string;
}

interface StageOutcome {
  stagingDir: string;
  /** The staged directory that actually holds the manifest (may be nested
   *  one level below stagingDir — zip wrapper / git checkout root). */
  pluginRoot: string;
  manifest: PluginManifest;
  version: string;
}

function makeStagingDir(): string {
  return path.join(PLUGINS_ROOT, `.staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

/** Materialize `source` into a fresh staging dir and resolve its manifest.
 *  Throws user-presentable Chinese errors; the staging dir is removed on
 *  failure, and stays behind on success for finalizePluginInstall. */
async function stagePluginSource(source: StageSource): Promise<StageOutcome> {
  await fs.mkdir(PLUGINS_ROOT, { recursive: true });
  const stagingDir = makeStagingDir();
  await fs.mkdir(stagingDir, { recursive: true });
  try {
    if (source.kind === "git") {
      await gitClone(source.ref, path.join(stagingDir, "repo"), source.gitRef);
      await fs.rm(path.join(stagingDir, "repo", ".git"), { recursive: true, force: true });
    } else if (source.kind === "git-subdir") {
      // Official-marketplace shape `{source:"git-subdir", url, path, ref?}` —
      // clone the tree, then take only `path` (the clone lives in staging and
      // is discarded wholesale, so the subPath must merely stay inside it).
      await gitClone(source.ref, path.join(stagingDir, "repo"), source.gitRef);
      const sub = path.resolve(path.join(stagingDir, "repo"), source.subPath ?? "");
      const rel = path.relative(path.join(stagingDir, "repo"), sub);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`git-subdir 的 path 逃逸出仓库:${source.subPath}`);
      }
      if (!existsSync(sub) || !statSync(sub).isDirectory()) {
        throw new Error(`git-subdir 子目录不存在:${source.subPath}`);
      }
      await fs.cp(sub, path.join(stagingDir, "plugin"), { recursive: true });
      await fs.rm(path.join(stagingDir, "repo"), { recursive: true, force: true });
    } else if (source.kind === "remote-zip") {
      // `{source:"url", url}` whose path ends in an archive extension — fetch it
      // and run the same platform extraction as local zips. Transport/proxy
      // policy lives in downloadFile (same discipline as gitClone).
      const tmpZip = path.join(stagingDir, "..", `.dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.zip`);
      try {
        await downloadFile(source.ref, tmpZip);
        try {
          await extractZip(tmpZip, stagingDir);
        } catch (err) {
          // The URL claimed an archive but the bytes say otherwise — point at
          // the likely mistake instead of leaving a bare tar error.
          throw new Error(
            `${err instanceof Error ? err.message : String(err)}。该地址看起来是压缩包但无法解压;若它其实是 git 仓库,请改用「从 Git 安装」`,
          );
        }
      } finally {
        await fs.rm(tmpZip, { force: true }).catch(() => {});
      }
    } else if (source.kind === "local-zip") {
      await extractZip(source.ref, stagingDir);
    } else {
      // local-dir / marketplace-path: plain copy; never ship a .git tree.
      const src = path.resolve(source.ref);
      if (!existsSync(src) || !statSync(src).isDirectory()) {
        throw new Error(`插件目录不存在:${src}`);
      }
      await fs.cp(src, path.join(stagingDir, "plugin"), { recursive: true });
      await fs.rm(path.join(stagingDir, "plugin", ".git"), { recursive: true, force: true });
    }

    // Marketplace repos (`.claude-plugin/marketplace.json` + one dir per
    // plugin — the official claude-plugins-official shape) must NOT be
    // installed as a plugin: their manifest probe would silently pick one of
    // the plugin children. Redirect to the marketplace flow with an explicit
    // message instead of a confusing "manifest not found".
    if (findMarketplaceManifestFile(stagingDir)) {
      throw new Error(
        "该仓库是插件市场(marketplace)而非单个插件。请在下方「插件市场」区域添加该 git 地址,再从市场列表中安装插件。",
      );
    }

    const resolved = findPluginManifestDeep(stagingDir);
    if (!resolved) {
      throw new Error(
        "未找到插件清单:目录里没有 .claude-plugin/.zcode-plugin/.codex-plugin 的 plugin.json",
      );
    }
    const manifest = PluginManifestSchema.parse(resolved.manifest);
    return { stagingDir, pluginRoot: resolved.rootDir, manifest, version: pluginVersionOf(manifest) };
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Copy the staged plugin into its final `plugins/<name>/<version>/` slot,
 *  write the install record, prune other versions (single-version model).
 *  Copies (not renames) so the staging tree can be cleaned uniformly after. */
async function finalizePluginInstall(stage: StageOutcome, source: PluginSourceInfo): Promise<string> {
  if (isReservedPluginName(stage.manifest.name)) {
    throw new Error(`插件名 ${stage.manifest.name} 与插件目录的内部文件夹冲突,已拒绝安装`);
  }
  const nameDir = path.join(PLUGINS_ROOT, stage.manifest.name);
  const finalDir = path.join(nameDir, stage.version);
  // The swap and prune below delete siblings of finalDir; it must be exactly
  // one level below this plugin's own directory.
  if (path.dirname(finalDir) !== nameDir || path.basename(finalDir) !== stage.version) {
    throw new Error(`插件版本号不能用作目录名,已拒绝安装:${stage.version}`);
  }
  await fs.mkdir(path.dirname(finalDir), { recursive: true });
  // Stage the new copy BESIDE the final slot, then swap — a same-version
  // reinstall never leaves a half-copied directory at the live path.
  const swapDir = `${finalDir}.swapping-${Date.now()}`;
  await fs.cp(stage.pluginRoot, swapDir, { recursive: true });
  const record: InstallRecord = { source, installedAt: new Date().toISOString() };
  await fs.writeFile(
    path.join(swapDir, INSTALL_RECORD_FILE),
    JSON.stringify(record, null, 2),
    "utf-8",
  );
  const backupDir = `${finalDir}.backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let backedUp = false;
  try {
    if (existsSync(finalDir)) {
      await fs.rename(finalDir, backupDir);
      backedUp = true;
    }
    await fs.rename(swapDir, finalDir);
    if (backedUp) await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
  } catch (err) {
    await fs.rm(swapDir, { recursive: true, force: true }).catch(() => {});
    if (backedUp && !existsSync(finalDir)) {
      await fs.rename(backupDir, finalDir).catch(() => {});
    }
    throw err;
  }
  // 清理其它版本是**尽力而为**:新版本已经就位,某个旧目录被占用(EBUSY / EPERM)
  // 不能把一次成功的安装报成失败。删不掉的留到下次安装再清(`installedRootOf` 会跳过它)。
  for (const other of readdirSync(path.join(PLUGINS_ROOT, stage.manifest.name))) {
    if (other === stage.version) continue;
    try {
      rmSync(path.join(PLUGINS_ROOT, stage.manifest.name, other), { recursive: true, force: true });
    } catch (err) {
      console.warn(`[plugins] 旧版本目录暂时删不掉,下次再清:${other}(${(err as Error).message})`);
    }
  }
  return finalDir;
}

export interface InstallResult {
  ok: boolean;
  error?: string;
  plugin?: PluginState;
}

async function installFromSource(source: StageSource, sourceInfo?: PluginSourceInfo): Promise<InstallResult> {
  if (installing.has(source.ref)) {
    return { ok: false, error: "该来源正在安装中" };
  }
  installing.add(source.ref);
  try {
    const stage = await stagePluginSource(source);
    try {
      const pluginName = stage.manifest.name;
      if (finalizingPluginNames.has(pluginName)) {
        return { ok: false, error: `插件 ${pluginName} 正在安装中` };
      }
      finalizingPluginNames.add(pluginName);
      try {
        const finalDir = await finalizePluginInstall(stage, sourceInfo ?? { kind: "local-dir", ref: source.ref });
        const state = toPluginState(finalDir, new Set(readEnabledPlugins()));
        return state ? { ok: true, plugin: state } : { ok: false, error: "安装后清单解析失败" };
      } finally {
        finalizingPluginNames.delete(pluginName);
      }
    } finally {
      await fs.rm(stage.stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    installing.delete(source.ref);
  }
}

/** Install from a local plugin directory or .zip archive. */
export async function installFromLocal(localPath: string): Promise<InstallResult> {
  const abs = path.resolve(localPath);
  if (!existsSync(abs)) return { ok: false, error: `路径不存在:${abs}` };
  const st = statSync(abs);
  if (!st.isDirectory() && !st.isFile()) return { ok: false, error: "路径既非目录也非文件" };
  const kind: StageKind = st.isFile() ? "local-zip" : "local-dir";
  if (kind === "local-zip" && !abs.toLowerCase().endsWith(".zip")) {
    return { ok: false, error: "暂只支持安装插件目录或 .zip 包" };
  }
  return installFromSource({ kind, ref: abs }, { kind, ref: abs });
}

/** Install by shallow-cloning a git repository. */
export async function installFromGit(url: string, ref?: string): Promise<InstallResult> {
  return installFromSource(
    { kind: "git", ref: url, gitRef: ref },
    { kind: "git", ref: url },
  );
}

/* ── Enable / disable / remove ── */

export function setPluginEnabled(name: string, enabledValue: boolean): { ok: boolean; error?: string } {
  if (!PLUGIN_NAME_RE.test(name) || isReservedPluginName(name)) return { ok: false, error: "非法插件名" };
  // 【MC-030】目录读不了 **不是** "未安装":从前这里只判 `installedRootOf` 为 null
  //   就报"未安装",用户会去重装一个其实还在的插件。读不了要如实说是读不了。
  const probe = probeInstalledDir(name);
  if (isUnreadableProbe(probe)) {
    return { ok: false, error: `插件 ${name} 的目录读不了(ACL/磁盘错误?),无法读取安装信息:${probe.error.message}` };
  }
  if (!installedRootFrom(probe)) return { ok: false, error: `插件 ${name} 未安装` };
  // 【MC-019】启用名单损坏时拒绝写 — 读-改-写会把坏值洗成"合法"名单,
  // 而兜底空表 = 全部停用(用户会以为只动了一个插件)。
  const refuse = refuseIfCorrupt(PLUGINS_ENABLED_SETTING_KEY, isPluginNameListShape);
  if (refuse) return refuse;
  const names = readEnabledPlugins().filter((n) => n !== name);
  if (enabledValue) names.push(name);
  writeEnabledPlugins(names);
  // 【MC-061 复审修复】停用即**同步撤销该插件的全部 hook 授权** —— 与卸载同一纪律。
  // 否则「停用插件后,它的 hook 仍凭旧授权在跑」是一条静默的信任残留(独立复审点名)。
  if (!enabledValue) revokeHostHookGrants(name);
  return { ok: true };
}

export function removePlugin(name: string): { ok: boolean; error?: string } {
  if (!PLUGIN_NAME_RE.test(name) || isReservedPluginName(name)) return { ok: false, error: "非法插件名" };
  // 【MC-030】读不了的目录**不删**。它可能只是暂时读不了(ACL / 磁盘),而里面是
  //   用户的插件文件 —— 不能在"看不见里面有什么"的时候动手。从前这里 `existsSync`
  //   为真就继续,后面 `renameSync` 会得到同样的错误但被包装成"文件被占用"的误导话术。
  const probe = probeInstalledDir(name);
  if (isUnreadableProbe(probe)) {
    return { ok: false, error: `插件 ${name} 的目录读不了(ACL/磁盘错误?),未做任何改动:${probe.error.message}` };
  }
  if (probe.kind === "absent") return { ok: false, error: `插件 ${name} 未安装` };
  const base = probe.base;
  // 【MC-019】逐个键检查它**无条件回写**的那两个策略键:启用名单与 MCP 禁用名单。
  // 损坏时回写会把坏值洗成兜底空表 —— 别的插件静默停用 / 别的已关服务静默放开。
  // 放在任何文件改动之前:拒绝要干净,不留"目录删了、设置没动"的半截。
  // (未安装的早退在上面:那条路径一个字节都不写,没有可洗的东西。)
  const refuse =
    refuseIfCorrupt(PLUGINS_ENABLED_SETTING_KEY, isPluginNameListShape) ??
    refuseIfCorrupt(PLUGINS_MCP_DISABLED_SETTING_KEY, isPluginNameListShape);
  if (refuse) return refuse;
  // 先整体改名挪开再删:Windows 上插件文件被占用(它的 MCP 服务还在跑)时,直接
  // `rmSync` 会删掉一半后抛出 —— 插件残缺却仍处于启用状态。改名要么整体成功、要么
  // 什么都没动,失败就如实告诉用户。
  const trash = path.join(PLUGINS_ROOT, `.removing-${name}-${Date.now()}`);
  try {
    renameSync(base, trash);
  } catch (err) {
    return {
      ok: false,
      error: `插件 ${name} 的文件正被占用(可能它的 MCP 服务还在运行),请结束相关对话或重启应用后再删除:${(err as Error).message}`,
    };
  }
  try {
    rmSync(trash, { recursive: true, force: true });
  } catch {
    /* 已经挪出插件目录、不会再被加载;残留的临时目录不影响使用 */
  }
  writeEnabledPlugins(readEnabledPlugins().filter((n) => n !== name));
  const enginesMap = readPluginEnginesMap();
  if (name in enginesMap) {
    delete enginesMap[name];
    writeJsonSetting(PLUGINS_ENGINES_SETTING_KEY, enginesMap);
  }
  // Drop this plugin's per-project overrides.
  const projectMap = readPluginProjectMap();
  let projectMapChanged = false;
  for (const [key, rows] of Object.entries(projectMap)) {
    if (!(name in rows)) continue;
    delete rows[name];
    if (Object.keys(rows).length === 0) delete projectMap[key];
    projectMapChanged = true;
  }
  if (projectMapChanged) writeJsonSetting(PLUGINS_PROJECT_SETTING_KEY, projectMap);
  // Drop this plugin's per-server MCP toggles (namespaced `<name>__`).
  const mcpDisabled = [...readMcpDisabled()].filter((n) => !n.startsWith(`${name}__`));
  writeJsonSetting(PLUGINS_MCP_DISABLED_SETTING_KEY, mcpDisabled);
  // 【MC-061 复审修复】卸载即**同步撤销该插件的全部 hook 授权** —— 台账「卸载后 hook
  // 同步撤销」就落在这一句真实调用上,不是需要各入口自己记得。
  revokeHostHookGrants(name);
  return { ok: true };
}

/* ── Marketplaces ── */

/** Canonical form of a git URL for identity comparison: case, trailing slashes
 *  and a `.git` suffix are noise — the same repository typed as
 *  `https://github.com/x/y`, `.../y.git` or with a trailing slash must match
 *  one built-in entry, not produce three. */
function normalizeGitUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

const BUILTIN_MARKETPLACE_URLS = new Set(BUILTIN_MARKETPLACES.map((b) => normalizeGitUrl(b.url)));

/** True for a record pointing at one of the shipped catalogs (tested by URL, so
 *  it also holds for records written before the URL was declared built-in). */
function isBuiltinMarketplaceRecord(rec: PluginMarketplaceRecord): boolean {
  return (
    rec.builtin === true ||
    (rec.source.kind === "git" && BUILTIN_MARKETPLACE_URLS.has(normalizeGitUrl(rec.source.ref)))
  );
}

/** Materialize a record for every shipped marketplace that is missing, and
 *  adopt an existing copy of the same repository (matched by URL) as built-in.
 *  Idempotent and write-free unless something actually changed, so it is safe
 *  to call on every list. User records keep their order; new built-ins append
 *  (a user's own catalogs stay first, which is also where the panel opens). */
function ensureBuiltinMarketplaceRecords(
  records: PluginMarketplaceRecord[],
  opts?: { persist?: boolean },
): PluginMarketplaceRecord[] {
  let changed = false;
  const knownUrls = new Set<string>();
  const out: PluginMarketplaceRecord[] = [];
  for (const rec of records) {
    if (rec.source.kind === "git") knownUrls.add(normalizeGitUrl(rec.source.ref));
    if (isBuiltinMarketplaceRecord(rec) && rec.builtin !== true) {
      changed = true;
      out.push({ ...rec, builtin: true });
    } else {
      out.push(rec);
    }
  }
  for (const def of BUILTIN_MARKETPLACES) {
    if (knownUrls.has(normalizeGitUrl(def.url))) continue;
    // Name clash with an unrelated user marketplace: skip this one rather than
    // taking over a directory the user is already using under that name.
    if (out.some((r) => r.name === def.name)) continue;
    out.push({
      name: def.name,
      source: { kind: "git", ref: def.url },
      addedAt: new Date().toISOString(),
      builtin: true,
    });
    changed = true;
  }
  if (changed && opts?.persist !== false) writeJsonSetting(PLUGINS_MARKETPLACES_SETTING_KEY, out);
  return out;
}

/** Locate + parse a marketplace tree's manifest
 *  (`.claude-plugin/marketplace.json`, root `marketplace.json` fallback).
 *
 *  Entry-level tolerance: the official marketplace mixes several `source`
 *  shapes and keeps adding new ones, so ONE unrecognized entry must not blank
 *  the whole catalog — when the strict schema rejects the manifest, entries
 *  are re-validated individually and only the bad ones are skipped. */
/** Manifest files probed in a marketplace tree, in order, with the ecosystem
 *  each layout belongs to. Codex catalogs (openai/plugins) keep theirs under
 *  `.agents/plugins/`; `api_marketplace.json` is the list Codex shows to
 *  API-key logins — Mcode's Codex runs that way — so it wins over the
 *  ChatGPT-login `marketplace.json` (which adds app-only plugins). */
const MARKETPLACE_MANIFEST_CANDIDATES: ReadonlyArray<{ rel: string; ecosystem: PluginEcosystem }> = [
  { rel: path.join(".claude-plugin", "marketplace.json"), ecosystem: "claude" },
  { rel: "marketplace.json", ecosystem: "claude" },
  { rel: path.join(".agents", "plugins", "api_marketplace.json"), ecosystem: "codex" },
  { rel: path.join(".agents", "plugins", "marketplace.json"), ecosystem: "codex" },
];

/** Ecosystem of a marketplace tree from its manifest layout (null: none). */
function marketplaceEcosystemOf(dir: string): PluginEcosystem | null {
  const hit = MARKETPLACE_MANIFEST_CANDIDATES.find((c) => existsSync(path.join(dir, c.rel)));
  return hit ? hit.ecosystem : null;
}

const ZCODE_MARKETPLACE_URL = normalizeGitUrl(
  BUILTIN_MARKETPLACES.find((b) => b.name === "zcode-plugins-official")?.url ?? "",
);
const CODEX_MARKETPLACE_URL = normalizeGitUrl(
  BUILTIN_MARKETPLACES.find((b) => b.name === "codex-plugins-official")?.url ?? "",
);

/** Ecosystem shown on a marketplace tab: the manifest layout once cloned; the
 *  built-in URL decides before that (and marks ZCode's Claude-layout catalog). */
function recordEcosystem(rec: PluginMarketplaceRecord, dir: string): PluginEcosystem | undefined {
  const url = rec.source.kind === "git" ? normalizeGitUrl(rec.source.ref) : "";
  if (url && url === ZCODE_MARKETPLACE_URL) return "zcode";
  const fromTree = existsSync(dir) ? marketplaceEcosystemOf(dir) : null;
  if (fromTree) return fromTree;
  if (url && url === CODEX_MARKETPLACE_URL) return "codex";
  if (url && BUILTIN_MARKETPLACE_URLS.has(url)) return "claude";
  return undefined;
}

function readMarketplaceManifest(dir: string) {
  const candidates = MARKETPLACE_MANIFEST_CANDIDATES.map((c) => path.join(dir, c.rel));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf-8"));
      const parsed = PluginMarketplaceManifestSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      if (raw && typeof raw === "object" && Array.isArray((raw as { plugins?: unknown }).plugins)) {
        const obj = raw as { name?: unknown; owner?: unknown; plugins: unknown[] };
        const plugins: z.infer<typeof PluginMarketEntrySchema>[] = [];
        for (const entry of obj.plugins) {
          const ep = PluginMarketEntrySchema.safeParse(entry);
          if (ep.success) plugins.push(ep.data);
        }
        if (plugins.length > 0) {
          return {
            name: typeof obj.name === "string" ? obj.name : undefined,
            owner: typeof obj.owner === "string" ? obj.owner : undefined,
            plugins,
          };
        }
      }
      return null; // present but unusable
    } catch {
      return null;
    }
  }
  return null;
}

function marketplaceDirOf(name: string): string {
  return path.join(MARKETPLACES_DIR, name);
}

/** Materialize a marketplace tree into `dest` (must not exist; staged under
 *  MARKETPLACES_DIR's parent so the final rename stays on one filesystem). */
async function materializeMarketplaceTree(
  source: { kind: "git" | "local"; ref: string },
  dest: string,
  progress?: MarketProgressSink,
): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (source.kind === "git") {
    await gitClone(source.ref, dest, undefined, progress);
    await fs.rm(path.join(dest, ".git"), { recursive: true, force: true });
  } else {
    const src = path.resolve(source.ref);
    if (!existsSync(src) || !statSync(src).isDirectory()) {
      throw new Error(`marketplace 目录不存在:${src}`);
    }
    await fs.cp(src, dest, { recursive: true });
    await fs.rm(path.join(dest, ".git"), { recursive: true, force: true });
  }
}

/** Add a marketplace (git URL or local directory). The display name comes
 *  from the explicit override or the manifest's own `name`; the last resort
 *  is a sanitized form of the ref. */
export async function addMarketplace(input: {
  kind: "git" | "local";
  ref: string;
  name?: string;
}, progress?: MarketProgressSink): Promise<{ ok: boolean; error?: string; corrupt?: boolean }> {
  // 【MC-037】写回前先问健康度:损坏记录拒绝进入修改事务(原设置行一个不动)。
  const state = readMarketplaceRecordsState();
  if (state.kind === "corrupt") {
    return { ok: false, error: marketRegistryCorruptMessage("插件市场", state.reason), corrupt: true };
  }
  const records = state.kind === "ok" ? state.records : [];
  // Same repository (however it was spelled) already listed — usually one of the
  // shipped catalogs, which must be refreshed rather than added a second time.
  if (
    input.kind === "git" &&
    records.some(
      (r) => r.source.kind === "git" && normalizeGitUrl(r.source.ref) === normalizeGitUrl(input.ref),
    )
  ) {
    return { ok: false, error: `该仓库已在插件市场中:${input.ref}` };
  }
  const staging = path.join(PLUGINS_ROOT, `.mp-staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await materializeMarketplaceTree({ kind: input.kind, ref: input.ref }, staging, progress);
    progress?.({ phase: "scan", message: "校验插件市场 / Validating plugin catalog", elapsedMs: 0 });
    const manifest = readMarketplaceManifest(staging);
    if (!manifest) {
      throw new Error(
        "marketplace 清单缺失或无效(需要 .claude-plugin/marketplace.json 或 Codex 的 .agents/plugins/marketplace.json)",
      );
    }
    const rawName = input.name ?? manifest.name ?? sanitizeMarketplaceName(input.ref);
    if (!PLUGIN_NAME_RE.test(rawName)) {
      throw new Error(`marketplace 名称非法:${rawName}`);
    }
    if (records.some((r) => r.name === rawName)) {
      throw new Error(`同名 marketplace 已存在:${rawName}`);
    }
    const dest = marketplaceDirOf(rawName);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await promoteMarketCatalog(staging, dest);
    // 【MC-037 时序变体】materialize/校验是 await 窗口(本地 fs.cp,git 还要 clone):
    // 写回前必须**重读**记录。从前这里用入口处的 `records` 快照整表覆盖 ——
    // 窗口内记录被并发改写/砸坏时,新增的 marketplace 会丢、坏档会被覆盖。
    // 与技能/MCP 市场共用同一判据(`lib/marketRegistry.ts`):损坏拒绝且原值不动。
    const fresh = recheckMarketRegistryBeforeWrite(readMarketplaceRecordsState(), "插件市场");
    if (!fresh.ok) return fresh;
    if (fresh.base.some((r) => r.name === rawName)) {
      // 窗口内已有人建了同名市场 —— 不覆盖别人的记录。目录可能已被对方写,
      // 这里不删(删了可能删掉对方刚 promote 的树),记录才是真相层。
      return { ok: false, error: `同名 marketplace 已存在:${rawName}(记录在添加期间被其他操作更新)` };
    }
    writeJsonSetting(PLUGINS_MARKETPLACES_SETTING_KEY, [
      ...fresh.base,
      {
        name: rawName,
        source: { kind: input.kind, ref: input.ref },
        addedAt: new Date().toISOString(),
      },
    ]);
    return { ok: true };
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function sanitizeMarketplaceName(ref: string): string {
  // "owner/repo" or a URL tail — keep the last path segment, strip .git.
  const tail = ref.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "marketplace";
  const cleaned = tail.replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "-");
  return cleaned || "marketplace";
}

export function removeMarketplace(name: string): { ok: boolean; error?: string; corrupt?: boolean } {
  // 【MC-037】坏表时"不存在"是谎 —— 记录可能就在坏字节里;拒绝而非覆盖。
  const state = readMarketplaceRecordsState();
  if (state.kind === "corrupt") {
    return { ok: false, error: marketRegistryCorruptMessage("插件市场", state.reason), corrupt: true };
  }
  const records = state.kind === "ok" ? state.records : [];
  const rec = records.find((r) => r.name === name);
  if (!rec) return { ok: false, error: `marketplace ${name} 不存在` };
  // Shipped catalogs are part of the product surface, not user state: the panel
  // hides their remove action, and this is the guard for any other caller.
  if (isBuiltinMarketplaceRecord(rec)) {
    return { ok: false, error: `内置插件市场不可移除,可刷新:${name}` };
  }
  writeJsonSetting(
    PLUGINS_MARKETPLACES_SETTING_KEY,
    records.filter((r) => r.name !== name),
  );
  rmSync(marketplaceDirOf(name), { recursive: true, force: true });
  return { ok: true };
}

/** Re-fetch a marketplace tree (git: fresh clone; local: re-copy). */
export async function refreshMarketplace(name: string, progress?: MarketProgressSink): Promise<{ ok: boolean; error?: string; corrupt?: boolean }> {
  // 【MC-037】刷新不写 records(只动目录),但坏表时"不存在"仍是谎 —— 同样拒绝。
  const state = readMarketplaceRecordsState();
  if (state.kind === "corrupt") {
    return { ok: false, error: marketRegistryCorruptMessage("插件市场", state.reason), corrupt: true };
  }
  const record = (state.kind === "ok" ? state.records : []).find((r) => r.name === name);
  if (!record) return { ok: false, error: `marketplace ${name} 不存在` };
  const dest = marketplaceDirOf(name);
  const staging = path.join(PLUGINS_ROOT, `.mp-staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await materializeMarketplaceTree(record.source, staging, progress);
    progress?.({ phase: "scan", message: "校验插件市场 / Validating plugin catalog", elapsedMs: 0 });
    if (!readMarketplaceManifest(staging)) throw new Error("市场清单无效，保留原有目录 / Invalid manifest; previous catalog preserved");
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await promoteMarketCatalog(staging, dest);
    return { ok: true };
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** All marketplaces with their parsed entries; `installed` matched against
 *  the installed plugin set by name. */
export function listMarketplaces(): PluginMarketplaceState[] {
  const installed = new Set(listPlugins().map((p) => p.name));
  // Also the seeding point for the shipped catalogs: any list call (i.e. opening
  // the plugin panel) makes sure they are present in the records.
  // 【MC-037】但**损坏时绝不能落盘** —— 从前 readMarketplaceRecords 把坏表降级成
  // 空表,ensureBuiltin 往空表里塞出厂项再整表写回:**打开一次面板就抹掉了用户的
  // 自定义市场记录**(比 add 路径更早、更隐蔽)。损坏时退回纯内存合并(展示照常),
  // 一个字节不写。
  const state = readMarketplaceRecordsState();
  const records = state.kind === "ok" ? state.records : [];
  const merged = state.kind === "corrupt"
    ? ensureBuiltinMarketplaceRecords(records, { persist: false })
    : ensureBuiltinMarketplaceRecords(records);
  return merged.map((rec) => {
    const dir = marketplaceDirOf(rec.name);
    const manifest = existsSync(dir) ? readMarketplaceManifest(dir) : null;
    const ecosystem = recordEcosystem(rec, dir);
    const plugins: PluginMarketEntry[] = [];
    for (const e of manifest?.plugins ?? []) {
      // Codex entry policy: NOT_AVAILABLE entries are hidden by Codex itself.
      if (entryInstallPolicy(e) === "NOT_AVAILABLE") continue;
      const local = localEntryPath(e.source);
      const peek = local !== null ? peekMarketplaceEntry(dir, local) : null;
      plugins.push({
        marketplace: rec.name,
        name: e.name,
        // Codex catalogs carry no description/version in the entry — the
        // plugin's own manifest (already in the cloned tree) has them.
        description: e.description || peek?.description || "",
        version: e.version || peek?.version || "",
        installed: installed.has(e.name),
        ...(peek ? { compatibleProviderIds: peek.compatibleProviderIds } : {}),
        ...(peek?.appsOnly ? { appsOnly: true } : {}),
      });
    }
    return {
      name: rec.name,
      sourceKind: rec.source.kind,
      sourceRef: rec.source.ref,
      addedAt: rec.addedAt,
      builtin: rec.builtin === true,
      cloned: existsSync(dir),
      ...(ecosystem ? { ecosystem } : {}),
      plugins,
    };
  });
}

/** `policy.installation` of a Codex marketplace entry (undefined elsewhere). */
function entryInstallPolicy(entry: object): string | undefined {
  const policy = (entry as { policy?: unknown }).policy;
  if (!policy || typeof policy !== "object") return undefined;
  const installation = (policy as { installation?: unknown }).installation;
  return typeof installation === "string" ? installation : undefined;
}

/** The marketplace-relative path of a local entry source (bare string or
 *  Codex `{source:"local", path}`), or null for remote sources. */
function localEntryPath(src: PluginMarketEntrySource): string | null {
  if (typeof src === "string") return src;
  return src.source === "local" ? src.path : null;
}

interface MarketEntryPeek {
  description: string;
  version: string;
  compatibleProviderIds: string[];
  appsOnly: boolean;
}

/** Peek cache, keyed by the entry's directory + its mtime: a refresh re-clones
 *  the catalog (new directory mtime), so stale results cannot survive it. */
const marketPeekCache = new Map<string, { mtimeMs: number; peek: MarketEntryPeek | null }>();

/** Inspect a local-path marketplace entry inside the cloned catalog, so the
 *  catalog can say which engines can use it BEFORE install. Null when the path
 *  escapes the catalog, is missing, or holds no valid manifest. */
function peekMarketplaceEntry(dir: string, rel: string): MarketEntryPeek | null {
  if (path.isAbsolute(rel)) return null;
  const abs = path.resolve(dir, rel);
  const back = path.relative(dir, abs);
  if (!back || back.startsWith("..") || path.isAbsolute(back)) return null;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(abs).mtimeMs;
  } catch {
    return null;
  }
  const cached = marketPeekCache.get(abs);
  if (cached && cached.mtimeMs === mtimeMs) return cached.peek;
  let peek: MarketEntryPeek | null = null;
  try {
    const resolved = findPluginManifest(abs);
    if (resolved) {
      const components = summarizeComponents(abs, resolved.manifest);
      const usable =
        components.skills.length +
        components.commands.length +
        components.agents.length +
        components.hooks.length +
        components.mcpServers.length;
      peek = {
        description: resolved.manifest.description ?? "",
        version: resolved.manifest.version ?? "",
        compatibleProviderIds: compatibleProviderIdsForPlugin(resolved.manifest, components),
        appsOnly: usable === 0 && (components.apps?.length ?? 0) > 0,
      };
    }
  } catch {
    peek = null;
  }
  marketPeekCache.set(abs, { mtimeMs, peek });
  return peek;
}

/** True when a marketplace `{source:"url"}` points at a downloadable archive
 *  rather than a repository.
 *
 *  The Claude marketplace schema uses `url` for BOTH, and a repository URL is
 *  the dominant case by far — all 152 `url` entries of
 *  anthropics/claude-plugins-official are `https://github.com/<owner>/<repo>.git`
 *  (verified against the real manifest). Treating those as downloads fetched
 *  GitHub's HTML repo page with HTTP 200 and handed it to tar, which failed
 *  with the very unhelpful "Unrecognized archive format" — half the catalog
 *  could not be installed. Only an archive-extension path is downloaded. */
function urlLooksLikeArchive(url: string): boolean {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    /* not a parseable URL — fall back to the raw string */
  }
  return /\.(zip|tgz|tar\.gz|tar)$/i.test(pathname);
}

/** Resolve a marketplace entry's `source` into an installable source.
 *  Relative paths must stay inside the marketplace tree (same path
 *  discipline as plugin component paths). */
function resolveMarketplaceEntrySource(
  marketplaceName: string,
  entryName: string,
): StageSource & { info: PluginSourceInfo } {
  const rec = readMarketplaceRecords().find((r) => r.name === marketplaceName);
  if (!rec) throw new Error(`marketplace ${marketplaceName} 不存在`);
  const dir = marketplaceDirOf(marketplaceName);
  const manifest = existsSync(dir) ? readMarketplaceManifest(dir) : null;
  const entry = manifest?.plugins.find((p) => p.name === entryName);
  if (!entry) throw new Error(`marketplace ${marketplaceName} 中没有插件 ${entryName}`);

  const src: PluginMarketEntrySource = entry.source;
  if (typeof src === "string" || src.source === "local") {
    const localRel = typeof src === "string" ? src : src.path;
    if (path.isAbsolute(localRel)) throw new Error("marketplace 条目 source 不允许绝对路径");
    const abs = path.resolve(dir, localRel);
    const rel = path.relative(dir, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("marketplace 条目 source 逃逸出 marketplace 目录");
    }
    if (!existsSync(abs)) throw new Error(`marketplace 条目路径不存在:${localRel}`);
    return {
      kind: "marketplace-path",
      ref: abs,
      info: { kind: "marketplace", ref: `${marketplaceName}:${localRel}` },
    };
  }
  if (src.source === "github") {
    const url = `https://github.com/${src.repo}.git`;
    return {
      kind: "git",
      ref: url,
      info: { kind: "marketplace", ref: `${marketplaceName}:github/${src.repo}` },
    };
  }
  if (src.source === "git-subdir") {
    return {
      kind: "git-subdir",
      ref: src.url,
      gitRef: src.ref,
      subPath: src.path,
      info: { kind: "marketplace", ref: `${marketplaceName}:${src.url}#${src.path}` },
    };
  }
  if (src.source === "url") {
    return {
      kind: urlLooksLikeArchive(src.url) ? "remote-zip" : "git",
      ref: src.url,
      info: { kind: "marketplace", ref: `${marketplaceName}:${src.url}` },
    };
  }
  // git
  return {
    kind: "git",
    ref: src.url,
    gitRef: src.ref,
    info: { kind: "marketplace", ref: `${marketplaceName}:${src.url}` },
  };
}

export async function installFromMarketplace(
  marketplaceName: string,
  entryName: string,
): Promise<InstallResult> {
  try {
    const { info, ...source } = resolveMarketplaceEntrySource(marketplaceName, entryName);
    return await installFromSource(source, info);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ── Provider delivery queries ──
 * Called at turn start by the three providers; each call re-reads the
 * enabled set + rescans the (tiny) plugin trees, so enable/disable lands on
 * the very next turn without any invalidation protocol. */

export interface EnabledPlugin {
  name: string;
  rootDir: string;
  manifest: PluginManifest;
  /** Providers this plugin is DELIVERED to: what its components allow
   *  ({@link compatibleProviderIdsForPlugin}) narrowed by the user's per-engine
   *  switches (plugins.engines). Every delivery point filters on this. */
  compatibleProviderIds: string[];
  /** The effective per-engine switches (global ∘ project override). */
  engines?: PluginEngineSwitches;
  /** True when the plugin declares hooks (parsed for display; v1 never
   *  executes them — the Claude provider's disableAllHooks is the backstop). */
  hasHooks: boolean;
  /** 【ARC-003】逐引擎的**逐组件交付报告**(见 {@link componentDeliveryReport})。
   *  一个已启用插件对三个内置引擎各一份,喂能力目录时翻成 `component:<providerId>:<componentId>`
   *  标签 —— 目录因此有**组件级**可用性,而不只是 `compatibleProviderIds` 的 ANY。
   *  与 `pluginComponentReadiness` 取同一份事实(都走 `componentDeliveryReport`)。 */
  componentReports: ComponentDeliveryReport[];
  /** True for plugins shipped inside the app (see builtinPlugins.ts). They are
   *  always delivered, appear in no marketplace, and cannot be uninstalled —
   *  the Plugins panel renders them as a read-only row. */
  builtin?: boolean;
}

/**
 * Resolve the currently enabled plugins (missing dirs silently skipped).
 *
 * ## 内置插件在 2026-09-20 删掉了
 *
 * 从前这里会无条件追加一条内置项（`mcode-document-skills`，随应用发布的那四个文档
 * 技能）。用户决定不要内置技能了 —— 以后一律从 GitHub 自己导 —— 于是那个包连同
 * 只服务于它的 `builtinPlugins.ts` 一起删了。
 *
 * **这条投递链本身没动**：它照旧只认 `readEnabledPlugins()` 里那些名字。将来若要
 * 再加内置插件（比如期刊分区、文献检索），在这一层重新追加即可 —— 调用点用的还是
 * `...getEnabledPlugins()` 展开，不用改。
 */
export async function getEnabledPlugins(projectPath?: string): Promise<EnabledPlugin[]> {
  return enabledPluginsNow(projectPath);
}

/**
 * {@link getEnabledPlugins} 的**同步核心** —— 整段本来就全同步(读设置表、扫插件根、
 * 解析清单都是同步的),`async` 只是既有签名。抽出来是因为宿主 `HookRunner` 的事件分发
 * 路径上要给一条**同步**的"现在有哪些启用插件"读法(见 `enabledPluginHookDeclarations`),
 * 而多写第二份扫描逻辑 = 迟早与这一份分家。**只有这一份扫描。**
 */
export function enabledPluginsNow(projectPath?: string): EnabledPlugin[] {
  // 【MC-019】先过**配置健康闸**:启用名单 / 项目覆盖 / 引擎开关三个策略键,
  //   任一个"存在但读不懂"→ 本轮**拒绝投递全部插件**(fail-closed)。
  //   从前坏 JSON 会静默落进各自的兜底值(空表 / 全开),而兜底方向恰好是放宽:
  //   `p:{pi:false}` 截断成 `{broken` 后 `pluginEngineSwitches('p')` 得 `pi:true`,
  //   被禁用的插件被"默认开启"重新投递。损坏不是"没配过",不能拿兜底值继续算。
  //   损坏同时经 reportCorruptPluginSetting 显式报告(console.warn,含键名与原因)。
  //   刻意不短路(逐个检查全部键):多键同时损坏时每个键都要有机会被报出来。
  let corrupt = false;
  for (const [key, shape] of PLUGIN_DELIVERY_POLICY_KEYS) {
    if (isCorruptPluginSetting(key, shape)) corrupt = true;
  }
  if (corrupt) return [];
  const enabledNames = new Set(readEnabledPlugins());
  // 项目级覆盖(会话 cwd 落在某个项目里时):项目里开的补进来、关的拿掉。
  const overrides = projectOverridesFor(projectPath);
  for (const [name, ov] of Object.entries(overrides)) {
    if (ov.enabled === true) enabledNames.add(name);
    else if (ov.enabled === false) enabledNames.delete(name);
  }
  if (enabledNames.size === 0) return [];
  const enginesMap = readPluginEnginesMap();
  const out: EnabledPlugin[] = [];
  for (const name of enabledNames) {
    const probe = probeInstalledDir(name);
    // 【MC-030】已启用 + 目录读不了 ≠ 未安装。从前这里 `continue`,该插件从本轮
    //   投递集里**静默消失**(模型那侧的插件工具/技能就没了,没人知道为什么)。
    //   现在显式留痕;真正"能从面板读到"的诊断行走 `listPlugins`(同一次失败在那里
    //   落成带 `problems` 的行,两处消费同一条 README 语义:读不了 ≠ 不存在)。
    if (isUnreadableProbe(probe)) {
      console.warn(
        `[plugins] 已启用插件「${name}」的目录读不了(ACL/磁盘错误?),本轮无法投递: ${probe.error.message}`,
      );
      continue;
    }
    if (probe.kind === "absent") continue;
    const rootDir = installedRootFrom(probe);
    if (!rootDir) continue;
    try {
      const resolved = findPluginManifest(rootDir);
      if (!resolved) continue;
      const components = summarizeComponents(rootDir, resolved.manifest);
      const hasHooks = components.hooks.length > 0;
      const engines = effectiveEngines(
        resolved.manifest.name,
        enginesMap,
        overrides[name] ?? overrides[resolved.manifest.name],
      );
      out.push({
        name: resolved.manifest.name,
        rootDir,
        manifest: resolved.manifest,
        hasHooks,
        compatibleProviderIds: narrowToEngines(
          compatibleProviderIdsForPlugin(resolved.manifest, components),
          engines,
        ),
        engines,
        // 【ARC-003】逐引擎的逐组件交付报告,供能力目录做组件级可用性判定。
        // 与面板的 pluginComponentReadiness 同源(都读 componentDeliveryReport)。
        componentReports: PLUGIN_ENGINE_IDS.map((engine) =>
          componentDeliveryReport(
            resolved.manifest.name,
            resolved.manifest.version,
            PLUGIN_ENGINE_PROVIDER_IDS[engine],
            components,
            true,
          ),
        ),
      });
    } catch (err) {
      // 【MC-030】从前这里是空 `catch {}` —— 一个**已启用**插件的 manifest 坏了,它会从
      //   本轮的启用集里**静默消失**(模型那侧插件工具就没了,而没人知道为什么)。至少留痕:
      //   坏东西显式报出来(硬规矩 3)。真正"从 UI 可读"的诊断要给 `plugins.list` 加 problems
      //   字段并贯通 contracts/preload/面板(另切,见 MC-030 的系统性修复)。
      console.warn(`[plugins] 已启用插件「${name}」加载失败,本轮跳过: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * 【MC-061】**读**当前启用插件声明的 hook(宿主执行通道的输入)。
 *
 * 与面板({@link listPlugins})、provider 投递({@link getEnabledPlugins})走**同一个**
 * 插件扫描 —— 名字、版本、hooks 摘要都来自 {@link summarizeComponents},没有第二份解析。
 * 宿主 `HookRunner` 拿它去构造候选、逐条判定授权(见 `main/hooks/pluginHooks.ts`)。
 *
 * **同步**:它挂在宿主每个事件的分发路径上(见 `HookRunner.onEvent`)。只读、不进数据库写、
 * 不起进程、不算交付报告 —— 判定「准不准跑」由调用方用 `decidePluginHookExecution`(纯的)
 * 做,这里只负责「有哪些声明」。
 */
export function enabledPluginHookDeclarations(
  projectPath?: string,
): EnabledPluginHookDeclaration[] {
  const out: EnabledPluginHookDeclaration[] = [];
  for (const plugin of enabledPluginsNow(projectPath)) {
    // 与面板同源:`summarizeComponents` 是 hooks 解析的唯一一份。
    const components = summarizeComponents(plugin.rootDir, plugin.manifest);
    for (const h of components.hooks) {
      out.push({
        pluginId: plugin.name,
        version: pluginVersionOf(plugin.manifest),
        nativeEvent: h.event,
        command: h.command,
        ...(h.matcher !== undefined ? { matcher: h.matcher } : {}),
      });
    }
  }
  return out;
}

/** 一个已启用插件的技能根，附带"是不是内置"的来源标记。
 *  技能列表面板需要它来把内置的四个标成「内置」并禁止编辑。 */
export interface PluginSkillSource {
  rootDir: string;
  builtin: boolean;
  /** The contributing plugin (manifest name). */
  name: string;
  /** That plugin's effective engine switches. */
  engines?: PluginEngineSwitches;
}

/** {@link PluginSkillSource} 版本 —— 需要来源标记的调用点用它。 */
export async function getPluginSkillSources(
  pluginNames?: readonly string[],
  providerId?: string,
  projectPath?: string,
): Promise<PluginSkillSource[]> {
  const out: PluginSkillSource[] = [];
  const allow = pluginNames && pluginNames.length > 0 ? new Set(pluginNames) : null;
  for (const p of await getEnabledPlugins(projectPath)) {
    if (allow && !allow.has(p.name)) continue;
    // Candidate filtering and preflight are user-facing guardrails; enforce
    // the same applicability again at delivery so a stale/shared workflow
    // cannot mount a plugin into a provider the manifest excludes.
    if (providerId && !p.compatibleProviderIds.includes(providerId)) continue;
    for (const rootDir of pluginSkillsDirs(p.rootDir, p.manifest)) {
      out.push({ rootDir, builtin: p.builtin === true, name: p.name, ...(p.engines ? { engines: p.engines } : {}) });
    }
  }
  return out;
}

/** Existing skills directories of enabled plugins (+ the built-in plugin's) —
 *  appended to Codex's `skills/extraRoots/set` and Pi's
 *  `additionalSkillPaths`. A manifest may declare multiple skills roots
 *  (Claude's string[] form). */
export async function getEnabledPluginSkillRoots(
  pluginNames?: readonly string[],
  providerId?: string,
  projectPath?: string,
): Promise<string[]> {
  return (await getPluginSkillSources(pluginNames, providerId, projectPath)).map((s) => s.rootDir);
}

/** 一个已启用插件提供的工作流节点类型目录。
 *
 *  与 {@link PluginSkillSource} 字段一样,但**不合并成一个类型**:那个类型的名字说的是
 *  技能,而这个东西既不投递给任何 provider、也不归技能体系管 —— 它是 Mcode 自己的
 *  调度器要用的(见 `main/orchestration/nodeTypes.ts`)。共用一个叫 Skill 的类型,
 *  下一个人在技能那边改字段时会以为跟节点类型无关。 */
export interface PluginNodeTypeSource {
  /** 插件名(清单里的名字)。节点类型列表拿它当"从哪来的"标签 —— 从 `rootDir`
   *  反推名字要数三层目录,太脆。 */
  name: string;
  rootDir: string;
  /** 随应用发布的内置插件。决定它在节点类型里的来源等级(builtin 还是 plugin)。 */
  builtin: boolean;
}

/** 已启用插件的节点类型目录(+ 内置插件的)。**与技能不同:这里的东西一个都不往
 *  provider 送**,只给 Mcode 自己的节点类型注册表读。 */
export async function getEnabledPluginNodeTypeSources(): Promise<PluginNodeTypeSource[]> {
  const out: PluginNodeTypeSource[] = [];
  for (const p of await getEnabledPlugins()) {
    for (const rootDir of pluginNodeTypesDirs(p.rootDir, p.manifest)) {
      out.push({ name: p.name, rootDir, builtin: p.builtin === true });
    }
  }
  return out;
}

/** Raw `[serverName, config]` pairs across every MCP definition file of a
 *  plugin (the manifest may declare multiple — Claude's string[] form).
 *  Unreadable files are skipped, never fatal. */
function readPluginMcpEntries(p: EnabledPlugin): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = Object.entries(pluginInlineMcpServers(p.manifest) ?? {});
  for (const file of pluginMcpFiles(p.rootDir, p.manifest)) {
    let cfg: unknown;
    try {
      cfg = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    const servers =
      cfg && typeof cfg === "object" && !Array.isArray(cfg)
        ? (cfg as Record<string, unknown>).mcpServers ?? cfg
        : null;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
    for (const [serverName, raw] of Object.entries(servers as Record<string, unknown>)) {
      out.push([serverName, raw]);
    }
  }
  return out;
}

/** Raw config of one namespaced plugin MCP server among ENABLED plugins,
 *  ignoring the per-server disable list. The MCP panel's OAuth login/logout
 *  needs the server's full config (headers included) even while it is turned
 *  off, because the CLI's credential identity is a hash of name + url +
 *  headers. Returns null when no enabled plugin declares it. */
export async function getPluginMcpServerConfig(fullName: string): Promise<unknown | null> {
  for (const p of await getEnabledPlugins()) {
    for (const [serverName, raw] of readPluginMcpEntries(p)) {
      if (`${p.name}__${serverName}` === fullName) return raw;
    }
  }
  return null;
}

/** Namespaced MCP server entries of enabled plugins:
 *  `[["<plugin>__<server>", config], ...]`, honoring the per-server disable
 *  list (plugins.mcpDisabled, written by the MCP panel). Invalid configs are
 *  skipped — a broken plugin server never blocks a turn.
 *
 *  `precomputed` lets a caller that already resolved the enabled set (the
 *  provider's startTurn resolves it once per turn) skip the second directory
 *  scan this function would otherwise perform. */
export async function getPluginMcpServers(
  precomputed?: EnabledPlugin[],
  providerId?: string,
): Promise<Array<[string, McpServerConfig]>> {
  // 【MC-019】禁用名单是 MCP 投递的唯一直通闸(getPluginMcpServers 绕不开它)。
  //   名单"存在但读不懂"→ 拒绝交付**任何**插件 MCP 服务,而不是当空名单继续 ——
  //   从前坏 JSON 落进空 Set,原禁用服务 `p__s` 会被重新交付(同一条 fail-open 链)。
  if (isCorruptPluginSetting(PLUGINS_MCP_DISABLED_SETTING_KEY, isPluginNameListShape)) {
    return [];
  }
  const disabled = readMcpDisabled();
  const out: Array<[string, McpServerConfig]> = [];
  for (const p of precomputed ?? (await getEnabledPlugins())) {
    if (providerId && !p.compatibleProviderIds.includes(providerId)) continue;
    for (const [serverName, raw] of readPluginMcpEntries(p)) {
      const parsed = McpServerConfigSchema.safeParse(raw);
      if (!parsed.success) continue;
      const fullName = `${p.name}__${serverName}`;
      if (disabled.has(fullName)) continue;
      out.push([fullName, parsed.data]);
    }
  }
  return out;
}

/** Toggle one plugin-contributed MCP server (MCP panel, scope "plugin").
 *  Pure denylist write — the plugin's own enable state is untouched. */
export function setPluginMcpDisabled(
  serverName: string,
  disabledValue: boolean,
): { ok: boolean; error?: string; previousDisabled?: boolean } {
  // 【MC-019】禁用名单损坏时拒绝写 — 读-改-写会拿兜底空名单当基准,
  // 别的插件已关的服务被这次「关一个服务」的操作静默放开。
  const refuse = refuseIfCorrupt(PLUGINS_MCP_DISABLED_SETTING_KEY, isPluginNameListShape);
  if (refuse) return refuse;
  const current = readMcpDisabled();
  const previousDisabled = current.has(serverName);
  const next = new Set([...current].filter((n) => n !== serverName));
  if (disabledValue) next.add(serverName);
  writeJsonSetting(PLUGINS_MCP_DISABLED_SETTING_KEY, [...next]);
  return { ok: true, previousDisabled };
}

/** Rows for the MCP panel (scope "plugin"): one per server of each ENABLED
 *  plugin, `enabled` = not on the plugins.mcpDisabled denylist. Disabled
 *  plugins contribute no rows — the plugin's own switch is the master gate,
 *  so the two controls never contradict each other. */
export async function listPluginMcpPanelEntries(): Promise<
  Array<{
    name: string;
    scope: "plugin";
    kind: "stdio" | "http" | "sse";
    detail: string;
    enabled: boolean;
    pluginName: string;
    pluginEngines: { claude: boolean; codex: boolean };
  }>
> {
  const disabled = readMcpDisabled();
  const enginesMap = readPluginEnginesMap();
  const out: Array<{
    name: string;
    scope: "plugin";
    kind: "stdio" | "http" | "sse";
    detail: string;
    enabled: boolean;
    pluginName: string;
    pluginEngines: { claude: boolean; codex: boolean };
  }> = [];
  for (const p of await getEnabledPlugins()) {
    const sw = pluginEngineSwitches(p.name, enginesMap);
    for (const [serverName, raw] of readPluginMcpEntries(p)) {
      const desc = describePluginMcp(raw);
      if (!desc) continue;
      const fullName = `${p.name}__${serverName}`;
      out.push({
        name: fullName,
        scope: "plugin",
        kind: desc.kind,
        detail: desc.detail,
        enabled: !disabled.has(fullName),
        pluginName: p.name,
        pluginEngines: { claude: sw.claude, codex: sw.codex },
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
