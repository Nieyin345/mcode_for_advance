/**
 * T8 夹具 —— 一张 `engine=node-red` 的 SQL 图（含触发器 + 两个 agent 步骤），
 * 以及它的迁移器产物（编辑器「导入」用的原生节点数组）。
 *
 * ## 为什么触发器是 `manual`
 *
 * 保存闸门（`validateWorkflowDoc` + `deriveTrigger`）要求：**普通图必须有
 * `mcode.main`**、**自动化必须有触发器节点**。而 `mcode.main` / `mcode-conversation`
 * 在迁移器里必报 `needs-human-decision`，`mcode.agent` 带产出契约必报 lossy ——
 * 任何**可保存**的图都过不了 T59 装载闸门（本套件把这条记为事实证据）。本夹具选
 * 「自动化 + manual 触发器」这一支，是为了让 SQL 行真实存在、T3 的引擎归属门禁
 * 有东西可判（`engine=node-red` 的触发器**不该**由旧 runner 安装）。
 */
import type { WorkflowDoc } from "@contracts/workflow";
import type { NodeTypeManifest } from "@contracts/nodeType";
import { migrateWorkflowDoc } from "@main/workflowEngines/flowMigration.js";

/** 工作流 id（SQL 行、触发器事实表、对账账本都用它）。 */
export const FIXTURE_WORKFLOW_ID = "wf_t8_nodered_fixture";

/** agent 节点的唯一入参 —— 改造前后用它对照。 */
export const FIXTURE_INSTRUCTION = "T8 夹具：检查工作区里的 README.md，并给出一句结论。";

/** 夹具图的 SQL 行（`trigger` 必须显式声明：保存闸门靠它区分自动化/普通图）。 */
export function fixtureDoc(projectId: string): WorkflowDoc {
  return {
    id: FIXTURE_WORKFLOW_ID,
    engine: "node-red",
    name: "T8 Node-RED 夹具自动化",
    builtin: false,
    trigger: "manual",
    updatedAt: 1_700_000_000_000,
    nodes: [
      {
        id: "n_t8_trigger",
        type: "mcode.trigger",
        title: "入口",
        params: { triggerKind: "manual", task: "运行 T8 夹具", project: projectId },
        position: { x: 100, y: 100 },
      },
      {
        id: "n_t8_agent",
        type: "mcode.agent",
        title: "检查 README",
        params: { instruction: FIXTURE_INSTRUCTION },
        // 整数坐标：迁移器的浮点舍入本身报 lossy，夹具不应触发它（那是另一条判据）。
        position: { x: 320, y: 100 },
      },
      {
        id: "n_t8_second",
        type: "mcode.agent",
        title: "汇总",
        params: { instruction: "把上一步的结论压成一句话。" },
        position: { x: 540, y: 100 },
      },
    ],
    edges: [
      { id: "e_t8_1", from: "n_t8_trigger", to: "n_t8_agent" },
      { id: "e_t8_2", from: "n_t8_agent", to: "n_t8_second" },
    ],
  };
}

/** 夹具图的原生节点数组（迁移器产物；编辑器「导入」直接吃这一份）。 */
export function fixtureNativeNodes(types: ReadonlyMap<string, NodeTypeManifest>): unknown[] {
  const migrated = migrateWorkflowDoc(fixtureDoc("proj_t8_fixture"), { types });
  return JSON.parse(JSON.stringify(migrated.flow.nodes)) as unknown[];
}

/** 迁移报告摘要（证据里记录：本夹具在迁移器眼里有哪些损失/裁决项）。 */
export function fixtureMigrationReport(types: ReadonlyMap<string, NodeTypeManifest>): {
  mapped: number;
  unmapped: number;
  needsHumanDecision: number;
  lossy: Array<{ nodeId?: string; message: string }>;
} {
  const migrated = migrateWorkflowDoc(fixtureDoc("proj_t8_fixture"), { types });
  return {
    mapped: migrated.report.mapped.length,
    unmapped: migrated.report.unmapped.length,
    needsHumanDecision: migrated.report.needsHumanDecision.length,
    lossy: migrated.report.lossy.map((item) => ({
      ...(item.nodeId !== undefined ? { nodeId: item.nodeId } : {}),
      message: item.message,
    })),
  };
}

/** 夹具的原生 type（编辑器画布与 flows.json 里看到的那个）。 */
export const NATIVE_AGENT_TYPE = "mcode-agent";
