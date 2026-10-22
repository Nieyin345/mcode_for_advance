/**
 * 【T21】**迁移预检的宿主事实投影 + 生产调用胶水**（纯逻辑，不读盘、不碰 DB）。
 *
 * ## 这个模块补的是哪一段
 *
 * `workflowMigrationPreflight.ts` 是 T85 交付的只读 G0/G1 预检：输入隔离目录里的
 * 导出副本 + 运行时事实，逐行给出 `SAFE / HUMAN / REJECT / UNREADABLE`。它刻意
 * **不** import `SettingRepo` / `workflowTrust` / `dataRoot`（审批与在途事实必须由
 * 调用方以 `runtimeFacts` 传入），也要求 `isolationRoot` 是带隔离标记的目录。
 * 于是生产装配层没有任何地方调用它 —— T21 的出发事实。
 *
 * 本模块是那个缺失的调用方：把宿主已经拿到的 WorkflowDoc（内存快照）、审批信息与
 * 在途事实，投影成预检能读的输入，在临时隔离目录里跑一次**完整的**
 * `runWorkflowMigrationPreflight`，返回该文档的判定。
 *
 * ## 判据一条都不复制
 *
 * SAFE/HUMAN/REJECT 全部由 `runWorkflowMigrationPreflight` 给出。这里只做机械投影：
 *
 *   - 文档投影（{@link libraryDocumentForPreflight}）：删掉派生的 `engine` 标记，
 *     其余原样；
 *   - 审批投影（{@link reviewFactsForLoad}）：见下表；
 *   - 在途投影：调用方给的是执行归属账本的**运行租约**集合；`undefined` = 没有可信
 *     快照（预检按 unknown → HUMAN 处理，fail-closed），空集 = 查过、确认没在跑。
 *
 * ## 审批投影为什么"批准了也只能说 unknown"
 *
 * 预检的 approval 判据要求 `approvedRevision` **严格等于**它对输入文档现算的
 * revision（`workflowMigrationPreflight.ts` 内部 `workflowRevision`：剪掉
 * updatedAt/icon/positions）。而 SQL 侧的 `workflowTrust.workflowRevision` 是**另一个
 * 形状**上的哈希（它保留 `engine` 字段，而装载投影必须删掉 `engine` 才能让预检按
 * "一张图"而非"已归原生的图"来判，见 {@link libraryDocumentForPreflight}）。
 * 两个哈希**不可能相等** —— 硬塞进去会让**每一份已批准的工作流**都被判
 * `approval-revision-mismatch` 而 REJECT。`flowTrustGate.ts` 的文件头讲的就是这条：
 * 不同形状的 revision 之间不做换算，只做严格相等；喂不可比的哈希是范畴错误。
 *
 * 所以投影是：没有记录 → `not-required`（与 `workflowReviewOf` 的既有语义一致：
 * 没有标记 = 本地既有工作流）；待审 → `pending`；已批准 → `unknown`（**如实**：预检
 * 拿不到可比对的审批快照）。`pending` 与 `unknown` 都只会升级成 HUMAN（要求人工
 * 确认），**不会被放宽成 SAFE**；`REJECT` 永远来自预检自己。
 *
 * ## 为什么落在临时目录
 *
 * 预检不写任何东西（T85 的套件断言源字节不变、不新增文件）。生产调用方给一个
 * `mkdtemp` 出来的目录、把内存里的文档以 `content` 形式传入，跑完即删 —— 不读用户
 * 数据根，也不把真实工作流写到盘上。判的是**用户此刻要装载的那一版**，不是某份可能
 * 过期的导出副本。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeTypeManifest } from "@contracts/nodeType";
import type { WorkflowDoc, WorkflowReviewInfo } from "@contracts/workflow";
import {
  runWorkflowMigrationPreflight,
  WORKFLOW_PREFLIGHT_ISOLATION_MARKER,
  WORKFLOW_PREFLIGHT_ISOLATION_MARKER_CONTENT,
  type WorkflowMigrationPreflightRow,
  type WorkflowPreflightDecision,
  type WorkflowPreflightRuntimeFacts,
} from "./workflowMigrationPreflight.js";

/** 预检行的稳定标识：生产装配只有一条来源（宿主库里那一份文档）。 */
export const LIBRARY_DOCUMENT_SOURCE_ID = "library-document";

/** 宿主侧已知的事实。 */
export interface WorkflowMigrationHostFacts {
  /** `workflowReviewOf(doc)` 的结果；`null` = 没有审批记录。 */
  review: WorkflowReviewInfo | null;
  /** 执行归属账本里此刻正在跑的 flowId 集合；`undefined` = 未取得快照。 */
  inFlightWorkflowIds: ReadonlySet<string> | undefined;
}

/** 审批记录 → 预检 review 态（理由见文件头的"范畴错误"一段）。 */
export function reviewFactsForLoad(review: WorkflowReviewInfo | null): WorkflowPreflightRuntimeFacts["review"] {
  if (review === null) return { state: "not-required" };
  if (review.pending) return { state: "pending" };
  return { state: "unknown" };
}

