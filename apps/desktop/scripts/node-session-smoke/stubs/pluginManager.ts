/**
 * `@main/plugins/pluginManager.js` 的替身 —— 真的那个读插件目录、解压、spawn git,
 * 还 `import { spawn } from "node:child_process"` 与 electron 的路径常量。
 *
 * 这一套要用的是**内置节点类型**那一份,所以报"一个插件都没启用"。与
 * `scripts/mcode-admin-smoke/stubs/pluginManager.ts` 同款取舍。
 *
 * 导出面按**调用方**补齐:`nodeTypes.ts` 只要 `getEnabledPluginNodeTypeSources`,
 * 而 `capabilityResolver.ts`(`runner.ts` 能力清单那一段)还要 `getEnabledPlugins`。
 * 漏一个的话 esbuild 会在打包这一步直接报 "No matching export" —— 那正是这一套
 * 早先踩过的一次(报错看起来像"被测代码坏了",其实是桩少了一个名字)。
 */
import type { PluginManifest } from "@contracts/plugin";

export interface PluginNodeTypeSource {
  name: string;
  rootDir: string;
  builtin: boolean;
}

export async function getEnabledPluginNodeTypeSources(): Promise<PluginNodeTypeSource[]> {
  return [];
}

export async function getEnabledPlugins(): Promise<PluginManifest[]> {
  return [];
}

export async function getPluginMcpServers(): Promise<Array<{ name: string }>> {
  return [];
}

export async function getEnabledPluginSkillRoots(): Promise<string[]> {
  return [];
}
