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

export type WorkflowOrigin = "import" | "ai";

const REVIEW_PREFIX = "workflow.review.v1.";
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface ReviewRecord {
  origin: WorkflowOrigin;
  approvedRevision: string | null;
  reviewedAt?: number;
}

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
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null) {
      const entry = value as Record<string, unknown>;
      if (entry.origin === "import" || entry.origin === "ai") {
        return {
          origin: entry.origin,
          approvedRevision:
            typeof entry.approvedRevision === "string" && SHA256_HEX.test(entry.approvedRevision)
              ? entry.approvedRevision
              : null,
          ...(typeof entry.reviewedAt === "number" && Number.isFinite(entry.reviewedAt)
            ? { reviewedAt: entry.reviewedAt }
            : {}),
        };
      }
    }
  } catch {
    // A malformed marker is never interpreted as consent.
  }
  return { origin: "import", approvedRevision: null };
}

/** Call BEFORE saving the new document. A crash between the two writes leaves
 * the previous revision disabled, never a new executable doc without a marker. */
export function requireWorkflowReview(id: string, origin: WorkflowOrigin): void {
  SettingRepo.set(`${REVIEW_PREFIX}${id}`, JSON.stringify({ origin, approvedRevision: null }));
}

export function clearWorkflowReview(id: string): void {
  // SettingRepo has no delete; an empty marker has the same meaning as absent.
  SettingRepo.set(`${REVIEW_PREFIX}${id}`, "");
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
  const record = recordOf(doc.id);
  if (record === null) return { ok: false, error: "这份工作流没有待审查的外来版本" };
  const revision = workflowRevision(doc);
  if (revision !== expectedRevision) {
    return { ok: false, error: "审查期间工作流已更新，请重新打开并检查最新版本" };
  }
  const reviewedAt = Date.now();
  SettingRepo.set(
    `${REVIEW_PREFIX}${doc.id}`,
    JSON.stringify({ origin: record.origin, approvedRevision: revision, reviewedAt }),
  );
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
  const risky = inFlightNodeIds.filter((id) => {
    const node = doc.nodes.find((entry) => entry.id === id);
    // Branch and trigger nodes don't run external code. All other nodes,
    // including missing/third-party types and model agents, may have effects.
    if (!node) return true;
    // With a runtime catalog, missing types fail closed. The fallback is only
    // for callers without a catalog and recognizes reserved pure builtins.
    const kind = manifests ? manifests.get(node.type)?.runner.kind
      : ({ "mcode.branch": "branch", "mcode.trigger": "trigger", "mcode.condition": "condition" } as Record<string, string>)[node.type];
    return kind !== "branch" && kind !== "trigger" && kind !== "condition";
  });
  if (risky.length > 0) {
    return `旧运行中「${risky.join("、")}」被中断时可能已产生文件、命令或网络副作用；为避免自动重放，请先核对结果，再重新发起运行`;
  }
  return null;
}
