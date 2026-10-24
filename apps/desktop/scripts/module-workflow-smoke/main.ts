import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ExecutionEngine, createBuiltinExecutionEngine, createWorkflowInputBuilder, executionEngine } from "../../src/main/orchestration/executionEngine.js";
import type { ExecutionContext } from "../../src/main/orchestration/executionContext.js";
import { buildNodeInput, type ModelInputScope } from "../../src/main/orchestration/nodeInputBuilders.js";
import { builtinManifestById, loadNodeTypes } from "../../src/main/orchestration/nodeTypes.js";
import { runWorkflow, type RunPorts, type RunResume } from "../../src/main/orchestration/scheduler.js";
import { planOf } from "../../src/main/orchestration/schedulerPrompt.js";
import { exportWorkflowDoc, importWorkflowDoc, validateWorkflowDoc } from "../../src/main/orchestration/workflowValidation.js";
import { requireWorkflowReview, workflowReviewError, workflowReplayError } from "../../src/main/orchestration/workflowTrust.js";
import { getModuleHost } from "../../src/main/modules/service.js";
import { registerModuleHandlers } from "../../src/main/ipc/modules.js";
import { createWebApi } from "../../src/renderer/lib/webApi.js";
import "../../src/preload/index.js";
import { createModuleClient } from "@contracts/moduleClient";
import { IPC } from "@contracts/ipc";
import { EXAMPLE_MODULE } from "@contracts/modules";
import { MODULE_CAPABILITY_NODE_TYPE_ID, MODULE_CAPABILITY_RUNNER_KIND, ModuleCatalogSchema, ModuleWorkflowExecutionInputSchema, classifyModuleWorkflowGrants } from "@contracts/moduleCapability";
import { isNodeRunnable, NodeTypeManifestSchema, type NodeOutcome, type NodeTypeManifest } from "@contracts/nodeType";
import { WorkflowDocSchema, type WorkflowDoc, type WorkflowNode } from "@contracts/workflow";
import { dataRootCalls } from "./stubs/dataRoot.js";
import { fakeIpcMain, handlers, preloadApi } from "./stubs/electron.js";
import { createRunnerFixture, runnerInputFixture, runnerKindsFixture } from "./runnerPath.js";

const root = process.env.P2_WORKFLOW_WORKSPACE;
const evidence = process.env.P2_WORKFLOW_EVIDENCE;
assert.ok(root && evidence, "Isolated fixture paths must be supplied by build.mjs");
const workspace: string = root;
const evidenceDir: string = evidence;
const payload = "module workflow real-file fixture\n";
const expectedBytes = Buffer.byteLength(payload);
const expectedHash = createHash("sha256").update(payload).digest("hex");
const nativeGateOpen = process.env.P2_WORKFLOW_PHASE === "native-open";
let passed = 0;
let failed = 0;
const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, action: () => void | Promise<void>): Promise<void> {
  try { await action(); passed++; results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) { failed++; results.push({ name, ok: false, error: String(error) }); console.error(`FAIL ${name}`, error); }
}
function builtin(id: string): NodeTypeManifest {
  const manifest = builtinManifestById(id);
  assert.ok(manifest, `Missing production builtin: ${id}`);
  return manifest;
}
const manifest = builtin(MODULE_CAPABILITY_NODE_TYPE_ID);
const node: WorkflowNode = { id: "n_inspect", type: manifest.id, title: "文件检查", position: { x: 0, y: 0 }, params: { moduleId: "core.file-report", contributionId: "inspect", path: "module-inspect-demo.txt" } };
const inputScope: ModelInputScope = {
  userPrompt: "read only", upstream: "", upstreamArtifacts: [], upstreamOutputs: {}, nodeId: node.id,
  plan: planOf({ id: "wf_fixture", name: "Fixture", nodes: [node], edges: [], builtin: false, updatedAt: 0 }, () => node.title), root: true, terminal: true, contextLines: () => [],
};
const inputBuilder = runnerInputFixture({ id: "p2-session" }, "p2-run");
function inputFor(params: Record<string, unknown> = node.params, signal = new AbortController().signal): ExecutionContext["input"] {
  return inputBuilder(params, manifest, inputScope, signal);
}
function contextFor(input = inputFor(), cwd = workspace): ExecutionContext {
  return { node, manifest, input, cwd, metadata: { sessionId: "p2-session", runId: "p2-run", nodeId: node.id } };
}
const unexpectedModel = async (): Promise<NodeOutcome> => { throw new Error("A model must never be called by module workflow tests"); };
const runner = createRunnerFixture(unexpectedModel, unexpectedModel);

