import type { NodeTypeManifest } from "@contracts/nodeType";
/**
 * A saved workflow is not automatically an approved executable workflow.
 *
 * Imports and agent-authored saves are untrusted until the user reviews the
 * exact persisted revision. The approval is stored OUTSIDE WorkflowDoc: JSON
 * supplied by an importer must never be able to approve itself. No setting
 * means a pre-existing/local workflow, which keeps its historical behavior.
 */
import { createHash } from "node:crypto";
import type { WorkflowDoc, WorkflowReviewInfo } from "@contracts/workflow";
import { SettingRepo } from "@main/store/repositories.js";
import { parseFlowTrust, type FlowTrustRecord } from "@main/workflowEngines/flowTrustGate.js";

/**
 * 这份图是**怎么来的** —— 决定审查账本里记的理由。
 *
 * - `import` —— 从文件 / 预设导入；
 * - `ai` —— AI 生成或改过；
 * - `duplicate` —— 用户复制了另一份（**副本也是新的可执行文档**：
 *   原图审过不代表副本审过，而且副本随时可能被改得和原件不同）。
 */
export type WorkflowOrigin = "import" | "ai" | "duplicate";

const REVIEW_PREFIX = "workflow.review.v1.";
/** Node-RED and the legacy execution runner share ONE approval parser, so
 * a malformed record can never be executable through only one engine. */
type ReviewRecord = FlowTrustRecord;

/** JSON with sorted object keys, so irrelevant property insertion order cannot
 * turn a reviewed document into a different revision. Array order IS relevant:
 * the first trigger and graph edge order can affect execution. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(fields)
        .sort()
        .filter((key) => fields[key] !== undefined)
        .map((key) => [key, canonical(fields[key])]),
    );
  }
  return value;
}

/** A content revision, NOT WorkflowDoc.schemaVersion (the import format).
 * updatedAt, icon and canvas coordinates cannot alter an execution. Everything
 * else, including prompts, node parameters, capabilities and edges, is pinned. */
export function workflowRevision(doc: WorkflowDoc): string {
  const execution = {
    ...doc,
    updatedAt: undefined,
    icon: undefined,
    nodes: doc.nodes.map((node) => ({ ...node, position: undefined })),
  };
  return createHash("sha256").update(JSON.stringify(canonical(execution))).digest("hex");
}

function recordOf(id: string): ReviewRecord | null {
  const raw = SettingRepo.get(`${REVIEW_PREFIX}${id}`);
  if (raw === null || raw === "") return null;
  const parsed = parseFlowTrust(raw);
  // An explicit but corrupt marker is NOT an absent (legacy local) marker.
  // Keep it pending without laundering invalid reviewedAt or giant JSON into
  // a valid approvedRevision. Both native/legacy runners use this same rule.
  if (!parsed.ok) return { origin: "import", approvedRevision: null };
  return parsed.record;
}

/** Call BEFORE saving the new document. A crash between the two writes leaves
 * the previous revision disabled, never a new executable doc without a marker. */
export function requireWorkflowReview(id: string, origin: WorkflowOrigin): void {
  SettingRepo.set(`${REVIEW_PREFIX}${id}`, JSON.stringify({ origin, approvedRevision: null }));
  notifyReviewChanged();
}

export function clearWorkflowReview(id: string): void {
  // SettingRepo has no delete; an empty marker has the same meaning as absent.
  SettingRepo.set(`${REVIEW_PREFIX}${id}`, "");
  notifyReviewChanged();
}

/* ── 审批状态变化的广播口（【Q8】引擎信任标记的触发点） ──
 *
 * **为什么是广播而不是每个写路径各调一次**：审批账本有四个写入口（保存、
 * 审批、恢复默认、出厂更新），而引擎信任标记的判据是"库里全部图都通过"——
 * 它依赖的是**整个账本**，不是刚写的那一条。逐个调用点伸手去算，等于把同一条
 * 判据抄四份，漏一处就出现"批准了但引擎仍 safeMode"或更糟的"撤回了但仍 trust"。
 *
 * 监听器由装配层注册（见 `ipc/orchestration.ts`），本模块不 import 任何
 * workflowEngines / dataRoot —— 那是纯逻辑层不该有的依赖。
 */
type ReviewChangeListener = () => void;
let reviewChangeListener: ReviewChangeListener | null = null;

/** 装配审批变化监听（幂等；生产只注册一次）。传 null 解除。 */
export function setWorkflowReviewChangeListener(listener: ReviewChangeListener | null): void {
  reviewChangeListener = listener;
}

/** 审批账本变了。**失败不能让调用方的保存失败** —— 保存已经落盘，
 *  信任标记只是它的下游；把异常吞掉并留给监听器自己记日志。 */
function notifyReviewChanged(): void {
  try {
    reviewChangeListener?.();
  } catch {
    /* 监听器内部已记日志；账本写入成功不该因下游失败而回滚 */
  }
}

/**
 * **账本没变、但"哪些图归 Node-RED"变了**时主动重算。
 *
 * 用于引擎切换（`saveWorkflow` 的 `checkEngineSwitch` 分支）：新文档是 mcode 图，
 * 不写审批账本，所以 `requireWorkflowReview` 那条广播不会触发 —— 可信任判据里的
 * 集合已经变了（少了一份 node-red 图），标记必须跟着重算。
 */
export function notifyWorkflowReviewFactsChanged(): void {
  notifyReviewChanged();
}

