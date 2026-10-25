/** T59 isolated canvas-load evidence. Uses a temporary Node-RED dir and fake
 * process; NO real DB, Electron, user flows.json, or runtime is touched. */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDoc } from "@contracts/workflow";
import type { NodeTypeManifest } from "@contracts/nodeType";
import type { EngineRuntimeStatus } from "../../src/main/workflowEngines/runtimeSupervisor.js";
import { loadWorkflowIntoNative, mergeNativeWorkflowTab, type NativeLoadPorts } from "../../src/main/workflowEngines/nativeLibraryLoad.js";
import { NodeRedFlowStorage, readNativeCanvas, replaceNativeCanvas } from "../../src/main/workflowEngines/nodeRedStorage.js";
import { flowToWorkflowDoc } from "../../src/main/workflowEngines/flowMigration.js";

let total = 0;
let failed = 0;
const check = (label: string, pass: boolean, detail: unknown = "") => {
  total++;
  if (pass) console.log("  ok   " + label);
  else { failed++; console.error("  FAIL " + label, detail); }
};
const docOf = (id: string, engine: "mcode" | "node-red" = "node-red", type = "known"): WorkflowDoc => ({
  id, name: "Workflow " + id, engine, builtin: false, updatedAt: 100,
  nodes: [{ id: id + "-node", type, title: "step " + id, params: { instruction: "hello " + id },
    position: { x: 100, y: 50 } }],
  edges: [],
});
const dir = mkdtempSync(join(tmpdir(), "mcode-t59-"));
try {
  const docs = new Map<string, WorkflowDoc>([
    ["A", docOf("A")], ["B", docOf("B")], ["legacy", docOf("legacy", "mcode")],
    ["unmapped", docOf("unmapped", "node-red", "not-installed")],
  ]);
  const originalAUpdatedAt = docs.get("A")!.updatedAt;
  const originalBUpdatedAt = docs.get("B")!.updatedAt;
  let status: EngineRuntimeStatus = { engineId: "node-red", state: "stopped", port: null, reason: null };
  let stops = 0, starts = 0;
  let startShouldFail = false;
  const ports: NativeLoadPorts = {
    get: id => docs.get(id) ?? null,
    types: async () => new Map([
      ["known", { runner: { kind: "prompt" } } as NodeTypeManifest],
      ["mcode.trigger", { id: "mcode.trigger", manifestVersion: 1, name: "Trigger",
        runner: { kind: "trigger" }, capability: "read", params: [] } as NodeTypeManifest],
      ["mcode.condition", { id: "mcode.condition", manifestVersion: 1, name: "Condition",
        runner: { kind: "condition" }, capability: "read", params: [] } as NodeTypeManifest],
    ]),
    dataDir: () => dir,
    // 【T21】装载前会过迁移预检，它要宿主事实。这里是夹具的诚实声明：
    // 没有任何审批记录（= 本地既有工作流），也没有在跑的执行（空集，不是"未知"）。
    migrationFacts: () => ({ review: null, inFlightWorkflowIds: new Set<string>() }),
    runtime: {
      status: () => status,
      stop: async () => {
        stops++;
        status = { engineId: "node-red", state: "stopped", port: null, reason: null };
        return status;
      },
      start: async () => {
        starts++;
        if (startShouldFail) throw new Error("synthetic startup failed");
        status = { engineId: "node-red", state: "running", port: 12345, reason: null };
        return status;
      },
    },
    beforeStart: async () => {},
    launchSpec: () => ({ command: "fake-node", dataDir: dir, args: () => [] }),
  };
  const canvasDocIds = (): string[] => {
    const bytes = readNativeCanvas(dir);
    return bytes === null ? [] : (JSON.parse(bytes) as Array<{ type: string; "x-mcode"?: { docId?: string } }>)
      .filter(n => n.type === "tab").map(n => n["x-mcode"]?.docId ?? "").filter(Boolean);
  };
  const canvasDocId = () => canvasDocIds().at(-1) ?? null;
  const hasDoc = (id: string) => canvasDocIds().includes(id);

  let result = await loadWorkflowIntoNative("A", ports);
  check("A 从工作流库打开 -> 引擎真的读到 A", result.ok && result.unchanged !== true && canvasDocId() === "A", { result, canvas: canvasDocId() });
  check("启动不是 POST /flows: 工作流 updatedAt 未变", docs.get("A")!.updatedAt === originalAUpdatedAt);
  // Native editor reentry for the already-mounted same graph must not stop
  // the shared Node-RED engine or spend another process startup. The document
  // preflight still runs, and three persisted facts must agree.
  const beforeNoOp = readNativeCanvas(dir);
  result = await loadWorkflowIntoNative("A", ports);
  check("相同工作流再次打开直接复用已运行 Node-RED，不要求再次确认", result.ok && result.unchanged === true,
    result);
  check("重复打开不调用 stop/start、不重写原生画布",
    stops === 0 && starts === 1 && readNativeCanvas(dir) === beforeNoOp,
    { stops, starts, canvasUnchanged: readNativeCanvas(dir) === beforeNoOp });

  result = await loadWorkflowIntoNative("B", ports);
  check("运行中打开 B 必须先提示替换与未部署编辑风险",
    !result.ok && result.requiresConfirmation === true && result.reason.includes("尚未 Deploy"), result);
  check("未确认时不停止 A，不改画布", canvasDocId() === "A" && stops === 0);

  result = await loadWorkflowIntoNative("B", ports, true);
  check("确认后停止旧引擎、装载 B、重新启动", result.ok && hasDoc("A") && hasDoc("B") && stops === 1 && starts === 2,
    { result, canvas: canvasDocId(), stops, starts });
  check("A -> B 不是用户 Deploy，两张库文档 updatedAt 都不变",
    docs.get("A")!.updatedAt === originalAUpdatedAt && docs.get("B")!.updatedAt === originalBUpdatedAt);
  check("加载 B 后 A 仍在同一 Node-RED canvas（不是两个引擎、也未丢图）",
    canvasDocIds().join(",") === "A,B", canvasDocIds());
  check("旧 A 画布保留了内容寻址备份",
    readdirSync(dir).some(name => name.startsWith(".mcode-flows-backup-") && name.endsWith(".json")));
  result = await loadWorkflowIntoNative("B", ports);
  check("已装载 B 的真正无改动重入，无需用户确认/引擎重启",
    result.ok && result.unchanged === true && stops === 1 && starts === 2 && hasDoc("B"),
    { result, stops, starts });
  // Updating the saved library doc invalidates this fast path even if the
  // running editor still shows the old graph.
  const unchangedB = docs.get("B")!;
  docs.set("B", { ...unchangedB, nodes: unchangedB.nodes.map(node =>
    ({ ...node, params: { ...node.params, instruction: "modified source" } })) });
  result = await loadWorkflowIntoNative("B", ports);
  check("同一 docId 但库文档变更必须重新确认，不能用旧画布冒充最新版",
    !result.ok && result.requiresConfirmation === true && stops === 1 && starts === 2,
    { result, stops, starts });
  docs.set("B", unchangedB);
  const nativeBytesBefore = readNativeCanvas(dir)!;
  // Simulate a real editor Deploy changing flows.json without rewriting
  // Mcode's last load record. A no-op here would conceal native changes.
  const nativeEdited = JSON.parse(nativeBytesBefore) as Array<Record<string, unknown>>;
  nativeEdited.push({ id: "native-debug", type: "debug", z: "tab_B", name: "edited natively" });
  writeFileSync(join(dir, "flows.json"), JSON.stringify(nativeEdited), "utf8");
  result = await loadWorkflowIntoNative("B", ports);
  check("原生编辑器另行 Deploy 后即使 docId 相同也不得跳过替换确认",
    !result.ok && result.requiresConfirmation === true && stops === 1 && starts === 2,
    { result, stops, starts });
  writeFileSync(join(dir, "flows.json"), nativeBytesBefore, "utf8");
  result = await loadWorkflowIntoNative("B", ports);
  check("恢复原生画布后，三份权威数据一致才允许再次复用",
    result.ok && result.unchanged === true && stops === 1 && starts === 2, result);
  // Reuse is meaningful only for a healthy *running* child, never for
  // failed/stopped runtime with matching persisted bytes.
  const runningBefore = status;
  status = { ...status, state: "failed", reason: "simulated crash" };
  result = await loadWorkflowIntoNative("B", ports);
  check("失败引擎即使图与 journal 完全相同也不冒充仍可复用",
    !result.ok && result.requiresConfirmation === true && stops === 1 && starts === 2,
    result);
  status = runningBefore;

  result = await loadWorkflowIntoNative("unmapped", ports, true);
  check("缺节点清单拒绝并列出类型", !result.ok && result.reason.includes("not-installed"), result);
  check("拒绝迁移仍保留 A 与 B", hasDoc("A") && hasDoc("B"));

  result = await loadWorkflowIntoNative("legacy", ports, true);
  check("mcode-owned 图不静默切引擎", !result.ok && result.reason.includes("原生调度器"), result);
  check("mcode-owned 拒绝没有停止现有运行", stops === 1 && hasDoc("A") && hasDoc("B"));

  docs.set("loss", { ...docOf("loss"), nodes: [{ ...docOf("loss").nodes[0], position: { x: 3.5, y: 1 } }] });
  // 【T27】已知损失（坐标取整、trigger 的 debounce 留在 x-mcode.params…）不是拒绝理由：
  // 一次确认（与画布替换合并）后照常装载。这里用坐标取整这条最窄的损失验确认文案。
  result = await loadWorkflowIntoNative("loss", ports, false);
  check("【T27】已知损失先要求确认，且点名具体损失（坐标舍入）",
    !result.ok && result.requiresConfirmation === true && result.reason.includes("舍入"), result);
  check("未确认时画布仍有 A 与 B", hasDoc("A") && hasDoc("B") && !hasDoc("loss"));
  result = await loadWorkflowIntoNative("loss", ports, true);
  check("【T27】用户确认后已知损失照常装载（不再被当作拒绝理由）",
    result.ok && hasDoc("A") && hasDoc("B") && hasDoc("loss"), { result, canvas: canvasDocIds() });

  const manualDoc: WorkflowDoc = {
    ...docOf("manual-warning"),
    nodes: [
      { id: "manual-trigger", type: "mcode.trigger", title: "Manual",
        params: { triggerKind: "manual" }, position: { x: 10, y: 10 } },
      { id: "manual-condition", type: "mcode.condition", title: "DOI gate",
        params: { expression: { logic: "and", rules: [
          { ref: "{{trigger.input.doi}}", op: "exists" },
        ] } }, position: { x: 40, y: 10 } },
    ],
    edges: [{ id: "manual-to-condition", from: "manual-trigger", to: "manual-condition" }],
  };
  docs.set("manual-warning", manualDoc);
  const beforeWarning = canvasDocId();
  result = await loadWorkflowIntoNative("manual-warning", ports, false);
  check("W25 迁移提示从真实装载接口暴露 DOI 输入限制，而非仅记在 report",
    !result.ok && result.requiresConfirmation === true
      && result.reason.includes("【需从 Mcode 自定义 UI 运行】")
      && result.reason.includes("{{trigger.input.doi}}"), result);
  check("W25 尚未确认 DOI 输入限制时原生画布绝不被替换",
    canvasDocId() === beforeWarning, { beforeWarning, after: canvasDocId() });

  const beforeFailure = readNativeCanvas(dir);
  const unmodifiedA = docs.get("A")!;
  docs.set("A", { ...unmodifiedA, nodes: unmodifiedA.nodes.map(node =>
    ({ ...node, params: { ...node.params, instruction: "changed before failing restart" } })) });
  startShouldFail = true;
  result = await loadWorkflowIntoNative("A", ports, true);
  check("启动失败显式报错", !result.ok && result.reason.includes("synthetic startup failed"), result);
  check("引擎启动失败原子回滚原画布及其他全部 tab", readNativeCanvas(dir) === beforeFailure);
  docs.set("A", unmodifiedA);
  startShouldFail = false;
  result = await loadWorkflowIntoNative("A", ports, true);
  check("A 重新进入仍保留 A/B/loss 所有 tab", result.ok && ["A","B","loss"].every(hasDoc), { result, canvas: canvasDocIds() });
  check("所有装载都没有反向写库（updatedAt 不变）", docs.get("A")!.updatedAt === originalAUpdatedAt && docs.get("B")!.updatedAt === originalBUpdatedAt);

  // Multiple independent tabs belong to ONE Node-RED runtime; opening
  // C/D must preserve A/B/loss and a native-only Node-RED tab. C/D use
  // identical Mcode-local node IDs, exercising cross-workflow collisions.
  const nativeOnly = [
    { id: "native-tab", type: "tab", label: "Native only" },
    { id: "native-debug", type: "debug", z: "native-tab", name: "Unrelated" },
  ];
  const beforeNative = JSON.parse(readNativeCanvas(dir)!) as Array<Record<string, unknown>>;
  writeFileSync(join(dir, "flows.json"), JSON.stringify([...beforeNative, ...nativeOnly]), "utf8");
  const sharedDoc = (id: string): WorkflowDoc => ({
    ...docOf(id),
    nodes: [
      { ...docOf(id).nodes[0], id: "shared", title: "Shared local identity" },
      { ...docOf(id).nodes[0], id: "shared-target", title: "Target", position: { x: 300, y: 50 } },
    ],
    edges: [{ id: "shared-edge", from: "shared", to: "shared-target", label: "Preserve original edge" }],
  });
  docs.set("C", sharedDoc("C"));
  docs.set("D", sharedDoc("D"));
  result = await loadWorkflowIntoNative("C", ports, true);
  check("同一原生工作台装载 C 保留旧 A/B/loss + 原生独立 tab",
    result.ok && ["A","B","loss","C"].every(hasDoc)
      && readNativeCanvas(dir)!.includes('"native-tab"'), { result, ids: canvasDocIds() });
  result = await loadWorkflowIntoNative("D", ports, true);
  const sharedCanvas = JSON.parse(readNativeCanvas(dir)!) as Array<Record<string, unknown>>;
  const cNode = sharedCanvas.find(n => (n["x-mcode"] as { nodeId?: string } | undefined)?.nodeId === "shared" && n["z"] === "tab_C");
  const dNode = sharedCanvas.find(n => (n["x-mcode"] as { nodeId?: string } | undefined)?.nodeId === "shared" && n["z"] === "tab_D");
  check("C 与 D 的同名本地节点被确定性隔离，nativeId 同步真实 ID",
    result.ok && cNode?.["id"] !== dNode?.["id"]
      && typeof cNode?.["id"] === "string" && typeof dNode?.["id"] === "string"
      && (cNode?.["x-mcode"] as { nativeId?: string } | undefined)?.nativeId === cNode?.["id"]
      && (dNode?.["x-mcode"] as { nativeId?: string } | undefined)?.nativeId === dNode?.["id"],
    { c: cNode?.["id"], d: dNode?.["id"] });
  const dTarget = sharedCanvas.find(n => (n["x-mcode"] as { nodeId?: string } | undefined)?.nodeId === "shared-target"
    && n["z"] === "tab_D");
  const dSidecar = dNode?.["x-mcode"] as { edgeMeta?: Array<{ sourceNativeId: string; targetNativeId: string }> } | undefined;
  const dJournal = new NodeRedFlowStorage(dir).loadFlow(null, "D");
  const dReversed = dJournal.ok ? flowToWorkflowDoc(dJournal.flow) : null;
  check("同名节点改名也同步 wires、edgeMeta、journal links；反向迁移仍恢复原始边",
    (dNode?.["wires"] as string[][] | undefined)?.[0]?.[0] === dTarget?.["id"]
      && dSidecar?.edgeMeta?.[0]?.sourceNativeId === dNode?.["id"]
      && dSidecar?.edgeMeta?.[0]?.targetNativeId === dTarget?.["id"]
      && dReversed?.edges.some(edge => edge.from === "shared" && edge.to === "shared-target"
        && edge.label === "Preserve original edge") === true,
    { source: dNode?.["id"], target: dTarget?.["id"], wires: dNode?.["wires"], metadata: dSidecar, reversed: dReversed?.edges });
  check("Node-RED 原生 tab 和节点未发生结构变化",
    nativeOnly.every(node => sharedCanvas.some(n => JSON.stringify(n) === JSON.stringify(node))),
    sharedCanvas.filter(n => n["z"] === "native-tab" || n["id"] === "native-tab"));
  const beforeReentry = readNativeCanvas(dir);
  const startsBeforeReentry = starts;
  result = await loadWorkflowIntoNative("C", ports);
  check("单一 Node-RED 中切回 C 不重新启动，更不删除 D",
    result.ok && result.unchanged === true && starts === startsBeforeReentry
      && readNativeCanvas(dir) === beforeReentry && hasDoc("D"), result);

  // A path-level compare-and-swap catches an unrelated native Deploy after
  // confirmation, before the OS lease is acquired for the merged write.
  const oldCanvas = readNativeCanvas(dir)!;
  const altered = [...sharedCanvas, { id: "late-native", type: "debug", z: "native-tab", name: "External deploy" }];
  writeFileSync(join(dir, "flows.json"), JSON.stringify(altered), "utf8");
  let raceRejected = false;
  try {
    await replaceNativeCanvas(dir, sharedCanvas as never, { expectedCanvas: oldCanvas });
  } catch (error) { raceRejected = String(error).includes("其他操作更改"); }
  check("其他进程先完成 Deploy，旧画布快照不许覆盖外部节点",
    raceRejected && (readNativeCanvas(dir) ?? "").includes("late-native"));
  writeFileSync(join(dir, "flows.json"), oldCanvas, "utf8");

  // Corrupt old canvas identity must be rejected rather than silently
  // trusting the first matching tab.
  let duplicateRejected = false;
  try {
    mergeNativeWorkflowTab([...sharedCanvas, structuredClone(sharedCanvas[0]!) ] as never,
      sharedCanvas.filter(n => n["z"] === "tab_C" || n["id"] === "tab_C") as never, "C");
  } catch (error) { duplicateRejected = /重复(?:节点| tab) id/.test(String(error)); }
  check("已有画布内重复 node id 时拒绝不确定归属，不执行合并", duplicateRejected);

  // A native editor/other process could Deploy while Mcode is installing the
  // node pack. The OS-level CAS must reject stale whole-canvas replacement
  // AND restore this document's journal, not just keep the other tab's bytes.
  const preRaceDoc = docs.get("D")!;
  docs.set("D", { ...preRaceDoc, nodes: preRaceDoc.nodes.map(node =>
    node.id === "shared" ? { ...node, params: { ...node.params, instruction: "source updated" } } : node) });
  const preRaceJournal = new NodeRedFlowStorage(dir).loadFlow(null, "D");
  const externalNode = { id: "outside-deploy", type: "debug", z: "native-tab", name: "newer external deploy" };
  const racePorts: NativeLoadPorts = { ...ports, beforeStart: async () => {
    const current = JSON.parse(readNativeCanvas(dir) ?? "[]") as Array<Record<string, unknown>>;
    writeFileSync(join(dir, "flows.json"), JSON.stringify([...current, externalNode]), "utf8");
  } };
  result = await loadWorkflowIntoNative("D", racePorts, true);
  const afterRaceJournal = new NodeRedFlowStorage(dir).loadFlow(null, "D");
  check("确认后其他进程先 Deploy：装载明确 CAS 失败，不覆盖刚部署的原生节点",
    !result.ok && result.reason.includes("其他操作更改")
      && (readNativeCanvas(dir) ?? "").includes("outside-deploy"), result);
  check("外部 Deploy 竞争导致装载失败时恢复旧 journal，而不是留下假完成记录",
    preRaceJournal.ok && afterRaceJournal.ok
      && preRaceJournal.revision === afterRaceJournal.revision,
    { before: preRaceJournal.ok ? preRaceJournal.revision : null,
      after: afterRaceJournal.ok ? afterRaceJournal.revision : null });
  docs.set("D", preRaceDoc);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`workflow-native-load-smoke:${total - failed}/${total} 通过`);
if (failed) process.exitCode = 1;
