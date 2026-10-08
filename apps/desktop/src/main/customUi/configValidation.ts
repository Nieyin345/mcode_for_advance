import { CustomUiConfigSchema, renderShellTemplate, isActionAllowed, type CustomUiConfig } from "@contracts/customUi";
/** Strict writes, tolerant legacy reads. Never persist a configuration the UI would silently drop. */
export function validateCustomUiWrite(raw: string): CustomUiConfig {
  const config = CustomUiConfigSchema.parse(JSON.parse(raw));
  const ids = new Set<string>();
  for (const item of config.items) {
    if (ids.has(item.id)) throw new Error(`自定义界面里有两个条目的 id 相同:${item.id}`);
    if (!isActionAllowed(item.slot, item.action.type)) throw new Error(`动作「${item.action.type}」不能挂在「${item.slot}」这个位置上`);
    if (item.action.type === "shell") renderShellTemplate(item.action.command, {}, "posix");
    ids.add(item.id);
  }
  return config;
}