export function workflowReviewOf(doc: WorkflowDoc): WorkflowReviewInfo | null {
  const record = recordOf(doc.id);
  if (record === null) return null;
  const revision = workflowRevision(doc);
  return {
    origin: record.origin,
    revision,
    pending: record.approvedRevision !== revision,
    ...(record.reviewedAt === undefined ? {} : { reviewedAt: record.reviewedAt }),
  };
}

/** Host-only operation: the caller must obtain the document from storage, not
 * from the approval request. The supplied revision prevents approving a newer
 * agent save while the user is still looking at an older version in the UI. */
export function approveWorkflowRevision(
  doc: WorkflowDoc,
  expectedRevision: string,
): { ok: true; review: WorkflowReviewInfo } | { ok: false; error: string } {
  const key = `${REVIEW_PREFIX}${doc.id}`;
  const raw = SettingRepo.get(key);
  if (raw === null || raw === "") {
    return { ok: false, error: "这份工作流没有待审查的外来版本" };
  }
  // Interpret precisely the SAME snapshot displayed by this approval action.
  // Reading again through recordOf could observe a concurrent corrupt marker,
  // treat it as pending and accidentally overwrite it as approved.
  const parsed = parseFlowTrust(raw);
  if (!parsed.ok) {
    return { ok: false, error: "工作流审批记录损坏或超出大小限制；请先修复审批账本，再重新申请审查" };
  }
  const record = parsed.record;
  const revision = workflowRevision(doc);
  if (revision !== expectedRevision) {
    return { ok: false, error: "审查期间工作流已更新，请重新打开并检查最新版本" };
  }
  // Condition and mutation are ONE SQLite statement on the Host's canonical
  // in-memory DB. A second writer in this process cannot alter the marker
  // between a separate check and write; never upgrade corrupted raw to consent.
  const reviewedAt = Date.now();
  if (!SettingRepo.compareAndSet(
    key,
    raw,
    JSON.stringify({ origin: record.origin, approvedRevision: revision, reviewedAt }),
  )) {
    return { ok: false, error: "审查期间审批账本已改变，请重新打开并检查最新审批状态" };
  }
  notifyReviewChanged();
  return { ok: true, review: { origin: record.origin, revision, pending: false, reviewedAt } };
}

export function workflowReviewError(doc: WorkflowDoc): string | null {
  if (!workflowReviewOf(doc)?.pending) return null;
  return `工作流「${doc.name}」来自导入或 AI 修改，当前版本尚未审查；请到设置 → 工作流/自动化检查内容并明确启用`;
}

/** A run's settled nodes and branch choices belong to ONE graph revision.
 * Missing revisions are readable history, not permission to continue an old
 * snapshot against the current graph. This applies to both retry and choice,
 * including a choice still waiting in memory when the graph is edited. */
export function workflowResumeError(doc: WorkflowDoc, savedRevision: string | undefined): string | null {
  const reviewError = workflowReviewError(doc);
  if (reviewError !== null) return reviewError;
  if (savedRevision === undefined) {
    return "旧版运行没有记录工作流图版本，无法安全续跑或重试；请重新发送消息启动新运行";
  }
  if (savedRevision !== workflowRevision(doc)) {
    return `工作流「${doc.name}」在运行后已修改，旧运行状态不适用于当前图；请重新发送消息启动新运行`;
  }
  return null;
}

/** Interrupted external effects are not safely retryable: the command or
 * model may have written a file just before the process died, without getting
 * to record an outcome. Refuse automatic continuation; leave the old record
 * readable so the user can inspect it and start a fresh run deliberately. */
export function workflowReplayError(
  doc: WorkflowDoc,
  inFlightNodeIds: readonly string[] | undefined,
  manifests?: ReadonlyMap<string, Pick<NodeTypeManifest, "runner">>,
): string | null {
  if (inFlightNodeIds === undefined) {
    return "旧版运行未记录中断时正在执行的节点，可能重复命令或写入；请检查结果后重新发起运行";
  }
  // 报给用户的是节点的**标题**(退回 id),不是它在存档里的内部 id —— 与同仓每一条
  // 点名节点的消息同一条规矩(`library.ts` 的 `where`、`workflowValidation` 的 `labelOf`、
  // `runner.ts` 的 `displayTitle`)。用户在图上是按标题认节点的:画一张带「训练脚本」
  // 的图,报出的是「n_l8x2k_ab12」等于什么都没说,只能照着 id 去图上一个个找。
  const risky = inFlightNodeIds.flatMap((id): string[] => {
    const node = doc.nodes.find((entry) => entry.id === id);
    // 图上找不到这个节点(存档比图旧,或 id 对不上):没有标题可显示,只能退回原 id,
    // 且**失败关闭**(当成可能有副作用)。
    if (!node) return [id];
    // With a runtime catalog, missing types fail closed. The fallback is only
    // for callers without a catalog and recognizes reserved pure builtins.
    const kind = manifests ? manifests.get(node.type)?.runner.kind
      : ({ "mcode.branch": "branch", "mcode.trigger": "trigger", "mcode.condition": "condition" } as Record<string, string>)[node.type];
    // 分支、触发器、条件不跑外部代码 —— 不算危险节点。
    return kind === "branch" || kind === "trigger" || kind === "condition"
      ? [] : [node.title || node.id];
  });
  // 标题可能重名(用户给两个节点起同一个名字),去重后仍保留出现顺序。
  const named = [...new Set(risky)];
  if (named.length > 0) {
    return `旧运行中「${named.join("、")}」被中断时可能已产生文件、命令或网络副作用；为避免自动重放，请先核对结果，再重新发起运行`;
  }
  return null;
}
