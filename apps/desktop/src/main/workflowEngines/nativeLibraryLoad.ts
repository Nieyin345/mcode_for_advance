/** T59: Mcode library -> native Node-RED canvas. This is not a user Deploy.
 * Switching canvases replaces the native working graph only after explicit
 * acknowledgment when another graph is present; no reverse sync is invoked.
 *
 * ## T21: the two orphaned workflow adapters now run on this production path
 *
 * **Migration preflight** (`workflowMigrationPreflight.ts`, T85): loading a
 * library document is the app's real "migrate this workflow to Node-RED"
 * moment, and this is its only production entry (called from `ipc/index.ts`,
 * which supplies the Host approval/in-flight facts). Every load evaluates the
 * exact document through the G0/G1 preflight:
 *
 *   - `REJECT` / `UNREADABLE` → refused unconditionally. `confirmReplace` is
 *     **not** consulted on this branch; there is no confirmation that can let
 *     a rejected document through.
 *   - `HUMAN` → requires the user's explicit `confirmReplace`, exactly like
 *     the canvas-replacement confirmation below. One acknowledgment covers
 *     both, and its text names every preflight reason.
 *   - `SAFE` → proceeds.
 *
 * The judgment itself lives in `workflowMigrationGate.ts`; nothing here
 * re-implements SAFE/HUMAN/REJECT.
 *
 * **Per-document load journal** (`NodeRedFlowStorage`, MERGE-1 step 1): each
 * load records what Mcode placed into the engine for that document in
 * `<engineDir>/flows/<safe-doc-id>.json` — a CAS-protected, docId-bound,
 * OS-leased record. It is **derivative, never a source of truth**: `flows.json`
 * remains the engine's authority (with its content-addressed backup/rollback
 * below) and the SQL library remains the user's document. The journal only
 * answers "what did Mcode last put on this canvas for this document", and on
 * the production path it:
 *   - refuses to overwrite a **corrupt** record (坏档不装空);
 *   - refuses a record whose `x-mcode.docId` is another document
 *     (doc-id-drift) instead of silently re-binding it;
 *   - serializes concurrent loads of the same document through per-flow CAS
 *     + the shared OS file lease (two Mcode processes cannot both pass);
 *   - lets the confirmation message say whether the canvas still matches
 *     Mcode's last load or has diverged (edited natively / an earlier load
 *     never completed).
 * It is deliberately not consulted for execution, deploy, or mirroring.
 */
import type { WorkflowDoc, WorkflowReviewInfo } from "@contracts/workflow";
import type { NodeTypeManifest } from "@contracts/nodeType";
import { migrateWorkflowDoc } from "./flowMigration.js";
import { NodeRedFlowStorage, readNativeCanvas, replaceNativeCanvas } from "./nodeRedStorage.js";
import {
  evaluateWorkflowMigration,
  type WorkflowMigrationEvaluation,
  type WorkflowMigrationHostFacts,
} from "./workflowMigrationGate.js";
import { log } from "@main/lib/logger.js";
import type { EngineRuntimeStatus } from "./runtimeSupervisor.js";
import type { WorkflowEngineLaunchSpec } from "@main/ipc/workflowEngine.js";

export type NativeLoadResult =
  | { ok: true }
  | { ok: false; reason: string; requiresConfirmation?: boolean };

export interface NativeLoadPorts {
  get(id: string): WorkflowDoc | null;
  types(): Promise<ReadonlyMap<string, NodeTypeManifest>>;
  dataDir(): string;
  /** T21: Host-side facts the preflight needs. Production (`ipc/index.ts`)
   * supplies the SQL approval record and the executor-ownership running set.
   * When omitted the preflight sees review as "no record" and in-flight as
   * **unknown**, which yields HUMAN (confirmation required) — never a silent
   * SAFE on unexamined facts. */
  migrationFacts?(doc: WorkflowDoc): { review: WorkflowReviewInfo | null; inFlightWorkflowIds?: ReadonlySet<string> };
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

/** The journal lives in the engine's legacy singleton project directory — the
 * same directory `registry.dataDirOf("node-red")` hands the runtime. */
const JOURNAL_PROJECT_ID: string | null = null;

function reasonLines(evaluation: WorkflowMigrationEvaluation): string {
  return evaluation.reasons.map((reason) => `- ${reason.summary}（${reason.code}）`).join("\n");
}

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

