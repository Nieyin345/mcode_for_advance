/**
 * `pluginManager` 的替身 —— 只给 `skill-copy-smoke` 用。
 *
 * ## 为什么要换掉它
 *
 * `ipc/skills.ts` 只为了一件事 import 这个模块：`getPluginSkillSources()`
 * （列出已启用插件带来的技能根）。而 `pluginManager` 底下拖着 `store/db` →
 * `sql.js` → 一整套数据库初始化 —— 那跟"复制技能"这件事毫无关系，却会让
 * 冒烟脚本在 import 期就去建库、读盘。
 *
 * ## 为什么是空的列表，而不是"一律显式抛"
 *
 * 这和 `browserManager` / `runtimeManager` 那些桩的取舍不同：那些是"本套根本
 * 不该碰到的能力"，碰到了要立刻显形。而这里**空列表就是正确的语义** —— 这套
 * 验的是"把**通用库**的技能复制到项目"，插件技能本来就该是空的（复制也只对
 * 通用库开放，见 `canCopy`）。返回空既忠实又不掩盖任何东西。
 *
 * 哪天真要验"插件技能能不能复制"，那要单独一套带真插件的夹具，不是给这里塞。
 */
export async function getPluginSkillSources(): Promise<
  Array<{ rootDir: string; builtin: boolean }>
> {
  return [];
}