await check("imports and both engine constructions preserve service laziness", () => {
  createBuiltinExecutionEngine();
  assert.equal(dataRootCalls(), 0);
});
await check("both actual registration paths and preflight inventory include the capability", () => {
  assert.ok(executionEngine.has(MODULE_CAPABILITY_RUNNER_KIND));
  assert.ok(runner.has(MODULE_CAPABILITY_RUNNER_KIND));
  assert.ok(runnerKindsFixture(runner).includes(MODULE_CAPABILITY_RUNNER_KIND));
  assert.ok(runner.has("code") && runner.has("command") && runner.has("conversation"));
});
await check("missing executor fails closed despite installed model fallback", async () => {
  let calls = 0;
  const empty = new ExecutionEngine().setDefault({ execute: async () => { calls++; return { status: "success", summary: "model" }; } });
  const outcome = await empty.execute(contextFor());
  assert.equal(outcome.status, "failed");
  // 这句会画在失败节点卡片上;执行引擎里未知执行器的失败原因一律中文
  // (见底层修复记录 #111 / executionEngine.ts)。断言跟着源码走,别再钉英文。
  assert.match(outcome.error ?? "", /没有能执行这种节点的执行器/);
  assert.equal(calls, 0);
});
await check("legacy prompt fallback behavior is unchanged", async () => {
  const empty = new ExecutionEngine().setDefault({ execute: async () => ({ status: "success", summary: "fixture-model" }) });
  const outcome = await empty.execute({ ...contextFor(), manifest: { ...manifest, runner: { kind: "prompt" } } });
  assert.equal(outcome.summary, "fixture-model");
});
await check("production manifest is valid with exactly the three frozen parameters", () => {
  NodeTypeManifestSchema.parse(manifest);
  assert.deepEqual(manifest.params.map(spec => spec.key), ["moduleId", "contributionId", "path"]);
  // Preserve the shared MCP/native tooltip contract for every builtin param.
  for (const spec of manifest.params) assert.ok(spec.help?.trim() && spec.help.length <= 80, `Short nonempty help required: ${spec.key}`);
  assert.deepEqual(manifest.outputs?.map(output => output.key), ["bytes", "sha256", "modifiedAt"]);
});
await check("builder requires host identity, not an unbound global or caller parameter", () => {
  assert.throws(() => buildNodeInput(node.params, manifest, inputScope, new AbortController().signal), /host-bound workflow identity/);
  const input = inputFor();
  ModuleWorkflowExecutionInputSchema.parse(input.moduleCall);
  assert.match(input.moduleCall?.requestId ?? "", /^wf:[a-f0-9]{64}$/);
  assert.equal(input.prompt, "");
  assert.deepEqual(input.skills, []);
  assert.deepEqual(input.mcpServerNames, []);
  assert.deepEqual(input.pluginNames, []);
  assert.equal(input.returnMode, "none");
});
await check("new dispatches, node identities and runs get fresh bounded IDs", () => {
  const first = inputFor().moduleCall?.requestId;
  const second = inputFor().moduleCall?.requestId;
  const otherRun = createWorkflowInputBuilder({ sessionId: "p2-session", runId: "other-run" });
  const third = otherRun(node.params, manifest, inputScope, new AbortController().signal).moduleCall?.requestId;
  assert.notEqual(first, second);
  assert.notEqual(first, third);
  assert.ok(first && first.length <= 100);
});
await check("frozen schema rejects all caller-controlled execution fields", () => {
  for (const key of ["requestId", "projectPath", "capabilityId", "trusted", "source", "script"]) {
    assert.throws(() => inputFor({ ...node.params, [key]: key === "trusted" ? true : "forged" }), key);
  }
  for (const path of ["", " ", "x\0y", "x".repeat(4097), 123]) {
    assert.throws(() => inputFor({ ...node.params, path }));
  }
});
await check("pre-cancelled execution does not initialize the module service", async () => {
  const ac = new AbortController(); ac.abort();
  const before = dataRootCalls();
  const outcome = await runner.execute(contextFor(inputFor(node.params, ac.signal)));
  assert.equal(outcome.status, "cancelled");
  assert.equal(dataRootCalls(), before);
});
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "module-inspect-demo.txt"), payload);
await writeFile(join(workspace, "manual.txt"), payload);
await writeFile(join(workspace, `${expectedBytes}.txt`), "downstream-file");
await writeFile(join(evidenceDir, "outside.txt"), "outside");
await check("shared engine query uses the real async service and file capability", async () => {
  const outcome = await executionEngine.execute(contextFor(inputFor({ ...node.params, contributionId: "info" })));
  assert.equal(outcome.status, "success", outcome.error);
  assert.equal(outcome.outputs?.bytes, expectedBytes);
  assert.equal(outcome.outputs?.modifiedAt, (await stat(join(workspace, "module-inspect-demo.txt"))).mtimeMs);
  assert.equal(outcome.execution?.executorKind, MODULE_CAPABILITY_RUNNER_KIND);
});
await check("runner registration expression executes the real task and hash", async () => {
  const outcome = await runner.execute(contextFor());
  assert.equal(outcome.status, "success", outcome.error);
  assert.deepEqual(outcome.outputs, { bytes: expectedBytes, sha256: expectedHash });
});
const host = await getModuleHost();
await check("same finished input retry deduplicates, new dispatch starts a new task", async () => {
  const first = contextFor();
  const before = host.tasks({ projectPath: workspace }).length;
  assert.equal((await runner.execute(first)).status, "success");
  const once = host.tasks({ projectPath: workspace }).length;
  assert.equal(once, before + 1);
  assert.equal((await runner.execute(first)).status, "success");
  assert.equal(host.tasks({ projectPath: workspace }).length, once);
  assert.equal((await runner.execute(contextFor())).status, "success");
  assert.equal(host.tasks({ projectPath: workspace }).length, once + 1);
});
await check("runtime authorization rejects outside files and unknown workspaces", async () => {
  const outside = await runner.execute(contextFor(inputFor({ ...node.params, path: "../outside.txt" })));
  assert.equal(outside.status, "failed"); assert.match(outside.error ?? "", /资源在工作区之外/);
  const unknown = await runner.execute(contextFor(inputFor(), evidenceDir));
  assert.equal(unknown.status, "failed"); assert.match(unknown.error ?? "", /未知工作区/);
});
await host.install({ ...EXAMPLE_MODULE, id: "user.workflow-fixture" });
const fixtureGrant = { moduleId: "user.workflow-fixture", moduleVersion: "1.0.0", contributionId: "inspect", capabilityId: "core.file.inspect", projectPath: workspace };
await check("用户模块未授权时工作流路径仍被拒绝(菜单可用不等于可自动运行)", async () => {
  const menu = await host.invoke({ moduleId: "user.workflow-fixture", contributionId: "inspect", requestId: "menu-fixture", resource: { projectPath: workspace, path: join(workspace, "module-inspect-demo.txt") } });
  assert.equal(menu.type, "task");
  assert.ok(!host.catalog().workflowTargets?.some(target => target.moduleId === "user.workflow-fixture"), "未授权用户模块不得出现在 workflowTargets");
  const outcome = await runner.execute(contextFor(inputFor({ ...node.params, moduleId: "user.workflow-fixture" })));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error ?? "", /需要宿主核验的工作流授权/);
  // 守卫:授权记录只覆盖 user.* —— 每一条记录在分类器里就按 moduleId 前缀拒收,
  // 一份伪造的 core.* 记录会把整表判坏(而不是被悄悄当成内置授权)。
  const forged = { version: 1, grants: [{ moduleId: "core.file-report", moduleVersion: "1.0.0", contributionId: "inspect", capabilityId: "core.file.inspect", projectPath: workspace, grantedAt: 1 }] };
  assert.equal(classifyModuleWorkflowGrants(JSON.stringify(forged)).state, "corrupt");
});
await check("授予工作流运行权后,菜单与工作流(含真实调度器)都能调用且输出一致", async () => {
  const issued = await host.issueWorkflowGrant(fixtureGrant);
  assert.equal(issued.moduleVersion, "1.0.0");
  assert.ok(host.catalog().workflowTargets?.some(target => target.moduleId === "user.workflow-fixture" && target.contributionId === "inspect"), "授权后目标必须出现在 workflowTargets");
  const menu = await host.invoke({ moduleId: "user.workflow-fixture", contributionId: "inspect", requestId: "menu-fixture-granted", resource: { projectPath: workspace, path: join(workspace, "module-inspect-demo.txt") } });
  assert.equal(menu.type, "task");
  const outcome = await runner.execute(contextFor(inputFor({ ...node.params, moduleId: "user.workflow-fixture" })));
  assert.equal(outcome.status, "success", outcome.error);
  // 菜单路径(真实宿主任务)与工作流路径(执行器→宿主)对同一文件给出同一份「字节数/SHA-256」。
  const menuTask = menu.type === "task" ? menu.task : undefined;
  let settled = menuTask;
  for (let i = 0; i < 200 && settled?.status === "running"; i++) { await new Promise(resolve => setTimeout(resolve, 5)); settled = host.task({ moduleId: "user.workflow-fixture", taskId: menuTask!.id }); }
  assert.equal(settled?.status, "completed", settled?.error);
  assert.deepEqual(outcome.outputs, settled?.result);
  assert.equal(outcome.outputs?.sha256, expectedHash);
});
await check("撤销授权后工作流路径立刻失败闭合,菜单仍可调用", async () => {
  const revoked = await host.revokeWorkflowGrant(fixtureGrant);
  assert.equal(revoked.revoked, true);
  const outcome = await runner.execute(contextFor(inputFor({ ...node.params, moduleId: "user.workflow-fixture" })));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error ?? "", /需要宿主核验的工作流授权/);
  assert.ok(!host.catalog().workflowTargets?.some(target => target.moduleId === "user.workflow-fixture"));
  const menu = await host.invoke({ moduleId: "user.workflow-fixture", contributionId: "inspect", requestId: "menu-after-revoke", resource: { projectPath: workspace, path: join(workspace, "module-inspect-demo.txt") } });
  assert.equal(menu.type, "task");
});
await check("换版本或换授权工作区后旧授权失效", async () => {
  await host.issueWorkflowGrant(fixtureGrant);
  assert.equal((await runner.execute(contextFor(inputFor({ ...node.params, moduleId: "user.workflow-fixture" })))).status, "success");
  // 换资源范围:旧授权只覆盖 workspace,别的(同一套桩认得的)工作区不覆盖。
  const otherWorkspace = evidenceDir;
  const other = await runner.execute(contextFor(inputFor({ ...node.params, moduleId: "user.workflow-fixture" }), otherWorkspace));
  assert.equal(other.status, "failed");
  assert.match(other.error ?? "", /需要宿主核验的工作流授权/);
  // 换版本:模块清单换成 1.0.1 后,1.0.0 的授权不再命中。
  await host.install({ ...EXAMPLE_MODULE, id: "user.workflow-fixture", version: "1.0.1" });
  const outdated = await runner.execute(contextFor(inputFor({ ...node.params, moduleId: "user.workflow-fixture" })));
  assert.equal(outdated.status, "failed");
  assert.match(outdated.error ?? "", /需要宿主核验的工作流授权/);
  // 恢复:按当前版本重新授权后,工作流重新可用。
  await host.issueWorkflowGrant({ ...fixtureGrant, moduleVersion: "1.0.1" });
  assert.equal((await runner.execute(contextFor(inputFor({ ...node.params, moduleId: "user.workflow-fixture" })))).status, "success");
  // 复原清单版本与授权(旧版本的授权仍在表里,但不会命中恢复后的 1.0.0 —— 需要再授一次)。
  await host.install({ ...EXAMPLE_MODULE, id: "user.workflow-fixture" });
  await host.issueWorkflowGrant(fixtureGrant);
});
await check("授权表损坏时 fail-closed + 显式诊断,且拒绝改写", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const grantFile = path.join(process.env.P2_WORKFLOW_DATA_ROOT!, "ui-modules", "workflow-grants.json");
  const original = await fs.readFile(grantFile, "utf8");
  try {
    await fs.writeFile(grantFile, "{ 这不是合法 JSON", "utf8");
    const catalog = host.catalog();
    assert.equal(catalog.workflowGrantStatus?.archive, "corrupt");
    assert.ok(catalog.workflowGrantStatus?.reason);
    assert.ok(!catalog.workflowTargets?.some(target => target.moduleId === "user.workflow-fixture"), "坏表下用户模块目标必须全部不可用");
    const outcome = await runner.execute(contextFor(inputFor({ ...node.params, moduleId: "user.workflow-fixture" })));
    assert.equal(outcome.status, "failed");
    assert.match(outcome.error ?? "", /需要宿主核验的工作流授权/);
    // 坏表不当空表:签发 / 撤销都拒绝改写原字节。
    await assert.rejects(host.issueWorkflowGrant(fixtureGrant), /损坏/);
    await assert.rejects(host.revokeWorkflowGrant(fixtureGrant), /损坏/);
    assert.equal(await fs.readFile(grantFile, "utf8"), "{ 这不是合法 JSON", "坏表必须原样保留,不得被空表覆盖");
  } finally {
    await fs.writeFile(grantFile, original, "utf8");
  }
  // 修复后立即恢复(读侧不缓存)。
  assert.equal((await runner.execute(contextFor(inputFor({ ...node.params, moduleId: "user.workflow-fixture" })))).status, "success");
});
await check("MC-036:工作区按归一位置授权/撤销(不同写法不制造假失配、不攒重复授权)", async () => {
  // 撤销基线授权,从"未授权"开始(上面的用例恢复过一份 fixtureGrant)。
  await host.revokeWorkflowGrant(fixtureGrant);
  assert.ok(!host.catalog().workflowTargets?.some(target => target.moduleId === "user.workflow-fixture"));
  const variants = [workspace + "/", workspace + "/.", workspace + "//"];
  const grantsOf = () => host.catalog().workflowGrantCandidates
    ?.find(item => item.moduleId === "user.workflow-fixture" && item.contributionId === "inspect")?.grants ?? [];
  // ① 授权时是"带尾随分隔符"的写法,运行时 cwd 是项目行里的原样写法 —— 必须命中。
  //    裸 `grant.projectPath === context.cwd` 会在这里假失配(fail-closed 但不可用)。
  await host.issueWorkflowGrant({ ...fixtureGrant, projectPath: variants[0]! });
  const outcome = await runner.execute(contextFor(inputFor({ ...node.params, moduleId: "user.workflow-fixture" })));
  assert.equal(outcome.status, "success", outcome.error);
  // ② 同一目录的三种写法只应是一条授权(幂等键归一),不是三条。
  for (const variant of variants.slice(1)) await host.issueWorkflowGrant({ ...fixtureGrant, projectPath: variant });
  assert.equal(grantsOf().length, 1, JSON.stringify(grantsOf()));
  // ③ 撤销时用又一种写法,同样命中同一条 —— 撤销后执行立刻失败闭合。
  const revoked = await host.revokeWorkflowGrant({ ...fixtureGrant, projectPath: variants[1]! });
  assert.equal(revoked.revoked, true);
  assert.equal(grantsOf().length, 0, JSON.stringify(grantsOf()));
  const closed = await runner.execute(contextFor(inputFor({ ...node.params, moduleId: "user.workflow-fixture" })));
  assert.equal(closed.status, "failed");
  assert.match(closed.error ?? "", /需要宿主核验的工作流授权/);
  // ④ 归一不能把**不同位置**揉成一个:另一个工作区是独立的一条授权。
  await host.issueWorkflowGrant(fixtureGrant);
  await host.issueWorkflowGrant({ ...fixtureGrant, projectPath: evidenceDir });
  assert.equal(grantsOf().length, 2, JSON.stringify(grantsOf()));
  await host.revokeWorkflowGrant({ ...fixtureGrant, projectPath: evidenceDir });
  // 复原:基线授权(执行路径上面的用例已恢复)。
  assert.equal((await runner.execute(contextFor(inputFor({ ...node.params, moduleId: "user.workflow-fixture" })))).status, "success");
});
await check("未知贡献失败而不是落到模型", async () => {
  const outcome = await runner.execute(contextFor(inputFor({ ...node.params, contributionId: "missing" })));
  assert.equal(outcome.status, "failed");
});
await check("真实主进程 IPC 与 preload 原样携带元数据、工作流目标与授权分面", async () => {
  registerModuleHandlers(fakeIpcMain);
  // 13，不是 12：【F006】`901e58ee` 加了 `MODULE_INSTALL_VSIX`。
  // 光改数字不够 —— 那条断言只说明「多了一条」，不说明多的是哪条。所以补一条
  // `has(MODULE_INSTALL_VSIX)`：下次再加 IPC，红的那条会点名。
  assert.equal(handlers.size, 13); // T16 egress get/set + T48 user's permission update + F006 vsix install
  assert.ok(handlers.has(IPC.MODULE_INSTALL_VSIX), "F006 的 vsix 安装入口必须在主进程注册");
  assert.ok(handlers.has(IPC.MODULE_EGRESS_CONSENT_GET));
  assert.ok(handlers.has(IPC.MODULE_EGRESS_CONSENT_SET));
  const api = preloadApi();
  const catalog = await api.modules.catalog();
  ModuleCatalogSchema.parse(catalog);
  assert.deepEqual(catalog, host.catalog());
  // 内置两个 + 已获授权的用户模块一个。
  assert.equal(catalog.workflowTargets?.length, 3);
  assert.ok(catalog.workflowTargets?.some(target => target.moduleId === "user.workflow-fixture"));
  assert.ok(catalog.capabilities.every(capability => capability.metadata));
  assert.equal(catalog.workflowGrantStatus?.archive, "valid");
  assert.ok(catalog.workflowGrantCandidates?.some(candidate => candidate.moduleId === "user.workflow-fixture"));
  assert.equal(Reflect.has(api.modules, "invokeForWorkflow"), false);
  // 授权签发 / 撤销是**真人 UI 动作**,但走的是公开 IPC 面:preload 上有,主进程有 handler。
  assert.equal(typeof api.modules.issueWorkflowGrant, "function");
  assert.equal(typeof api.modules.revokeWorkflowGrant, "function");
  assert.ok(handlers.has(IPC.MODULE_ISSUE_WORKFLOW_GRANT));
  assert.ok(handlers.has(IPC.MODULE_REVOKE_WORKFLOW_GRANT));
  const client = createModuleClient(api.modules, "core.file-report");
  const reply = await client.invoke("info", { projectPath: workspace, path: join(workspace, "module-inspect-demo.txt") }, "preload-info");
  assert.equal(reply.type, "result");
  if (reply.type === "result") assert.equal(reply.value.bytes, expectedBytes);
  assert.ok(handlers.has(IPC.MODULE_CATALOG));
});
await check("授权 IPC 经 preload 真实往返:签发→目录可见→撤销→目录消失", async () => {
  const api = preloadApi();
  await api.modules.revokeWorkflowGrant(fixtureGrant);
  assert.ok(!(await api.modules.catalog()).workflowTargets?.some(target => target.moduleId === "user.workflow-fixture"));
  const issued = await api.modules.issueWorkflowGrant(fixtureGrant);
  assert.ok(issued.workflowTargets?.some(target => target.moduleId === "user.workflow-fixture"));
  const revoked = await api.modules.revokeWorkflowGrant(fixtureGrant);
  assert.ok(!revoked.workflowTargets?.some(target => target.moduleId === "user.workflow-fixture"));
  // IPC 形状校验:多带一个字段被拒。
  await assert.rejects(api.modules.issueWorkflowGrant({ ...fixtureGrant, trusted: true } as never));
  // 留在"已授权"状态给后续断言用(与上面菜单/工作流一致的最终态)。
  await api.modules.issueWorkflowGrant(fixtureGrant);
});
await check("mobile modules are explicitly rejected before any network request", async () => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { lang: "en" } } });
  const fetchBefore = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Unexpected network access"); };
  try {
    const modules = createWebApi().modules;
    for (const method of Object.values(modules)) {
      await assert.rejects(async () => Reflect.apply(method, modules, [{}]), /not available|unavailable|web mode/i);
    }
    assert.equal(calls, 0);
    assert.equal(Reflect.has(modules, "invokeForWorkflow"), false);
  } finally { globalThis.fetch = fetchBefore; Reflect.deleteProperty(globalThis, "document"); }
});
const catalog = await loadNodeTypes();
const types = new Map(catalog.entries.map(entry => [entry.id, entry.manifest]));
await check("builtin node types survive a library-groups table the user emptied", () => {
  // 本套的 `loadLibraryGroups` 桩恒返回 `[]` —— 那正是用户在大类管理里把最后一个大类
  // 删掉之后的形状(`LibrarySection.removeGroup` 只做 `filter`,没有"至少留一个"的闸,
  // `parseLibraryGroupsJson` 也认空数组)。而 `ioParams` 的「资料」下拉候选就是现读这张表。
  //
  // ⚠️ 于是"下拉一个选项都没有"会让 `validateNodeTypeManifest` 拒掉**整个内置清单**
  // (`参数 context 是下拉,但没有给选项`),`loadBuiltin` 把 mcode.main / mcode.agent /
  // mcode.conversation **三个一起从注册表里丢出去**。这正是文件头那条
  // 「随应用发出去、自己却加载不了的内置类型,是这套机制里最难查的一种坏法」。
  for (const id of ["mcode.main", "mcode.agent", "mcode.conversation"]) {
    assert.ok(types.has(id), `builtin ${id} dropped from the catalog when the library-groups table is empty`);
  }
});
const example = WorkflowDocSchema.parse(JSON.parse(await readFile(resolve("../../examples/workflows/module-file-inspect.json"), "utf8")));
await check("real node catalog and workflow import/export round-trip keep configuration", () => {
  assert.ok(types.has(MODULE_CAPABILITY_NODE_TYPE_ID));
  const check = validateWorkflowDoc(example, { types });
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  const imported = importWorkflowDoc(exportWorkflowDoc(example), { types });
  assert.equal(imported.ok, true);
  if (imported.ok) assert.deepEqual(imported.doc.nodes, example.nodes);
  assert.equal(example.nodes[0]?.params.enabled, false);
  assert.equal(example.nodes[0]?.params.triggerKind, "manual");
});
await check("existing save/import gate rejects missing required capability parameters", () => {
  const bad = structuredClone(example); delete bad.nodes[1]!.params.path;
  assert.equal(validateWorkflowDoc(bad, { types }).ok, false);
  assert.equal(importWorkflowDoc(JSON.stringify(bad), { types }).ok, false);
});
await check("review and interrupted-run replay guards remain closed", () => {
  requireWorkflowReview(example.id, "import");
  assert.ok(workflowReviewError(example));
  assert.ok(workflowReplayError(example, ["n_inspect"]));
  assert.ok(workflowReplayError(example, undefined));
});

