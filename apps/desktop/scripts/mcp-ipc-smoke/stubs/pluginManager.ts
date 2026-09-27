/**
 * `@main/plugins/pluginManager.js` 的替身 —— 只为无头脚本存在。
 *
 * ## 为什么必须换掉
 *
 * 真的那份走 `getEnabledPlugins()` → `installedRootOf()` → `PLUGINS_ROOT`
 * (`<MCODE_CONFIG_DIR>/plugins`),而本套要断言的是 **IPC handler 怎么消费**
 * 插件贡献的 MCP 行,不是安装管线。换掉之后夹具就是内存里的两个数组,
 * 一行磁盘都不碰用户的 `~/.mcode/plugins`。
 *
 * ## 与真的一致的那几条语义(照抄,不发明)
 *
 * 下面每条都是**从真文件里逐字搬过来**的,不是"大致像":
 *   - 行名 = `<plugin>__<server>`(真 `listPluginMcpPanelEntries`);
 *   - 行按名字排好序再返回(真那边 `out.sort(...)`);
 *   - `enabled` = 不在 `plugins.mcpDisabled` 名单里;
 *   - `getPluginMcpServers()` **也吃那份名单**(关掉的服务器不进引擎视图);
 *   - `setPluginMcpDisabled` 是纯名单写入,永远 `{ok:true}`
 *     (⚠️ 真的那个也永远返回 ok —— 本套有一条断言专门钉这个形状,见 main.ts §6);
 *   - `describePluginMcp` 式的 detail:http/sse 给 url,stdio 给
 *     `command + args`(真那份在 `pluginManifest.ts`,这里照抄行为)。
 *
 * ## 与真的**故意不同**的一条
 *
 * 真的 `getEnabledPlugins()` 永远附带随应用发布的内置插件
 * (`mcode-document-skills`,见 `builtinPlugins.ts`)。本套把它**关掉**:
 * 那个插件的根目录是靠 `import.meta.url` / `process.cwd()` 往上找源码树里的
 * `resources/builtin-skills`,而这里是 esbuild 打出来的临时 bundle ——
 * 找到与否取决于跑脚本时人在哪个目录。夹具要是跟着 cwd 变,断言就不是在测
 * handler 了。所以这里给的是**固定两条**内存插件。
 */
function mcpDetail(raw: unknown): { kind: "stdio" | "http" | "sse"; detail: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const cfg = raw as Record<string, unknown>;
  if (cfg.type === "http" || cfg.type === "sse") {
    if (typeof cfg.url !== "string" || !cfg.url) return null;
    return { kind: cfg.type, detail: cfg.url };
  }
  if (typeof cfg.command !== "string" || !cfg.command) return null;
  const args = Array.isArray(cfg.args) ? cfg.args.filter((a) => typeof a === "string") : [];
  return { kind: "stdio", detail: [cfg.command, ...args].join(" ") };
}

/** 内存夹具:插件名 → { 服务器名 → 原始配置 }。 */
export const pluginServers: Record<string, Record<string, unknown>> = {};

/** 内存夹具:`plugins.mcpDisabled` 名单。 */
export const mcpDisabled = new Set<string>();

/** 清空夹具(每条用例开头调,免得互相污染)。 */
export function resetPlugins(): void {
  for (const k of Object.keys(pluginServers)) delete pluginServers[k];
  mcpDisabled.clear();
}

/** 按名字排好序的插件名 —— 与真那份 `getEnabledPlugins()` 的返回顺序无关,
 *  因为下面 `listPluginMcpPanelEntries` 自己会排序。 */
function pluginNames(): string[] {
  return Object.keys(pluginServers).sort();
}

export async function getEnabledPlugins(): Promise<
  Array<{ name: string; rootDir: string; manifest: unknown; hasHooks: boolean }>
> {
  return pluginNames().map((name) => ({
    name,
    rootDir: `/smoke/plugins/${name}`,
    manifest: { name },
    hasHooks: false,
  }));
}

export async function listPluginMcpPanelEntries(): Promise<
  Array<{ name: string; scope: "plugin"; kind: "stdio" | "http" | "sse"; detail: string; enabled: boolean }>
> {
  const out: Array<{
    name: string;
    scope: "plugin";
    kind: "stdio" | "http" | "sse";
    detail: string;
    enabled: boolean;
  }> = [];
  for (const p of pluginNames()) {
    for (const [serverName, raw] of Object.entries(pluginServers[p])) {
      const desc = mcpDetail(raw);
      if (!desc) continue;
      const fullName = `${p}__${serverName}`;
      out.push({
        name: fullName,
        scope: "plugin",
        kind: desc.kind,
        detail: desc.detail,
        enabled: !mcpDisabled.has(fullName),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 真那份:`getPluginMcpServers(precomputed?)` —— 忽略关掉的服务器。 */
export async function getPluginMcpServers(): Promise<Array<[string, unknown]>> {
  const out: Array<[string, unknown]> = [];
  for (const p of pluginNames()) {
    for (const [serverName, raw] of Object.entries(pluginServers[p])) {
      if (!mcpDetail(raw)) continue;
      const fullName = `${p}__${serverName}`;
      if (mcpDisabled.has(fullName)) continue;
      out.push([fullName, raw]);
    }
  }
  return out;
}

/** OAuth 那两个 handler 靠它拿"这个 server 的真实配置(含 headers)"。
 *  真那份忽略 disable 名单(见它的文件头),这里照做。 */
export async function getPluginMcpServerConfig(fullName: string): Promise<unknown | null> {
  for (const p of pluginNames()) {
    for (const [serverName, raw] of Object.entries(pluginServers[p])) {
      if (`${p}__${serverName}` === fullName) return raw;
    }
  }
  return null;
}

/** 纯名单写入。**永远 `{ok:true}`** —— 与真那份一致(它是 `writeJsonSetting`
 *  一把梭,没有失败路径可报)。 */
export function setPluginMcpDisabled(
  serverName: string,
  disabledValue: boolean,
): { ok: boolean; error?: string; previousDisabled?: boolean } {
  const previousDisabled = mcpDisabled.has(serverName);
  if (disabledValue) mcpDisabled.add(serverName);
  else mcpDisabled.delete(serverName);
  return { ok: true, previousDisabled };
}
