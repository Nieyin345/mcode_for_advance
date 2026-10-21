/**
 * T64 isolated E1: fake workflow ports; all files live under OS tmpdir.
 * Never reads the real Mcode data root/database.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { composeNodePrompt, FRAMEWORK_SECTIONS } from "@main/orchestration/schedulerPrompt.js";
import { frameworkFile, listFrameworkSections, readFrameworkOverrides, resetFrameworkSection, saveFrameworkSection } from "@main/orchestration/frameworkPromptStore.js";
import { runWorkflow } from "@main/orchestration/scheduler.js";
import { check, eq, makePorts, node, edge, docOf, controller, PLAN, summary } from "../scheduler-smoke/harness.js";

const root = mkdtempSync(join(tmpdir(), "mcode-t64-test-"));
const graph = docOf([node("A"), node("B")], [edge("A", "B")]);
const args = { userPrompt: "请完成任务", upstream: "上游数据", instruction: "只做本步", nodeId: "B", plan: PLAN, outputContract: "正文" };

try {
  const untouched = composeNodePrompt(args);
  check("默认流程话术与原文逐字一致", untouched.includes("本流程共 4 步,每一步由一名独立的助手完成,彼此之间不共享上下文。你负责其中一步:"));
  check("默认产出标题与原文逐字一致", untouched.includes("## 这一步要产出什么\n正文"));

  const rows = listFrameworkSections(root);
  eq("框架一共四段", rows.length, 4);
  eq("默认没有任何自定义", rows.filter((v) => v.customized).length, 0);
  const memory = rows.find((v) => v.id === "memory");
  check("记忆快照禁止编辑且带说明", memory?.editable === false && (memory.description.includes("动态") && memory.description.includes("不可编辑")));
  check("工具权限协议禁止编辑且带说明", rows.find((v) => v.id === "protocol")?.editable === false);
  let rejected = false;
  try { saveFrameworkSection(root, "memory" as "flow", "篡改记忆"); } catch { rejected = true; }
  check("只读段无论从什么调用方进入均拒绝写入", rejected);

  saveFrameworkSection(root, "flow", "本流程有 {{total}} 步；T64自定义流程话术");
  saveFrameworkSection(root, "output", "## 自定义产出标题");
  const a = readFrameworkOverrides(root);
  eq("自定义状态被持久化", listFrameworkSections(root).filter((v) => v.customized).length, 2);
  const changed = composeNodePrompt({ ...args, frameworkOverrides: a });
  check("自定义流程下一轮生效", changed.includes("本流程有 4 步；T64自定义流程话术"));
  check("自定义产出标题下一轮生效", changed.includes("## 自定义产出标题\n正文"));
  check("动态流程节点清单不能被设置覆盖", changed.includes("查文献、算数据"));
  check("节点指令不受设置覆盖", changed.includes("只做本步"));
  check("上游不受设置覆盖", changed.includes("上游数据"));

  // Two concurrent workflow runs, each frozen at the start of its own turn.
  const old = makePorts({ delayMs: (id) => id === "A" ? 35 : 5 });
  old.ports.frameworkOverrides = a;
  const running = runWorkflow({ doc: graph, prompt: "任务", ports: old.ports, signal: controller().signal });
  saveFrameworkSection(root, "flow", "T64第二个对话独立话术 {{total}}");
  const b = readFrameworkOverrides(root);
  const fresh = makePorts();
  fresh.ports.frameworkOverrides = b;
  const second = runWorkflow({ doc: graph, prompt: "任务", ports: fresh.ports, signal: controller().signal });
  await Promise.all([running, second]);
  check("运行中的旧对话保持旧快照", old.calls.every((v) => v.prompt.includes("T64自定义流程话术")));
  check("新对话用新话术且不串入旧对话", fresh.calls.every((v) => v.prompt.includes("T64第二个对话独立话术")));
  check("旧对话无新文本", old.calls.every((v) => !v.prompt.includes("T64第二个对话独立话术")));

  resetFrameworkSection(root, "flow");
  const reset = readFrameworkOverrides(root);
  check("恢复默认确实回到硬编码原文", composeNodePrompt({ ...args, frameworkOverrides: reset }).includes("本流程共 4 步,每一步由一名独立的助手完成,彼此之间不共享上下文。你负责其中一步:"));
  check("恢复默认不会动另一段", reset.output === "## 自定义产出标题");

  // This assertion MUST turn red when the empty-file fallback is mutated.
  mkdirSync(join(root, "context", "framework"), { recursive: true });
  writeFileSync(frameworkFile(root, "flow"), " \n  ", "utf8");
  const empty = readFrameworkOverrides(root);
  eq("空文件不应作为覆盖值", empty.flow, undefined);
  check("空文件回到默认而非空串", composeNodePrompt({ ...args, frameworkOverrides: empty }).includes("本流程共 4 步,每一步由一名独立的助手完成"));
  saveFrameworkSection(root, "flow", "");
  check("保存空串等同恢复默认", !listFrameworkSections(root).find((v) => v.id === "flow")?.customized);

  // UI guard: readonly rows are visually dimmed and explicitly marked;
  // disabled rows have no edit/reset controls. Source-level assertion is only
  // supplemental to the runtime allowlist above.
  const ui = readFileSync(join(process.cwd(), "src", "renderer", "components", "settings", "FrameworkPromptPanel.tsx"), "utf8");
  check("UI 灰显只读段并标记 aria-disabled", ui.includes('!section.editable ? "opacity-55"') && ui.includes('aria-disabled={!section.editable ? "true"'));
  check("UI 向用户说明生效时机", ui.includes('settings.framework.nextRun'));
} finally {
  rmSync(root, { recursive: true, force: true });
}
summary();
