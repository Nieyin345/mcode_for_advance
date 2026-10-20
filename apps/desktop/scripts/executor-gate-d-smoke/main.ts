/** Gate D production path: isolated Node-RED flows.json + fake EngineRuntime ports.
 * Actual ownership, parsing, registry and process lifecycle; no Electron/user DB.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExecutorOwnershipRegistry, InMemoryExecutorOwnershipStore, sharedExecutorOwnership } from "@main/workflowEngines/executorOwnership.js";
import { ProductionWorkflowEngineRegistry } from "@main/workflowEngines/registry.js";
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
  const live = new ExecutorOwnershipRegistry(new InMemoryExecutorOwnershipStore());
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
  const bridge = new ProductionWorkflowEngineRegistry(bridgePorts, live);
  writeFileSync(flowsPath, JSON.stringify(nativeFlow(flowId)), "utf8");
  const server = bridge.get("node-red")!;
  eq("★ deploy bridge: production runtime running", (await server.start(options)).state, "running");
  check("★ deploy bridge: legacy owner reserves competing flow", live.claim("gate-d-other", "mcode").ok);
  deliver?.({ kind: "mcode-deploy-prepare", id: "denied", flows: [
    { id: "other-tab", type: "tab", "x-mcode": { docId: "gate-d-other" } },
  ] });
  check("★ native hot deploy explicitly rejected when mcode owns candidate flow",
    replies.at(-1)?.id === "denied" && replies.at(-1)?.ok === false && (replies.at(-1)?.reason ?? "").includes("mcode"),
    replies.at(-1));
  eq("★ rejected hot deploy preserves original owner", live.executorOwnerOf(flowId), "node-red");
  check("★ competing mcode owner releases", live.release("gate-d-other", "mcode").ok);

  deliver?.({ kind: "mcode-deploy-prepare", id: "accepted", flows: [
    { id: "next-tab", type: "tab", "x-mcode": { docId: "gate-d-next" } },
  ] });
  check("★ native hot deploy preflights successfully", replies.at(-1)?.id === "accepted" && replies.at(-1)?.ok === true, replies.at(-1));
  eq("★ new owner is reserved BEFORE engine can deploy", live.executorOwnerOf("gate-d-next"), "node-red");
  eq("★ previous owner remains reserved until deploy commits", live.executorOwnerOf(flowId), "node-red");
  deliver?.({ kind: "mcode-deploy-final", id: "accepted", success: true });
  eq("★ committed deploy releases removed flow", live.executorOwnerOf(flowId), null);
  eq("★ committed deploy retains next flow", live.executorOwnerOf("gate-d-next"), "node-red");

  deliver?.({ kind: "mcode-deploy-prepare", id: "abort", flows: [
    { id: "abort-tab", type: "tab", "x-mcode": { docId: "gate-d-abort" } },
  ] });
  eq("★ candidate flow reserved while deployment pending", live.executorOwnerOf("gate-d-abort"), "node-red");
  deliver?.({ kind: "mcode-deploy-final", id: "abort", success: false });
  eq("★ failed deploy rolls back new claim", live.executorOwnerOf("gate-d-abort"), null);
  eq("★ failed deploy keeps current flow", live.executorOwnerOf("gate-d-next"), "node-red");

  deliver?.({ kind: "mcode-deploy-prepare", id: "uncertain", flows: [
    { id: "uncertain-tab", type: "tab", "x-mcode": { docId: "gate-d-uncertain" } },
  ] });
  eq("★ network abort candidate initially reserved", live.executorOwnerOf("gate-d-uncertain"), "node-red");
  deliver?.({ kind: "mcode-deploy-final", id: "uncertain", success: false, uncertain: true });
  eq("★ ambiguous native commit must KEEP owner claim (fail-closed)",
    live.executorOwnerOf("gate-d-uncertain"), "node-red");
  eq("★ native engine stop releases uncertain claim",
    (await server.stop(), live.executorOwnerOf("gate-d-uncertain")), null);
  eq("★ native deploy bridge can stop", (await server.stop()).state, "stopped");
  eq("★ native deploy bridge stop releases final claim", live.executorOwnerOf("gate-d-next"), null);
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
eq("★ shared registry has no accidental fixture state", sharedExecutorOwnership.executorOwnerOf(flowId), null);
console.log("executor-gate-d-smoke: " + (total - failed) + "/" + total + " 通过");
if (failed) process.exitCode = 1;
