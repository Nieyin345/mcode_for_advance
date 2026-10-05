import { CustomUiConfigSchema, renderShellTemplate, isActionAllowed, type CustomUiConfig } from "@contracts/customUi";
/** Strict writes, tolerant legacy reads. Never persist a configuration the UI would silently drop. */
export function validateCustomUiWrite(raw: string): CustomUiConfig {
  const config = CustomUiConfigSchema.parse(JSON.parse(raw));
  const ids = new Set<string>();
  for (const item of config.items) {
    if (ids.has(item.id)) throw new Error(`Duplicate custom UI id: ${item.id}`);
    if (!isActionAllowed(item.slot, item.action.type)) throw new Error(`Custom UI action ${item.action.type} is not allowed in ${item.slot}`);
    if (item.action.type === "shell") renderShellTemplate(item.action.command, {}, "posix");
    ids.add(item.id);
  }
  return config;
}
