/**
 * ARC-003 / ARC-002 真实 Pi Extension 审批通道缺失 fail-closed 契约。
 * 利用 TypeScript AST 从当前 mcodeExtension.ts 提取**生产函数**原文，
 * 仅替换依赖/IPC 为纯内存桩，执行真实 handler；既不接真实引擎也不触碰用户资源。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type * as TypeScript from "typescript";
const require = createRequire(join(process.cwd(), "package.json"));
const ts = require("typescript") as typeof TypeScript;
const file = join(process.cwd(), "src/main/providers/pi-sdk/mcodeExtension.ts");
const src = readFileSync(file, "utf8");
const parsed = ts.createSourceFile("mcodeExtension.ts", src, ts.ScriptTarget.ES2022, true);
function real(name: string): string {
  const fn = parsed.statements.find((s): s is TypeScript.FunctionDeclaration =>
    ts.isFunctionDeclaration(s) && s.name?.text === name);
  if (!fn) throw new Error("找不到生产函数：" + name);
  return fn.getText(parsed);
}

let passed = 0, failed = 0;
function check(label: string, good: boolean, detail?: unknown): void {
  if (good) { passed++; console.log("  ok   " + label); }
  else { failed++; console.log("  FAIL " + label, detail); }
}
let approvals = 0;
let nextUUID = 0;
const mocks = {
  randomUUID: () => `fake-request-${++nextUUID}`,
  Type: { Object: () => ({}), String: () => ({}) },
  shouldAutoApproveForPi: (_mode: string, tool: string, planning: boolean, always: boolean) => !planning && (tool === "read" || always),
  workflowEngineBridge: { isReadonly: () => false },
  isLibraryReadonlyTool: () => false,
  isAgentReadonlyTool: () => false,
  MCODE_BROWSER_READONLY: new Set(["browser_snapshot"]),
  getFileSnapshot: () => ({ recordPre: async () => {} }),
  guardToolPath: () => ({ denied: false }),
  normalizeBashCommand: (s: string) => s,
  guardBashCommand: () => null,
  resolveBashWriteTargets: () => [],
  writeLandsInLibrary: () => false,
};
const names = ["randomUUID","Type","shouldAutoApproveForPi","workflowEngineBridge",
  "isLibraryReadonlyTool","isAgentReadonlyTool","MCODE_BROWSER_READONLY",
  "getFileSnapshot","guardToolPath","normalizeBashCommand","guardBashCommand",
  "resolveBashWriteTargets","writeLandsInLibrary"] as const;
const js = ts.transpileModule(
  real("registerToolCallGuard") + "\n" + real("registerPlanModeTools"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;
const funcs = new Function(...names, js + "\nreturn { registerToolCallGuard, registerPlanModeTools };")(
  ...names.map((n) => mocks[n] as unknown),
) as {
  registerToolCallGuard: (pi: unknown, deps: unknown) => void;
  registerPlanModeTools: (pi: unknown, deps: unknown) => void;
};
const toolHandlers: Record<string, (event: any) => Promise<any>> = {};
const tools: Record<string, { execute: (...args: any[]) => Promise<any> }> = {};
const pi = {
  on: (name: string, cb: (event: any) => Promise<any>) => { toolHandlers[name] = cb; },
  registerTool: (spec: { name: string; execute: (...args: any[]) => Promise<any> }) => { tools[spec.name] = spec; },
};
const mode = { active: false };
const emitted: unknown[] = [];
const ctx: Record<string, unknown> = {
  emit: (evt: unknown) => emitted.push(evt),
  getPermissionMode: () => "default",
  isToolAlwaysAllowed: () => false,
};
funcs.registerToolCallGuard(pi, { ctx, cwd: "virtual-project", strict: true, sessionId: "fake", planMode: mode });
funcs.registerPlanModeTools(pi, { ctx, sessionId: "fake", planMode: mode });
const guard = toolHandlers.tool_call;
check("捕获的 tool_call 是真实生产扩展函数", typeof guard === "function");
const event = (name: string) => ({ toolName: name, input: {} });
const unavailable = await guard(event("library_write"));
check("无审批桥的写操作必须显式 block 而不是默认执行", unavailable?.block === true && /审批|批准|用户|授权/.test(unavailable.reason ?? ""), unavailable);
const noBridgeBrowser = await guard(event("browser_click"));
check("无审批桥的浏览器副作用操作也必须 block", noBridgeBrowser?.block === true, noBridgeBrowser);
check("无审批桥只读 read 不应被误拦", (await guard(event("read"))) === undefined);
ctx.requestApproval = async () => { approvals++; return { allow: false, reason: "user refused" }; };
const denied = await guard(event("library_write"));
check("用户明确拒绝仍然生效", denied?.block === true && denied.reason === "user refused" && approvals === 1, denied);
ctx.requestApproval = async () => { approvals++; return { allow: true }; };
check("用户明确批准允许执行", (await guard(event("library_write"))) === undefined && approvals === 2);
ctx.isToolAlwaysAllowed = () => true;
delete ctx.requestApproval;
check("显式预先批准的工具仍可通过", (await guard(event("library_write"))) === undefined);
ctx.isToolAlwaysAllowed = () => false;

const entered = await tools.EnterPlanMode.execute("enter", {});
check("EnterPlanMode 把真实闭包状态切为 plan", mode.active === true && /计划/.test(entered.content?.[0]?.text ?? ""));
emitted.length = 0;
const lacking = await tools.ExitPlanMode.execute("exit", { plan: "# isolated approved plan?" });
check("无计划审批桥不能自动退出计划模式", mode.active === true, { lacking, emitted });
check("无计划审批桥不能发送切回 default 的事件",
  !emitted.some((e: any) => e?.type === "mode.change" && e?.mode === "default"), emitted);
check("无计划审批桥结果必须显式说明拒绝/不可用，而不是谎报成功",
  /审批|批准|不可用|拒绝/.test(lacking.content?.[0]?.text ?? "")
  && !/自动退出|已批准/.test(lacking.content?.[0]?.text ?? ""), lacking);
// 宿主 IPC 曾可用却在等待时断开，跟“从未装配审批桥”同样不能放行。
ctx.requestPlanApproval = async () => { throw new Error("simulated approval transport unavailable"); };
emitted.length = 0;
let transportFailed = false;
try { await tools.ExitPlanMode.execute("exit", { plan: "# transport failed" }); }
catch (err) { transportFailed = (err as Error).message.includes("transport unavailable"); }
check("审批桥抛错必须作为失败报告，而不是宣称成功", transportFailed);
check("审批桥中断后仍保留计划模式", mode.active === true);
check("审批桥中断后不得发送 mode=default",
  !emitted.some((e: any) => e?.type === "mode.change" && e?.mode === "default"), emitted);
ctx.requestPlanApproval = async () => ({ approved: false, reason: "user refuses plan" });
const rejectedPlan = await tools.ExitPlanMode.execute("exit", { plan: "# another plan" });
check("显式计划拒绝保留计划模式并告知模型", mode.active === true && /拒绝/.test(rejectedPlan.content?.[0]?.text ?? ""));
ctx.requestPlanApproval = async () => ({ approved: true, editedPlan: "# user approved edit" });
const accepted = await tools.ExitPlanMode.execute("exit", { plan: "# draft" });
check("用户明确批准才允许退出", mode.active === false && /user approved edit/.test(accepted.content?.[0]?.text ?? ""));

console.log("pi-approval-unavailable-smoke: " + passed + "/" + (passed + failed) + " assertions pass");
if (failed) process.exitCode = 1;
