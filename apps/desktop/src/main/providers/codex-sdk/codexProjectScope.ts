/**
 * Codex 的**项目级**投递(每轮,进程内 `-c` 覆盖)。
 *
 * Codex 的 config.toml 是全局物化的(用户级 MCP + 总库启用的插件 MCP)。项目层面的两样
 * 东西没法写进那份全局文件 —— 不同项目要不同的结果 —— 所以这里按会话 cwd 算出一组
 * `-c` 参数,随这一轮的 app-server 进程一起起(每轮一个进程,互不串):
 *
 *  1. 项目插件开关(见 pluginManager 的 projectOverridesFor):
 *     - 项目里关掉 / 对 Codex 关掉的插件 → 它在全局清单里的服务器 `enabled=false`;
 *     - 项目里打开、但总库没开的插件 → 它的服务器整条补进来。
 *  2. 项目 `.mcp.json` 里被信任的服务器(见 lib/projectMcp.ts)→ 整条补进来,同名时
 *     覆盖全局那份(项目 > 用户,与 Claude 侧一致)。
 *
 * 节点收窄(mcpServerNames / pluginNames)对补进来的这些同样生效:不在名单里的不补。
 */
import type { McpServerConfig } from "@contracts/ipc";
import { log } from "@main/lib/logger.js";
import { mcpEngineEnabled, readMcpEnginesMap } from "@main/lib/mcpEngines.js";
import { getTrustedProjectMcpServers } from "@main/lib/projectMcp.js";
import { codexTurnAllowsMcpServer, type CodexMcpInventoryEntry } from "./codexTurnScope.js";

/** TOML basic string. */
function tomlStr(v: string): string {
  return `"${v
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\x00-\x1f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlStr(k);
}

function tomlStringTable(rec: unknown): string | null {
  if (!rec || typeof rec !== "object") return null;
  const entries = Object.entries(rec as Record<string, unknown>).filter(([, v]) => typeof v === "string");
  if (entries.length === 0) return null;
  return `{ ${entries.map(([k, v]) => `${tomlKey(k)} = ${tomlStr(v as string)}`).join(", ")} }`;
}

/** One server as a Codex inline table (`{ command = …, args = […] }`), or null
 *  when it can't be represented. Same field mapping as the config.toml writer. */
export function codexInlineServer(config: McpServerConfig): string | null {
  const parts: string[] = [];
  if (config.type === "http" || config.type === "sse") {
    if (!config.url) return null;
    parts.push(`url = ${tomlStr(config.url)}`);
    const headers = tomlStringTable(config.headers);
    if (headers) parts.push(`http_headers = ${headers}`);
  } else {
    if (!config.command) return null;
    parts.push(`command = ${tomlStr(config.command)}`);
    const args = (config.args ?? []).filter((a): a is string => typeof a === "string");
    if (args.length > 0) parts.push(`args = [${args.map(tomlStr).join(", ")}]`);
    const env = tomlStringTable(config.env);
    if (env) parts.push(`env = ${env}`);
  }
  return `{ ${parts.join(", ")} }`;
}

/** `-c` args for one turn's project scope (empty = nothing project-specific). */
export async function codexProjectScopeArgs(opts: {
  cwd: string | undefined;
  inventory: readonly CodexMcpInventoryEntry[];
  mcpServerNames?: readonly string[];
  pluginNames?: readonly string[];
}): Promise<string[]> {
  const { cwd, inventory, mcpServerNames, pluginNames } = opts;
  if (!cwd) return [];
  const args: string[] = [];
  const add = new Map<string, McpServerConfig>();
  const pluginAllow = pluginNames?.length ? new Set(pluginNames) : null;
  try {
    const { getEnabledPlugins, getPluginMcpServers } = await import("@main/plugins/pluginManager.js");
    const forCodex = (list: Awaited<ReturnType<typeof getEnabledPlugins>>) =>
      list.filter((p) => p.compatibleProviderIds.includes("codex-sdk"));
    const projectPlugins = forCodex(await getEnabledPlugins(cwd));
    const globalNames = new Set(forCodex(await getEnabledPlugins()).map((p) => p.name));
    const projectNames = new Set(projectPlugins.map((p) => p.name));
    // 1a. Plugins the project turned off (or off for Codex): drop their servers.
    const disabled = new Set<string>();
    for (const entry of inventory) {
      if (entry.pluginName && !projectNames.has(entry.pluginName)) disabled.add(entry.name);
    }
    for (const name of disabled) args.push("-c", `mcp_servers.${tomlKey(name)}.enabled=false`);
    // 1b. Plugins the project turned on that the global config doesn't carry.
    const extra = projectPlugins.filter((p) => !globalNames.has(p.name) && (!pluginAllow || pluginAllow.has(p.name)));
    if (extra.length > 0) {
      const enginesMap = readMcpEnginesMap();
      const inInventory = new Set(inventory.map((e) => e.name));
      for (const [name, config] of await getPluginMcpServers(extra, "codex-sdk")) {
        if (inInventory.has(name) || !mcpEngineEnabled(enginesMap, name, "codex")) continue;
        if (!codexTurnAllowsMcpServer(name, mcpServerNames)) continue;
        add.set(name, config);
      }
    }
  } catch (err) {
    log.warn(`codex: project plugin scope skipped: ${(err as Error).message}`);
  }
  // 2. Trusted servers of the project's .mcp.json (project wins on a clash).
  for (const [name, config] of getTrustedProjectMcpServers(cwd)) {
    if (!codexTurnAllowsMcpServer(name, mcpServerNames)) continue;
    add.set(name, config);
  }
  for (const [name, config] of add) {
    const inline = codexInlineServer(config);
    if (inline) args.push("-c", `mcp_servers.${tomlKey(name)}=${inline}`);
    else log.warn(`codex: skipped unrepresentable project MCP server "${name}"`);
  }
  return args;
}
