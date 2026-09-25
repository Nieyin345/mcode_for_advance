/**
 * 1B · 两种入口各走真链路:主页选择工作流从主代理开始;
 * 事件先被自动化触发器捕获,再经条件判定交给子代理。
 *
 * 后台触发器、导入审查、工作流保存/加载与调度器都是真实现。只有模型
 * 执行端口被替身代替;数据根必须指向一次性的测试目录,绝不读用户的真库。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, SYSTEM_AUTOMATION_PROJECT_ID } from "@main/store/repositories.js";
import { importWorkflowInto, getWorkflow } from "@main/orchestration/library.js";
import { approveWorkflowRevision, workflowRevision } from "@main/orchestration/workflowTrust.js";
import { automationRunner } from "@main/orchestration/automationRunner.js";
import { builtinManifestById, loadNodeTypes } from "@main/orchestration/nodeTypes.js";
import { validateWorkflowDoc } from "@main/orchestration/workflowValidation.js";
import { runWorkflow, type RunPorts } from "@main/orchestration/scheduler.js";
import type { RuntimeEvent } from "@contracts/runtime";
import type { NodeOutcome } from "@contracts/nodeType";
import type { WorkflowDoc } from "@contracts/workflow";
import { runtimeManager } from "../automation-smoke/stubs/runtimeManager.js";
import { resetRuns, runsOfNode, type CapturedRun } from "./stubs/runner.js";

let passed = 0, failed = 0;
function check(name: string, okay: boolean, detail?: unknown): void {
  (okay ? passed++ : failed++);
  console.log(`  ${okay ? "ok  " : "FAIL"} ${name}`, okay ? "" : detail ?? "");
}
const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const data = process.env.MCODE_SMOKE_DATA_ROOT;
if (!data || !resolve(data).startsWith(resolve(".tmp"))) {
  throw new Error("只准在 apps/desktop/.tmp 的临时数据根执行此烟测");
}

const automationFile = "examples/workflows/event-to-agent-automation.json";
const chatFile = "examples/workflows/chat-main-workflow.json";
check("可导入、可编辑的自动化范例已提供", existsSync(automationFile));
check("可导入、可编辑的主页工作流范例已提供", existsSync(chatFile));

if (existsSync(automationFile) && existsSync(chatFile)) {
  await initDb();
  const catalog = await loadNodeTypes();
  const types = new Map(catalog.entries.map((entry) => [entry.id, entry.manifest]));
  const rawAuto = JSON.parse(readFileSync(automationFile, "utf8")) as WorkflowDoc;
  const rawChat = JSON.parse(readFileSync(chatFile, "utf8")) as WorkflowDoc;
  check("自动化有事件触发器,没有聊天主代理", rawAuto.trigger === "event" &&
    rawAuto.nodes.some((n) => n.type === "mcode.trigger") &&
    !rawAuto.nodes.some((n) => n.type === "mcode.main"));
  check("聊天工作流有主代理,没有自动触发器", rawChat.trigger === undefined &&
    rawChat.nodes.some((n) => n.type === "mcode.main") &&
    !rawChat.nodes.some((n) => n.type === "mcode.trigger"));
  check("示例默认不自动运行,须用户主动启用", rawAuto.nodes.find((n) => n.type === "mcode.trigger")?.params.enabled === false);
  for (const [name, doc] of [["自动化", rawAuto], ["聊天工作流", rawChat]] as const) {
    const report = validateWorkflowDoc(doc, { types });
    check(`${name}范例能通过真实保存校验`, report.ok, report.errors);
  }
  const badTrigger = {
    ...rawAuto,
    nodes: rawAuto.nodes.map((n) => n.type === "mcode.trigger"
      ? { ...n, params: { ...n.params, events: "unknown.event" } } : n),
  };
  const rejected = await importWorkflowInto(JSON.stringify(badTrigger));
  check("导入不是绕过事件清单/存盘校验的后门", !rejected.ok, rejected);

  // 按「导入」实际走一次入口;只对本次测试的临时库落盘。修改导入副本而非
  // 给用户的示例:打开 enable + 设 0ms 合并窗口,模拟用户自行配置后审查。
  const active = {
    ...rawAuto,
    nodes: rawAuto.nodes.map((n) => n.type === "mcode.trigger"
      ? { ...n, params: { ...n.params, enabled: true, debounceMs: 0 } } : n),
  };
  const imported = await importWorkflowInto(JSON.stringify(active));
  check("用户导入自定义自动化可落盘", imported.ok, imported);
  if (imported.ok) {
    const doc = getWorkflow(imported.id);
    const trigger = doc?.nodes.find((n) => n.type === "mcode.trigger");
    const yes = doc?.nodes.find((n) => n.id === "review-agent");
    const no = doc?.nodes.find((n) => n.id === "fallback-agent");
    check("落盘保留可自定义的事件/规则/子代理节点", doc?.trigger === "event" &&
      trigger?.params.events === "library.item.downloaded" &&
      doc.nodes.some((n) => n.type === "mcode.condition") &&
      yes?.type === "mcode.agent" && no?.type === "mcode.agent");

    if (doc && trigger && yes && no) {
      resetRuns();
      await automationRunner.start();
      try {
        const send = async (id: string, pdfPath: string): Promise<CapturedRun | undefined> => {
          const before = runsOfNode(trigger.id).length;
          runtimeManager.emit({
            type: "library.item.downloaded", sessionId: "(system)",
            itemId: id, title: `论文 ${id}`, pdfPath,
          } as RuntimeEvent);
          // debounceMs=0,但 fire 会经历 setTimeout 与一次异步会话建档。
          for (let i = 0; i < 24 && runsOfNode(trigger.id).length <= before; i++) await wait(10);
          return runsOfNode(trigger.id)[before];
        };
        // 导入的图未经审查,即使触发器参数启用也绝不后台运行。
        const blocked = await send("lib_unreviewed", "paper.pdf");
        check("未审查的导入自动化不会因事件起跑", blocked === undefined);
        check("用户批准当前版本后才放行", approveWorkflowRevision(doc, workflowRevision(doc)).ok);
        await automationRunner.reload(imported.id);
        check("审查后事件触发器显示已武装", automationRunner.statusOf(imported.id).some((r) => r.armed));

        const portsFor = (summary: string) => {
          const executed: string[] = [];
          let chose = 0;
          const ports: RunPorts = {
            async manifestOf(typeId) { return builtinManifestById(typeId); },
            async manifestDirOf() { return undefined; },
            contextLines() { return []; },
            async execute(node, _manifest, input): Promise<NodeOutcome> {
              executed.push(node.id);
              return { status: "success", summary: node.type === "mcode.main" ? summary : input.prompt };
            },
            async choose() { chose++; return { edgeId: "not-allowed" }; },
            report() {},
          };
          return { ports, executed, choices: () => chose };
        };
        const resumeCaptured = async (capture: CapturedRun | undefined, label: string) => {
          if (!capture?.entry?.nodeId) { check(`${label}有正确的事件起跑参数`, false, capture); return; }
          const entry = {
            nodeId: capture.entry.nodeId,
            summary: capture.entry.summary ?? "",
            payload: capture.entry.payload ?? {},
          };
          const host = portsFor("");
          const result = await runWorkflow({
            doc, prompt: capture.prompt ?? "", entry, ports: host.ports,
            signal: new AbortController().signal,
          });
          check(`${label}直接进入工作流调度器并由规则选路`,
            result.status === "success" && result.outcomes.get("judge")?.status === "success" &&
            host.choices() === 0, result.outcomes.get("judge"));
          const matched = label === "带 PDF";
          check(`${label}只派发对应子代理,另一支路 unselected`,
            host.executed.includes(matched ? yes.id : no.id) &&
            !host.executed.includes(matched ? no.id : yes.id) &&
            result.outcomes.get(matched ? no.id : yes.id)?.status === "unselected", host.executed);
          check(`${label}条件与所选出边写进运行存档`,
            result.state.picks.some(([id, choice]) => id === "judge" &&
              choice.edgeId === (matched ? "e_true" : "e_false")));
        };

        const pdf = await send("lib_pdf", "papers/lib_pdf.pdf");
        check("真实事件→自动化入口保留原始载荷/任务", pdf?.entry?.payload?.itemId === "lib_pdf" &&
          pdf.entry.payload?.pdfPath === "papers/lib_pdf.pdf" &&
          pdf.prompt?.includes("论文 lib_pdf") === true, pdf);
        check("无项目事件使用专属后台会话而非借用用户项目",
          SessionRepo.findAutomationByWorkflow(imported.id)?.projectId === SYSTEM_AUTOMATION_PROJECT_ID &&
          ProjectRepo.get(SYSTEM_AUTOMATION_PROJECT_ID) !== undefined);
        check("后台外键占位行不出现在项目列表/工作目录白名单",
          ProjectRepo.list().every((p) => p.id !== SYSTEM_AUTOMATION_PROJECT_ID) &&
          !ProjectRepo.listPaths().includes(process.cwd()));
        await resumeCaptured(pdf, "带 PDF");
        const other = await send("lib_other", "papers/attachment.txt");
        await resumeCaptured(other, "非 PDF");
        const savedSession = SessionRepo.findAutomationByWorkflow(imported.id)?.id;
        ProjectRepo.delete(SYSTEM_AUTOMATION_PROJECT_ID);
        check("误删系统项目不会级联删除后台运行史",
          ProjectRepo.get(SYSTEM_AUTOMATION_PROJECT_ID) !== undefined &&
          SessionRepo.findAutomationByWorkflow(imported.id)?.id === savedSession);
      } finally {
        automationRunner.dispose();
      }
    }
  }

  // 另一类不靠任何后台监听:主页聊天选中主代理那份图,用户消息就是输入。
  const chat = await importWorkflowInto(JSON.stringify(rawChat));
  check("聊天工作流也能走同一个导入/保存入口", chat.ok, chat);
  const chosenDoc = chat.ok ? getWorkflow(chat.id) : null;
  if (chosenDoc) {
    check("聊天图导入后也要审查本版本", approveWorkflowRevision(chosenDoc, workflowRevision(chosenDoc)).ok);
    const executed: string[] = [];
    let chose = 0;
    const result = await runWorkflow({
      doc: chosenDoc, prompt: "请整理刚才讨论的研究成果", signal: new AbortController().signal,
      ports: {
        async manifestOf(id) { return builtinManifestById(id); },
        async manifestDirOf() { return undefined; },
        contextLines() { return []; },
        async execute(node, _manifest, input) {
          executed.push(node.id);
          return { status: "success", summary: node.type === "mcode.main" ? "通过：开始整理" : input.prompt };
        },
        async choose() { chose++; return { edgeId: "not-allowed" }; },
        report() {},
      },
    });
    check("主页工作流从主代理起跑,不依赖事件载荷", result.status === "success" &&
      executed[0] === "main-chat" && executed.includes("chat-approved") &&
      !executed.includes("chat-revisit") && chose === 0, executed);
  }
}

console.log(`event-vertical-smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
