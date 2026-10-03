/** Pure policy: fixed shell source, dynamic values on the existing JSON stdin. */
import { hasNodeTemplateReferences } from "@contracts/nodeTemplate";
import { translate } from "@renderer/lib/i18n/core.js";

export function shellCommandTemplateError(command: string, locale: "zh" | "en" = "zh"): string | null {
  return hasNodeTemplateReferences(command)
    ? translate(locale, "settings.workflow.commandTemplateUnsafe")
    : null;
}
