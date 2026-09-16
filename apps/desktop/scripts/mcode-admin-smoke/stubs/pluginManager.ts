/**
 * `@main/plugins/pluginManager.js` 的替身 —— 只给出 `nodeTypes.ts` 要的那一个函数。
 *
 * 真的插件管理器要读插件目录、解压、spawn git,还 import 了 electron 的路径常量。
 * 这个 suite 关心的是**内置那一种**节点类型,所以这里报"一个插件都没启用"。
 *
 * ⚠️ 返回 `[]` 等于**这一份里插件带来的节点类型全都不存在**。这是有意的:被测的
 * 那几条规则(认不出的类型不算错、保留前缀不能用)在内置那一份上就能验完。
 */
export interface PluginNodeTypeSource {
  name: string;
  rootDir: string;
  builtin: boolean;
}

export async function getEnabledPluginNodeTypeSources(): Promise<PluginNodeTypeSource[]> {
  return [];
}
