/** T59: Mcode library -> native Node-RED canvas. This is not a user Deploy.
 * Switching canvases replaces the native working graph only after explicit
 * acknowledgment when another graph is present; no reverse sync is invoked.
 */
import type { WorkflowDoc } from "@contracts/workflow";
import type { NodeTypeManifest } from "@contracts/nodeType";
import { migrateWorkflowDoc } from "./flowMigration.js";
import { replaceNativeCanvas, readNativeCanvas } from "./nodeRedStorage.js";
import type { EngineRuntimeStatus } from "./runtimeSupervisor.js";
import type { WorkflowEngineLaunchSpec } from "@main/ipc/workflowEngine.js";

export type NativeLoadResult =
  | { ok: true }
  | { ok: false; reason: string; requiresConfirmation?: boolean };

export interface NativeLoadPorts {
  get(id: string): WorkflowDoc | null;
  types(): Promise<ReadonlyMap<string, NodeTypeManifest>>;
  dataDir(): string;
  runtime: {
    status(): EngineRuntimeStatus;
    stop(): Promise<EngineRuntimeStatus>;
    start(spec: { engineId: string; dataDir: string; command: string; args: WorkflowEngineLaunchSpec["args"]; env?: NodeJS.ProcessEnv; probeIdentity?: { adminToken: string } }): Promise<EngineRuntimeStatus>;
  };
  beforeStart(): Promise<void>;
  launchSpec(): WorkflowEngineLaunchSpec | null;
}

// One native flows.json per engine. Two clicks must not interleave stop/save/start.
let tail: Promise<void> = Promise.resolve();

export function loadWorkflowIntoNative(
  workflowId: string,
  ports: NativeLoadPorts,
  confirmReplace = false,
): Promise<NativeLoadResult> {
  const task = tail.then(async (): Promise<NativeLoadResult> => {
    try {
      if (typeof workflowId !== "string" || !workflowId.trim() || workflowId.length > 200) {
        return { ok: false, reason: "工作流 ID 不合法" };
      }
      const doc = ports.get(workflowId);
      if (!doc) return { ok: false, reason: "工作流不存在或已被删除" };
      if (doc.engine !== "node-red") {
        return { ok: false, reason: "这张图归原生调度器（mcode），请先显式切换到 Node-RED；不会自动更改 engine" };
      }

      const migrated = migrateWorkflowDoc(doc, { types: await ports.types() });
      const issues = [
        ...migrated.report.unmapped.map(item => item.reason),
        ...migrated.report.needsHumanDecision.map(item => item.message),
        ...migrated.report.lossy.map(item => item.message),
      ];
      if (issues.length > 0) {
        return { ok: false, reason: `无法无损装载「${doc.name}」：${issues.length} 个节点/语义问题：\n${issues.join("\n")}` };
      }

      const status = ports.runtime.status();
      if (status.state === "starting") return { ok: false, reason: "Node-RED 正在启动，不能切换画布" };
      const dataDir = ports.dataDir();
      // Compare the exact native canvas, not a sidecar archive. An external
      // Node-RED Deploy may already have changed the on-disk graph.
      const before = readNativeCanvas(dataDir);
      const nodes = migrated.flow.nodes;
      const next = JSON.stringify(nodes);
      const different = before !== null && JSON.stringify(JSON.parse(before)) !== next;
      if ((different || status.state === "running" || status.state === "failed") && !confirmReplace) {
        return {
          ok: false,
          requiresConfirmation: true,
          reason: "切换会替换当前 Node-RED 画布并重启运行中的引擎。尚未 Deploy 的编辑无法从磁盘恢复；请先在原生编辑器部署或另存。旧的已部署 flows.json 将保留内容寻址备份。确定继续？",
        };
      }

      // No POST /flows: that endpoint is a *user* Deploy and would cause T58
      // to rewrite library updatedAt. A stopped runtime reads flows.json only
      // on startup, so no deploy-final handshake fires on load.
      if (status.state === "running" || status.state === "failed") {
        const stopped = await ports.runtime.stop();
        if (stopped.state !== "stopped") throw new Error("无法安全停止旧 Node-RED 引擎");
      }
      await ports.beforeStart();
      const spec = ports.launchSpec();
      if (!spec) throw new Error("Node-RED 启动参数不可用，已拒绝写入画布");
      const written = await replaceNativeCanvas(dataDir, nodes);
      try {
        const started = await ports.runtime.start({
          engineId: "node-red", dataDir: spec.dataDir, command: spec.command, args: spec.args,
          ...(spec.env ? { env: spec.env } : {}),
          ...(spec.probeIdentity ? { probeIdentity: spec.probeIdentity } : {}),
        });
        if (started.state !== "running") throw new Error(started.reason ?? "Node-RED 启动失败");
        return { ok: true };
      } catch (err) {
        // Only restore if no other actor replaced our exact bytes.
        if (written.changed) await written.rollback();
        throw err;
      }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });
  tail = task.then(() => undefined, () => undefined);
  return task;
}
