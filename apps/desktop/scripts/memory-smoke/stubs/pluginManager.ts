/**
 * `@main/plugins/pluginManager.js` 的替身 —— 只给出 `nodeTypes.ts` 要的那一个函数。
 *
 * 真的插件管理器要读插件目录、解压、spawn git,还 import 了 electron 的路径常量。
 * 这一套关心的是**内置那六种**节点类型(参数表里哪几格摆出来了),所以这里报
 * "一个插件都没启用"。
 *
 * ⚠️ 返回 `[]` 等于**插件带来的节点类型在这一份里全都不存在**。这是有意收窄的:
 * 被测的那几条(「注入记忆」摆在哪几种内置类型上)在内置那一份上就能验完,而
 * 插件节点的参数表是插件自己声明的,不该由这一套来管。
 *
 * (与 `mcode-admin-smoke/stubs/pluginManager.ts` 是同一份形状,两边各留一份是因为
 *  `--alias` 只换得到**模块名**,换不到"另一个套件的 stubs 目录"。)
 */
export interface PluginNodeTypeSource {
  name: string;
  rootDir: string;
  builtin: boolean;
}

export async function getEnabledPluginNodeTypeSources(): Promise<PluginNodeTypeSource[]> {
  return [];
}
