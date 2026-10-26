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
 *
 * ## T27: the deadlock this entry point had, and the one gate that was wrong
 *
 * Until T27 this function also ran a second, *stricter* verdict right after
 * the preflight: it refused whenever `migrateWorkflowDoc` reported **any**
 * `lossy` / `needsHumanDecision` item, with no way to confirm. That made the
 * entry reject every graph a user can actually save:
 *
 *   - the save gate (`workflowValidation` + `deriveTrigger`) requires an
 *     ordinary graph to have exactly one `mcode.main` and an automation to
 *     have at least one trigger node — those are the *legacy runner's* entry
 *     requirements, and they are correct for it;
 *   - the migrator must therefore always report at least one item for such a
 *     document: `mcode.main` is a `conversation` runner (needs-human-decision,
 *     MERGE-0 #1), and every trigger maps to `inject`/`watch` (lossy:
 *     debounce/project/task/excludePaths live in `x-mcode.params`) or to
 *     `mcode-trigger` (needs-human-decision, event mapping).
 *
 * Both facts are honest *descriptions*, not impossibility proofs: the migrated
 * artifact is complete and round-trip-clean (that is why the preflight does
 * **not** REJECT these documents — it returns HUMAN), and the unexpressed
 * parameters survive in `x-mcode.params` for the Host side. The wrong gate was
 * this file's use of the report as a hard veto. T27 therefore:
 *
 *   - keeps the preflight as the single authority: REJECT / UNREADABLE still
 *     refuse unconditionally, unknown node types included;
 *   - turns the known-loss / human-decision items into the **confirmation
 *     text** (one acknowledgment with the canvas replacement), so the user
 *     sees exactly what will not be natively expressed;
 *   - keeps a defense-in-depth refusal for `unmapped` items in the exact
 *     artifact about to be written (the preflight already rejects these, so
 *     this can only refuse more, never wave anything through).
 */
import { createHash } from "node:crypto";
import type { WorkflowDoc, WorkflowReviewInfo } from "@contracts/workflow";
import type { NodeTypeManifest } from "@contracts/nodeType";
import { migrateWorkflowDoc, type NodeRedNode } from "./flowMigration.js";
import { nativeFlowIdsOfNodes } from "./nodeRedOwnership.js";
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
  | { ok: true; unchanged?: boolean }
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

/** Assemble ONE Mcode tab into the single real Node-RED canvas.
 * Other tabs (including native-only tabs) remain byte-for-byte identical as
 * JSON values. Never treat opening B as permission to delete deployed A.
 * Reject ambiguous identity, dangling membership, duplicate node ids and
 * aliases instead of guessing whether a node belongs to this document.
 */
