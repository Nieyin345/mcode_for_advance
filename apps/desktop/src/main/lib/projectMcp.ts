/**
 * **项目级 MCP** —— `<项目>/.mcp.json`(Claude Code 的标准格式)。
 *
 * ## 为什么又有项目级了
 *
 * 从前项目级来源被整体移除(settingSources 钉在 ["user"],外部 .mcp.json 一律不继承)。
 * 2026-10-03 用户要求 MCP 和技能一样能放进项目:跟着项目目录走、能分享给同事。所以这里
 * 是 **Mcode 自己读** 这份文件、自己投递,二进制那条路依旧关着 —— 投递口径只有一个。
 *
 * ## 信任
 *
 * stdio 服务器 = 在本机跑一条命令,克隆来的仓库可能自带 `.mcp.json`。所以只有**被信任过**
 * 的条目才投递:信任按「名字 + 配置内容」的指纹记(设置项 `mcp.projectTrust`,字符串
 * 数组),配置一改指纹就变、要重新信任。在 Mcode 里新增 / 编辑 / 从总库复制的条目自动信任。
 * 指纹不带项目路径:同一份配置在 worktree 里也算信任过(它跑的就是用户点过头的那条命令)。
 *
 * ## 投递
 *
 * - Claude:每轮注入 `options.mcpServers`(见 ClaudeAgentSdkProvider);
 * - Codex:每轮 `-c mcp_servers.<名>={...}` 覆盖(见 codexProjectScope.ts);
 * - Pi:没有 MCP。
 *
 * 值里的 `${VAR}` / `${VAR:-默认}` 投递前按本机环境变量展开(与 Claude Code 一致),
 * 所以密钥可以不写进项目文件。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MCP_PROJECT_TRUST_SETTING_KEY,
  type McpProjectCopyResult,
  type McpProjectListResult,
  type McpProjectServer,
  type McpServerConfig,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { describeMcpConfig, parseMcpConfig } from "@main/lib/mcpConfig.js";

export const PROJECT_MCP_FILE = ".mcp.json";

/** Trusted fingerprints kept at most (oldest dropped first). */
const MAX_TRUST = 2000;

/** Names starting with `mcode-` belong to the app's own servers. Several of
 *  them are auto-approved BY NAME (`mcp__mcode-app__…`), so a project file
 *  must never be able to register one — it would inherit that trust. */
export function isReservedProjectServerName(name: string): boolean {
  return /^mcode[-_]/i.test(name);
}

export function projectMcpFile(projectPath: string): string {
  return path.join(projectPath, PROJECT_MCP_FILE);
}

/** Reject relative / missing project directories before any read or write. */
function checkProjectDir(projectPath: string): string | null {
  if (!path.isAbsolute(projectPath)) return "项目路径必须是绝对路径";
  try {
    if (!statSync(projectPath).isDirectory()) return "项目目录不存在";
  } catch {
    return "项目目录不存在";
  }
  return null;
}

interface ProjectFile {
  exists: boolean;
  obj: Record<string, unknown>;
  error?: string;
}

function readProjectFile(projectPath: string): ProjectFile {
  const file = projectMcpFile(projectPath);
  if (!existsSync(file)) return { exists: false, obj: {} };
  try {
    const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    if (!text.trim()) return { exists: true, obj: {} };
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { exists: true, obj: {}, error: ".mcp.json 不是一个 JSON 对象" };
    }
    return { exists: true, obj: parsed as Record<string, unknown> };
  } catch (err) {
    return { exists: true, obj: {}, error: `.mcp.json 读不了:${(err as Error).message}` };
  }
}

function serversOf(obj: Record<string, unknown>): Record<string, unknown> {
  const s = obj.mcpServers;
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
}