type GraphOptions = { resume?: RunResume; choose?: RunPorts["choose"]; ac?: AbortController; cancelOnProgress?: boolean };
async function graph(doc: WorkflowDoc, options: GraphOptions = {}) {
  const ac = options.ac ?? new AbortController();
  const inputs: ExecutionContext["input"][] = [];
  const started = new Set<string>();
  const boundInput = runnerInputFixture({ id: "graph-session" }, "graph-run");
  const ports: RunPorts = {
    buildInput: boundInput,
    manifestOf: async id => types.get(id), manifestDirOf: async () => undefined,
    contextLines: () => [], choose: options.choose ?? (async () => { throw new Error("Unexpected branch choice"); }),
    maxParallel: () => 2,
    report: event => { if (event.kind === "node.started") started.add(event.node.id); },
    execute: async (current, definition, input) => {
      assert.ok(started.has(current.id), "node.started must precede executor dispatch");
      inputs.push(input);
      return runner.execute({ node: current, manifest: definition, input, cwd: workspace,
        metadata: { sessionId: "graph-session", runId: "graph-run", nodeId: current.id },
        emitProgress: () => { if (options.cancelOnProgress) ac.abort(); },
      });
    },
  };
  const result = await runWorkflow({ doc, prompt: "read only", ports, signal: ac.signal,
    entry: { nodeId: "n_start", summary: "manual fixture", payload: { kind: "manual", files: "module-inspect-demo.txt" } },
    ...(options.resume ? { resume: options.resume } : {}),
  });
  return { result, inputs };
}
const gateOpen = isNodeRunnable(manifest);
console.log(`Scheduler gate: ${gateOpen ? "open" : "closed"}; phase=${process.env.P2_WORKFLOW_PHASE}; production activation is not changed by this suite`);
if (!gateOpen) {
  await check("native production gate blocks dispatch until task 01 activates it", async () => {
    const { result, inputs } = await graph(example);
    assert.equal(result.status, "failed"); assert.equal(inputs.length, 0);
    assert.match(result.outcomes.get("n_inspect")?.error ?? "", /还没有实现/);
  });
} else {
  assert.ok(nativeGateOpen || process.env.P2_WORKFLOW_PHASE === "fixture-open", "Gate must be native or explicitly fixture-open");
  await check("real scheduler resolves trigger variables and passes real outputs downstream", async () => {
    const doc = structuredClone(example);
    doc.nodes[1]!.params.path = "{{trigger.kind}}.txt";
    doc.nodes.push({ ...node, id: "n_info", title: "下游文件信息", params: { ...node.params, contributionId: "info", path: "{{文件检查.bytes}}.txt" } });
    doc.edges.push({ id: "e_info", from: "n_inspect", to: "n_info" });
    assert.equal(validateWorkflowDoc(doc, { types }).ok, true, JSON.stringify(validateWorkflowDoc(doc, { types }).errors));
    const { result, inputs } = await graph(doc);
    assert.equal(result.status, "success", JSON.stringify([...result.outcomes]));
    assert.deepEqual(result.outcomes.get("n_inspect")?.outputs, { bytes: expectedBytes, sha256: expectedHash });
    assert.equal(result.outcomes.get("n_info")?.outputs?.bytes, Buffer.byteLength("downstream-file"));
    assert.equal(inputs[0]?.moduleCall?.path, "manual.txt");
    assert.equal(inputs[1]?.moduleCall?.path, `${expectedBytes}.txt`);
    assert.equal(inputs[1]?.data.upstreamOutputs.n_inspect?.sha256, expectedHash);
  });
  await check("runtime invalid parameters and unresolved variables never reach an executor", async () => {
    for (const params of [{ ...node.params, requestId: "forged" }, { ...node.params, path: "{{missing.value}}" }, { ...node.params, path: " " }]) {
      const doc = structuredClone(example); doc.nodes[1]!.params = params;
      const { result, inputs } = await graph(doc);
      assert.equal(result.status, "failed"); assert.equal(inputs.length, 0);
    }
  });
  await check("loop iterations get fresh identities rather than stale host task results", async () => {
    const doc = structuredClone(example);
    doc.nodes.push({ id: "n_branch", type: "mcode.branch", title: "Repeat?", params: {}, position: { x: 700, y: 0 } });
    doc.nodes.push({ ...node, id: "n_info", title: "Done", params: { ...node.params, contributionId: "info" } });
    doc.edges.push({ id: "e_branch", from: "n_inspect", to: "n_branch" }, { id: "e_again", from: "n_branch", to: "n_inspect", label: "Again" }, { id: "e_done", from: "n_branch", to: "n_info", label: "Done" });
    let choices = 0;
    const { result, inputs } = await graph(doc, { choose: async () => ({ edgeId: choices++ === 0 ? "e_again" : "e_done" }) });
    assert.equal(result.status, "success", JSON.stringify([...result.outcomes]));
    const ids = inputs.filter(input => input.moduleCall?.contributionId === "inspect").map(input => input.moduleCall?.requestId);
    assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1]);
  });
  await check("explicit retry after failure gets a new nonce even though rounds never incremented", async () => {
    const doc = structuredClone(example); doc.nodes[1]!.params.path = `retry-${process.env.P2_WORKFLOW_PHASE}.txt`;
    const first = await graph(doc);
    assert.equal(first.result.status, "failed");
    assert.equal(first.result.state.rounds.some(([id]) => id === "n_inspect"), false);
    await writeFile(join(workspace, String(doc.nodes[1]!.params.path)), payload);
    const state = first.result.state;
    const second = await graph(doc, { resume: { record: state.record, rounds: state.rounds, picks: state.picks, settled: [...first.result.outcomes], rewind: ["n_inspect"] } });
    assert.equal(second.result.status, "success");
    assert.notEqual(first.inputs[0]?.moduleCall?.requestId, second.inputs[0]?.moduleCall?.requestId);
    const resumed = await graph(doc, { resume: { record: second.result.state.record, rounds: second.result.state.rounds, picks: second.result.state.picks, settled: [...second.result.outcomes] } });
    assert.equal(resumed.inputs.length, 0, "already settled nodes must not be replayed");
  });
  await check("scheduler cancellation propagates into the real task without successful outputs", async () => {
    const { result } = await graph(example, { cancelOnProgress: true });
    assert.equal(result.status, "cancelled");
    assert.equal(result.outcomes.get("n_inspect")?.status, "cancelled");
    assert.equal(result.outcomes.get("n_inspect")?.outputs, undefined);
  });
}
// Z12: no shell process is spawned by these tests; the real scheduler feeds a
// recording executor so injected content can never execute, even on the red run.
const commandManifest = builtin("mcode.command");
function commandDoc(command: string): WorkflowDoc {
  return { ...structuredClone(example), nodes: [example.nodes[0]!, {
    id: "n_inspect", title: "Command", type: commandManifest.id,
    position: { x: 200, y: 0 }, params: { command },
  }] };
}
await check("shell templates are rejected during workflow validation", () => {
  const report = validateWorkflowDoc(commandDoc('node process.js "{{user}}"'), { types });
  assert.ok(report.errors.some(issue => /stdin/i.test(issue.message)));
});
await check("runtime blocks legacy shell interpolation before executor dispatch", async () => {
  let executed = 0;
  const ports: RunPorts = {
    buildInput: runnerInputFixture({ id: "shell-fixture" }, "shell-run"),
    manifestOf: async id => types.get(id), manifestDirOf: async () => undefined,
    contextLines: () => [], choose: async () => { throw new Error("unexpected choice"); },
    maxParallel: () => 1, report: () => {},
    execute: async () => { executed++; return { status: "success", summary: "recorded only" }; },
  };
  const result = await runWorkflow({ doc: commandDoc('node process.js "{{user}}"'),
    prompt: 'x" & echo SHELL_INJECTION_SENTINEL & "', ports, signal: new AbortController().signal,
    entry: { nodeId: "n_start", summary: "manual", payload: { kind: "manual" } } });
  assert.equal(executed, 0);
  assert.equal(result.outcomes.get("n_inspect")?.status, "failed");
  assert.match(result.outcomes.get("n_inspect")?.error ?? "", /stdin/i);
});
await check("trigger-only command input reaches JSON stdin without shell interpolation", () => {
  const trigger = { files: ['x" & echo SHELL_INJECTION_SENTINEL & "'], kind: "files" };
  const input = buildNodeInput({ command: "node process.js" }, commandManifest,
    { ...inputScope, userPrompt: "", upstream: "", upstreamArtifacts: [], upstreamOutputs: {}, trigger }, new AbortController().signal);
  assert.equal(input.command?.command, "node process.js");
  assert.deepEqual(input.command?.input, input.data);
  assert.deepEqual(Reflect.get(input.command!.input as object, "trigger"), trigger);
});

