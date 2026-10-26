/** T79: immutable editor resource contract. Runs before the live-engine segment. */
import { agentNodeHtml } from "@main/workflowEngines/mcodeNodePack.js";
import {
  conversationNodeHtml, branchNodeHtml, triggerNodeHtml,
  moduleCapabilityNodeHtml, nodeRedCallNodeHtml,
} from "@main/workflowEngines/mcodeNodeTypes.js";
import { expectedNodePackFiles } from "@main/workflowEngines/nodePackManifest.js";

type Check = (name: string, passed: boolean, detail?: unknown) => void;
type Field = { id: string; kind: "text" | "textarea" | "select"; options?: string[] };
/** `palette: false` = 内部节点：仍完整注册（能读、能跑），但**不给 category**，
 *  用户拖不到新的。见 `MCODE_INTERNAL_NODE_TYPES` 的说明。 */
const defs: Array<{ type: string; icon: string; html: () => string; fields: Field[]; palette: boolean }> = [
  { type: "mcode-agent", icon: "fa-user", html: agentNodeHtml, fields: [
    { id: "instruction", kind: "textarea" }, { id: "capability", kind: "select", options: ["read", "write"] },
    { id: "outputVar", kind: "text" }, { id: "sessionId", kind: "text" },
  ], palette: true },
  { type: "mcode-conversation", icon: "fa-comments", html: conversationNodeHtml, fields: [
    { id: "instruction", kind: "textarea" }, { id: "capability", kind: "select", options: ["read", "write"] },
    { id: "outputVar", kind: "text" }, { id: "sessionId", kind: "text" },
  ], palette: true },
  { type: "mcode-branch", icon: "fa-random", html: branchNodeHtml, fields: [
    { id: "decider", kind: "select", options: ["user", "model"] },
    { id: "outputVar", kind: "text" }, { id: "note", kind: "textarea" }, { id: "sessionId", kind: "text" },
  ], palette: true },
  { type: "mcode-trigger", icon: "fa-bolt", html: triggerNodeHtml, fields: [
    { id: "triggerKind", kind: "select", options: ["manual", "schedule", "file", "event"] },
    { id: "task", kind: "textarea" }, { id: "cron", kind: "text" },
  ], palette: true },
  { type: "mcode-module-capability", icon: "fa-puzzle-piece", html: moduleCapabilityNodeHtml, fields: [
    { id: "moduleId", kind: "text" }, { id: "contributionId", kind: "text" },
    { id: "path", kind: "text" }, { id: "projectPath", kind: "text" },
  ], palette: true },
  { type: "mcode-node-red-call", icon: "fa-retweet", html: nodeRedCallNodeHtml, fields: [
    { id: "enginePath", kind: "text" },
    { id: "engineMethod", kind: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
    { id: "engineBody", kind: "textarea" },
  ], palette: false },
];
function attr(tag: string, property: string): string | null {
  const match = tag.match(new RegExp("(?:^|\\s)" + property + '="([^"]*)"'));
  return match?.[1] ?? null;
}
function element(html: string, tag: string, id: string): string {
  return html.match(new RegExp("<" + tag + "\\b[^>]*\\bid=\"node-input-" + id + "\"[^>]*>"))?.[0] ?? "";
}
export function checkPaletteResources(check: Check): void {
  const files = expectedNodePackFiles();
  const observedIcons: string[] = [];
  const helpTexts: string[] = [];
  for (const d of defs) {
    const html = d.html();
    const stem = d.type + ".html";
    check("T79 " + d.type + " manifest HTML equals generated editor form",
      files[stem] === html);
    // 注册块三件套对**所有**类型都必须有（缺模板 = 上游把它当 unknown，导出丢 x-mcode）。
    // category 分两档：palette 节点必须是 "mcode"，内部节点必须是空串（不进 palette）。
    check("T79 " + d.type + " all three Node-RED registration blocks",
      html.includes('RED.nodes.registerType("' + d.type + '"')
      && html.includes('data-template-name="' + d.type + '"')
      && html.includes('data-help-name="' + d.type + '"'));
    check("T79 " + d.type + (d.palette ? " 出现在 palette" : " 不出现在 palette"),
      d.palette ? html.includes('category: "mcode"') : html.includes('category: ""'),
      { palette: d.palette });
    const icon = html.match(/\bicon:\s*"font-awesome\/([^"]+)"/)?.[1] ?? "";
    observedIcons.push(icon);
    check("T79 " + d.type + " supported Font Awesome icon",
      icon === d.icon, { actual: icon, expected: d.icon });
    const help = html.match(new RegExp('<script type="text/html" data-help-name="' + d.type + '">([\\s\\S]*?)</script>'))?.[1] ?? "";
    helpTexts.push(help);
    for (const key of ["input", "output", "approval"]) {
      check("T79 " + d.type + " help explicitly documents " + key,
        help.includes('data-i18n="mcode.help.' + key + '"')
        && new RegExp("<p[^>]*>\\s*" + key[0]!.toUpperCase() + key.slice(1) + ":\\s*[^<]+</p>").test(help));
    }
    check("T79 " + d.type + " has native localized name label and placeholder/title",
      html.includes('data-i18n="common.label.name"')
      && attr(element(html, "input", "name"), "data-i18n") === "[placeholder]common.label.name"
      && /<label for="node-input-name"[^>]*data-i18n="\[title\]mcode\.tooltip\.name"/.test(html));
    const forms = d.fields;
    for (const f of forms) {
      const field = f.id;
      const labelMatch = new RegExp('<label for="node-input-' + field + '"[^>]*data-i18n="\\[title\\]mcode\\.tooltip\\.' + field + '"[^>]*>\\s*(?:<i[^>]*><\\/i>\\s*)?<span data-i18n="mcode.label.' + field + '">');
      check("T79 " + d.type + " " + field + " localizes label and tooltip", labelMatch.test(html));
      const tag = f.kind === "text" ? "input" : f.kind;
      const markup = element(html, tag, field);
      check("T79 " + d.type + " " + field + " preserves native editor control", markup !== "");
      if (f.kind !== "select") {
        check("T79 " + d.type + " " + field + " localizes placeholder",
          attr(markup, "data-i18n") === "[placeholder]mcode.placeholder." + field);
      } else {
        const section = html.split('<select id="node-input-' + field + '"')[1]?.split("</select>")[0] ?? "";
        const options = [...section.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)];
        check("T79 " + d.type + " " + field + " localizes every option without translating its value",
          options.length === f.options?.length && options.every((o, i) =>
            attr(o[1] ?? "", "value") === f.options?.[i] &&
            attr(o[1] ?? "", "data-i18n") === "mcode.option." + f.options?.[i]),
          { actual: options.map((o) => o[1]), expected: f.options });
      }
    }
    for (const language of ["en-US", "zh-CN"] as const) {
      const localeFile = files["locales/" + language + "/" + d.type + ".json"];
      let resource: Record<string, unknown> = {};
      try { resource = JSON.parse(localeFile ?? "{}") as Record<string, unknown>; } catch { /* fail assertions */ }
      const mcode = resource["mcode"] as Record<string, Record<string, string>> | undefined;
      const required: Record<string, string[]> = {
        label: ["name", ...forms.map((f) => f.id)],
        placeholder: forms.filter((f) => f.kind !== "select").map((f) => f.id),
        tooltip: ["name", ...forms.map((f) => f.id)],
        option: [...new Set(forms.flatMap((f) => f.options ?? []))],
        help: ["input", "output", "approval"],
      };
      for (const [group, keys] of Object.entries(required)) {
        check("T79 " + d.type + " " + language + " complete " + group + " catalog",
          keys.every((key) => typeof mcode?.[group]?.[key] === "string"
            && mcode[group][key]!.trim().length > 0),
          { missing: keys.filter((key) => !mcode?.[group]?.[key]) });
      }
      check("T79 " + d.type + " " + language + " help mentions payload/outputs and approval policy",
        /msg\.payload/.test(mcode?.help?.input ?? "")
        && /msg\.payload|outputs|出口|输出/.test(mcode?.help?.output ?? "")
        && /approv|permission|grant|deny|block|授权|审批|批准|确认|弹窗|权限/.test(mcode?.help?.approval ?? ""));
    }
    // A pair of non-empty English strings is not a bilingual UI. Require
    // every actually referenced field/option/help key to differ in zh-CN.
    const en = JSON.parse(files["locales/en-US/" + d.type + ".json"]!) as {
      mcode: Record<string, Record<string, string>>;
    };
    const zh = JSON.parse(files["locales/zh-CN/" + d.type + ".json"]!) as {
      mcode: Record<string, Record<string, string>>;
    };
    const translated: Record<string, string[]> = {
      label: d.fields.map((f) => f.id),
      tooltip: ["name", ...d.fields.map((f) => f.id)],
      placeholder: d.fields.filter((f) => f.kind !== "select").map((f) => f.id),
      option: [...new Set(d.fields.flatMap((f) => f.options ?? []))],
      help: ["input", "output", "approval"],
    };
    const untranslated = Object.entries(translated).flatMap(([part, keys]) =>
      keys.filter((key) => !en.mcode?.[part]?.[key]
        || !zh.mcode?.[part]?.[key]
        || en.mcode[part][key] === zh.mcode[part][key])
        .map((key) => part + "." + key));
    check("T79 " + d.type + " all visible English and Chinese strings are different",
      untranslated.length === 0, untranslated);
  }
  check("T79 six icons are pairwise distinct", new Set(observedIcons).size === 6, observedIcons);
  check("T79 six help texts are pairwise distinct", new Set(helpTexts).size === 6);
  const branch = defs.find((d) => d.type === "mcode-branch")!.html();
  check("T79 branch dynamic outputs preserved",
    branch.includes("Math.max(1, (this.wires && this.wires.length) || 1)"));
}