async function writeProjectFile(projectPath: string, obj: Record<string, unknown>): Promise<void> {
  const file = projectMcpFile(projectPath);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

/* ── Trust ── */

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Fingerprint of one entry as written (name + raw config). */
export function projectServerFingerprint(name: string, raw: unknown): string {
  return createHash("sha256").update(`${name}\0${stable(raw)}`).digest("hex");
}

function readTrust(): string[] {
  try {
    const raw = SettingRepo.get(MCP_PROJECT_TRUST_SETTING_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeTrust(list: string[]): void {
  const unique = [...new Set(list)];
  SettingRepo.set(MCP_PROJECT_TRUST_SETTING_KEY, JSON.stringify(unique.slice(-MAX_TRUST)));
}

function setTrusted(fingerprint: string, trusted: boolean): void {
  const list = readTrust().filter((f) => f !== fingerprint);
  if (trusted) list.push(fingerprint);
  writeTrust(list);
}

/* ── Env expansion (`${VAR}` / `${VAR:-default}`) ── */

function expand(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => {
    const v = env[name];
    return v !== undefined && v !== "" ? v : (def ?? "");
  });
}

function expandRecord(rec: unknown, env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (!rec || typeof rec !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = expand(v, env);
  }
  return out;
}

/** The config with `${VAR}` references resolved against `env`. */
export function expandProjectServerConfig(config: McpServerConfig, env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  if (config.type === "http" || config.type === "sse") {
    const headers = expandRecord(config.headers, env);
    return { ...config, url: expand(config.url, env), ...(headers ? { headers } : {}) };
  }
  const envVars = expandRecord(config.env, env);
  return {
    ...config,
    command: expand(config.command, env),
    ...(config.args ? { args: config.args.map((a) => (typeof a === "string" ? expand(a, env) : a)) } : {}),
    ...(envVars ? { env: envVars } : {}),
  };
}

/* ── Panel operations ── */

/** Secret-free one-line summary (URL query strings can carry tokens). */
function detailOf(config: McpServerConfig): { kind: McpProjectServer["kind"]; detail: string } {
  const d = describeMcpConfig(config);
  if (d.kind === "http" || d.kind === "sse") {
    return { kind: d.kind, detail: d.detail.replace(/[?#].*$/, "") };
  }
  return { kind: "stdio", detail: d.detail };
}

export function listProjectMcp(projectPath: string): McpProjectListResult {
  const file = projectMcpFile(projectPath);
  const dirError = checkProjectDir(projectPath);
  if (dirError) return { file, exists: false, servers: [], invalid: [], error: dirError };
  const read = readProjectFile(projectPath);
  const trust = new Set(readTrust());
  const servers: McpProjectServer[] = [];
  const invalid: string[] = [];
  for (const [name, raw] of Object.entries(serversOf(read.obj))) {
    const config = parseMcpConfig(raw);
    if (!config) {
      invalid.push(name);
      continue;
    }
    servers.push({
      name,
      ...detailOf(config),
      config,
      trusted: !isReservedProjectServerName(name) && trust.has(projectServerFingerprint(name, raw)),
    });
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { file, exists: read.exists, servers, invalid, ...(read.error ? { error: read.error } : {}) };
}

export async function saveProjectMcp(
  projectPath: string,
  name: string,
  config: McpServerConfig,
  replace = false,
): Promise<{ ok: boolean; error?: string }> {
  if (isReservedProjectServerName(name)) return { ok: false, error: `「${name}」是 Mcode 内置服务器的保留名(mcode- 开头)` };
  const dirError = checkProjectDir(projectPath);
  if (dirError) return { ok: false, error: dirError };
  const read = readProjectFile(projectPath);
  // A broken file is the user's content — never overwrite it with our guess.
  if (read.error) return { ok: false, error: `${read.error}(先手动修好再保存)` };
  const servers = { ...serversOf(read.obj) };
  if (!replace && name in servers) return { ok: false, error: `项目里已有名为「${name}」的服务器` };
  servers[name] = config;
  await writeProjectFile(projectPath, { ...read.obj, mcpServers: servers });
  setTrusted(projectServerFingerprint(name, config), true);
  return { ok: true };
}

export async function removeProjectMcp(projectPath: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const dirError = checkProjectDir(projectPath);
  if (dirError) return { ok: false, error: dirError };
  const read = readProjectFile(projectPath);
  if (read.error) return { ok: false, error: read.error };
  const servers = { ...serversOf(read.obj) };
  if (!(name in servers)) return { ok: false, error: `项目里没有名为「${name}」的服务器` };
  const fingerprint = projectServerFingerprint(name, servers[name]);
  delete servers[name];
  await writeProjectFile(projectPath, { ...read.obj, mcpServers: servers });
  setTrusted(fingerprint, false);
  return { ok: true };
}

export function trustProjectMcp(projectPath: string, name: string, trusted: boolean): { ok: boolean; error?: string } {
  const dirError = checkProjectDir(projectPath);
  if (dirError) return { ok: false, error: dirError };
  const read = readProjectFile(projectPath);
  if (read.error) return { ok: false, error: read.error };
  const raw = serversOf(read.obj)[name];
  if (raw === undefined) return { ok: false, error: `项目里没有名为「${name}」的服务器` };
  if (trusted && isReservedProjectServerName(name)) return { ok: false, error: `「${name}」是 Mcode 内置服务器的保留名,不能信任` };
  if (trusted && !parseMcpConfig(raw)) return { ok: false, error: `「${name}」的配置无效,不能信任` };
  setTrusted(projectServerFingerprint(name, raw), trusted);
  return { ok: true };
}

/** Copy user-scope configs (总库) into the project file; existing names are
 *  skipped. `userConfigs` = the truth layer (enabled + stashed). */
export async function copyUserServersToProject(
  projectPath: string,
  names: readonly string[],
  userConfigs: Record<string, McpServerConfig>,
): Promise<McpProjectCopyResult> {
  const result: McpProjectCopyResult = { copied: [], skipped: [], failed: [] };
  const dirError = checkProjectDir(projectPath);
  if (dirError) {
    result.failed = names.map((name) => ({ name, reason: dirError }));
    return result;
  }
  const read = readProjectFile(projectPath);
  if (read.error) {
    result.failed = names.map((name) => ({ name, reason: read.error as string }));
    return result;
  }
  const servers = { ...serversOf(read.obj) };
  for (const name of names) {
    const config = userConfigs[name];
    if (!config) result.failed.push({ name, reason: "总库里没有这个服务器" });
    else if (isReservedProjectServerName(name)) result.failed.push({ name, reason: "mcode- 开头是保留名" });
    else if (name in servers) result.skipped.push(name);
    else {
      servers[name] = config;
      result.copied.push(name);
    }
  }
  if (result.copied.length > 0) {
    await writeProjectFile(projectPath, { ...read.obj, mcpServers: servers });
    writeTrust([...readTrust(), ...result.copied.map((n) => projectServerFingerprint(n, servers[n]))]);
  }
  return result;
}

/* ── Delivery ── */

/** The nearest directory at or above `cwd` holding a `.mcp.json` — a session
 *  started in a project subfolder still gets the project's servers (same
 *  lookup direction as Claude Code). Trust gates delivery, so finding a stray
 *  file higher up is harmless. */
function findProjectRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 32; i += 1) {
    if (existsSync(path.join(dir, PROJECT_MCP_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Trusted, valid servers of the project a session runs in (`cwd`), with
 *  `${VAR}` expanded. Never throws: a broken file delivers nothing. */
export function getTrustedProjectMcpServers(cwd: string | undefined): Array<[string, McpServerConfig]> {
  if (!cwd || !path.isAbsolute(cwd)) return [];
  try {
    const root = findProjectRoot(cwd);
    if (!root) return [];
    const read = readProjectFile(root);
    if (!read.exists || read.error) return [];
    const trust = new Set(readTrust());
    const out: Array<[string, McpServerConfig]> = [];
    for (const [name, raw] of Object.entries(serversOf(read.obj))) {
      if (!/^[A-Za-z0-9_-]+$/.test(name) || isReservedProjectServerName(name)) continue;
      if (!trust.has(projectServerFingerprint(name, raw))) continue;
      const config = parseMcpConfig(raw);
      if (config) out.push([name, expandProjectServerConfig(config)]);
    }
    return out;
  } catch {
    return [];
  }
}