export function mergeNativeWorkflowTab(
  current: readonly NodeRedNode[] | null,
  replacement: readonly NodeRedNode[],
  docId: string,
): { nodes: NodeRedNode[]; currentTab: NodeRedNode[] | null; imported: NodeRedNode[]; idRemap: ReadonlyMap<string, string> } {
  if (!Array.isArray(replacement)) throw Error("Node-RED 迁移结果不是节点数组");
  const tabs = replacement.filter(node => node.type === "tab");
  const meta = tabs[0]?.["x-mcode"];
  if (tabs.length !== 1 || !meta || typeof meta !== "object"
    || (meta as Record<string, unknown>)["docId"] !== docId
    || typeof tabs[0]?.id !== "string") {
    throw Error("待装载工作流没有唯一可信的 Mcode tab 身份");
  }
  const incomingTabId = tabs[0]!.id;
  const old = current === null ? [] : [...current];
  // The same identity and node-membership requirements as engine startup.
  nativeFlowIdsOfNodes(replacement);
  nativeFlowIdsOfNodes(old);
  const ids = new Set<string>();
  const existingIds = new Set<string>();
  for (const node of old) {
    if (typeof node.id !== "string" || !node.id.trim()) throw Error("Node-RED 节点 id 无效");
    if (existingIds.has(node.id)) throw Error("已有原生画布含重复节点 id，拒绝有歧义的合并");
    existingIds.add(node.id);
  }
  for (const node of replacement) {
    if (typeof node.id !== "string" || !node.id.trim()) throw Error("Node-RED 迁移节点 id 无效");
  }
  const targetTabs = old.filter(node =>
    node.type === "tab"
    && (node["x-mcode"] as Record<string, unknown> | undefined)?.["docId"] === docId);
  if (targetTabs.length > 1) throw Error("同一工作流存在多个 Node-RED tab，拒绝猜测覆盖范围");
  const previousTabId = targetTabs[0]?.id ?? null;
  // Only a tab plus its direct members can be replaced. Unscoped config
  // nodes may be shared; they are preserved, never inferred as part of B.
  for (const node of replacement) {
    if (node.type !== "tab" && node.z !== incomingTabId)
      throw Error("迁移结果含无法归属到目标 tab 的节点，拒绝合并");
    if (ids.has(node.id)) throw Error("迁移结果存在重复节点 id");
    ids.add(node.id);
  }
  const target: NodeRedNode[] = [];
  const retained: NodeRedNode[] = [];
  for (const node of old) {
    if ((node.type === "tab" && node.id === previousTabId)
      || (previousTabId !== null && node.type !== "tab" && node.z === previousTabId)) {
      target.push(node);
    } else {
      retained.push(node);
    }
  }
  // Older migration artifacts derived native node IDs from local node IDs,
  // so unrelated documents with nodes "t" collide on "n_t". Namespace only
  // genuine collisions, updating wires and signed sidecars consistently.
  const reserved = new Set(retained.map(node => node.id));
  const remap = new Map<string, string>();
  const allocated = new Set<string>(ids);
  const suffix = createHash("sha256").update(docId).digest("hex").slice(0, 16);
  for (const node of replacement) {
    if (!reserved.has(node.id)) continue;
    const scoped = `${node.id}__${suffix}`;
    if (reserved.has(scoped) || allocated.has(scoped))
      throw Error(`原生工作流节点身份冲突无法安全消除：${node.id}`);
    remap.set(node.id, scoped);
    allocated.add(scoped);
  }
  const idOf = (id: string): string => remap.get(id) ?? id;
  const imported = replacement.map(original => {
    const node: NodeRedNode = structuredClone(original);
    node.id = idOf(node.id);
    if (typeof node.z === "string") node.z = idOf(node.z);
    if (Array.isArray(node.wires)) node.wires = node.wires.map(port =>
      Array.isArray(port) ? port.map(id => typeof id === "string" ? idOf(id) : id) : port);
    const meta = node["x-mcode"];
    if (meta && typeof meta === "object") {
      if (typeof meta.nativeId === "string") meta.nativeId = idOf(meta.nativeId);
      if (Array.isArray(meta.edgeMeta)) meta.edgeMeta = meta.edgeMeta.map(edge => ({
        ...edge,
        sourceNativeId: idOf(edge.sourceNativeId),
        targetNativeId: idOf(edge.targetNativeId),
      }));
    }
    return node;
  });
  for (const node of imported) {
    if (reserved.has(node.id)) throw Error(`工作流节点 id 与其他 Node-RED 工作流冲突：${node.id}`);
  }
  // A byte-for-byte identical target tab may be revisited without changing
  // any existing links. For an actual replacement, native Node-RED supports
  // cross-tab links (link in/out/call) and even cross-tab wires. Updating a
  // tab referenced from another one could silently disconnect or retarget
  // the foreign workflow. Mcode owns only this tab; require the user to
  // resolve the incoming links in the native editor before replacing it.
  if (JSON.stringify(target) !== JSON.stringify(imported)) {
    const replacedIds = new Set(target.map(node => node.id));
    for (const node of retained) {
      const foreign = node as Record<string, unknown>;
      const wires = Array.isArray(node.wires) ? node.wires.flat() : [];
      const nativeLinks = Array.isArray(foreign["links"]) ? foreign["links"] : [];
      const incomingRef = [...wires, ...nativeLinks].find(
        id => typeof id === "string" && replacedIds.has(id));
      if (incomingRef !== undefined) {
        throw Error(`其他 Node-RED 工作流节点 ${node.id} 仍引用目标工作流节点 ${incomingRef}；拒绝破坏跨 tab 连线，请先在原生编辑器处理`);
      }
    }
  }
  // Keep the target tab at its previous position to avoid unnecessary
  // reordering; newly imported tabs append, never discard other flows.
  const firstTargetIndex = previousTabId === null ? -1 : old.findIndex(node => node.id === previousTabId);
  const prefixCount = firstTargetIndex < 0
    ? retained.length
    : old.slice(0, firstTargetIndex).filter(node =>
      node.id !== previousTabId && !(previousTabId !== null && node.z === previousTabId)).length;
  const nodes = [
    ...retained.slice(0, prefixCount),
    ...imported,
    ...retained.slice(prefixCount),
  ];
  nativeFlowIdsOfNodes(nodes);
  return { nodes, currentTab: previousTabId === null ? null : target, imported, idRemap: remap };
}

