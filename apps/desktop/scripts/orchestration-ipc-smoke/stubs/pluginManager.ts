/**
 * `@main/plugins/pluginManager.js` 的替身 —— 真的那个读插件目录、解压、spawn git,
 * 还 import electron 的路径常量。
 *
 * ## 为什么本套需要它
 *
 * 被测的 `nodeTypes.ts` 要 `getEnabledPluginNodeTypeSources`(插件带来的节点类型目录),
 * 而 `capabilityResolver.ts`(经 `runner.ts` 拉进来)还要 `getEnabledPlugins`。
 *
 * ⚠️ 漏一个名字的话 esbuild 会在**打包这一步**直接报 "No matching export" —— 看着像
 * "被测代码坏了",其实是桩少了一个名字(node-live-smoke 踩过一次)。所以这里导出的
 * 名字是**超集**:把本套 import 图里出现过的名字全列上。
 *
 * 返回空 = **这一份里插件带来的节点类型一个都不存在**。这是刻意的本套只验内置那一份
 * 与用户自写目录那一份,插件那一份要真装插件才能验(不在无头范围内)。
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