      const types = await ports.types();
      // ── T21 ① 迁移预检：REJECT / UNREADABLE 无条件拒绝（confirmReplace 不参与） ──
      let evaluation: WorkflowMigrationEvaluation;
      try {
        const facts = ports.migrationFacts?.(doc);
        evaluation = evaluateWorkflowMigration({
          doc,
          types,
          facts: {
            review: facts?.review ?? null,
            inFlightWorkflowIds: facts?.inFlightWorkflowIds,
          },
        });
      } catch (err) {
        // A gate that cannot run must not wave the document through.
        return { ok: false, reason: `迁移预检无法完成，已拒绝装载：${err instanceof Error ? err.message : String(err)}` };
      }
      if (evaluation.decision === "REJECT" || evaluation.decision === "UNREADABLE") {
        const typesLine = evaluation.unknownMcodeNodeTypes.length > 0
          ? `\n缺失的节点类型：${evaluation.unknownMcodeNodeTypes.join("、")}`
          : "";
        return {
          ok: false,
          reason: `「${doc.name}」没有通过 Node-RED 迁移预检（${evaluation.decision}），已拒绝装载。\n${reasonLines(evaluation)}${typesLine}`,
        };
      }

      const migrated = migrateWorkflowDoc(doc, { types });
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
      const journal = new NodeRedFlowStorage(dataDir);
      // Read the journal before any confirmation: a corrupt or wrong-doc
      // record refuses the load instead of being overwritten by it.
      const previousLoad = journal.loadFlow(JOURNAL_PROJECT_ID, doc.id);
      if (!previousLoad.ok && previousLoad.kind !== "missing") {
        return {
          ok: false,
          reason: `「${doc.name}」的 Node-RED 装载记录不可用，拒绝覆盖：${previousLoad.reason}`,
        };
      }
      // Compare the exact native canvas, not a sidecar archive. An external
      // Node-RED Deploy may already have changed the on-disk graph.
      const before = readNativeCanvas(dataDir);
      const nodes = migrated.flow.nodes;
      const next = JSON.stringify(nodes);
      const canvasDiffers = before !== null && JSON.stringify(JSON.parse(before)) !== next;
      const canvasDivergedFromLastLoad = previousLoad.ok
        && before !== null && JSON.stringify(previousLoad.flow.nodes) !== JSON.stringify(JSON.parse(before));
      const canvasNeedsConfirmation = canvasDiffers || status.state === "running" || status.state === "failed";
      if ((canvasNeedsConfirmation || evaluation.decision === "HUMAN") && !confirmReplace) {
        const migrationPart = evaluation.decision === "HUMAN"
          ? `\n\n迁移预检要求人工确认：\n${reasonLines(evaluation)}`
          : "";
        const divergencePart = canvasDivergedFromLastLoad
          ? "\n注意：当前画布与 Mcode 上次为这张图装载的内容不一致 —— 可能是在原生编辑器里改过，或上次装载没有完成。"
          : "";
        return {
          ok: false,
          requiresConfirmation: true,
          reason: "切换会替换当前 Node-RED 画布并重启运行中的引擎。尚未 Deploy 的编辑无法从磁盘恢复；请先在原生编辑器部署或另存。旧的已部署 flows.json 将保留内容寻址备份。确定继续？"
            + divergencePart + migrationPart,
        };
      }

      // ── T21 ② 装载记录（写前记账）：先落 CAS 记录，再动画布。 ──
      // 另一个进程在同一文档上抢先写入 → conflict，本进程在碰画布之前就退出。
      const journalSaved = await journal.saveFlow(JOURNAL_PROJECT_ID, doc.id, migrated.flow, {
        expectedRevision: previousLoad.ok ? previousLoad.revision : null,
      });
      if (!journalSaved.ok) {
        return {
          ok: false,
          reason: `「${doc.name}」的 Node-RED 装载记录写入失败（${journalSaved.kind}），已在修改画布前停止：${journalSaved.reason}`,
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
        // The journal recorded *this* load's intent before the canvas write.
        // A failed load must not keep claiming a completed load: restore the
        // previous record when there was one; a first-ever failed load leaves
        // the intent, which the divergence check above compares against the
        // actual canvas on the next load (so it cannot be mistaken for one).
        if (previousLoad.ok) {
          const restored = await journal.saveFlow(JOURNAL_PROJECT_ID, doc.id, previousLoad.flow, {
            expectedRevision: journalSaved.revision,
          });
          if (!restored.ok) {
            log.warn(`Node-RED 装载失败后装载记录未能还原（${restored.kind}）：${restored.reason}`);
          }
        }
        throw err;
      }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });
  tail = task.then(() => undefined, () => undefined);
  return task;
}
