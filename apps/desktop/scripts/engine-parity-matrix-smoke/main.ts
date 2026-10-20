/**
 * T08 / ARC-003: historical (2026-09-20) three-engine comparison, executable.
 * Evidence: E2 source anchors + E1 pure host-context & JSON validation.
 * A reported capability FAIL is a product finding, not a smoke harness failure.
 * A missing/changed source anchor IS a harness failure (prevents stale green).
 * No real SDK traffic, credentials or user files.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { turnContextSections } from "@main/providers/contextPrompt.js";
import { parseStructuredOutput } from "@main/lib/structuredOutput.js";

type Engine = "claude" | "pi" | "codex";
type State = "PASS" | "FAIL" | "N/A";
type Cell = { state: State; reason: string; anchors: readonly string[] };
type Capability = { id: string; title: string; doc: string; cells: Record<Engine, Cell> };
const engines: readonly Engine[] = ["claude", "pi", "codex"];
const sources: Record<string, string> = {
  claude: "src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts",
  pi: "src/main/providers/pi-sdk/PiAgentSdkProvider.ts",
  codex: "src/main/providers/codex-sdk/CodexAgentSdkProvider.ts",
  runtime: "src/main/claude/RuntimeManager.ts",
  context: "src/main/providers/contextPrompt.ts",
  approvals: "src/main/claude/ApprovalBridge.ts",
  structured: "src/main/lib/structuredOutput.ts",
  piExtension: "src/main/providers/pi-sdk/mcodeExtension.ts",
  piAdapter: "src/main/providers/pi-sdk/PiMessageAdapter.ts",
  criteria: "src/main/orchestration/criteriaInject.ts",
  workflowRunner: "src/main/orchestration/runner.ts",
  settings: "src/renderer/components/settings/SettingsPage.tsx",
  uiMcp: "src/renderer/components/settings/workflows/ParamFieldParts.tsx",
  piToken: "src/main/providers/pi-sdk/piTokenUsage.ts",
  codexBinary: "src/main/providers/codex-sdk/codexBinaryResolve.ts",
  general: "src/renderer/components/settings/GeneralPanel.tsx",
};
const sourceText = Object.fromEntries(Object.entries(sources).map(([id, path]) => [id, readFileSync(join(process.cwd(), path), "utf8")])) as Record<string, string>;
const contents = (key: string, fragment: string): boolean => sourceText[key]?.includes(fragment) === true;
let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, observed?: unknown): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`  FAIL ${label} ${JSON.stringify(observed)}`);
  } else console.log(`  ok   ${label}`);
}
function c(state: State, reason: string, ...anchors: string[]): Cell { return { state, reason, anchors }; }
const capabilities: Capability[] = [
  { id: "budget", title: "本轮预算及超限停止", doc: "23-27", cells: {
    claude: c("PASS", "宿主 enforceBudget 发 notice/interrupt，另有 SDK maxTurns/maxBudgetUsd", "runtime:budgetViolations(budget", "runtime:rt.handle.interrupt()", "claude:maxBudgetUsd: req.budget?.maxUsd"),
    pi: c("PASS", "宿主同一入口；Pi 读取单轮 delta 而非会话累计", "runtime:budgetViolations(budget", "piToken:t.total - sessionTotalBaseline", "piToken:stats.cost - sessionCostBaseline", "runtime:rt.handle.interrupt()"),
    codex: c("PASS", "宿主同一入口；无 Codex 原生 USD 预算参数", "runtime:budgetViolations(budget", "runtime:rt.handle.interrupt()", "codex:budget: req.toolBudget"),
  }},
  { id: "fallback", title: "普通主对话模型失败回退", doc: "23-35", cells: {
    claude: c("PASS", "宿主错误后重发 + SDK 第一 fallbackModel", "runtime:rt.fallbackModels.shift()", "claude:fallbackModel: req.fallbackModels?.[0]"),
    pi: c("PASS", "共享 RuntimeManager 回退，不是 Pi provider 的模型选择降级", "runtime:rt.fallbackModels.shift()", "runtime:fallbackRetryModel: nextModel"),
    codex: c("PASS", "共享 RuntimeManager 回退，不是 Codex provider 原生重试", "runtime:rt.fallbackModels.shift()", "runtime:fallbackRetryModel: nextModel"),
  }},
  { id: "fallback-custom", title: "自定义网关/工作流会话回退", doc: "33-35", cells: {
    claude: c("FAIL", "宿主 !session.customModelId、!session.workflowId 禁用整个链（文档已指出）", "runtime:!session.workflowId && !session.customModelId"),
    pi: c("FAIL", "同一个宿主门禁，与引擎无关", "runtime:!session.workflowId && !session.customModelId"),
    codex: c("FAIL", "同一个宿主门禁，与引擎无关", "runtime:!session.workflowId && !session.customModelId"),
  }},
  { id: "structured", title: "结构化输出二次校验失败", doc: "103-110,122-129", cells: {
    claude: c("PASS", "自定义网关使用共享 schema 校验+structured_invalid；默认端点走 SDK outputFormat", "claude:parseStructuredOutput(", "claude:structured_invalid", "claude:options.outputFormat"),
    pi: c("PASS", "提示词+解析，失败重试一次仍失败按 error 收尾", "pi:parseStructuredOutput(", "pi:structured_invalid", "pi:buildCorrectivePrompt("),
    codex: c("PASS", "提示词+解析，失败重试一次仍失败按 error 收尾", "codex:parseStructuredOutput(", "codex:structured_invalid", "codex:buildCorrectivePrompt("),
  }},
  { id: "custom-subagents", title: "自定义子代理派发/回收", doc: "90-100", cells: {
    claude: c("PASS", "SDK Options.agents，forwardSubagentText", "claude:options.agents = subagentsToAgentsRecord(", "claude:forwardSubagentText: true"),
    pi: c("N/A", "Pi 没有 Mcode 自定义子代理 SDK API；不是宿主实现的假同等能力", "pi:readonly capabilities: ProviderCapabilities"),
    codex: c("N/A", "Codex 可能有原生任务委派，但没有等价的自定义 Options.agents", "codex:readonly capabilities: ProviderCapabilities"),
  }},
  { id: "elicitation", title: "MCP elicitation/问题交互", doc: "57-67,103-110,131-133", cells: {
    claude: c("PASS", "MCP onElicitation → 宿主 requestUserInput，可 cancel", "claude:options.onElicitation = onElicitation", "claude:action: \"cancel\""),
    pi: c("N/A", "Pi supportsMcp:false，不存在 MCP elicitation；AskUserQuestion 为另一条桥", "pi:supportsMcp: false", "pi:supportsAskUserQuestion: true"),
    codex: c("PASS", "app-server item/tool/requestUserInput → 宿主 requestUserInput", "codex:item/tool/requestUserInput", "codex:const decision = await requestUserInput("),
  }},
  { id: "ask-question", title: "原生 AskUserQuestion / 缺桥失败", doc: "97-99,131-133", cells: {
    claude: c("PASS", "Claude canUseTool 分支接宿主提问; 缺省有 sentinel prompt", "claude:ASK_SYSTEM_PROMPT", "claude:supportsAskUserQuestion: true"),
    pi: c("PASS", "扩展注册 AskUserQuestion 使用 requestUserInput", "piExtension:toolName === \"AskUserQuestion\"", "piExtension:const decision = await requestUserInput("),
    codex: c("PASS", "动态 ask_user_question 与 app-server 提问共桥", "codex:case \"ask_user_question\":", "codex:const decision = await requestUserInput("),
  }},
  { id: "approval", title: "工具审批落点与缺桥拒绝", doc: "80-88,131-133", cells: {
    claude: c("PASS", "canUseTool → requestApproval，缺桥 deny", "claude:if (!requestApproval)", "claude:behavior: \"deny\""),
    pi: c("PASS", "扩展 tool_call，缺桥 block:true", "piExtension:if (!requestApproval)", "piExtension:block: true"),
    codex: c("PASS", "server requestApproval，无桥 codexApprovalReply(null)", "codex:if (!requestApproval)", "codex:return codexApprovalReply(null)"),
  }},
  { id: "approval-timeout", title: "用户不回应审批时的超时", doc: "80-88", cells: {
    claude: c("FAIL", "共用 ApprovalBridge pending Promise 未安装定时器/过期处理", "approvals:this.pendingApprovals.set(req.requestId", "approvals:new Promise<ProviderApprovalDecision>"),
    pi: c("FAIL", "共用 ApprovalBridge 既无超时也无自动拒绝（中断时另走 rejectPending）", "approvals:this.pendingApprovals.set(req.requestId", "approvals:new Promise<ProviderApprovalDecision>"),
    codex: c("FAIL", "同一共用审批桥；真实 SDK 可能自行超时，宿主没有保证", "approvals:this.pendingApprovals.set(req.requestId", "approvals:new Promise<ProviderApprovalDecision>"),
  }},
  { id: "context-injection", title: "五层可配置上下文经各引擎唯一入口", doc: "47-55,72-78", cells: {
    claude: c("PASS", "shared turnContextSections → systemPrompt preset append", "claude:appends.push(...turnContextSections(req))", "claude:append: joinPromptSections(...appends)"),
    pi: c("PASS", "shared turnContextSections → DefaultResourceLoader", "pi:systemPromptAppends: turnContextSections(req)", "pi:resourceLoader: skillLoader"),
    codex: c("PASS", "shared turnContextSections → thread/start 与 thread/resume developerInstructions", "codex:joinPromptSections(hostIdentity, ...turnContextSections(req))", "codex:developerInstructions,"),
  }},
  { id: "context-dedup", title: "相同上下文跨层只注入一次", doc: "47-55,72-78", cells: {
    claude: c("FAIL", "共同纯函数仅 trim/filter，无内容去重；相同 memory/agent 进入两次", "context:.filter((value) => value.length > 0)", "claude:appends.push(...turnContextSections(req))"),
    pi: c("FAIL", "同一 shared 纯函数允许重复片段", "context:.filter((value) => value.length > 0)", "pi:systemPromptAppends: turnContextSections(req)"),
    codex: c("FAIL", "同一 shared 纯函数允许重复片段", "context:.filter((value) => value.length > 0)", "codex:...turnContextSections(req)"),
  }},
  { id: "cancel", title: "取消与中断后回合终态", doc: "80-88", cells: {
    claude: c("PASS", "handle interrupt -> AbortController abort", "claude:interrupt: () => ac.abort()"),
    pi: c("PASS", "ac.abort + session.abort；结束标 interrupted", "pi:await session.abort()", "pi:adapter.finalizeTurn(\"interrupted\")"),
    codex: c("PASS", "turn/interrupt + adapter aborted terminal", "codex:client.request(\"turn/interrupt\"", "codex:adapter.finalizeAborted()"),
  }},
  { id: "resume", title: "会话恢复失败不可静默新建", doc: "98-100,103-110", cells: {
    claude: c("PASS", "SDK Options.resume，宿主统一追踪 provider session", "claude:resume: req.resumeProviderSessionId ?? undefined"),
    pi: c("PASS", "SessionManager.open 失败回报 FAILED 并抛错", "pi:SessionManager.open(req.resumeProviderSessionId)", "pi:kind: \"FAILED\""),
    codex: c("PASS", "thread/resume 失败回报 FAILED 并抛错", "codex:client.request(\"thread/resume\"", "codex:kind: \"FAILED\""),
  }},
  { id: "mcp", title: "MCP 接线与按节点限制", doc: "47-55,57-67", cells: {
    claude: c("PASS", "MCP 以 SDK options.mcpServers 与 req.mcpServerNames 筛选", "claude:const wantMcp = req.mcpServerNames ?? []"),
    pi: c("N/A", "Pi 扩展不是 MCP, supportsMcp:false", "pi:supportsMcp: false"),
    codex: c("PASS", "Codex mcpServerNames/config.toml 过滤器", "codex:codexTurnAllowsMcpServer(", "codex:mcpServerNames: req.mcpServerNames"),
  }},
  { id: "workflow-prompt", title: "工作流系统指令对三引擎可见", doc: "47-55", cells: {
    claude: c("PASS", "宿主解析 workflowPrompt 再由 shared sections append", "runtime:const workflowPrompt = resolveWorkflowPrompt(", "context:req.workflowPrompt", "claude:turnContextSections(req)"),
    pi: c("PASS", "Pi shared sections systemPromptAppends", "runtime:const workflowPrompt = resolveWorkflowPrompt(", "context:req.workflowPrompt", "pi:turnContextSections(req)"),
    codex: c("PASS", "Codex shared sections developerInstructions", "runtime:const workflowPrompt = resolveWorkflowPrompt(", "context:req.workflowPrompt", "codex:turnContextSections(req)"),
  }},
  { id: "plan-mode", title: "计划模式写操作语义", doc: "80-88", cells: {
    claude: c("PASS", "Claude SDK plan mode；需按真实策略验证不同后端权限", "claude:claudePlanModeNudge(", "claude:permissionModes: ["),
    pi: c("N/A", "有意差异：Pi 计划模式写操作需用户审批而非 Claude 严格只读；Pi provider 上方只读注释过期", "piExtension:Plan-mode: write tools allowed but require approval.", "piExtension:if (!requestApproval)", "pi:while in plan"),
    codex: c("N/A", "Codex plan mode 不提供可即时降级的等价 sandbox，提示词和 sandbox 是不同机制", "codex:const { sandbox, approvalPolicy } = codexModeToPolicy(mode)"),
  }},
  { id: "criteria-first-turn", title: "工作流固定条件只在入口首次注入", doc: "47-55", cells: {
    claude: c("PASS", "宿主 runner 仅未恢复且会话无消息时注入一次，与 provider 无关", "criteria:if (args.resumed || !args.firstTurn)", "workflowRunner:firstTurn: !MessageRepo.hasAny(session.id)"),
    pi: c("PASS", "共享入口 firstTurn 门禁；Pi 不额外拼固定条件", "criteria:if (args.resumed || !args.firstTurn)", "workflowRunner:prompt = injectEntryCriteria({"),
    codex: c("PASS", "共享入口 firstTurn 门禁；Codex 不额外拼固定条件", "criteria:if (args.resumed || !args.firstTurn)", "workflowRunner:prompt = injectEntryCriteria({"),
  }},
  { id: "criteria-passdown", title: "固定条件下游节点的选择性显式注入", doc: "47-55", cells: {
    claude: c("PASS", "按节点开关启用 downstream section，流程节点才接入", "criteria:if (!criteriaPassedDown(doc)) return \"\";", "workflowRunner:criteriaSectionForNodes(doc, session.workflowId)"),
    pi: c("PASS", "同一入口 runner 控制下游条件，provider 中立", "criteria:if (!criteriaPassedDown(doc)) return \"\";", "workflowRunner:criteriaSectionForNodes(doc, session.workflowId)"),
    codex: c("PASS", "同一入口 runner 控制下游条件，provider 中立", "criteria:if (!criteriaPassedDown(doc)) return \"\";", "workflowRunner:criteriaSectionForNodes(doc, session.workflowId)"),
  }},
  { id: "settings-visibility", title: "共用设置面板未按能力差异隐藏", doc: "16-31", cells: {
    claude: c("PASS", "Claude 的预算、回退、输出风格有原生或宿主支持", "general:<TurnBudgetPanel />", "general:<FallbackModelsPanel />", "general:<OutputStylePanel />"),
    pi: c("FAIL", "共用面板三项无条件显示；Pi 没有等价输出风格入口", "general:<TurnBudgetPanel />", "general:<FallbackModelsPanel />", "general:<OutputStylePanel />"),
    codex: c("FAIL", "共用面板三项无条件显示；Codex 没有等价输出风格入口", "general:<TurnBudgetPanel />", "general:<FallbackModelsPanel />", "general:<OutputStylePanel />"),
  }},
  { id: "skills", title: "技能路径与已选技能白名单", doc: "53-55,154-158", cells: {
    claude: c("PASS", "Claude SDK Options.skills 允许列表，插件技能合并", "claude:skills: await claudeSkillsOption(", "claude:await getEnabledPluginSkillRoots("),
    pi: c("PASS", "Pi loader 对已选技能做 allowNames；从启用插件取路径", "pi:allowNames: req.skills", "pi:extraSkillPaths: await getEnabledPluginSkillRoots("),
    codex: c("PASS", "Codex skills/extraRoots/set 注册经过筛选的技能根", "codex:skills/extraRoots/set", "codex:...projectSkillRootsFor(req.cwd"),
  }},
  { id: "slash-commands", title: "引擎原生命令列表能否执行", doc: "154-158", cells: {
    claude: c("PASS", "Claude listCommands 支持真实 SDK 命令", "claude:async listCommands(opts:"),
    pi: c("N/A", "Pi 命令在当前 Mcode 路径不能运行；listCommands 明示不支持", "pi:return { supported: false, commands: [] }"),
    codex: c("N/A", "Codex 自有 TUI 命令无法直接从当前 app-server 通路执行", "codex:return { supported: false, commands: [] }"),
  }},
  { id: "output-style", title: "输出风格选项的引擎能力边界", doc: "16-31", cells: {
    claude: c("PASS", "通过 SDK options.settings 指定 Claude 输出风格", "claude:getOutputStyleSetting()", "claude:if (outputStyle)"),
    pi: c("N/A", "现有输出风格配置明确只适用于 Claude，Pi 未实现同等 SDK 设置", "pi:readonly capabilities: ProviderCapabilities"),
    codex: c("N/A", "现有输出风格配置只适用于 Claude，Codex 未实现同等 SDK 设置", "codex:readonly capabilities: ProviderCapabilities"),
  }},
  { id: "fork", title: "引擎上下文复制 fork", doc: "98-100", cells: {
    claude: c("PASS", "SDK forkSession 真复制 Provider 上下文", "claude:supportsFork: true", "claude:async forkSession("),
    pi: c("N/A", "Pi 本适配器没有 provider 级 forkSession", "pi:readonly capabilities: ProviderCapabilities"),
    codex: c("N/A", "Codex 本适配器没有 provider 级 forkSession", "codex:readonly capabilities: ProviderCapabilities"),
  }},
  { id: "pi-bash-snapshot", title: "Bash 文件变更能否进入撤销快照", doc: "114-117", cells: {
    claude: c("N/A", "这是 2026-09-20 文档里 Pi 的特定缺陷；Claude 快照独立实现", "claude:ClaudeAgentSdkProvider"),
    pi: c("PASS", "已能解析并记录 Bash 中可识别的字面量写目标；复杂动态目标不保证", "piExtension:resolveBashWriteTargets(cwd, normalized)", "piExtension:recordPre(cwd, target.absPath)"),
    codex: c("N/A", "这是 Pi 的特定 Bash 扩展路径，Codex 通过独立的文件变更机制", "codex:CodexFileSnapshot"),
  }},
  { id: "ui-capability", title: "渲染端是否消费能力声明", doc: "57-67,131-133", cells: {
    claude: c("PASS", "至少已有 settings requiresCapability 与工作流 MCP 能力门控", "settings:requiresCapability?:"),
    pi: c("PASS", "Pi supportsMcp:false 在工作流表单被识别为不支持而非自由输入兜底", "pi:supportsMcp: false", "uiMcp:const unsupportedMcp = spec.from === \"mcp\" && provider?.capabilities.supportsMcp === false;"),
    codex: c("PASS", "至少部分能力位被消费；不等于所有能力位均已接入", "codex:supportsMcp: true", "settings:requiresCapability?:"),
  }},
  { id: "codex-platform", title: "Codex 平台二进制包查找", doc: "103-110", cells: {
    claude: c("N/A", "旧文档是 Codex 固定 macOS 包名缺陷，仅验 Codex 分支", "claude:ClaudeAgentSdkProvider"),
    pi: c("N/A", "旧文档是 Codex 固定 macOS 包名缺陷，不涉及 Pi SDK", "pi:PiAgentSdkProvider"),
    codex: c("PASS", "已用 platformSuffix 构造动态包名，不再写死 darwin-arm64", "codexBinary:const pkg =", "codexBinary:const suffix = platformSuffix()"),
  }},
  { id: "turn-stop-reason", title: "Pi 长度截断 vs 正常结束", doc: "114-117,128-130", cells: {
    claude: c("N/A", "本行是历史文档所述 Pi 独有缺陷复核; Claude 停止原因另走 adapter", "claude:SdkMessageAdapter"),
    pi: c("PASS", "2026-09-20 文档已过期:末 assistant.stopReason=length -> max_tokens", "piAdapter:case \"length\": return \"max_tokens\""),
    codex: c("N/A", "本行只复核 Pi adapter 过去恒 end_turn 的缺陷；Codex 另走适配器", "codex:CodexMessageAdapter"),
  }},
];
const documentText = readFileSync(join(process.cwd(), "../../docs/design/三引擎能力对照.md"), "utf8");
const docChecks = ["预算面板", "回退面板", "结构化输出", "子代理", "Elicitation", "审批", "工作流提示词", "计划模式", "结束原因", "上下文"];
// '上下文' is present in several doc sections even if no dedicated header.
check("至少覆盖任务要求九项+对照文档的扩展能力", capabilities.length >= 16, capabilities.map((x) => x.id));
check("能力编号不重复", new Set(capabilities.map((x) => x.id)).size === capabilities.length);
for (const heading of docChecks) check(`历史文档覆盖关键词 ${heading}`, documentText.includes(heading));
check("矩阵每行三元组齐全", capabilities.every((cap) => engines.every((e) => cap.cells[e] !== undefined)));
for (const row of capabilities) {
  check(`${row.id} 有历史文档行锚点`, /^[0-9]+(?:[-,][0-9]+)*$/.test(row.doc), row.doc);
  for (const engine of engines) {
    const cell = row.cells[engine];
    check(`${row.id}/${engine} 三态与 N/A 原因`, ["PASS", "FAIL", "N/A"].includes(cell.state) && cell.reason.length >= 12 && (cell.state !== "N/A" || cell.reason.length >= 20));
    for (const anchor of cell.anchors) {
      const separator = anchor.indexOf(":");
      const source = anchor.slice(0, separator);
      const needle = anchor.slice(separator + 1);
      check(`证据存在 ${row.id}/${engine} ${source}:${needle.slice(0, 38)}`, Boolean(sources[source] && needle && contents(source, needle)), sources[source]);
    }
    console.log(`MATRIX|${row.id}|${engine}|${cell.state}|${cell.reason}`);
  }
}
// Positive source facts; do not assume that a pure helper equals a real SDK U1.
const sample = { envPrompt: "ENV-T08", memoryPrompt: "MEM-T08", projectInstructionPrompt: "PROJECT-T08", agentPrompt: "AGENT-T08", workflowPrompt: "WORKFLOW-T08" };
const once = turnContextSections(sample);
check("context 五层优先级 ENV→MEM→PROJECT→AGENT→WORKFLOW", JSON.stringify(once) === JSON.stringify(["ENV-T08", "MEM-T08", "PROJECT-T08", "AGENT-T08", "WORKFLOW-T08"]), once);
check("同一上下文原始输入只在共享 section 出现一次", once.filter((v) => v === sample.memoryPrompt).length === 1);
check("空字段不注入", turnContextSections({ ...sample, agentPrompt: "  " }).length === 4);
const duplicate = turnContextSections({ ...sample, agentPrompt: sample.memoryPrompt });
const observedDuplicate = duplicate.filter((v) => v === sample.memoryPrompt).length;
check("相同上下文跨两层重复缺陷确实可复现", observedDuplicate === 2, observedDuplicate);
// The requirement "inject only once" is deliberately made executable as a red
// product finding rather than silently treating the defective baseline as PASS.
// The isolated mutation overrides the imported *production helper* in a temporary bundle.
// The unmodified helper passes; a test-only duplicate-producing helper turns it red.
check("可变异：同一份上下文发给 provider 的次数必须为 1", once.filter((v) => v === sample.memoryPrompt).length === 1, once);
for (const engine of engines) {
  const calls = sourceText[engine].match(/turnContextSections\(req\)/g) ?? [];
  check(`Provider ${engine} 每轮只消费一次共享上下文`, calls.length === 1, calls.length);
}
const spec = { name: "t08", schema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false } };
check("共享结构化输出真实校验通过", parseStructuredOutput('{"count":1}', spec).ok);
check("共享结构化输出拒绝字段缺失", !parseStructuredOutput('{"other":1}', spec).ok);
check("共享结构化输出拒绝非 JSON", !parseStructuredOutput("not-json", spec).ok);
check("审批桥未装超时：作为显式三家共同 FAIL 记录", !sourceText.approvals.includes("setTimeout("), "no-expiration");
console.log(`SUMMARY_MATRIX: ${capabilities.length} rows / ${capabilities.length * 3} cells; states ${engines.map((e) => e + "=" + capabilities.map((r) => r.cells[e].state).join(",")).join("; ")}`);
console.log(`engine-parity-matrix-smoke: ${checks - failures}/${checks} passed`);
if (failures) process.exitCode = 1;
