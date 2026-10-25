/** Gate D production path: isolated Node-RED flows.json + fake EngineRuntime ports.
 * Actual ownership, parsing, registry and process lifecycle; no Electron/user DB.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { FileExecutorOwnershipStore, OWNERSHIP_FILE } from "@main/workflowEngines/fileExecutorOwnershipStore.js";
import { join } from "node:path";
import { ExecutorOwnershipRegistry, InMemoryExecutorOwnershipStore, sharedExecutorOwnership } from "@main/workflowEngines/executorOwnership.js";
import { OwnedNodeRedRuntime, ProductionWorkflowEngineRegistry, assertSafeMigratedManualInject } from "@main/workflowEngines/registry.js";
import { syncNativeLibraryDocs } from "@main/workflowEngines/nativeLibrarySync.js";
import { migrateWorkflowDoc } from "@main/workflowEngines/flowMigration.js";
import type { WorkflowDoc } from "@contracts/workflow";
import type { EngineChildProcess, EngineRuntimePorts } from "@main/workflowEngines/runtimeSupervisor.js";

let total = 0, failed = 0;
function check(name: string, ok: boolean, info?: unknown): void {
  total++;
  if (ok) console.log("  ok   " + name);
  else { failed++; console.log("  FAIL " + name + " — " + JSON.stringify(info)); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
const ROOT = process.env.MCODE_SMOKE_DATA_ROOT;
if (!ROOT || !/mcode-executor-gate-d-data/i.test(ROOT)) {
  throw new Error("Refusing to run without fresh isolated MCODE_SMOKE_DATA_ROOT");
}
const registry = new ExecutorOwnershipRegistry(new InMemoryExecutorOwnershipStore());
const events: Array<{ exited: boolean; crash(code?: number | null): void }> = [];
let spawns = 0, signals: string[] = [];
const ports: EngineRuntimePorts = {
  allocatePort: async () => 35274,
  now: () => Date.now(),
  sleep: async () => {},
  probe: async () => true,
  spawn: () => {
    spawns++;
    const exits: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    const state = { exited: false, crash(code: number | null = 11): void {
      if (state.exited) return;
      state.exited = true;
      for (const cb of [...exits]) cb(code, null);
    } };
    events.push(state);
    const child: EngineChildProcess = {
      pid: 43210,
      kill: (signal) => { signals.push(signal ?? "SIGTERM"); state.crash(0); return true; },
      onExit: (listener) => exits.push(listener),
      onError: () => {},
      tailOutput: () => "fake-child",
    };
    return child;
  },
};
const prod = new ProductionWorkflowEngineRegistry(ports, registry);
const dir = prod.dataDirOf("node-red");
mkdirSync(dir, { recursive: true });
const flowId = "fictional-gate-d-flow";
const nativeFlow = (id: string) => [
  { id: "tab1", type: "tab", "x-mcode": { docId: id } },
  { id: "cron1", type: "inject", z: "tab1", props: [{ p: "payload" }], repeat: "60" },
  { id: "watch1", type: "file-watch", z: "tab1" },
  { id: "event1", type: "mcode-app-event", z: "tab1" },
];
const flowsPath = join(dir, "flows.json");
writeFileSync(flowsPath, JSON.stringify(nativeFlow(flowId)), "utf8");
const runtime = prod.get("node-red")!;
const options = { engineId: "node-red", command: "node", args: () => [], dataDir: dir };


// T10. Real-disk claims: reboot, compare-and-insert, corrupt archive, fail-closed
// recovery, stale native claims. Fixtures live under the smoke-only data root.
{
  const storeDir = join(ROOT, "t10-ownership");
  mkdirSync(storeDir, { recursive: true });
  const native = "t10-native";
  const nativePath = join(storeDir, "flows.json");
  writeFileSync(nativePath, JSON.stringify(nativeFlow(native)), "utf8");
  const firstStore = new FileExecutorOwnershipStore(storeDir);
  const firstRegistry = new ExecutorOwnershipRegistry(firstStore);
  check("T10 native flow reconstructed on first boot", firstRegistry.executorOwnerOf(native) === "node-red");
  check("T10 explicit mcode owner persisted", firstRegistry.claim("t10-legacy", "mcode").ok);
  const ownerPath = join(storeDir, OWNERSHIP_FILE);
  const persisted = readFileSync(ownerPath, "utf8");

  const duplicate = firstStore.insert({ flowId: "t10-legacy", owner: "node-red" });
  eq("T10 existing insert rejects second owner", duplicate, false);
  eq("T10 failed insert does not mutate bytes", readFileSync(ownerPath, "utf8"), persisted);
  eq("T10 failed insert leaves old owner", firstRegistry.executorOwnerOf("t10-legacy"), "mcode");

  const restarted = new ExecutorOwnershipRegistry(new FileExecutorOwnershipStore(storeDir));
  eq("T10 new registry after restart retains real disk mcode owner", restarted.executorOwnerOf("t10-legacy"), "mcode");
  eq("T10 new registry retains native owner", restarted.executorOwnerOf(native), "node-red");

  const broken = "{not-owner-json";
  writeFileSync(ownerPath, broken, "utf8");
  const recoveredStore = new FileExecutorOwnershipStore(storeDir);
  const retained = readdirSync(storeDir).filter((file) => file.startsWith(OWNERSHIP_FILE + ".corrupt-"));
  check("T10 corrupted owner original archived byte-for-byte",
    retained.some((file) => readFileSync(join(storeDir, file), "utf8") === broken), retained);
  eq("T10 damaged archive rebuilds native ownership from flows", recoveredStore.get(native)?.owner, "node-red");
  check("T10 corruption emits visible diagnostic", recoveredStore.diagnostics().events.some((event) => event.kind === "corrupt"));
  const damagedRegistry = new ExecutorOwnershipRegistry(recoveredStore);
  eq("T10 unknown flow is NOT silently assumed node-red", damagedRegistry.executorOwnerOf("t10-unknown"), null);
  check("T10 missing owner is NOT silently assigned to mcode after corruption",
    !damagedRegistry.claim("t10-unknown", "mcode").ok);

  const bothDir = join(ROOT, "t10-both-corrupt");
  mkdirSync(bothDir, { recursive: true });
  writeFileSync(join(bothDir, "flows.json"), "{broken-flows", "utf8");
  writeFileSync(join(bothDir, OWNERSHIP_FILE), broken, "utf8");
  const bothStore = new FileExecutorOwnershipStore(bothDir);
  const both = new ExecutorOwnershipRegistry(bothStore);
  eq("T10 double corruption gives an empty registry", both.list().length, 0);
  check("T10 double corruption emits flows-invalid diagnostic",
    bothStore.diagnostics().events.some((event) => event.kind === "flows-invalid"));
  check("T10 double corruption rejects legacy runner takeover", !both.acquireExecution("t10-unknown", "mcode").ok);

  // A native tab deleted from the durable flow graph must not retain its old
  // ownership forever (but legacy-only mcode claims are not Node-RED tabs).
  writeFileSync(nativePath, "[]", "utf8");
  const staleStore = new FileExecutorOwnershipStore(storeDir);
  eq("T10 stale native claim released during boot reconciliation", staleStore.get(native), null);
  check("T10 stale native claim emits diagnostic", staleStore.diagnostics().events.some((event) => event.kind === "stale"));
}

// 1. Production EngineRuntime.start is guarded, not merely the IPC facade.
check("★ mcode first owner claim", registry.claim(flowId, "mcode").ok);
let rejected: unknown;
try { await runtime.start(options); } catch (err) { rejected = err; }
check("★ second owner explicitly fails closed before spawn",
  rejected instanceof Error && rejected.message.includes("mcode"), String(rejected));
eq("★ denied Node-RED owner did not spawn", spawns, 0);
eq("★ conflict preserved first owner", registry.executorOwnerOf(flowId), "mcode");
check("★ original mcode owner releases", registry.release(flowId, "mcode").ok);

// 2. First Node-RED owner owns cron / watch / event flow as one docId.
eq("★ production registry contains same runtime", prod.get("node-red"), runtime);
eq("★ Node-RED successfully starts", (await runtime.start(options)).state, "running");
eq("★ native tab owns exactly the original Mcode flow ID", registry.executorOwnerOf(flowId), "node-red");
const competitor = registry.acquireExecution(flowId, "mcode");
check("★ manual workflow cannot run while Node-RED owns the same flow", !competitor.ok, competitor);
check("★ a pending cron/file/event dispatch cannot acquire a rival owner", !registry.claim(flowId, "mcode").ok);
eq("★ repeated start does not spawn a second engine", (await runtime.start(options)).state, "running");
eq("★ repeated start produced exactly one child", spawns, 1);

// 3. Exit event must synchronously release; not require a later status polling call.
events[0]!.crash(19);
eq("★ unexpected child crash releases flow claim", registry.executorOwnerOf(flowId), null);
check("★ legacy automation can take ownership immediately after crash", registry.claim(flowId, "mcode").ok);
check("★ legacy owner can release after recovering", registry.release(flowId, "mcode").ok);

// 4. Explicit stop and process exit both clean up.
eq("★ restarted engine runs", (await runtime.start(options)).state, "running");
eq("★ explicit stop terminates instance", (await runtime.stop()).state, "stopped");
eq("★ stop releases Node-RED owner", registry.executorOwnerOf(flowId), null);
check("★ Node-RED can start again after stop", (await runtime.start(options)).state === "running");
prod.terminateOnProcessExit();
eq("★ process exit synchronously kills child and frees owner", registry.executorOwnerOf(flowId), null);
check("★ process exit delivered kill to child", signals.includes("SIGKILL"), signals);

// 5. Read failures and foreign nodes must never enable unknown triggers.
writeFileSync(flowsPath, "{corrupt", "utf8");
const badRuntime = new ProductionWorkflowEngineRegistry(ports, registry).get("node-red")!;
const before = spawns;
let bad: unknown;
try { await badRuntime.start(options); } catch (err) { bad = err; }
check("★ corrupt flows.json fails closed", bad instanceof Error && bad.message.includes("损坏"), String(bad));
eq("★ corrupt flows.json did not spawn", spawns, before);
writeFileSync(flowsPath, JSON.stringify([{ id: "tab1", type: "tab", label: "broken sidecar", "x-mcode": {} }]), "utf8");
try { await badRuntime.start(options); } catch (err) { bad = err; }
check("★ native tab without x-mcode.docId fails closed", bad instanceof Error && bad.message.includes("docId"), String(bad));
eq("★ foreign tab did not spawn", spawns, before);
writeFileSync(flowsPath, JSON.stringify(nativeFlow(flowId)), "utf8");
check("★ verified fixture flow remains isolated",
  readFileSync(flowsPath, "utf8").includes("fictional-gate-d-flow"));

// 6. Running execution lease keeps ownership while an automation is disabled.
const held = registry.acquireExecution(flowId, "mcode");
check("★ manual legacy execution acquires the shared registry", held.ok);
if (held.ok) {
  eq("★ lease alone blocks Node-RED", registry.claim(flowId, "node-red").ok, false);
  eq("★ legacy run's lease is released on completion", (held.release(), registry.executorOwnerOf(flowId)), null);
}
// 7. A trigger's release while its asynchronous run is active is deferred.
check("★ persistent cron/file/event owner claimed", registry.claim(flowId, "mcode").ok);
const stillRunning = registry.acquireExecution(flowId, "mcode");
check("★ legacy flow holds in-flight lease", stillRunning.ok);
check("★ trigger stop requests release without discarding running lease", registry.release(flowId, "mcode").ok);
eq("★ trigger stop cannot expose active flow to Node-RED", registry.executorOwnerOf(flowId), "mcode");
eq("★ stopped trigger with in-flight run rejects Node-RED", registry.claim(flowId, "node-red").ok, false);
if (stillRunning.ok) stillRunning.release();
eq("★ workflow completion finalizes deferred release", registry.executorOwnerOf(flowId), null);

// 8. A crash racing with an asynchronous positive readiness probe must not
// turn a dead process back into 'running' after its claim was already released.
{
  const racePorts: EngineRuntimePorts = {
    ...ports,
    probe: async () => {
      events[events.length - 1]?.crash(23);
      return true;
    },
  };
  const raceRegistry = new ProductionWorkflowEngineRegistry(racePorts, registry);
  const race = raceRegistry.get("node-red")!;
  const status = await race.start(options);
  check("★ child crash during readiness probe cannot report running", status.state !== "running", status);
  eq("★ child crash during readiness probe releases owner", registry.executorOwnerOf(flowId), null);
}
check("★ no orphaned production Node-RED owner remains", registry.list().length === 0, registry.list());

// 9. Authenticated native deploy: parent owns the new document BEFORE deploy,
// rolls back on failure, and keeps the old owner until Node-RED confirms 2xx.
{
  const live = new ExecutorOwnershipRegistry(new FileExecutorOwnershipStore(dir));
  let deliver: ((message: unknown) => void) | undefined;
  const replies: Array<{ id?: string; ok?: boolean; reason?: string }> = [];
  const bridgePorts: EngineRuntimePorts = {
    ...ports,
    spawn: () => {
      const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
      return {
        onExit: (fn) => exitListeners.push(fn),
        onError: () => {},
        onMessage: (fn) => { deliver = fn; },
        sendMessage: (message) => { replies.push(message as typeof replies[number]); return true; },
        kill: () => { exitListeners.forEach(fn => fn(0, null)); return true; },
        tailOutput: () => "owned-deploy-child",
      };
    },
  };
  // T58: feed a real migrated native document through the same authenticated
  // prepare/final messages that Node-RED's POST /flows produces.
  const originalDoc: WorkflowDoc = {
    id: "gate-d-next", name: "Native library test", schemaVersion: "1",
    builtin: false, updatedAt: 0,
    nodes: [{ id: "inspect", type: "mcode.fixture", title: "Before native edit",
      position: { x: 100, y: 100 }, params: {} }],
    edges: [],
  };
  const libraryDocs = new Map([[originalDoc.id, originalDoc]]);
  const libraryEvents: string[] = [];
  let libraryCalls = 0;
  const sync = async (flows: unknown): Promise<void> => {
    libraryCalls++;
    await syncNativeLibraryDocs(flows, {
      get: id => libraryDocs.get(id) ?? null,
      revision: doc => JSON.stringify(doc),
      save: async (doc, expected) => {
        const old = libraryDocs.get(doc.id);
        if (!old || JSON.stringify(old) !== expected) return { ok: false, error: "CAS" };
        libraryDocs.set(doc.id, doc);
        return { ok: true };
      },
      changed: id => { libraryEvents.push(id); },
    });
  };
  const bridge = new ProductionWorkflowEngineRegistry(bridgePorts, live, sync);
  writeFileSync(flowsPath, JSON.stringify(nativeFlow(flowId)), "utf8");
  const server = bridge.get("node-red")!;
  eq("★ deploy bridge: production runtime running", (await server.start(options)).state, "running");
  eq("W6 启动成功但未部署 → 不得伪称 deployed", server.status().deploymentState, "not-deployed");
  deliver?.({ kind: "mcode-deploy-final", id: "forged-unpaired", success: true });
  eq("W6 无匹配 prepare 的伪成功回执必须忽略", server.status().deploymentState, "not-deployed");
  check("★ deploy bridge: legacy owner reserves competing flow", live.claim("gate-d-other", "mcode").ok);
  deliver?.({ kind: "mcode-deploy-prepare", id: "denied", flows: [
    { id: "other-tab", type: "tab", "x-mcode": { docId: "gate-d-other" } },
  ] });
  eq("W6 竞争 owner 阻止部署 → 仍未部署", server.status().deploymentState, "not-deployed");
  check("★ native hot deploy explicitly rejected when mcode owns candidate flow",
    replies.at(-1)?.id === "denied" && replies.at(-1)?.ok === false && (replies.at(-1)?.reason ?? "").includes("mcode"),
    replies.at(-1));
  eq("★ rejected hot deploy preserves original owner", live.executorOwnerOf(flowId), "node-red");
  check("★ competing mcode owner releases", live.release("gate-d-other", "mcode").ok);

  const nativeEdited = structuredClone(migrateWorkflowDoc(originalDoc).flow.nodes);
  nativeEdited.find(n => n.type !== "tab")!.name = "After editor Deploy";
  deliver?.({ kind: "mcode-deploy-prepare", id: "accepted", flows: nativeEdited });
  check("★ native hot deploy preflights successfully", replies.at(-1)?.id === "accepted" && replies.at(-1)?.ok === true, replies.at(-1));
  eq("★ new owner is reserved BEFORE engine can deploy", live.executorOwnerOf("gate-d-next"), "node-red");
  eq("★ previous owner remains reserved until deploy commits", live.executorOwnerOf(flowId), "node-red");
  deliver?.({ kind: "mcode-deploy-final", id: "accepted", success: true });
  eq("W6 成功回执 + 可执行节点 → 当前进程确实已部署", server.status().deploymentState, "deployed");
  await Promise.resolve();
  eq("T58 actual native editor title saves back into Mcode workflow library",
    libraryDocs.get("gate-d-next")?.nodes[0].title, "After editor Deploy");
  eq("T58 changed Mcode workflow is broadcast to library view", libraryEvents.join(","), "gate-d-next");
  eq("T58 sync fires exactly once on confirmed deploy", libraryCalls, 1);
  eq("★ committed deploy releases removed flow", live.executorOwnerOf(flowId), null);
  eq("★ committed deploy retains next flow", live.executorOwnerOf("gate-d-next"), "node-red");

  deliver?.({ kind: "mcode-deploy-prepare", id: "abort", flows: [
    { id: "abort-tab", type: "tab", "x-mcode": { docId: "gate-d-abort" } },
  ] });
  eq("★ candidate flow reserved while deployment pending", live.executorOwnerOf("gate-d-abort"), "node-red");
  deliver?.({ kind: "mcode-deploy-final", id: "abort", success: false });
  eq("W6 明确失败的后续部署不能抹掉之前仍活跃的部署", server.status().deploymentState, "deployed");
  eq("T58 failed native deploy never writes workflow library", libraryCalls, 1);
  eq("★ failed deploy rolls back new claim", live.executorOwnerOf("gate-d-abort"), null);
  eq("★ failed deploy keeps current flow", live.executorOwnerOf("gate-d-next"), "node-red");
  eq("T10 failed deploy rollback left memory and disk exactly consistent",
    JSON.stringify(JSON.parse(readFileSync(join(dir, OWNERSHIP_FILE), "utf8")).records),
    JSON.stringify(live.list()));
  eq("T10 failed deploy did not leave aborted native claim on disk",
    JSON.parse(readFileSync(join(dir, OWNERSHIP_FILE), "utf8")).records.some(
      (entry: { flowId: string }) => entry.flowId === "gate-d-abort"), false);

  deliver?.({ kind: "mcode-deploy-prepare", id: "uncertain", flows: [
    { id: "uncertain-tab", type: "tab", "x-mcode": { docId: "gate-d-uncertain" } },
  ] });
  eq("★ network abort candidate initially reserved", live.executorOwnerOf("gate-d-uncertain"), "node-red");
  deliver?.({ kind: "mcode-deploy-final", id: "uncertain", success: false, uncertain: true });
  eq("W6 结果不确定必须撤销已部署的断言", server.status().deploymentState, "unknown");
  eq("★ ambiguous native commit must KEEP owner claim (fail-closed)",
    live.executorOwnerOf("gate-d-uncertain"), "node-red");
  eq("★ native engine stop releases uncertain claim",
    (await server.stop(), live.executorOwnerOf("gate-d-uncertain")), null);
  check("W6 stop 后不得保留上次 OS 进程的部署回执", server.status().deploymentState === undefined);
  eq("★ native deploy bridge can stop", (await server.stop()).state, "stopped");
  eq("★ native deploy bridge stop releases final claim", live.executorOwnerOf("gate-d-next"), null);
  eq("W6 未可信的下次启动不得继承上一次部署", (await server.start(options)).deploymentState,
    "not-deployed");
  await server.stop();
  const trustedOptions = { ...options, env: { MCODE_ENGINE_TRUSTED: "1" } };
  eq("W6 已可信的引擎启动不误报需要手动部署", (await server.start(trustedOptions)).deploymentState,
    "unknown");
  deliver?.({ kind: "mcode-deploy-prepare", id: "trusted-manual", flows: nativeEdited });
  deliver?.({ kind: "mcode-deploy-final", id: "trusted-manual", success: true });
  eq("W6 具备持久信任的引擎即便手动部署也不弹错误重启提示",
    server.status().deploymentState, "unknown");
  await server.stop();
}

// 10. An unkillable OS child is NOT a stopped flow: preserve the owner until
// actual exit. This also covers a late exit after both kill signals have failed.
{
  const stuckStore = new ExecutorOwnershipRegistry(new InMemoryExecutorOwnershipStore());
  const lateExitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const stuckPorts: EngineRuntimePorts = {
    ...ports,
    spawn: () => ({
      onExit: (fn) => { lateExitHandlers.push(fn); },
      onError: () => {},
      kill: () => true, // fake process refuses to exit, even on SIGKILL
      tailOutput: () => "still alive",
    }),
  };
  const stuckEngine = new ProductionWorkflowEngineRegistry(stuckPorts, stuckStore).get("node-red")!;
  writeFileSync(flowsPath, JSON.stringify(nativeFlow(flowId)), "utf8");
  eq("★ unkillable fixture starts", (await stuckEngine.start(options)).state, "running");
  await stuckEngine.stop(1);
  eq("★ stop without confirmed process exit MUST retain the owner", stuckStore.executorOwnerOf(flowId), "node-red");
  check("★ another executor still blocked after incomplete SIGKILL", !stuckStore.claim(flowId, "mcode").ok);
  check("★ restart refused while old child may still be alive",
    await stuckEngine.start(options).then(() => false, () => true));
  for (const fn of [...lateExitHandlers]) fn(9, null);
  eq("★ late confirmed process exit eventually releases claim", stuckStore.executorOwnerOf(flowId), null);
}
// W25: Host must authorize a *specific* deployed manual Inject before issuing
// any ticket/HTTP call. This uses real OwnedNodeRedRuntime, fake OS child only.
{
  const manualDir = join(ROOT, "w25-native-manual");
  mkdirSync(manualDir, { recursive: true });
  const owned = "w25-manual-doc";
  const manualId = "w25-manual-trigger";
  const manualDocument = {
    id: owned, name: "Trusted custom UI target", engine: "node-red",
    builtin: false, updatedAt: 1, nodes: [{
      id: manualId, type: "mcode.trigger", title: "Explicit manual",
      position: { x: 0, y: 0 }, params: { triggerKind: "manual" },
    }], edges: [],
  } as WorkflowDoc;
  const stored = [
    { id: "w25-tab", type: "tab", "x-mcode": { docId: owned } },
    { id: "w25-inject", type: "inject", z: "w25-tab",
      "x-mcode": { nodeId: manualId, type: "mcode.trigger", params: { triggerKind: "manual" } },
      once: false, repeat: "", crontab: "", wires: [["w25-next"]] },
    { id: "w25-next", type: "debug", z: "w25-tab" },
  ];
  const brokenManual = stored.map(node => node["type"] === "inject"
    ? { ...node, once: true, "x-mcode": {
      ...(node["x-mcode"] ?? {}), type: "mcode.trigger", params: { triggerKind: "manual" },
    } } : node);
  check("W25 旧迁移器 once=true 的手动节点在引擎启动前会被检测",
    (() => { try { assertSafeMigratedManualInject(brokenManual); return false; }
      catch (e) { return e instanceof Error && e.message.includes("禁止自动执行"); } })());
  check("W25 用户自己创建的普通 Node-RED 原生 Inject 不受此限制",
    (() => { try { assertSafeMigratedManualInject([{ id: "native", type: "inject", once: true }]); return true; }
      catch { return false; } })());
  writeFileSync(join(manualDir, "flows.json"), JSON.stringify(brokenManual), "utf8");
  const store = new ExecutorOwnershipRegistry(new InMemoryExecutorOwnershipStore());
  const subject = new OwnedNodeRedRuntime("node-red", ports, store, undefined,
    async () => [], id => id === owned ? manualDocument : null);
  const untrustedOptions = {
    ...options, dataDir: manualDir, probeIdentity: { adminToken: "w25-private-admin" },
  };
  const initialSpawns = spawns;
  let unsafeStartRejected = false;
  try { await subject.start(untrustedOptions); }
  catch (e) { unsafeStartRejected = e instanceof Error && e.message.includes("禁止自动执行"); }
  check("W25 已持久化的危险手动 Once 流在真实 runtime.start 边界拒绝，不生成子进程",
    unsafeStartRejected && spawns === initialSpawns);
  writeFileSync(join(manualDir, "flows.json"), JSON.stringify(stored), "utf8");
  eq("W25 原生手动入口只读启动", (await subject.start(untrustedOptions)).state, "running");
  check("W25 未部署的非可信流程拒绝 Custom UI 运行",
    (() => { try { subject.nativeManualTarget(owned, manualId); return false; }
      catch (e) { return e instanceof Error && e.message.includes("尚未确认"); } })());
  await subject.stop();

  const nativeOpts = { ...untrustedOptions, env: { MCODE_ENGINE_TRUSTED: "1" } };
  eq("W25 可信原生引擎启动", (await subject.start(nativeOpts)).state, "running");
  const deliverForManual = (msg: unknown): void => {
    (subject as unknown as { onDeployMessage(message: unknown, reply: (response: unknown) => void): void })
      .onDeployMessage(msg, () => {});
  };
  deliverForManual({ kind: "mcode-deploy-prepare", id: "manual-pending", flows: stored });
  check("W25 原生部署尚未完成时不允许向旧 Inject 派发",
    (() => { try { subject.nativeManualTarget(owned, manualId); return false; }
      catch (e) { return e instanceof Error && e.message.includes("尚未确认"); } })());
  deliverForManual({ kind: "mcode-deploy-final", id: "manual-pending", success: false, uncertain: true });
  check("W25 部署回执不确定时即使是可信重启工作流也拒绝继续触发",
    (() => { try { subject.nativeManualTarget(owned, manualId); return false; }
      catch (e) { return e instanceof Error && e.message.includes("不确定"); } })());
  await subject.stop();
  eq("W25 不确定部署后必须经新生命周期重新确认才能触发",
    (await subject.start(nativeOpts)).state, "running");
  for (const [label, changed] of [
    ["没有下游连线", { ...stored[1]!, wires: [[]] }],
    ["连向已删除的节点", { ...stored[1]!, wires: [["missing-downstream"]] }],
    ["已禁用", { ...stored[1]!, d: true }],
    ["被改为周期自动触发", { ...stored[1]!, repeat: "60" }],
    ["节点 sidecar 变更", { ...stored[1]!, "x-mcode": { nodeId: manualId } }],
  ] as const) {
    // The same production indexing used after native deploy and startup.
    const variant = [stored[0]!, changed, stored[2]!];
    (subject as unknown as { indexNativeNodes(flows: unknown): void }).indexNativeNodes(variant);
    check("W25 原生 Inject " + label + "时不允许仅靠 200 假装已执行",
      (() => { try { subject.nativeManualTarget(owned, manualId); return false; }
        catch (e) { return e instanceof Error && e.message.includes("已禁用"); } })());
  }
  (subject as unknown as { indexNativeNodes(flows: unknown): void }).indexNativeNodes(stored);
  check("W25 复原合法原生手动 Inject 后可以定位",
    (() => { try { return subject.nativeManualTarget(owned, manualId).nodeId === "w25-inject"; }
      catch { return false; } })());
  check("W25 错的 triggerNodeId 不能执行",
    (() => { try { subject.nativeManualTarget(owned, "other-trigger"); return false; }
      catch (e) { return e instanceof Error && e.message.includes("不是已保存"); } })());
  check("W25 错的 docId 不能跨工作流执行",
    (() => { try { subject.nativeManualTarget("foreign-doc", manualId); return false; }
      catch (e) { return e instanceof Error && e.message.includes("不属于"); } })());

  const actualFetch = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  try {
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return { ok: true, status: 200 } as Response;
    };
    const invoked = await subject.runNativeManual(owned, manualId, {
      kind: "event", event: "library.item.imported", "input.doi": "10.1000/mcode",
    });
    check("W25 已归属/已部署的手动入口经 Host 才能运行", invoked.ok, invoked);
    const call = requests[0];
    const posted = JSON.parse(String(call?.init.body)) as {
      __user_inject_props__?: Array<{ p: string; v: string }>;
    };
    check("W25 只调用指定 Node-RED 原生 inject 节点",
      requests.length === 1 && call?.url.endsWith("/inject/w25-inject"), call);
    check("W25 请求必须带本次私有 adminToken", call?.init.headers !== undefined
      && (call.init.headers as Record<string, string>).Authorization === "Bearer w25-private-admin");
    check("W25 用户 DOI 不泄露到 Node-RED 消息体，只传不透明短期票据",
      posted.__user_inject_props__?.length === 1
      && posted.__user_inject_props__[0]?.p === "mcode.triggerTicket"
      && /^[a-f0-9-]{36}$/.test(posted.__user_inject_props__[0]?.v ?? "")
      && !String(call?.init.body).includes("10.1000/mcode"), posted);
    globalThis.fetch = async () => ({ ok: false, status: 403 }) as Response;
    const rejected = await subject.runNativeManual(owned, manualId, { kind: "event", "input.doi": "error" });
    check("W25 Admin API 授权失败时不会虚报运行成功",
      !rejected.ok && rejected.error?.includes("403") === true, rejected);
  } finally {
    globalThis.fetch = actualFetch;
    await subject.stop();
  }
  check("W25 引擎停止后拒绝继续注入", await subject.runNativeManual(
    owned, manualId, { kind: "event", "input.doi": "late" },
  ).then(r => !r.ok));
}

eq("★ shared registry lazily reconciles its real native flows.json", sharedExecutorOwnership.executorOwnerOf(flowId), "node-red");
console.log("executor-gate-d-smoke: " + (total - failed) + "/" + total + " 通过");
if (failed) process.exitCode = 1;
