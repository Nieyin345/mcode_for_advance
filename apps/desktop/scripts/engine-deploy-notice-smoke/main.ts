/**
 * W6 deployment notice: real EngineRow SSR, real zh/en i18n,
 * and the Host-backed status predicate. Never mock the component's markup.
 * Runtime deploy receipt is tested separately in executor-gate-d-smoke.
 */
import "../workflow-engine-view-owner-smoke/prelude.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowEngineStatusView } from "@contracts/ipc";
import { EngineRow, shouldShowRestartDeployNotice } from "@renderer/components/settings/workflows/EngineRuntimePanel.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

let total = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  total++;
  if (condition) console.log("  ok   " + label);
  else { failed++; console.error("  FAIL " + label + (detail === undefined ? "" : " — " + JSON.stringify(detail))); }
}
function view(
  deploymentState: WorkflowEngineStatusView["deploymentState"],
  state: WorkflowEngineStatusView["state"] = "running",
  engineId = "node-red",
  locale: "zh" | "en" = "zh",
): { html: string; predicate: boolean } {
  const current = useSessionStore.getInitialState() as { locale: string };
  const previous = current.locale;
  current.locale = locale;
  const status: WorkflowEngineStatusView = {
    engineId, state, port: state === "running" ? 2389 : null,
    reason: null, editorUrl: state === "running" ? "http://127.0.0.1:2389/" : null,
    ...(deploymentState === undefined ? {} : { deploymentState }),
  };
  try {
    return {
      predicate: shouldShowRestartDeployNotice(status),
      html: renderToStaticMarkup(createElement(EngineRow, { status, active: true, onChanged: async () => {} })),
    };
  } finally {
    current.locale = previous;
  }
}
const hasNotice = (html: string) => html.includes('data-engine-deploy-notice=""');
const runningOnly = view("not-deployed");
check("引擎 running 但未部署 → 不显示重启提示", !hasNotice(runningOnly.html) && !runningOnly.predicate);
const valid = view("deployed");
check("收到本次成功部署回执 → 真实 UI 显示提示", valid.predicate && hasNotice(valid.html));
check("中文明确告知重启后不会自动运行、需重新部署", valid.html.includes("重启 Mcode 后不会自动恢复运行")
  && valid.html.includes("再次点击") && valid.html.includes("部署"), valid.html.slice(0, 1300));
const unknown = view("unknown");
check("部署结果不确定 → 不伪装成功", !hasNotice(unknown.html) && !unknown.predicate);
const absent = view(undefined);
check("旧版/未实现 deploymentState 的状态 → fail closed", !hasNotice(absent.html) && !absent.predicate);
const stopped = view("deployed", "stopped");
check("停止引擎后即使载荷陈旧也不显示", !hasNotice(stopped.html) && !stopped.predicate);
const other = view("deployed", "running", "other-engine");
check("其他引擎不套用 Node-RED 的重启规则", !hasNotice(other.html) && !other.predicate);
const english = view("deployed", "running", "node-red", "en");
check("英文真实 SSR 提示指出 restart 与 Deploy", hasNotice(english.html)
  && english.html.includes("restarting Mcode") && english.html.includes("click Deploy"), english.html.slice(0, 1300));
console.log("engine-deploy-notice-smoke: " + (total - failed) + "/" + total);
if (failed) process.exitCode = 1;
