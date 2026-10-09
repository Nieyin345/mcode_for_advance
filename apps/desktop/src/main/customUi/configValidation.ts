import { CustomUiConfigSchema, renderShellTemplate, isActionAllowed, type CustomUiConfig } from "@contracts/customUi";
import { hasNodeTemplateReferences } from "@contracts/nodeTemplate";
/** Strict writes, tolerant legacy reads. Never persist a configuration the UI would silently drop. */
export function validateCustomUiWrite(raw: string): CustomUiConfig {
  const config = CustomUiConfigSchema.parse(JSON.parse(raw));
  const ids = new Set<string>();
  for (const item of config.items) {
    if (ids.has(item.id)) throw new Error(`自定义界面里有两个条目的 id 相同:${item.id}`);
    if (!isActionAllowed(item.slot, item.action.type)) throw new Error(`动作「${item.action.type}」不能挂在「${item.slot}」这个位置上`);
    // shell 命令只允许**静态**源:`renderShellTemplate` 会拒掉带 `{{…}}` 的模板,但它抛的是
    // 英文(契约层没 i18n)。这条错误经整条保存链原样进 toast,所以在这里先用同一判据
    // (`hasNodeTemplateReferences`)拦一道、给人话。两条判据必须同步。
    if (item.action.type === "shell" && hasNodeTemplateReferences(item.action.command)) {
      throw new Error(`「${item.slot}」上的 shell 动作只支持固定命令,不能用 {{…}} 模板变量;要动态参数请改用自动化工作流。`);
    }
    if (item.action.type === "shell") renderShellTemplate(item.action.command, {}, "posix");
    ids.add(item.id);
  }
  return config;
}