/** 宿主事实 → 预检的 `runtimeFacts`（纯函数）。 */
export function workflowPreflightFacts(
  workflowId: string,
  facts: WorkflowMigrationHostFacts,
): WorkflowPreflightRuntimeFacts {
  const inFlight = facts.inFlightWorkflowIds === undefined
    ? { state: "unknown" as const }
    : facts.inFlightWorkflowIds.has(workflowId)
      ? { state: "active" as const, activeCount: 1 }
      : { state: "none" as const };
  return {
    review: reviewFactsForLoad(facts.review),
    inFlight,
    // 装载本来就不携带运行史；这一维在装载场景明确为 not-applicable，而不是
    // 冒充"已验证有历史"或白白升成 HUMAN（原生运行史是另一张卡，见 T14 §7.5）。
    runboardHistory: "not-applicable",
  };
}

/**
 * 把一份 WorkflowDoc 投影成预检的**送检形状**：删掉派生的 `engine` 标记，其余原样。
 *
 * 为什么必须删：预检对 `engine === "node-red"` 的文档直接 REJECT
 * （`workflow-already-node-red-owned`，语义是"它已归原生，不该按旧图迁"）。装载入口
 * 恰好只接受 `engine === "node-red"` 的文档 —— 不投影就 100% REJECT，那是判据用错了
 * 对象。装载问的是"**这张图**迁到原生会不会丢东西"，不是"它属于哪个引擎"。
 * `engine` 在库里恒等于 `effectiveWorkflowEngine`（派生值，不是用户内容）。
 *
 * 其余键**一个都不放松**：未知字段保留（预检据此判 HUMAN）、`params` 里的危险键
 * 保留（预检据此判 REJECT）、节点/边原样参与 round-trip。
 */
export function libraryDocumentForPreflight(doc: WorkflowDoc): Record<string, unknown> {
  const view = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  delete view["engine"];
  return view;
}

export interface WorkflowMigrationEvaluation {
  decision: WorkflowPreflightDecision;
  /** 该行的全部原因（预检已去重、按 code 排序）。 */
  reasons: WorkflowMigrationPreflightRow["reasons"];
  /** `unmapped-mcode-node-type` 时缺失的类型清单（拒绝消息要点名）。 */
  unknownMcodeNodeTypes: string[];
  /** 给人看的一句总述。 */
  summary: string;
  /** 预检清单哈希（诊断/回写用）。 */
  manifestHash: string;
}

/**
 * 对**当前这一版**文档跑一次完整的迁移预检。失败关闭：任何无法判定都抛错，
 * 绝不默认 SAFE。
 */
export function evaluateWorkflowMigration(input: {
  doc: WorkflowDoc;
  types: ReadonlyMap<string, NodeTypeManifest>;
  facts: WorkflowMigrationHostFacts;
}): WorkflowMigrationEvaluation {
  const root = mkdtempSync(join(tmpdir(), "mcode-workflow-gate-"));
  try {
    writeFileSync(join(root, WORKFLOW_PREFLIGHT_ISOLATION_MARKER), WORKFLOW_PREFLIGHT_ISOLATION_MARKER_CONTENT, "utf8");
    const report = runWorkflowMigrationPreflight({
      isolationRoot: root,
      // 生产读的是 Host 库里的真实文档；传进预检的是内存快照，预检只读不写，
      // 隔离根只为通过它的路径围栏而存在。
      authorization: { kind: "authorized-export-copy", isolatedReadOnlyCopy: true },
      sources: [{
        sourceId: LIBRARY_DOCUMENT_SOURCE_ID,
        kind: "workflow-doc",
        direction: "mcode-to-node-red",
        content: libraryDocumentForPreflight(input.doc),
        runtimeFacts: workflowPreflightFacts(input.doc.id, input.facts),
      }],
      types: input.types,
    });
    const row = report.rows.find((candidate) => candidate.sourceId === LIBRARY_DOCUMENT_SOURCE_ID);
    if (row === undefined) throw new Error("迁移预检没有产出该文档的行（内部不变量失败）");
    return {
      decision: row.decision,
      reasons: row.reasons,
      unknownMcodeNodeTypes: [...row.unknownDependencies.unknownMcodeNodeTypes],
      summary: summarize(row),
      manifestHash: report.manifestHash,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function summarize(row: WorkflowMigrationPreflightRow): string {
  const first = row.reasons[0];
  const where = row.docId === null ? "该工作流" : `工作流「${row.docId}」`;
  switch (row.decision) {
    case "SAFE":
      return `${where}通过迁移预检（SAFE）`;
    case "HUMAN":
      return first === undefined ? `${where}需要人工确认后才能迁移`
        : `${where}需要人工确认：${first.summary}（${first.code}）`;
    case "REJECT":
      return first === undefined ? `${where}不能迁移到 Node-RED`
        : `${where}不能迁移到 Node-RED：${first.summary}（${first.code}；最小修复：${first.minimumFix}）`;
    case "UNREADABLE":
      return first === undefined ? `${where}无法读取，不能判定能否迁移`
        : `${where}无法读取：${first.summary}（${first.code}）`;
  }
}
