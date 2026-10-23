/**
 * `@main/plugins/pluginManager.js` 的替身 —— 只给出 `nodeTypes.ts` 与
 * `ClaudeAgentSdkProvider` 真正要的那几个函数。
 *
 * 真的插件管理器要读插件目录、解压、spawn git,还 import 了 electron 的路径常量。
 * 这个 suite 关心的是**内置那一种**节点类型,所以这里报"一个插件都没启用"。
 *
 * ⚠️ 返回 `[]` 等于**这一份里插件带来的节点类型 / 技能根 / MCP 服务全都不存在**。这是
 * 有意的:被测的那几条规则(认不出的类型不算错、保留前缀不能用)在内置那一份上就能
 * 验完;`ClaudeAgentSdkProvider` 那条 import 只是为了让它自己的模块层能解析,它在
 * 本套里从不真的 startTurn。
 *
 * ## 2026-10-23 补的三个导出
 *
 * `ClaudeAgentSdkProvider.ts:52` 从真模块里 import 了 `getEnabledPlugins` /
 * `getPluginMcpServers` / `getEnabledPluginSkillRoots`。桩缺一个,esbuild 就在**打包期**
 * 报 `No matching export` —— 一条断言都跑不到。签名照产品的写(可选参数也照抄),
 * 这样产品以后改签名,`tsc` 会在这份桩上先把类型对不上报出来。
 */
import type { EnabledPlugin, PluginNodeTypeSource } from "@main/plugins/pluginManager.js";
import type { McpServerConfig } from "@contracts/ipc";

export type { PluginNodeTypeSource };

export async function getEnabledPluginNodeTypeSources(): Promise<PluginNodeTypeSource[]> {
  return [];
}

export async function getEnabledPlugins(_projectPath?: string): Promise<EnabledPlugin[]> {
  return [];
}

export async function getEnabledPluginSkillRoots(
  _pluginNames?: readonly string[],
  _providerId?: string,
  _projectPath?: string,
): Promise<string[]> {
  return [];
}

export async function getPluginMcpServers(
  _precomputed?: EnabledPlugin[],
  _providerId?: string,
): Promise<Array<[string, McpServerConfig]>> {
  return [];
}
