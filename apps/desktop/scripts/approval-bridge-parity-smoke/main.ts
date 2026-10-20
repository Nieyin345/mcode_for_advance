/**
 * ARC-003 三引擎统一审批语义。读取当前源码，以 TypeScript AST 提取真实 Claude
 * canUseTool ArrowFunction 和 Codex invokeDynamicTool FunctionDeclaration，执行原函数，
 * 只注入内存 ctx、虚构引擎工具与事件。无外部 IPC、无账号、无实际文件写入。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type * as TypeScript from "typescript";
const require = createRequire(join(process.cwd(), "package.json"));
const ts = require("typescript") as typeof TypeScript;
let passed = 0, failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log("  ok   " + label); }
  else { failed++; console.error("  FAIL " + label + " " + JSON.stringify(detail ?? null)); }
}
function source(rel: string): TypeScript.SourceFile {
  const full = join(process.cwd(), "src/main/providers", rel);
  return ts.createSourceFile(rel, readFileSync(full, "utf8"), ts.ScriptTarget.Latest, true);
}
function findNestedArrow(sf: TypeScript.SourceFile, name: string): string {
  let text: string | null = null;
  const visit = (node: TypeScript.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(sf) === name && node.initializer
        && ts.isArrowFunction(node.initializer)) {
      text = node.initializer.getText(sf);
      return;
    }
    if (!text) ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!text) throw new Error("当前源码缺少生产回调：" + name);
  return text;
}
function findTopFunction(sf: TypeScript.SourceFile, name: string): string {
  const fn = sf.statements.find((n): n is TypeScript.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!fn) throw new Error("当前源码缺少生产函数：" + name);
  return fn.getText(sf);
}
function construct(src: string, exported: string, mocks: Record<string, unknown>): any {
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const keys = Object.keys(mocks);
  return new Function(...keys, js + "\nreturn " + exported + ";")(...keys.map(k => mocks[k]));
}

const claudeSf = source("claude-sdk/ClaudeAgentSdkProvider.ts");
const canUseTool = findNestedArrow(claudeSf, "canUseTool");
let id = 0;
const claudeCtx = { getPermissionMode: () => "default", isToolAlwaysAllowed: (_name: string) => false, log: { info: (_: string) => {} } };
function makeClaude(requestApproval?: (request: unknown) => Promise<{ allow: boolean; reason?: string }>, always = false) {
  return construct("const canUseTool = " + canUseTool + ";", "canUseTool", {
    ctx: { ...claudeCtx, isToolAlwaysAllowed: () => always },
    req: { cwd: "virtual-project" },
    requestApproval, requestUserInput: undefined, requestPlanApproval: undefined,
    MEMORY_MCP_SERVER: "memory", APP_MCP_SERVER: "app",
    FILE_MUTATING_TOOLS: new Set(["Write","Edit","NotebookEdit"]),
    getToolFilePath: () => null,
    normalizeToolFilePath: () => null,
    writeLandsInLibrary: () => false,
    normalizeBashCommand: (s: string) => s,
    shouldAutoApprove: () => false,
    randomUUID: () => "approval-" + (++id),
    parseQuestions: () => [],
  }) as (tool: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<any>;
}
const args = { toolUseID: "fake-tool-use-id" };
const blocked = await makeClaude()("Bash", { command: "echo harmless-stub" }, args);
check("Claude 无审批桥时 Bash 必须 deny", blocked?.behavior === "deny" && /审批|用户|批准/.test(blocked.message ?? ""), blocked);
const approved = await makeClaude(async () => ({ allow: true }))("Bash", {}, args);
check("Claude 有真人批准后才允许执行", approved?.behavior === "allow", approved);
const denied = await makeClaude(async () => ({ allow: false, reason: "explicit no" }))("Bash", {}, args);
check("Claude 真人拒绝必须保留拒绝原因", denied?.behavior === "deny" && denied?.message === "explicit no", denied);
const preAllowed = await makeClaude(undefined, true)("Bash", {}, args);
check("Claude 已由宿主明确预批准的工具允许", preAllowed?.behavior === "allow", preAllowed);

const codexSf = source("codex-sdk/CodexAgentSdkProvider.ts");
const codexBody = findTopFunction(codexSf, "invokeDynamicTool");
const invokeDynamicTool = construct(codexBody, "invokeDynamicTool", {
  isAppToolName: () => false, isLibraryToolName: () => false, isAgentToolName: () => false,
  workflowEngineBridge: { has: () => false },
  randomUUID: () => "codex-approval-" + (++id),
}) as (p: Record<string, unknown>, deps: any) => Promise<any>;

function makeCodex(bridge?: () => Promise<any>) {
  const events: Array<{ type: string; mode?: string; phase?: string }> = [];
  const active = { active: true };
  return {
    events, active,
    deps: {
      ctx: { emit: (e: any) => events.push(e), requestPlanApproval: bridge },
      req: { cwd: "virtual-project", sessionId: "fake-session", permissionMode: "default" },
      planMode: active, browserToolsEnabled: false,
    },
  };
}
const noCodex = makeCodex();
const codexOut = await invokeDynamicTool({ name: "exit_plan_mode", args: { plan: "# plan" } }, noCodex.deps);
check("Codex 无审批桥时不能离开 plan mode", noCodex.active.active === true, {codexOut, events:noCodex.events});
check("Codex 无审批桥时不得告知模型批准/自动退出", codexOut?.success === false &&
  /审批|拒绝|不可用|批准/.test(codexOut?.contentItems?.[0]?.text ?? "") &&
  !/自动退出|已批准/.test(codexOut?.contentItems?.[0]?.text ?? ""), codexOut);
check("Codex 无审批桥时不得发 default 模式事件", !noCodex.events.some(e=>e.type==="mode.change"&&e.mode==="default"), noCodex.events);

const interrupted = makeCodex(async()=>{ throw new Error("fake disconnect"); });
const interruptedOut = await invokeDynamicTool({name:"exit_plan_mode",args:{plan:"# cut"}},interrupted.deps);
check("Codex 宿主审批通信异常必须是失败响应，而不是成功",
  interruptedOut?.success === false && /disconnect/.test(interruptedOut?.contentItems?.[0]?.text ?? ""), interruptedOut);
check("Codex 审批通信断开仍在计划模式", interrupted.active.active === true);
check("Codex 审批中断不切默认模式", !interrupted.events.some(e=>e.type==="mode.change"&&e.mode==="default"));

const rejectedPlan = makeCodex(async () => ({ approved: false, reason: "human said no" }));
const rejectedOut = await invokeDynamicTool({name:"exit_plan_mode",args:{plan:"# revised"}}, rejectedPlan.deps);
check("Codex 真人拒绝保留计划模式", rejectedPlan.active.active === true &&
 /拒绝/.test(rejectedOut?.contentItems?.[0]?.text ?? ""), rejectedOut);
const acceptedPlan = makeCodex(async () => ({ approved: true, editedPlan: "# human edits" }));
const acceptedOut = await invokeDynamicTool({name:"exit_plan_mode",args:{plan:"# proposed"}}, acceptedPlan.deps);
check("Codex 真人批准才退出计划模式", acceptedPlan.active.active === false &&
 /human edits/.test(acceptedOut?.contentItems?.[0]?.text ?? "") &&
 acceptedPlan.events.some(e=>e.type==="mode.change"&&e.mode==="default"), acceptedOut);

console.log("approval-bridge-parity-smoke: "+passed+"/"+(passed+failed)+" assertions pass");
if(failed)process.exitCode=1;
