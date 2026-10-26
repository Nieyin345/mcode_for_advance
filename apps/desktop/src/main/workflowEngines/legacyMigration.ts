/**
 * 【Q6 / 批次 3】**旧图一次性迁移到 Node-RED。**
 *
 * ## 用户的决定
 *
 * 「之前的工作流不要了，但是功能要保留，转移到 node red 里面」。这是**方向**，
 * 而本模块把它落成一次可复现、可报告的迁移动作：库里所有 `engine=mcode` 的图，
 * 按已有判据逐张判定能不能迁，能迁的就迁，不能迁的**如实报出来**。
 *
 * ## 判据一条都不新写
 *
 * SAFE / HUMAN / REJECT 全部来自 `evaluateWorkflowMigration`（T85 的只读预检，
 * 34 条断言）与 `checkEngineSwitch`（保存路径上一直在用的那条）。本模块只做两件
 * 事：**逐张跑一遍**，以及**把结果聚合成人话**。
 *
 * 为什么不能各写一份判据：迁移的"安全"含义（哪些 lossy 可接受、哪些必须人工裁决）
 * 已经有唯一答案；这里再写一遍，就会出现"保存时能过、迁移时过不了"这种漂移。
 *
 * ## 三类图，三种处置
 *
 * | 判定 | 处置 | 理由 |
 * |---|---|---|
 * | SAFE | **自动迁**（写 `engine: "node-red"` + 走同一条 `saveWorkflow`） | 判据说它无损 |
 * | HUMAN | **不迁**，报给用户 | 有需要人拍板的地方（会话绑定、非零退出语义…），替用户决定等于绕过他 |
 * | REJECT / UNREADABLE | **不迁**，报给用户 | 连无损表示都做不到 |
 *
 * 迁移**不会删除**旧图：`engine` 改成 `node-red` 之后它仍然在库里、能打开、能编辑。
 * 真正的"删"是批次 3 后面移除 `engine=mcode` 执行路径 —— 那时留在 mcode 上的图
 * 会明确报错，而不是静默不跑。
 */
import type { NodeTypeManifest } from "@contracts/nodeType";
import type { WorkflowDoc } from "@contracts/workflow";
import { log } from "@main/lib/logger.js";

/** 迁移一张图的判定结果。 */
export type MigrationDecision = "migrated" | "needs-human" | "rejected" | "unreadable" | "already-native";

export interface MigrationOutcome {
  workflowId: string;
  name: string;
  decision: MigrationDecision;
  /** 人话原因（成功时为空）。 */
  reason: string | null;
}

export interface MigrationReport {
  outcomes: MigrationOutcome[];
  migrated: number;
  needsHuman: number;
  rejected: number;
}

/** 迁移需要的宿主能力 —— 注入以便无头验证判据。 */
export interface LegacyMigrationPorts {
  /** 库里全部 `engine=mcode` 且**有节点**的图（纯提示词型没有图，不需要迁）。 */
  legacyGraphs(): ReadonlyArray<WorkflowDoc>;
  /** 节点类型清单（迁移器要它把 `mcode.agent` 之类翻成原生 type）。 */
  types(): Promise<ReadonlyMap<string, NodeTypeManifest>>;
  /** 走与保存**同一条**路径落盘（CAS、审批记录、广播都跟着走）。 */
  save(doc: WorkflowDoc): Promise<{ ok: boolean; error?: string }>;
  /** 只读判定 —— 不落盘。 */
  evaluate(doc: WorkflowDoc, types: ReadonlyMap<string, NodeTypeManifest>): {
    decision: "SAFE" | "HUMAN" | "REJECT" | "UNREADABLE";
    summary: string;
  };
}

/**
 * 跑一次批量迁移。**幂等**：已经是 node-red 的图不在输入里，重复调用不会重复迁。
 *
 * 任何一张图出错都**不中断**其余的 —— 一次迁移卡在一张坏图上，会让其余几十张
 * 永远迁不了。每张的结局都进报告。
 */