function reasonLines(evaluation: WorkflowMigrationEvaluation): string {
  return evaluation.reasons.map((reason) => `- ${reason.summary}（${reason.code}）`).join("\n");
}

/** 迁移报告里的已知损失 / 需人工裁决项 → 确认文案。不是拒绝理由（T27）：这些条目
 *  描述的是"原生画布不直接表达的东西留在 x-mcode.params，由 Host 侧承担"，迁移产物
 *  本身仍完整、可回读；预检据此判 HUMAN（要人看一眼），而不是 REJECT。 */
function knownLossLines(migrated: ReturnType<typeof migrateWorkflowDoc>): string[] {
  return [
    ...migrated.report.needsHumanDecision.map((item) =>
      `- ${item.message}${item.nodeId === undefined ? "" : `（节点 ${item.nodeId}）`}`),
    ...migrated.report.lossy.map((item) =>
      `- ${item.message}${item.nodeId === undefined ? "" : `（节点 ${item.nodeId}）`}`),
  ];
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
      // T27: `lossy` / `needsHumanDecision` are descriptions, not refusals — they
      // become the confirmation text below. `unmapped` is the one item class that
      // means "this node cannot be represented at all"; the preflight already
      // REJECTs it, so reaching here with one is an internal contradiction and
      // must fail closed rather than write a mcode-unknown placeholder.
      if (migrated.report.unmapped.length > 0) {
        return {
          ok: false,
          reason: `「${doc.name}」含无法映射到 Node-RED 的节点，已拒绝装载：\n`
            + migrated.report.unmapped.map(item => `- ${item.reason}`).join("\n"),
        };
      }
      const knownLoss = knownLossLines(migrated);

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
      const existingNodes = before === null ? null : JSON.parse(before) as NodeRedNode[];
      const merged = mergeNativeWorkflowTab(existingNodes, migrated.flow.nodes, doc.id);
      const nodes = merged.nodes;
      const idOf = (id: string): string => merged.idRemap.get(id) ?? id;
      const importedFlow = { ...migrated.flow, nodes: merged.imported,
        ...(migrated.flow.links === undefined ? {} : {
          links: migrated.flow.links.map(link => ({
            ...link, source: idOf(link.source), target: idOf(link.target),
          })),
        }),
      };
      const next = JSON.stringify(nodes);
      const currentCanvas = before === null ? null : JSON.stringify(existingNodes);
      const canvasDiffers = currentCanvas !== null && currentCanvas !== next;
      // Only this document's deployed tab can diverge from its journal.
      // Deploying/editing another tab must not force a replacement of this
      // already-open Mcode workflow or lose changes to unrelated native flows.
      const currentTab = merged.currentTab === null ? null : JSON.stringify(merged.currentTab);
      const journalTab = previousLoad.ok ? JSON.stringify(previousLoad.flow.nodes) : null;
      const canvasDivergedFromLastLoad = previousLoad.ok
        && currentTab !== journalTab;
      // Opening the SAME saved graph is navigation, not a deploy operation.
      // If the running child, on-disk native graph and doc-bound load journal
      // all agree byte-for-byte (after JSON parsing), reusing the existing
      // editor avoids a costly full Node-RED process restart, a WebContents
      // reload and disruption to other flows. Only a verified journal match
      // can take this shortcut: missing/corrupt journal, changed library doc,
      // external Deploy or stopped/failed runtime retain the guarded load.
      // G0/G1 REJECT/UNREADABLE checks above must always run first.
      if (status.state === "running" && evaluation.decision === "SAFE"
        && previousLoad.ok && currentCanvas === next
        && currentTab === journalTab) {
        return { ok: true, unchanged: true };
      }
      // Only the preflight decides whether an acknowledgment is needed: whenever
      // the migrator reports lossy/human items it returns HUMAN, so duplicating
      // that test here would be a second, drift-prone authority. The loss list
      // below is still attached to whatever confirmation is asked for.
      const canvasNeedsConfirmation = canvasDiffers || status.state === "running" || status.state === "failed";
      if ((canvasNeedsConfirmation || evaluation.decision === "HUMAN") && !confirmReplace) {
        const migrationPart = evaluation.decision === "HUMAN"
          ? `\n\n迁移预检要求人工确认：\n${reasonLines(evaluation)}`
          : "";
        // T27: the concrete loss list, not just the preflight's summary code — the
        // user must see which parameters stay Host-side instead of being refused.
        const lossPart = knownLoss.length > 0
          ? `\n\n以下内容不会由 Node-RED 原生表达（原值保留在节点的 x-mcode.params，由 Mcode 宿主侧承担）：\n${knownLoss.join("\n")}`
          : "";
        const divergencePart = canvasDivergedFromLastLoad
          ? "\n注意：当前画布与 Mcode 上次为这张图装载的内容不一致 —— 可能是在原生编辑器里改过，或上次装载没有完成。"
          : "";
        return {
          ok: false,
          requiresConfirmation: true,
          reason: "装载会更新当前工作流对应的 Node-RED tab，并重启运行中的引擎；其他 tab 会保留。尚未 Deploy 的编辑无法从磁盘恢复；请先在原生编辑器部署或另存。旧的已部署 flows.json 将保留内容寻址备份。确定继续？"
            + divergencePart + migrationPart + lossPart,
        };
      }

      // ── T21 ② 装载记录（写前记账）：先落 CAS 记录，再动画布。 ──
      // 另一个进程在同一文档上抢先写入 → conflict，本进程在碰画布之前就退出。
      const journalSaved = await journal.saveFlow(JOURNAL_PROJECT_ID, doc.id, importedFlow, {
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
      // The journal was written before stopping; restore it on ANY failure
      // (stop, install, launch spec, concurrent native Deploy, or child boot).
      // Previously a pre-start failure silently left a stale "loaded" journal.
      let written: Awaited<ReturnType<typeof replaceNativeCanvas>> | null = null;
      try {
        if (status.state === "running" || status.state === "failed") {
          const stopped = await ports.runtime.stop();
          if (stopped.state !== "stopped") throw new Error("无法安全停止旧 Node-RED 引擎");
        }
        await ports.beforeStart();
        const spec = ports.launchSpec();
        if (!spec) throw new Error("Node-RED 启动参数不可用，已拒绝写入画布");
        written = await replaceNativeCanvas(dataDir, nodes, { expectedCanvas: before });
        const started = await ports.runtime.start({
          engineId: "node-red", dataDir: spec.dataDir, command: spec.command, args: spec.args,
          ...(spec.env ? { env: spec.env } : {}),
          ...(spec.probeIdentity ? { probeIdentity: spec.probeIdentity } : {}),
        });
        if (started.state !== "running") throw new Error(started.reason ?? "Node-RED 启动失败");
        return { ok: true };
      } catch (err) {
        // Only restore if no other actor replaced our exact bytes.
        if (written?.changed) await written.rollback();
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