await check("shell safety preserves escaped literals and localizes migration guidance", () => {
  const literal = commandDoc(String.raw`echo "\{{user}}"`);
  assert.equal(validateWorkflowDoc(literal, { types }).ok, true);
  const unsafe = commandDoc('node process.js "{{user}}"');
  assert.ok(validateWorkflowDoc(unsafe, { types, locale: "en" }).errors.some(issue => issue.message.includes("JSON stdin") && issue.message.includes("not allowed")));
  assert.ok(validateWorkflowDoc(unsafe, { types, locale: "zh" }).errors.some(issue => issue.message.includes("JSON stdin") && issue.message.includes("不允许")));
  const alias = { ...commandManifest, id: "extension.command" };
  unsafe.nodes[1]!.type = alias.id;
  assert.ok(validateWorkflowDoc(unsafe, { types: new Map([...types, [alias.id, alias]]) }).errors.some(issue => /stdin/i.test(issue.message)));
});

// D2: retain real returned data, never invent output for a promise that threw.
for (const mode of ["constraint", "retry-throws"] as const) {
  await check(`partial node outputs survive ${mode}`, async () => {
    const doc = commandDoc("node process.js");
    doc.nodes[1]!.params.outputVars = mode === "constraint" ? [{ name: "required", example: "value" }] : [];
    doc.nodes.push({ ...doc.nodes[1]!, id: "after", params: { command: "node next.js" } });
    doc.edges.push({ id: "after", from: "n_inspect", to: "after" });
    const artifacts = [{ kind: "file" as const, uri: "partial-result.txt" }];
    let calls = 0;
    const ports: RunPorts = {
      buildInput: runnerInputFixture({ id: "partial-session" }, "partial-run"),
      manifestOf: async id => id === commandManifest.id
        ? { ...commandManifest, retry: { maxAttempts: mode === "retry-throws" ? 2 : 1, backoffMs: 0 } }
        : types.get(id),
      manifestDirOf: async () => undefined, contextLines: () => [],
      choose: async () => { throw new Error("unexpected choice"); }, maxParallel: () => 1, report: () => {},
      execute: async () => {
        calls++;
        if (calls > 1) throw new Error("executor crashed");
        return { status: mode === "constraint" ? "success" : "failed", summary: "partial text",
          outputs: { partial: "kept" }, artifacts, ...(mode === "retry-throws" ? { error: "temporary", retryable: true } : {}) };
      },
    };
    const result = await runWorkflow({ doc, prompt: "partial", ports, signal: new AbortController().signal,
      entry: { nodeId: "n_start", summary: "manual", payload: { kind: "manual" } } });
    const outcome = result.outcomes.get("n_inspect");
    assert.equal(outcome?.status, "failed");
    assert.equal(outcome?.summary, "partial text");
    assert.deepEqual(outcome?.outputs, { partial: "kept" });
    assert.deepEqual(outcome?.artifacts, artifacts);
    assert.equal(result.outcomes.get("after")?.status, "skipped", "partial output must not make a failed prerequisite successful");
    if (mode === "retry-throws") assert.equal(calls, 2);
  });
}

console.log(`Module workflow: ${passed} passed, ${failed} failed (${process.env.P2_WORKFLOW_PHASE})`);
await writeFile(join(evidenceDir, `${process.env.P2_WORKFLOW_PHASE}-checks.json`), JSON.stringify({ passed, failed, results }, null, 2));
process.exitCode = failed ? 1 : 0;
