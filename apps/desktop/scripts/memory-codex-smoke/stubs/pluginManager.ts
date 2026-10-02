/**
 * `@main/plugins/pluginManager.js` 的替身 —— 只给无头脚本用。
 *
 * 真的那一个会读插件目录、解压、spawn git、并**在 import 期**就求
 * `MCODE_CONFIG_DIR`(经 `@main/lib/skillEngines.js` 的 electron 路径常量)。本套要验的
 * 是记忆库与 Codex 供应商那两条 IPC,和插件一点关系都没有 —— 这里只求"import 得过"。
 *
 * ## 为什么不是空的:总注册表会**真的调**它
 *
 * `registerIpcHandlers()` 里 `registerPluginsHandlers(ipc)` 会调 `listPlugins()` 之类,
 * 而 `codexModelsStore.materializeConfigToml()` 会调 `getPluginMcpServers()` /
 * `mcpEngineEnabled()`。所以这一份必须给出**形状正确**的返回值:
 *  - `getPluginMcpServers()` 返回 `[]` = "没有插件贡献 MCP 服务器" —— 于是生成的
 *    `config.toml` 里只有供应商那几张表,断言读起来不受噪音干扰;
 *  - `getEnabledPlugins()` / `getPluginMcpServerConfig()` 同理。
 *
 * 没走到的成员一律**显式抛**:真被调到要立刻显形,而不是安静返回 undefined。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`memory-codex-smoke 的 pluginManager 桩没造 ${name}`);
  };
}

export const PLUGINS_ROOT = "/nonexistent/mcode-smoke/plugins";

/** 本套一个插件都不装 —— 空表。 */
export async function getEnabledPlugins(): Promise<unknown[]> {
  return [];
}
export async function getPluginSkillSources(): Promise<unknown[]> {
  return [];
}
export async function getEnabledPluginSkillRoots(): Promise<string[]> {
  return [];
}
export async function getEnabledPluginNodeTypeSources(): Promise<unknown[]> {
  return [];
}
export async function getPluginMcpServers(): Promise<Array<[string, unknown]>> {
  return [];
}
export async function getPluginMcpServerConfig(): Promise<unknown | null> {
  return null;
}
export async function listPluginMcpPanelEntries(): Promise<unknown[]> {
  return [];
}

export const listPlugins = notHere("listPlugins");
export const installFromLocal = notHere("installFromLocal");
export const installFromGit = notHere("installFromGit");
export const installFromMarketplace = notHere("installFromMarketplace");
export const setPluginEnabled = notHere("setPluginEnabled");
export const setPluginEngines = notHere("setPluginEngines");
export const listPluginProjectRows = notHere("listPluginProjectRows");
export const setPluginProjectOverride = notHere("setPluginProjectOverride");
export const removePlugin = notHere("removePlugin");
export const listMarketplaces = notHere("listMarketplaces");
export const addMarketplace = notHere("addMarketplace");
export const removeMarketplace = notHere("removeMarketplace");
export const refreshMarketplace = notHere("refreshMarketplace");
export const setPluginMcpDisabled = notHere("setPluginMcpDisabled");
export const readEnabledPlugins = notHere("readEnabledPlugins");
