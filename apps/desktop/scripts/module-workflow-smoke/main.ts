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
import { MODULE_CAPABILITY_NODE_TYPE_ID, MODULE_CAPABILITY_RUNNER_KIND, ModuleCatalogSchema, ModuleWorkflowExecutionInputSchema } from "@contracts/moduleCapability";
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
  assert.match(outcome.error ?? "", /No executor registered/);
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
  assert.equal(outside.status, "failed"); assert.match(outside.error ?? "", /outside workspace/);
  const unknown = await runner.execute(contextFor(inputFor(), evidenceDir));
  assert.equal(unknown.status, "failed"); assert.match(unknown.error ?? "", /Unknown workspace/);
});
await host.install({ ...EXAMPLE_MODULE, id: "user.workflow-fixture" });
await check("user modules stay menu-callable but are rejected by the workflow path", async () => {
  const menu = await host.invoke({ moduleId: "user.workflow-fixture", contributionId: "inspect", requestId: "menu-fixture", resource: { projectPath: workspace, path: join(workspace, "module-inspect-demo.txt") } });
  assert.equal(menu.type, "task");
  const outcome = await runner.execute(contextFor(inputFor({ ...node.params, moduleId: "user.workflow-fixture" })));
  assert.equal(outcome.status, "failed"); assert.match(outcome.error ?? "", /builtin|built-in/i);
});
await check("unknown contribution fails instead of falling back to a model", async () => {
  const outcome = await runner.execute(contextFor(inputFor({ ...node.params, contributionId: "missing" })));
  assert.equal(outcome.status, "failed");
});
await check("real main IPC and preload carry metadata and workflow targets unchanged", async () => {
  registerModuleHandlers(fakeIpcMain);
  assert.equal(handlers.size, 7);
  const api = preloadApi();
  const catalog = await api.modules.catalog();
  ModuleCatalogSchema.parse(catalog);
  assert.deepEqual(catalog, host.catalog());
  assert.equal(catalog.workflowTargets?.length, 2);
  assert.ok(catalog.capabilities.every(capability => capability.metadata));
  assert.equal(Reflect.has(api.modules, "invokeForWorkflow"), false);
  assert.equal([...handlers.keys()].some(key => key.includes("Workflow")), false);
  const client = createModuleClient(api.modules, "core.file-report");
  const reply = await client.invoke("info", { projectPath: workspace, path: join(workspace, "module-inspect-demo.txt") }, "preload-info");
  assert.equal(reply.type, "result");
  if (reply.type === "result") assert.equal(reply.value.bytes, expectedBytes);
  assert.ok(handlers.has(IPC.MODULE_CATALOG));
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
console.log(`Module workflow: ${passed} passed, ${failed} failed (${process.env.P2_WORKFLOW_PHASE})`);
await writeFile(join(evidenceDir, `${process.env.P2_WORKFLOW_PHASE}-checks.json`), JSON.stringify({ passed, failed, results }, null, 2));
process.exitCode = failed ? 1 : 0;