export async function migrateLegacyWorkflows(ports: LegacyMigrationPorts): Promise<MigrationReport> {
  const outcomes: MigrationOutcome[] = [];
  const graphs = ports.legacyGraphs();
  if (graphs.length === 0) return { outcomes, migrated: 0, needsHuman: 0, rejected: 0 };

  const types = await ports.types();
  for (const doc of graphs) {
    try {
      const verdict = ports.evaluate(doc, types);
      if (verdict.decision !== "SAFE") {
        outcomes.push({
          workflowId: doc.id,
          name: doc.name,
          decision: verdict.decision === "HUMAN" ? "needs-human"
            : verdict.decision === "UNREADABLE" ? "unreadable" : "rejected",
          reason: verdict.summary,
        });
        continue;
      }
      const saved = await ports.save({ ...doc, engine: "node-red" });
      if (!saved.ok) {
        // 保存被拒（CAS 冲突 / 校验失败）：这不是"不能迁"，是"这次没写成"。
        // 如实归到 needs-human，让用户/下一次启动重试，而不是宣称迁完了。
        outcomes.push({
          workflowId: doc.id, name: doc.name, decision: "needs-human",
          reason: saved.error ?? "保存被拒绝",
        });
        continue;
      }
      outcomes.push({ workflowId: doc.id, name: doc.name, decision: "migrated", reason: null });
    } catch (err) {
      outcomes.push({
        workflowId: doc.id, name: doc.name, decision: "unreadable",
        reason: `迁移过程出错：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const report: MigrationReport = {
    outcomes,
    migrated: outcomes.filter((o) => o.decision === "migrated").length,
    needsHuman: outcomes.filter((o) => o.decision === "needs-human").length,
    rejected: outcomes.filter((o) => o.decision === "rejected" || o.decision === "unreadable").length,
  };
  if (report.outcomes.length > 0) {
    log.info(
      `[workflow-migration] 旧图迁移：迁成 ${report.migrated}，待人工 ${report.needsHuman}，拒绝 ${report.rejected}`,
    );
  }
  return report;
}

/**
 * 把报告变成一句人说得出的话。
 *
 * **必须区分"迁完了"和"有几张没迁"** —— 只说"迁移完成 12 张"会让用户以为全迁了，
 * 而那 3 张留在旧引擎上的图，正是他之后会发现"这张怎么不跑"的那几张。
 */
export function describeMigrationReport(report: MigrationReport): string {
  if (report.outcomes.length === 0) return "没有需要迁移的旧工作流。";
  const parts = [`已迁移 ${report.migrated} 张到 Node-RED`];
  if (report.needsHuman > 0) parts.push(`${report.needsHuman} 张需要你确认后才能迁移`);
  if (report.rejected > 0) parts.push(`${report.rejected} 张无法自动迁移`);
  const tail = report.migrated < report.outcomes.length
    ? "未迁移的图仍能在库里打开，但不会在 Node-RED 上执行。"
    : "";
  return parts.join("，") + "。" + tail;
}

/**
 * 【Q5】上次迁移的结果落进设置，供界面读取。
 *
 * ## 为什么必须持久化，而不是「启动时广播一下就完了」
 *
 * 迁移发生在**窗口还没开**的时候（`main/index.ts` 的启动序列）。那一刻广播没有
 * 听众 —— 渲染端连都还没起来。等用户打开工作流面板，那条广播早已消散。
 *
 * 而用户最需要知道这件事的时机恰恰是**事后**：他翻了半天找不到某张图能跑，
 * 打开面板时才看到「有 3 张没迁」。所以写进设置、由面板启动时读一次。
 *
 * 只留**未迁移**的那些条目：迁成功的图已经在 Node-RED 上了，用户看列表就知道；
 * 留着只会让这条提示一年都在。全迁完时清空这条设置。
 */
export const MIGRATION_REPORT_SETTING_KEY = "workflow.legacyMigration.lastReport";

/** 界面上那条提示要的东西 —— 只含**没迁成功**的。 */
export interface PendingMigrationNotice {
  /** 人话汇总（`describeMigrationReport` 的同一份口径）。 */
  summary: string;
  /** 逐条：哪张图、为什么没迁。 */
  pending: Array<{ workflowId: string; name: string; reason: string }>;
  at: number;
}

export function pendingMigrationNoticeOf(report: MigrationReport): PendingMigrationNotice | null {
  const pending = report.outcomes
    .filter((o) => o.decision !== "migrated")
    .map((o) => ({ workflowId: o.workflowId, name: o.name, reason: o.reason ?? "未知原因" }));
  if (pending.length === 0) return null;
  return { summary: describeMigrationReport(report), pending, at: Date.now() };
}
