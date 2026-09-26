import {
  NODE_DECIDER_KEY, NODE_INJECT_MODE_KEY, NODE_INJECT_TARGET_KEY, NODE_RETURN_PARAM_KEY,
  NODE_TRIGGER_ENABLED_PARAM_KEY, NODE_TRIGGER_KIND_PARAM_KEY, NODE_TRIGGER_PROJECT_PARAM_KEY,
  NODE_TRIGGER_CRON_PARAM_KEY, NODE_TRIGGER_PATHS_PARAM_KEY, NODE_TRIGGER_EVENTS_PARAM_KEY,
  NODE_TRIGGER_FILTER_PARAM_KEY, NODE_TRIGGER_DEBOUNCE_PARAM_KEY,
  deciderOf, injectModeOf, injectTargetOf, returnModeOf, triggerEnabledOf,
  type NodeTypeCatalog, type NodeTypeEntry, type NodeParamSpec,
} from "@contracts/nodeType";
import type { WorkflowNode } from "@contracts/workflow";
import type { MessageId, useI18n } from "@renderer/lib/i18n/index.js";
type Translate = ReturnType<typeof useI18n>["t"];

export function triggerKindLabel(kind: unknown, t: Translate): string {
  const keys: Record<string, MessageId> = {
    manual: "settings.automation.trigger.manual", schedule: "settings.automation.trigger.schedule",
    file: "settings.automation.trigger.file", event: "settings.automation.trigger.event",
    webhook: "settings.automation.trigger.webhook",
  };
  return t(typeof kind === "string" && Object.hasOwn(keys, kind) ? keys[kind] : "settings.automation.unknownTrigger");
}

export function visibleNodeParams(node: WorkflowNode, entry: NodeTypeEntry): NodeParamSpec[] {
  if (entry.manifest.runner.kind !== "trigger") return entry.manifest.params;
  const kind = node.params[NODE_TRIGGER_KIND_PARAM_KEY];
  const only: Record<string, readonly string[]> = {
    [NODE_TRIGGER_CRON_PARAM_KEY]: ["schedule"], [NODE_TRIGGER_PATHS_PARAM_KEY]: ["file"],
    [NODE_TRIGGER_EVENTS_PARAM_KEY]: ["event"], [NODE_TRIGGER_FILTER_PARAM_KEY]: ["event"],
    [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: ["file", "event"],
  };
  return entry.manifest.params.filter(s => !Object.hasOwn(only, s.key) || only[s.key].includes(String(kind)))
    .map(s => s.key === NODE_TRIGGER_PROJECT_PARAM_KEY ? { ...s, required: kind !== "event" } : s);
}

/** Reflect the same defaults that the executors use; never persist UI-only defaults. */
export function displayedParam(node: WorkflowNode, spec: NodeParamSpec): unknown {
  if (node.params[spec.key] !== undefined) return node.params[spec.key];
  switch (spec.key) {
    case NODE_DECIDER_KEY: return deciderOf(node.params);
    case NODE_INJECT_MODE_KEY: return injectModeOf(node.params);
    case NODE_INJECT_TARGET_KEY: return injectTargetOf(node.params);
    case NODE_RETURN_PARAM_KEY: return returnModeOf(node.params);
    case NODE_TRIGGER_ENABLED_PARAM_KEY: return triggerEnabledOf(node.params);
    default: return spec.default;
  }
}

/** Built-in UI metadata only: user/plugin text and executable configuration are untouched. */
export function localizeWorkflowCatalog(catalog: NodeTypeCatalog, t: Translate): NodeTypeCatalog {
  const labels: Record<string, [MessageId, MessageId]> = {
    language: ["settings.workflows.code.language", "settings.workflows.code.languageHelp"],
    code: ["settings.workflows.code.source", "settings.workflows.code.sourceHelp"],
    input: ["settings.workflows.code.input", "settings.workflows.code.inputHelp"],
    timeoutMs: ["settings.workflows.code.timeout", "settings.workflows.code.timeoutHelp"],
  };
  return { ...catalog, entries: catalog.entries.map(entry => {
    if (entry.id !== "mcode.code" || entry.source !== "builtin") return entry;
    return { ...entry, manifest: { ...entry.manifest,
      name: t("settings.workflows.code.name"), description: t("settings.workflows.code.description"),
      category: t("settings.nav.automation"), usage: t("settings.workflows.code.usage"),
      params: entry.manifest.params.map(spec => Object.hasOwn(labels, spec.key) ? {
        ...spec, label: t(labels[spec.key][0]), help: t(labels[spec.key][1]),
      } : spec),
    } };
  }) };
}
