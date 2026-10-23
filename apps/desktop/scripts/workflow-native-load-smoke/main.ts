/** T59 isolated canvas-load evidence. Uses a temporary Node-RED dir and fake
 * process; NO real DB, Electron, user flows.json, or runtime is touched. */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDoc } from "@contracts/workflow";
import type { NodeTypeManifest } from "@contracts/nodeType";
import type { EngineRuntimeStatus } from "../../src/main/workflowEngines/runtimeSupervisor.js";
import { loadWorkflowIntoNative, type NativeLoadPorts } from "../../src/main/workflowEngines/nativeLibraryLoad.js";
import { readNativeCanvas } from "../../src/main/workflowEngines/nodeRedStorage.js";

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
    types: async () => new Map([["known", { runner: { kind: "prompt" } } as NodeTypeManifest]]),
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
  const canvasDocId = () => {
    const bytes = readNativeCanvas(dir);
    if (!bytes) return null;
    const tab = (JSON.parse(bytes) as Array<{ type: string; "x-mcode"?: { docId?: string } }>).find(n => n.type === "tab");
    return tab?.["x-mcode"]?.docId ?? null;
  };

  let result = await loadWorkflowIntoNative("A", ports);
  check("A 从工作流库打开 -> 引擎真的读到 A", result.ok && canvasDocId() === "A", { result, canvas: canvasDocId() });
  check("启动不是 POST /flows: 工作流 updatedAt 未变", docs.get("A")!.updatedAt === originalAUpdatedAt);

  result = await loadWorkflowIntoNative("B", ports);
  check("运行中打开 B 必须先提示替换与未部署编辑风险",
    !result.ok && result.requiresConfirmation === true && result.reason.includes("尚未 Deploy"), result);
  check("未确认时不停止 A，不改画布", canvasDocId() === "A" && stops === 0);

  result = await loadWorkflowIntoNative("B", ports, true);
  check("确认后停止旧引擎、装载 B、重新启动", result.ok && canvasDocId() === "B" && stops === 1 && starts === 2,
    { result, canvas: canvasDocId(), stops, starts });
  check("A -> B 不是用户 Deploy，两张库文档 updatedAt 都不变",
    docs.get("A")!.updatedAt === originalAUpdatedAt && docs.get("B")!.updatedAt === originalBUpdatedAt);
  check("旧 A 画布保留了内容寻址备份",
    readdirSync(dir).some(name => name.startsWith(".mcode-flows-backup-") && name.endsWith(".json")));

  result = await loadWorkflowIntoNative("unmapped", ports, true);
  check("缺节点清单拒绝并列出类型", !result.ok && result.reason.includes("not-installed"), result);
  check("拒绝迁移仍保留 B", canvasDocId() === "B");

  result = await loadWorkflowIntoNative("legacy", ports, true);
  check("mcode-owned 图不静默切引擎", !result.ok && result.reason.includes("原生调度器"), result);
  check("mcode-owned 拒绝没有停止现有运行", stops === 1 && canvasDocId() === "B");

  docs.set("loss", { ...docOf("loss"), nodes: [{ ...docOf("loss").nodes[0], position: { x: 3.5, y: 1 } }] });
  // 【T27】已知损失（坐标取整、trigger 的 debounce 留在 x-mcode.params…）不是拒绝理由：
  // 一次确认（与画布替换合并）后照常装载。这里用坐标取整这条最窄的损失验确认文案。
  result = await loadWorkflowIntoNative("loss", ports, false);
  check("【T27】已知损失先要求确认，且点名具体损失（坐标舍入）",
    !result.ok && result.requiresConfirmation === true && result.reason.includes("舍入"), result);
  check("未确认时画布仍是 B", canvasDocId() === "B");
  result = await loadWorkflowIntoNative("loss", ports, true);
  check("【T27】用户确认后已知损失照常装载（不再被当作拒绝理由）",
    result.ok && canvasDocId() === "loss", { result, canvas: canvasDocId() });

  startShouldFail = true;
  result = await loadWorkflowIntoNative("A", ports, true);
  check("启动失败显式报错", !result.ok && result.reason.includes("synthetic startup failed"), result);
  check("引擎启动失败原子回滚原画布", canvasDocId() === "loss");
  startShouldFail = false;
  result = await loadWorkflowIntoNative("A", ports, true);
  check("B -> A 第三次打开恢复 A", result.ok && canvasDocId() === "A", { result, canvas: canvasDocId() });
  check("所有装载都没有反向写库（updatedAt 不变）", docs.get("A")!.updatedAt === originalAUpdatedAt && docs.get("B")!.updatedAt === originalBUpdatedAt);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`workflow-native-load-smoke:${total - failed}/${total} 通过`);
if (failed) process.exitCode = 1;
