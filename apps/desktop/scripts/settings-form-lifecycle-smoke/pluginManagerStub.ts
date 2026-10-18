/** 【MC-026 复核】生成节点类型目录时的插件来源桩 —— 本套件只验内置清单,
 *  不扫用户插件目录(那也是唯一会碰 `~/.mcode/plugins` 的入口)。 */
export async function getEnabledPluginNodeTypeSources(): Promise<Array<{ source: string; dir: string; from: string }>> {
  return [];
}
