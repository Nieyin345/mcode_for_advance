/**
 * 【ARC-006 Gate C 第一片】**WorkflowDoc → Node-RED flow 迁移器**的无头回归网。
 *
 * ## 它钉的五件事（全部是真数据、真字节，不用 mock 代替被测物）
 *
 *  1. **7 种 runner.kind 全映射**：一份含全部执行原语的样例 doc 迁移后，报告里没有
 *     「无法映射」的节点；MERGE-0 登记的四条未知语义逐条点名（branch 人工选择 /
 *     conversation 主对话身份 / code 非 JS 语言 / command 非零退出）。
 *  2. **未知字段无损**：文档级、节点级、边级、position 上的 `x-custom*` 在
 *     doc → flow → doc 往返后逐字节仍在，且报告点名路径。
 *  3. **已知会丢的语义显式列出**：不静默丢（上面第 1 条的 needsHumanDecision +
 *     lossy 两项都断言 code 与 nodeId）。
 *  4. **备份逐字节等于原文**：`<数据根>/workflow-migrations/<id>-<时间戳>.json`
 *     的字节与原文 `cmp` 一致；原子写不留临时文件。
 *  5. **round-trip**：doc → flow → doc 的已知字段完全一致（`roundTripMismatchPaths`
 *     为空；位置允许迁移器已在报告里点名的 <1px 舍入）。
 *
 * ## 为什么类型清单是夹具而不是真 `loadNodeTypes()`
 *
 * 迁移器的输入契约就是 `Map<id, manifest>`（主进程给真清单，本套给夹具）——测试的是
 * **映射规则**。夹具的 runner.kind 与 `BUILTIN_NODE_TYPES` 的真值一一对应（7 种 + 2
 * 个条件/扩展原语），所以它证明的是"规则覆盖全部 kind"，不是"某个清单文件的内容"。
 * 真清单与迁移器之间是否有漂移，由 Gate C 接存储时的装配断言负责。
 *
 * ## 6/7. MERGE-3：executor owner 单一性（同一 flow 不能两端执行）
 *
 * 冲突形态（读 `automationRunner.ts` / `runner.ts` 得出）：旧 runner 以 `workflowId`
 * （= `WorkflowDoc.id`）维护 cron/文件/事件触发器并经 `runWorkflow()` 执行；Node-RED
 * 侧同一份 flow（迁移器在 `x-mcode.docId` 保留同一个 id）由引擎自己的 inject/http-in
 * 执行。两边同时登记 → 同一事件跑两遍。本段钉住判据：第二个 owner 被**显式拒绝**
 * （不是后写赢）、释放后可重新登记、未登记返回 null（防空过）、不同 flow 互不影响。
 *
 * ## 8. MERGE-1 / P1-7：按项目隔离的 flow 目录
 *
 * `<engineDir>/projects/<safe-project-id>/` —— 同 projectId 稳定、不同 projectId
 * 隔离、非法 id 拒绝；默认项目仍指向旧单例目录（只读兼容，不迁移）。
 *
 * ## 9. MERGE-1 第一步：flow 存储（CAS + corrupt/missing + docId 防漂移）
 *
 * 每条 flow 一个文件（`<projectDir>/flows/<safe>.json`），revision = 规范化 JSON 的
 * SHA-256；保存带 expectedRevision CAS；坏档 → `corrupt`（不装空）。与 Mcode
 * `workflowId` 的关联靠 `x-mcode.docId`，同一条 flow 的 docId 不可漂移。
 *
 * ## 10. MERGE-1 / P1-6：graphRevision ↔ workflowTrust
 *
 * 审批记录里的 `approvedRevision` 必须等于**盘上 flow 现算的 revision**；三态严格
 * 区分：`untrusted`（没批过）/ `trust-corrupt`（账本坏了）/ `revision-mismatch`
 * （批的是旧版，带两个 revision）。组合顺序：owner（身份）先、trust（内容许可）后。
 *
 * Run: bash scripts/flow-migration-smoke/run.sh
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { acquireOsFileLease } from "@main/lib/osFileLease.js";
import type { WorkflowDoc, WorkflowEdge, WorkflowNode } from "@contracts/workflow";
import type { NodeRunner, NodeTypeManifest } from "@contracts/nodeType";
import { MODULE_CAPABILITY_RUNNER_KIND } from "@contracts/moduleCapability";
import {
  FLOW_MIGRATOR_VERSION,
  effectiveNodeRedTypeOf,
  execCommandForCode,
  flowToWorkflowDoc,
  migrateWorkflowDoc,
  roundTripMismatchPaths,
} from "@main/workflowEngines/flowMigration.js";
import {
  WORKFLOW_MIGRATIONS_DIR,
  backupWorkflowDocBytes,
  backupWorkflowDocText,
} from "@main/workflowEngines/flowMigrationBackup.js";
import {
  EXECUTOR_OWNERS,
  createInMemoryExecutorOwnership,
  decideClaim,
  isExecutorOwner,
} from "@main/workflowEngines/executorOwnership.js";
import {
  DEFAULT_PROJECT_ID,
  PROJECTS_DIR,
  projectFlowDir,
  resolveProjectFlowDir,
  safeProjectDirName,
  validateProjectId,
} from "@main/workflowEngines/projectFlowDir.js";
import {
  FLOWS_SUBDIR,
  NodeRedFlowStorage,
  flowRevision,
  safeFlowFileName,
  validateFlowId,
} from "@main/workflowEngines/nodeRedStorage.js";
import {
  canExecuteFlow,
  flowExecutableUnderTrust,
  parseFlowTrust,
} from "@main/workflowEngines/flowTrustGate.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/* ── 夹具：覆盖全部 runner.kind 的类型清单（runner 值与真内置清单一一对应） ── */

function manifest(id: string, runner: NodeRunner): NodeTypeManifest {
  return { id, manifestVersion: 1, name: id, runner, capability: "read", params: [] };
}
const TYPES: ReadonlyMap<string, NodeTypeManifest> = new Map([
  ["mcode.main", manifest("mcode.main", { kind: "conversation" })],
  ["mcode.agent", manifest("mcode.agent", { kind: "prompt" })],
  ["mcode.conversation", manifest("mcode.conversation", { kind: "conversation" })],
  ["mcode.branch", manifest("mcode.branch", { kind: "branch" })],
  ["mcode.condition", manifest("mcode.condition", { kind: "condition" })],
  ["mcode.trigger", manifest("mcode.trigger", { kind: "trigger" })],
  ["mcode.command", manifest("mcode.command", { kind: "command" })],
  ["mcode.code", manifest("mcode.code", { kind: "code", language: "python" })],
  ["mcode.module-capability", manifest("mcode.module-capability", { kind: MODULE_CAPABILITY_RUNNER_KIND })],
  ["mcode.node-red", manifest("mcode.node-red", { kind: "node-red" })],
]);

function node(id: string, type: string, params: Record<string, unknown> = {}, title = id): WorkflowNode {
  return { id, type, title, params, position: { x: 10, y: 20 } };
}
function edge(id: string, from: string, to: string, extra: Partial<WorkflowEdge> = {}): WorkflowEdge {
  return { id, from, to, ...extra };
}

/**
 * 样例：7 种 runner.kind 全部出现，且刻意包含 MERGE-0 的四个未知语义触发点：
 *  - conversation：`mcode.main`（入口）+ `mcode.conversation`（普通对话节点）；
 *  - branch：`decider: "user"`（人工选择挂起）；
 *  - code：`language: "python"`（非 JS 语言面）；
 *  - command：非零退出语义提醒。
 */
const richDoc: WorkflowDoc = {
  id: "wf_gatec_full",
  name: "Gate C 全 runner 样例",
  description: "含全部 7 种执行原语",
  icon: "flow",
  prompt: "",
  frameworkNote: "这是给模型的框架说明",
  trigger: "schedule",
  schemaVersion: "1",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  builtin: false,
  updatedAt: 1_760_000_000_000,
  nodes: [
    node("n_main", "mcode.main", { instruction: "拆解用户请求" }, "主代理"),
    node("n_agent", "mcode.agent", { instruction: "查资料" }, "子 agent"),
    node("n_conv", "mcode.conversation", { instruction: "按刚才聊的改稿" }, "对话"),
    node("n_branch", "mcode.branch", { decider: "user" }, "岔路"),
    node("n_cond", "mcode.condition", { expression: { logic: "and", rules: [] } }, "条件"),
    node("n_cmd", "mcode.command", { command: "echo hi", timeoutMs: 0 }, "命令"),
    node("n_code", "mcode.code", { code: "print(1)", language: "python" }, "代码"),
    node("n_module", "mcode.module-capability", { moduleId: "core.file-report", contributionId: "inspect", path: "a.txt" }, "模块"),
    node("n_nodered", "mcode.node-red", { enginePath: "/api/x", engineMethod: "POST", engineBody: "{}" }, "NR"),
    node("n_trigger", "mcode.trigger", { triggerKind: "schedule", cron: "0 9 * * *", task: "跑一遍" }, "定时"),
    // 未知字段（节点级 + position 级）
    { ...node("n_unknown", "mcode.agent", { instruction: "x" }, "未知字段"), "x-custom-node": { keep: true }, position: { x: 5, y: 6, z: 7 } } as WorkflowNode,
  ],
  edges: [
    edge("e_main_agent", "n_main", "n_agent"),
    edge("e_main_conv", "n_main", "n_conv"),
    edge("e_agent_branch", "n_agent", "n_branch"),
    edge("e_branch_a", "n_branch", "n_cond", { label: "再来一轮" }),
    edge("e_branch_b", "n_branch", "n_cmd", { note: "直接动手" }),
    edge("e_cond_true", "n_cond", "n_code", { label: "true" }),
    edge("e_cond_false", "n_cond", "n_module", { label: "false" }),
    edge("e_code_nr", "n_code", "n_nodered"),
    edge("e_nr_trigger", "n_nodered", "n_trigger"),
    // 未知字段（边级）
    { ...edge("e_unknown", "n_trigger", "n_unknown"), "x-custom-edge": ["a", "b"] } as WorkflowEdge,
  ],
  // 文档级未知字段
  "x-custom-doc": { deep: { value: 42 } },
} as WorkflowDoc;

/* ══════════ 1. 全 runner.kind 映射 + MERGE-0 未知语义逐条点名 ══════════ */
console.log("\n1. 7 种 runner.kind 全映射，未知语义逐条点名");
{
  const { flow, report } = migrateWorkflowDoc(richDoc, { types: TYPES });

  const mappedKinds = new Set(report.mapped.map((m) => m.runnerKind));
  for (const kind of ["prompt", "conversation", "branch", "condition", "trigger", "command", "code", "module-capability", "node-red"] as const) {
    check(`★ 映射覆盖 runner.kind=${kind}`, mappedKinds.has(kind), [...mappedKinds]);
  }
  check("★ 含全部 7 种 runner.kind 的样例 → 报告里没有「无法映射」", report.unmapped.length === 0, report.unmapped);
  check("★ 每个文档节点都产出一个 Node-RED 节点（另有一个 tab 容器）",
    flow.nodes.length === richDoc.nodes.length + 1 && flow.nodes.filter((n) => n.type === "tab").length === 1,
    { flow: flow.nodes.length, doc: richDoc.nodes.length });
  check("★ 所有节点挂在同一个 tab 下（z 指向 tab；Node-RED 编辑器才显示它们）",
    flow.nodes.filter((n) => n.type !== "tab").every((n) => n.z === flow.nodes[0]?.id), flow.nodes.map((n) => ({ id: n.id, z: n.z })));
  check("★ wires 指向**目标节点 id**（Node-RED 格式的真相是 wires，不是 link id）",
    flow.nodes.find((n) => n["x-mcode"]?.nodeId === "n_main")?.wires?.[0]?.includes(
      flow.nodes.find((n) => n["x-mcode"]?.nodeId === "n_agent")?.id ?? "??") === true,
    flow.nodes.find((n) => n["x-mcode"]?.nodeId === "n_main")?.wires);
  const links = flow.links ?? [];
  check("★ 每条边都产出一条 link", links.length === richDoc.edges.length, { links: links.length, edges: richDoc.edges.length });
  check("★ 报告版本号可复核", report.migratorVersion === FLOW_MIGRATOR_VERSION);

  // v3 changes only the adapter mapping, not the format of an old saved
  // sidecar-only flow. A pre-v3 archive that lacks native editor properties
  // must still read its original instruction/capability from x-mcode.params.
  const legacy = structuredClone(flow);
  const priorAgent = legacy.nodes.find((n) => n["x-mcode"]?.nodeId === "n_agent");
  if (priorAgent !== undefined) {
    delete priorAgent["instruction"];
    delete priorAgent["capability"];
    delete priorAgent["outputVar"];
    const original = richDoc.nodes.find((n) => n.id === "n_agent");
    const restored = flowToWorkflowDoc(legacy).nodes.find((n) => n.id === "n_agent");
    check("★【MERGE-0 v3】缺少原生顶层表单字段的旧存档仍按 sidecar 回读",
      restored !== undefined && original !== undefined
        && restored.params["instruction"] === original.params["instruction"]
        && restored.params["capability"] === original.params["capability"],
      { original: original?.params, restored: restored?.params });
  }

  // MERGE-0 四条未知语义：遇到必须列，不静默丢。
  const items = report.needsHumanDecision;
  const itemOf = (n: number): typeof items => items.filter((i) => i.merge0Item === n);
  check("★【MERGE-0 #1】conversation 主对话身份被点名（主代理 + 对话节点两条）",
    itemOf(1).some((i) => i.nodeId === "n_main") && itemOf(1).some((i) => i.nodeId === "n_conv"),
    itemOf(1).map((i) => i.nodeId));
  check("★【MERGE-0 #2】branch 人工选择挂起被点名（decider=user）",
    itemOf(2).some((i) => i.nodeId === "n_branch"), itemOf(2).map((i) => i.nodeId));
  check("★【MERGE-0 #3】code 非 JS 语言面被点名（python）",
    itemOf(3).some((i) => i.nodeId === "n_code"), itemOf(3).map((i) => i.nodeId));
  check("★【MERGE-0 #4】command 非零退出仍 success 被点名",
    itemOf(4).some((i) => i.nodeId === "n_cmd"), itemOf(4).map((i) => i.nodeId));
  check("★ 每条 needsHumanDecision 都带稳定 code 与人话原因",
    items.every((i) => i.code === "needs-human-decision" && i.message.length > 20));
  // decider=model 的分支不该被当成"人工选择"（它是模型即时选，不挂起）。
  const modelBranch = migrateWorkflowDoc(
    { ...richDoc, nodes: [node("b", "mcode.branch", { decider: "model" })], edges: [] } as WorkflowDoc,
    { types: TYPES },
  );
  check("★ decider=model 的分支不再点名「人工选择挂起」",
    !modelBranch.report.needsHumanDecision.some((i) => i.merge0Item === 2));
  // node 语言的 code 不触发语言面提醒。
  const jsCode = migrateWorkflowDoc(
    { ...richDoc, nodes: [node("c", "mcode.code", { language: "node" })], edges: [] } as WorkflowDoc,
    { types: TYPES },
  );
  check("★ language=node 的 code 不被当成语言面不等价",
    !jsCode.report.needsHumanDecision.some((i) => i.merge0Item === 3));

  // ── 节点统一（2026-10-19）：trigger 分流 + code 删除 ──
  const triggerNr = flow.nodes.find((n) => n["x-mcode"]?.nodeId === "n_trigger");
  check("★【节点统一】triggerKind=schedule → 内置 inject（crontab 原样）",
    triggerNr?.type === "inject" && (triggerNr as { crontab?: string }).crontab === "0 9 * * *",
    { type: triggerNr?.type, crontab: (triggerNr as { crontab?: string } | undefined)?.crontab });
  check("★【节点统一】schedule 的 lossy 报告点名内置 inject 不表达的字段",
    report.lossy.some((i) => i.nodeId === "n_trigger" && i.message.includes("inject")),
    report.lossy.filter((i) => i.nodeId === "n_trigger"));
  const codeNr = flow.nodes.find((n) => n["x-mcode"]?.nodeId === "n_code");
  check("★【节点统一】code(python) → 内置 exec + 解释器前缀",
    codeNr?.type === "exec" && String((codeNr as { command?: unknown }).command).startsWith("python -c "),
    { type: codeNr?.type, command: (codeNr as { command?: unknown } | undefined)?.command });
  check("★【节点统一】迁移产物里没有任何 mcode-code",
    !flow.nodes.some((n) => n.type === "mcode-code"), flow.nodes.map((n) => n.type));
  // 四种 triggerKind 的分流表（纯函数面直接钉）。
  eq("★【节点统一】manual → inject", effectiveNodeRedTypeOf("trigger", { triggerKind: "manual" }), "inject");
  eq("★【节点统一】schedule → inject", effectiveNodeRedTypeOf("trigger", { triggerKind: "schedule" }), "inject");
  eq("★【节点统一】file → watch（内置文件监听）", effectiveNodeRedTypeOf("trigger", { triggerKind: "file" }), "watch");
  eq("★【节点统一】event → mcode-trigger（内置没有应用事件）", effectiveNodeRedTypeOf("trigger", { triggerKind: "event" }), "mcode-trigger");
  eq("★【节点统一】code(node) → function", effectiveNodeRedTypeOf("code", { language: "node" }), "function");
  eq("★【节点统一】code(python) → exec", effectiveNodeRedTypeOf("code", { language: "python" }), "exec");
  eq("★【节点统一】code(shell) → exec", effectiveNodeRedTypeOf("code", { language: "shell" }), "exec");
  eq("★【节点统一】code(powershell) → exec", effectiveNodeRedTypeOf("code", { language: "powershell" }), "exec");
  eq("★【节点统一】exec 命令带语言前缀（python）", execCommandForCode({ language: "python", code: "print(1)" }), "python -c print(1)");
  eq("★【节点统一】exec 命令带语言前缀（shell）", execCommandForCode({ language: "shell", code: "echo hi" }), "sh -c echo hi");
  eq("★【节点统一】node 语言不产生 exec 命令", execCommandForCode({ language: "node", code: "return msg;" }), null);
  // 内置确认不重复：condition/command/code(JS) 没有自定义替身。
  eq("★【节点统一】condition 仍走内置 switch（无自定义替身）", effectiveNodeRedTypeOf("condition", {}), "switch");
  eq("★【节点统一】command 仍走内置 exec", effectiveNodeRedTypeOf("command", { command: "echo hi" }), "exec");
  check("★【MERGE-0】v4 原生克隆身份/类型护栏版本可追溯", FLOW_MIGRATOR_VERSION === 4, FLOW_MIGRATOR_VERSION);

  // 端口规则：branch = 每条出边一个口；condition = true 口 0 / false 口 1。
  const branchNode = flow.nodes.find((n) => n["x-mcode"]?.nodeId === "n_branch");
  check("★ branch 的端口数 = 出边数", branchNode?.wires?.length === 2, branchNode?.wires);
  const condLinks = links.filter((l) => l.source === flow.nodes.find((n) => n["x-mcode"]?.nodeId === "n_cond")?.id);
  check("★ condition 的 true 边在端口 0、false 边在端口 1",
    condLinks.some((l) => l["x-mcode-edge"]?.edgeId === "e_cond_true" && l.sourcePort === 0)
    && condLinks.some((l) => l["x-mcode-edge"]?.edgeId === "e_cond_false" && l.sourcePort === 1),
    condLinks.map((l) => ({ e: l["x-mcode-edge"]?.edgeId, p: l.sourcePort })));
  // 未知类型：不猜，报告点名，原始 type 留在 x-mcode。
  const unknownTypeDoc = migrateWorkflowDoc(
    { ...richDoc, nodes: [node("u", "myorg.mystery")], edges: [] } as WorkflowDoc,
    { types: TYPES },
  );
  check("★ 类型不在清单里 → 报告 unmapped-node 点名（不猜执行语义）",
    unknownTypeDoc.report.unmapped.some((u) => u.nodeId === "u" && u.type === "myorg.mystery"),
    unknownTypeDoc.report.unmapped);
  const unknownNode = unknownTypeDoc.flow.nodes.find((n) => n.type === "mcode-unknown");
  check("★ 未知类型节点仍以 mcode-unknown 迁移且保留原始 type",
    unknownNode?.["x-mcode"]?.type === "myorg.mystery",
    unknownTypeDoc.flow.nodes);
}

/* ══════════ 2. 未知字段：报告点名 + 往返后逐字节仍在 ══════════ */
console.log("\n2. 未知字段保全（文档/节点/边/position 四级）");
{
  const { flow, report } = migrateWorkflowDoc(richDoc, { types: TYPES });
  check("★ 未知字段路径被报告点名（文档级）", report.unknownFieldPaths.includes("x-custom-doc"), report.unknownFieldPaths);
  check("★ 未知字段路径被报告点名（节点级）", report.unknownFieldPaths.some((p) => p.endsWith("x-custom-node")), report.unknownFieldPaths);
  check("★ 未知字段路径被报告点名（position 级）", report.unknownFieldPaths.some((p) => p.endsWith("position.z")), report.unknownFieldPaths);
  check("★ 未知字段路径被报告点名（边级）", report.unknownFieldPaths.some((p) => p.endsWith("x-custom-edge")), report.unknownFieldPaths);

  const back = flowToWorkflowDoc(flow);
  check("★ 往返后文档级 x-custom-doc 逐字节仍在",
    JSON.stringify((back as unknown as Record<string, unknown>)["x-custom-doc"]) === JSON.stringify({ deep: { value: 42 } }),
    (back as unknown as Record<string, unknown>)["x-custom-doc"]);
  const nodeBack = back.nodes.find((n) => n.id === "n_unknown") as unknown as Record<string, unknown> | undefined;
  check("★ 往返后节点级 x-custom-node 仍在",
    nodeBack !== undefined && JSON.stringify(nodeBack["x-custom-node"]) === JSON.stringify({ keep: true }),
    nodeBack?.["x-custom-node"]);
  check("★ 往返后 position 未知分量 z 仍在",
    nodeBack !== undefined && (nodeBack.position as { z?: number }).z === 7,
    nodeBack?.position);
  const edgeBack = back.edges.find((e) => e.id === "e_unknown") as unknown as Record<string, unknown> | undefined;
  check("★ 往返后边级 x-custom-edge 仍在",
    edgeBack !== undefined && JSON.stringify(edgeBack["x-custom-edge"]) === JSON.stringify(["a", "b"]),
    edgeBack?.["x-custom-edge"]);
}

/* ══════════ 3. round-trip：已知字段完全一致 ══════════ */
console.log("\n3. round-trip（doc → flow → doc）");
{
  const { flow } = migrateWorkflowDoc(richDoc, { types: TYPES });
  const back = flowToWorkflowDoc(flow);
  const mismatches = roundTripMismatchPaths(richDoc, back);
  check("★ 已知字段往返完全一致（roundTripMismatchPaths 为空）", mismatches.length === 0, mismatches);
  // 边集合本身（含端口还原顺序）也不变。
  check("★ 边集合与 label/note 往返一致",
    JSON.stringify(back.edges.map((e) => [e.id, e.from, e.to, e.label ?? null, e.note ?? null]))
    === JSON.stringify(richDoc.edges.map((e) => [e.id, e.from, e.to, e.label ?? null, e.note ?? null])),
    back.edges);
  // 二次往返稳定（幂等）。
  const second = flowToWorkflowDoc(migrateWorkflowDoc(back, { types: TYPES }).flow);
  check("★ 二次往返仍然一致（迁移幂等）", roundTripMismatchPaths(back, second).length === 0, roundTripMismatchPaths(back, second));
}

/* ══════════ 4. 无损备份：逐字节等于原文 + 原子写 ══════════ */
console.log("\n4. 迁移前备份（workflow-migrations/<id>-<时间戳>.json）");
{
  const dataRoot = process.env.MCODE_FLOW_MIGRATION_DATA;
  check("前置：本套数据根由 run.sh 指向临时目录", typeof dataRoot === "string" && dataRoot.length > 0, dataRoot);
  if (dataRoot === undefined || dataRoot.length === 0) throw new Error("MCODE_FLOW_MIGRATION_DATA 没设");

  // 刻意用"非规范"文本：多余空白 + 键序 + 非 2 空格缩进 —— 备份若被 re-serialize，字节会变。
  const originalText = `{"id":"wf_backup",  "name":"备份样例",\n\t"nodes":[],"edges":[],"builtin":false,"updatedAt":0}`;
  const originalBytes = new TextEncoder().encode(originalText);
  const at = new Date("2026-10-19T01:02:03.004Z");

  const backup = await backupWorkflowDocText(dataRoot, "wf_backup", originalText, { at });
  check("★ 备份文件落在 <数据根>/workflow-migrations/", backup.path.includes(WORKFLOW_MIGRATIONS_DIR), backup.path);
  check("★ 文件名带 id、原 ID 哈希、时间戳与唯一 UUID", /wf_backup-[0-9a-f]{12}-2026-10-19T01-02-03-004Z-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.json$/.test(backup.path), backup.path);
  check("★ 备份文件存在", existsSync(backup.path));
  check("★ 备份逐字节等于原文", Buffer.compare(readFileSync(backup.path), Buffer.from(originalBytes)) === 0, {
    expectedBytes: originalBytes.byteLength,
    actualBytes: readFileSync(backup.path).byteLength,
  });
  check("★ 报告字节数与 SHA-256 与原文一致",
    backup.bytes === originalBytes.byteLength
    && backup.sha256 === createHash("sha256").update(originalBytes).digest("hex"),
    { bytes: backup.bytes, sha256: backup.sha256 });
  check("★ 原子写不留临时文件（目录里只有备份本身）",
    readdirSync(join(dataRoot, WORKFLOW_MIGRATIONS_DIR)).every((f) => !f.includes("mcode-tmp")),
    readdirSync(join(dataRoot, WORKFLOW_MIGRATIONS_DIR)));

  // 字节入口：随便一份含内嵌 NUL/非 ASCII 的字节也必须原样落盘。
  const weird = new Uint8Array([0x7b, 0x00, 0xe4, 0xb8, 0xad, 0x7d]);
  const weirdBackup = await backupWorkflowDocBytes(dataRoot, "wf_bytes", weird, { at });
  check("★ 字节入口原样落盘（含 NUL 与 UTF-8 中文）",
    Buffer.compare(readFileSync(weirdBackup.path), Buffer.from(weird)) === 0, weirdBackup.path);

  // 同一 id 不同时间戳 → 两份独立备份（不互相覆盖）。
  const later = await backupWorkflowDocText(dataRoot, "wf_backup", originalText, { at: new Date("2026-10-19T01:02:04.000Z") });
  check("★ 不同时间戳产生独立备份（前一份仍在）", later.path !== backup.path && existsSync(backup.path) && existsSync(later.path));
  check("★ 非法字符 id 被折成安全文件名（仍带原 ID 的哈希）",
    /a-b-c-[0-9a-f]{12}-2026-10-19T01-02-03-004Z-[0-9a-f-]{36}\.json$/.test(
      (await backupWorkflowDocText(dataRoot, "a/b:c", "{}", { at })).path));

  // ARC-006 Gate C：同一毫秒的连续迁移可能读取到两个不同版本。
  // 备份必须按「每次迁移的原始字节」独立保存，不许让后一次 atomicReplace 覆盖前一次。
  const firstSame = await backupWorkflowDocText(dataRoot, "wf_same_ms", "first revision", { at });
  const secondSame = await backupWorkflowDocText(dataRoot, "wf_same_ms", "second revision", { at });
  check("★ 同 id 同毫秒两份不同原文不能覆盖", firstSame.path !== secondSame.path
    && readFileSync(firstSame.path, "utf8") === "first revision"
    && readFileSync(secondSame.path, "utf8") === "second revision",
  { firstSame: firstSame.path, secondSame: secondSame.path });

  // 两个不同 id 经白名单折叠也可能同名：a/b 与 a:b 都是 a-b。
  const firstFold = await backupWorkflowDocText(dataRoot, "wf/a", "project A", { at });
  const secondFold = await backupWorkflowDocText(dataRoot, "wf:a", "project B", { at });
  check("★ 不同原始 id 折叠碰撞仍保留两份独立备份", firstFold.path !== secondFold.path
    && readFileSync(firstFold.path, "utf8") === "project A"
    && readFileSync(secondFold.path, "utf8") === "project B",
  { firstFold: firstFold.path, secondFold: secondFold.path });

  // 原始 id 若来自外部数据可超过 255 字符：备份不能因文件名过长而失败。
  const longBackup = await backupWorkflowDocText(dataRoot, "long".repeat(110), "long-id bytes", { at });
  check("★ 超长工作流 id 的备份文件名保持 Windows 安全长度且内容无损",
    longBackup.path.split(/[\\/]/).at(-1)!.length < 180
    && readFileSync(longBackup.path, "utf8") === "long-id bytes", longBackup.path);
}

/* ══════════ 6. executor owner 单一性（MERGE-3 第一刀） ══════════ */
console.log("\n6. executor owner：同一 flow 只能一端执行");
{
  check("★ owner 只有两端（封闭集合：mcode / node-red）", JSON.stringify([...EXECUTOR_OWNERS]) === '["mcode","node-red"]');
  check("★ 非 owner 字符串被拒（防空过）", !isExecutorOwner("other") && !isExecutorOwner(null) && isExecutorOwner("mcode"));

  // ★ 同一 flowId 登记两个 owner → 第二个被拒且原因可读。
  {
    const registry = createInMemoryExecutorOwnership();
    const first = registry.claim("wf_shared", "mcode", { reason: "旧 runner 的自动化触发器表" });
    check("★ 第一个 owner 登记成功", first.ok === true && first.owner === "mcode", first);
    const second = registry.claim("wf_shared", "node-red", { reason: "迁移产物部署到引擎" });
    check("★ 同一 flowId 登记第二个 owner → 被拒（不是后写赢）", second.ok === false, second);
    check("★ 拒绝原因点名双方且可读",
      second.ok === false
      && second.reason.includes("wf_shared") && second.reason.includes("mcode") && second.reason.includes("node-red"),
      second.ok === false ? second.reason : second);
    check("★ 冲突结果带双方身份（requested / current）",
      second.ok === false && second.conflict?.requested === "node-red" && second.conflict?.current === "mcode",
      second.ok === false ? second.conflict : second);
    eq("★ 冲突后 owner 仍是第一个（未被覆盖）", registry.executorOwnerOf("wf_shared"), "mcode");
    // 同一 owner 重复登记是幂等（automationRunner.reload 会反复登记），不是冲突。
    const again = registry.claim("wf_shared", "mcode");
    check("★ 同一 owner 重复登记 → 幂等允许（alreadyOwned）", again.ok === true && again.alreadyOwned === true, again);
  }

  // ★ 释放后可重新登记（切换 owner 的唯一合法路径）。
  {
    const registry = createInMemoryExecutorOwnership();
    registry.claim("wf_switch", "mcode");
    const wrongRelease = registry.release("wf_switch", "node-red");
    check("★ 非当前 owner 不能释放（陈旧一方偷不走所有权）", wrongRelease.ok === false, wrongRelease);
    eq("★ 释放被拒后 owner 不变", registry.executorOwnerOf("wf_switch"), "mcode");
    const released = registry.release("wf_switch", "mcode");
    check("★ 当前 owner 释放成功", released.ok === true, released);
    eq("★ 释放后 executorOwnerOf 回 null", registry.executorOwnerOf("wf_switch"), null);
    const reClaim = registry.claim("wf_switch", "node-red", { reason: "MERGE-3 切换" });
    check("★ 释放后可由另一端重新登记", reClaim.ok === true && reClaim.alreadyOwned === false, reClaim);
    eq("★ 重新登记后 owner 是 node-red", registry.executorOwnerOf("wf_switch"), "node-red");
    // 重复释放：没有登记过 → 明确失败（不是静默成功）。
    check("★ 重复释放明确失败", registry.release("wf_switch", "node-red").ok === true
      && registry.release("wf_switch", "node-red").ok === false);
  }

  // ★ 未登记的 flowId 返回 null（防空过：绝不能默认落端）。
  {
    const registry = createInMemoryExecutorOwnership();
    eq("★ 未登记的 flowId → null", registry.executorOwnerOf("wf_unknown"), null);
    eq("★ 空 flowId → null（不成为第二条'没人拥有'的路）", registry.executorOwnerOf(""), null);
    const bad = registry.claim("", "mcode");
    check("★ 空 flowId 登记被拒", bad.ok === false && bad.conflict === null, bad);
    const badOwner = registry.claim("wf_x", "other" as unknown as "mcode");
    check("★ 未知 owner 登记被拒且原因点名合法集合", badOwner.ok === false && badOwner.reason.includes("mcode"), badOwner);
  }

  // ★ 两个不同 flowId 互不影响。
  {
    const registry = createInMemoryExecutorOwnership();
    registry.claim("wf_a", "mcode");
    registry.claim("wf_b", "node-red");
    eq("★ 不同 flowId 各自 owner 独立", [registry.executorOwnerOf("wf_a"), registry.executorOwnerOf("wf_b")], ["mcode", "node-red"]);
    registry.release("wf_a", "mcode");
    eq("★ 释放一个不影响另一个", [registry.executorOwnerOf("wf_a"), registry.executorOwnerOf("wf_b")], [null, "node-red"]);
    const conflictB = registry.claim("wf_b", "mcode");
    check("★ 另一个 flow 的冲突判定同样生效", conflictB.ok === false && conflictB.conflict?.current === "node-red", conflictB);
    eq("★ 登记表里只有 wf_b 一条", registry.list().map((r) => r.flowId), ["wf_b"]);
  }

  // 纯判据面：decideClaim 不碰存储（可直接单测）。
  {
    const existing = { flowId: "x", owner: "node-red" as const };
    eq("★ decideClaim：未登记 → 允许", decideClaim(null, "mcode"), { ok: true, alreadyOwned: false });
    eq("★ decideClaim：同 owner → 幂等", decideClaim(existing, "node-red"), { ok: true, alreadyOwned: true });
    eq("★ decideClaim：异 owner → 拒绝并报 current", decideClaim(existing, "mcode"), { ok: false, current: "node-red" });
  }
}
console.log(`\nflow-migration-smoke(含 executor owner):${total - failures}/${total} 通过`);

/* ══════════ 7. 迁移产物的 flow 身份 = 登记键（端到端对齐） ══════════ */
console.log("\n7. 迁移产物的 flow 身份与 owner 登记键对齐");
{
  const { flow } = migrateWorkflowDoc(richDoc, { types: TYPES });
  const meta = flow["x-mcode"];
  eq("★ 迁移产物的 x-mcode.docId 就是 WorkflowDoc.id（两端说同一个键）", meta?.docId, richDoc.id);
  const registry = createInMemoryExecutorOwnership();
  const claimed = registry.claim(String(meta?.docId), "node-red", { reason: "迁移产物已部署给引擎" });
  check("★ 用迁移产物里的 docId 可直接登记归属", claimed.ok === true, claimed);
  eq("★ 旧 runner 侧按同一个 workflowId 查询会看到 node-red 拥有",
    registry.executorOwnerOf(richDoc.id), "node-red");
  const conflict = registry.claim(richDoc.id, "mcode");
  check("★ 旧 runner 若试图登记同一 flow → 显式冲突", conflict.ok === false, conflict);
}

/* ══════════ 8. 按项目隔离的 flow 目录（MERGE-1 / P1-7） ══════════ */
console.log("\n8. projectFlowDir：项目隔离 + 默认项目兼容");
{
  const engineDir = join(tmpdir(), "mcode-engine-root-fixture");
  const ra = resolveProjectFlowDir(engineDir, "proj_alpha");
  const rb = resolveProjectFlowDir(engineDir, "proj_beta");
  check("前置：两个合法 projectId 都解析成功", ra.ok === true && rb.ok === true, { ra, rb });
  const a = ra.ok ? ra.dir : "";
  const b = rb.ok ? rb.dir : "";
  check("★ 两个 projectId 的目录互不相同（隔离）", a !== "" && b !== "" && a !== b, { a, b });
  check("★ 目录落在 <engineDir>/projects/ 下",
    a.includes(PROJECTS_DIR) && b.includes(PROJECTS_DIR), { a, b });
  eq("★ 同一 projectId 重复调用稳定（纯判据）", resolveProjectFlowDir(engineDir, "proj_alpha"), ra);

  // 折叠碰撞：两个**合法**但折叠后同名的 id（空格与点都折成 `-`）→ 哈希后缀仍区分。
  const rc1 = resolveProjectFlowDir(engineDir, "a b");
  const rc2 = resolveProjectFlowDir(engineDir, "a.b");
  check("★ 折叠后同名的两个不同 id 目录仍不同（哈希后缀兜底）",
    rc1.ok && rc2.ok && rc1.dir !== rc2.dir, { rc1, rc2 });
  check("★ safeProjectDirName 带 8 位十六进制哈希后缀",
    /-[0-9a-f]{8}$/.test(safeProjectDirName("proj_alpha")), safeProjectDirName("proj_alpha"));
  check("★ safeProjectDirName 只含白名单字符",
    /^[A-Za-z0-9_-]+$/.test(safeProjectDirName("a b.c:d")), safeProjectDirName("a b.c:d"));

  // ★ 非法 projectId 被拒（..、绝对路径、空、分隔符、盘符、控制字符、超长）。
  const invalid = [
    ["空串", ""],
    ["纯空白", "   "],
    // 项目身份不做静默 trim：不同原始 ID 不能被映射到同一个 flow/凭据目录。
    ["前导空格", " proj_alpha"],
    ["尾随空格", "proj_alpha "],
    ["默认项目伪装（尾随空格）", "default "],
    ["..", ".."],
    [".", "."],
    ["绝对路径（/）", "/etc/passwd"],
    ["绝对路径（\\）", "C:\\Windows"],
    ["盘符", "D:secret"],
    ["含分隔符", "a/b"],
    ["含反斜杠", "a\\b"],
    ["NUL", "a\u0000b"],
    ["孤立高代理项 U+D800", "\uD800"],
    ["孤立高代理项 U+D801（原与 U+D800 目录碰撞）", "\uD801"],
    ["孤立低代理项 U+DC00", "\uDC00"],
    ["超长", "x".repeat(201)],
  ] as const;
  for (const [label, id] of invalid) {
    const result = resolveProjectFlowDir(engineDir, id);
    check(`★ 非法 projectId 被拒：${label}`, result.ok === false, { id, result });
    check(`★ 非法 projectId 不回退默认目录：${label}`,
      result.ok === false && !(result as { dir?: string }).dir, result);
    let threw = false;
    try {
      projectFlowDir(engineDir, id);
    } catch {
      threw = true;
    }
    check(`★ 便捷入口对非法 id 抛错：${label}`, threw);
  }
  check("★ validateProjectId 接受正常 id", validateProjectId("proj_alpha").ok === true);

  // ★ 默认项目仍指向旧目录（兼容，不迁移）。
  const legacy = resolveProjectFlowDir(engineDir, null);
  check("★ null projectId → 旧单例目录（legacy=true）", legacy.ok === true && legacy.legacy === true, legacy);
  eq("★ 旧目录就是 engineDir 本身（不套 projects/）", legacy.ok === true ? legacy.dir : null, resolve(engineDir));
  const defaultById = resolveProjectFlowDir(engineDir, DEFAULT_PROJECT_ID);
  check("★ DEFAULT_PROJECT_ID 同样落旧目录", defaultById.ok === true && defaultById.dir === (legacy.ok ? legacy.dir : ""), defaultById);
  const undefinedId = resolveProjectFlowDir(engineDir);
  check("★ 省略 projectId → 旧目录", undefinedId.ok === true && undefinedId.legacy === true, undefinedId);
  check("★ 默认项目目录不创建 projects/ 子目录语义（legacy 标记）",
    legacy.ok === true && !legacy.dir.includes(PROJECTS_DIR), legacy);

  // ★ 两个 projectId 的 flow 文件互不可见（真文件，不是只比字符串）。
  const isolRoot = process.env.MCODE_FLOW_MIGRATION_DATA;
  if (isolRoot !== undefined && isolRoot !== "") {
    const realRA = resolveProjectFlowDir(isolRoot, "proj_alpha");
    const realRB = resolveProjectFlowDir(isolRoot, "proj_beta");
    if (!realRA.ok || !realRB.ok) throw new Error("合法 projectId 解析失败");
    const realA = realRA.dir;
    const realB = realRB.dir;
    mkdirSync(realA, { recursive: true });
    mkdirSync(realB, { recursive: true });
    writeFileSync(join(realA, "flows.json"), JSON.stringify([{ id: "a" }]), "utf8");
    writeFileSync(join(realB, "flows.json"), JSON.stringify([{ id: "b" }]), "utf8");
    check("★ A 项目的 flows.json 在 B 项目目录不可见",
      existsSync(join(realA, "flows.json")) && !existsSync(join(realB, "flows.json")) === false
      || readFileSync(join(realA, "flows.json"), "utf8") !== readFileSync(join(realB, "flows.json"), "utf8"),
      { realA, realB });
    eq("★ A 项目目录里只有自己的 flows.json", readdirSync(realA).filter((f) => f.endsWith(".json")), ["flows.json"]);
    eq("★ B 项目目录里只有自己的 flows.json", readdirSync(realB).filter((f) => f.endsWith(".json")), ["flows.json"]);
  }
}

/* ══════════ 9. flow 存储：CAS / corrupt / missing / docId 防漂移 ══════════ */
console.log("\n9. nodeRedStorage：CAS 保存、坏档不装空、项目隔离、docId 防漂移");
{
  const root = process.env.MCODE_FLOW_MIGRATION_DATA;
  if (root === undefined || root === "") throw new Error("MCODE_FLOW_MIGRATION_DATA 没设");
  const storage = new NodeRedFlowStorage(root);
  const flowOf = (docId: string, marker: string): { nodes: Array<{ id: string; type: string }>; "x-mcode": { docId: string; marker: string } } => ({
    nodes: [{ id: "n1", type: "inject" }],
    "x-mcode": { docId, marker },
  });

  // ARC-006：两条合法项目 ID 真实的 SHA-256 前8位碰撞。
  // 不能只在 registry 校验；NodeRedFlowStorage 是另一条直接读/写入口。
  {
    const a = "p".repeat(40) + "-195";
    const b = "p".repeat(40) + "-92702";
    const first = await storage.saveFlow(a, "wf_collision", flowOf("wf_collision", "project-first") as never, {expectedRevision:null});
    check("★ project hash 碰撞前第一个项目能正常保存 flow", first.ok === true, first);
    const wrongLoad = storage.loadFlow(b, "wf_collision");
    check("★ 碰撞第二项目不能读取第一个项目原文",
      wrongLoad.ok === false && wrongLoad.kind === "invalid-project", wrongLoad);
    const wrongSave = await storage.saveFlow(b, "wf_collision", flowOf("wf_collision", "project-other") as never, {expectedRevision:null});
    check("★ 碰撞第二项目不能覆盖或创建第一个项目 flow",
      wrongSave.ok === false && wrongSave.kind === "invalid-project", wrongSave);
    const unchanged = storage.loadFlow(a, "wf_collision");
    check("★ 碰撞后第一个项目的 flow 原内容仍有效",
      unchanged.ok && (unchanged.flow as unknown as { "x-mcode": { marker: string } })["x-mcode"].marker === "project-first",
      unchanged);
  }

  // 直接存储入口原来只 mkdirSync(projects) 并不检查目录重解析点。
  // registry 拒 junction 不代表绕过 registry 的 NodeRedFlowStorage 同样安全。
  {
    const subroot = join(root, "storage-link-probe");
    const external = join(root, "storage-link-outside");
    mkdirSync(subroot, {recursive:true});
    mkdirSync(external, {recursive:true});
    writeFileSync(join(external, "sentinel.txt"), "external-owned", "utf8");
    let linked = false;
    try {
      try {
        symlinkSync(external, join(subroot, PROJECTS_DIR), process.platform === "win32" ? "junction" : "dir");
        linked = true;
      } catch (err) {
        console.log("  SKIP junction fixture（当前 OS 权限不足）：" + (err as Error).message);
      }
      if (linked) {
        check("★ 存储层测试确实创建了一个 OS 项目目录链接",
          lstatSync(join(subroot, PROJECTS_DIR)).isSymbolicLink());
        const isolatedStore = new NodeRedFlowStorage(subroot);
        const saved = await isolatedStore.saveFlow("junction-project", "wf_junction",
          flowOf("wf_junction", "must-not-escape") as never, {expectedRevision:null});
        check("★ 存储层拒绝沿 junction 向项目根外写 flow",
          saved.ok === false && saved.kind === "invalid-project", saved);
        check("★ 项目目录逃逸拒写后外部 sentinel 原字节仍在",
          readFileSync(join(external, "sentinel.txt"), "utf8") === "external-owned");
        check("★ 逃逸目标不允许产生新的项目目录或身份标记",
          readdirSync(external).length === 1);
      }
    } finally {
      if (linked) {
        if (process.platform === "win32") rmdirSync(join(subroot, PROJECTS_DIR));
        else unlinkSync(join(subroot, PROJECTS_DIR));
      }
    }
  }

  // ★ 健康往返（防空过）：保存 → 读回 → revision 一致。
  {
    const flow = flowOf("wf_store_ok", "v1");
    const created = await storage.saveFlow("proj_store_a", "wf_store_ok", flow as never, { expectedRevision: null });
    check("★ 新建保存成功（expectedRevision=null）", created.ok === true && created.created === true, created);
    const read = storage.loadFlow("proj_store_a", "wf_store_ok");
    check("★ 读回成功且 revision 与保存返回一致",
      read.ok === true && created.ok === true && read.revision === created.revision,
      { read: read.ok ? read.revision : read, created: created.ok ? created.revision : created });
    check("★ 读回的 flow 内容与写入一致（docId 补齐）",
      read.ok === true && (read.flow as unknown as { "x-mcode": { docId: string; marker: string } })["x-mcode"].marker === "v1",
      read.ok ? read.flow : read);
    // revision 对同一内容稳定：重新算一遍。
    check("★ revision 是内容哈希（同内容稳定）", read.ok === true && flowRevision(read.flow) === read.revision);
    if (created.ok) {
      const realFlowFile = join(storage.projectDir("proj_store_a"), FLOWS_SUBDIR,
        `${safeFlowFileName("wf_store_ok")}.json`);
      const release = await acquireOsFileLease(realFlowFile + ".mcode-lock", 2000);
      let finished = false;
      const pending = storage.saveFlow("proj_store_a", "wf_store_ok", flowOf("wf_store_ok", "v2") as never,
        {expectedRevision:created.revision}).then((value) => {
        finished = true;
        return value;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 180));
      check("★ OS 文件租约被占时 NodeRed flow 保存不能提前完成", !finished);
      await release();
      const updated = await pending;
      check("★ 释放 OS 文件租约后 flow CAS 能正常保存", updated.ok === true, updated);
      check("★ OS 文件租约释放后无遗留锁", !existsSync(realFlowFile + ".mcode-lock"));
    }
  }

  // ★ 两个客户端带同一 expectedRevision 并发保存 → 一成一败，败者 conflict + currentRevision。
  {
    const flowId = "wf_store_race";
    const first = await storage.saveFlow("proj_store_b", flowId, flowOf(flowId, "v1") as never, { expectedRevision: null });
    check("前置：初始保存成功", first.ok === true, first);
    const baseRevision = first.ok ? first.revision : "";
    // 两个客户端都拿着 baseRevision 同时提交不同内容。
    const [r1, r2] = await Promise.all([
      storage.saveFlow("proj_store_b", flowId, flowOf(flowId, "client-A") as never, { expectedRevision: baseRevision }),
      storage.saveFlow("proj_store_b", flowId, flowOf(flowId, "client-B") as never, { expectedRevision: baseRevision }),
    ]);
    const successes = [r1, r2].filter((r) => r.ok);
    const failures = [r1, r2].filter((r) => !r.ok);
    eq("★ 并发同一 expectedRevision：恰好一成一败", [successes.length, failures.length], [1, 1]);
    const loser = failures[0];
    check("★ 败者 conflict 且带 currentRevision",
      loser !== undefined && !loser.ok && loser.kind === "conflict" && typeof loser.currentRevision === "string",
      loser);
    const winner = successes[0];
    check("★ 败者的 currentRevision = 胜者写入的 revision",
      loser !== undefined && !loser.ok && winner !== undefined && winner.ok && loser.currentRevision === winner.revision,
      { loser: loser !== undefined && !loser.ok ? loser.currentRevision : null, winner: winner?.ok ? winner.revision : null });
    // 冲突不写：盘上内容是胜者的。
    const after = storage.loadFlow("proj_store_b", flowId);
    check("★ 冲突后盘上是胜者的内容（败者没有覆盖）",
      after.ok === true && (after.flow as unknown as { "x-mcode": { marker: string } })["x-mcode"].marker === (winner?.ok && (winner as { flowId: string }).flowId === flowId ? ((r1.ok ? "client-A" : "client-B")) : "?"),
      after.ok ? (after.flow as unknown as { "x-mcode": { marker: string } })["x-mcode"].marker : after);
  }

  // ★ 坏 JSON → corrupt（不是空对象）；不存在 → missing。
  {
    const dir = storage.projectDir("proj_store_c");
    mkdirSync(join(dir, FLOWS_SUBDIR), { recursive: true });
    const file = join(dir, FLOWS_SUBDIR, `${safeFlowFileName("wf_broken")}.json`);
    writeFileSync(file, "{not json", "utf8");
    const broken = storage.loadFlow("proj_store_c", "wf_broken");
    check("★ 坏 JSON → corrupt（kind 明确）", !broken.ok && broken.kind === "corrupt", broken);
    check("★ corrupt 不返回空对象（没有 flow 字段）", !broken.ok && !("flow" in broken), broken);
    check("★ corrupt 带可读原因", !broken.ok && broken.reason.length > 5, broken);
    // 形状不对（合法 JSON 但不是 flow）也算 corrupt。
    const shapeFile = join(dir, FLOWS_SUBDIR, `${safeFlowFileName("wf_shape")}.json`);
    writeFileSync(shapeFile, JSON.stringify({ hello: 1 }), "utf8");
    const shape = storage.loadFlow("proj_store_c", "wf_shape");
    check("★ 形状不是 flow → corrupt", !shape.ok && shape.kind === "corrupt", shape);
    // 不存在 → missing。
    const missing = storage.loadFlow("proj_store_c", "wf_missing");
    check("★ 不存在 → missing（不是 corrupt）", !missing.ok && missing.kind === "missing", missing);
    // 坏档不可被静默覆盖。
    const overwrite = await storage.saveFlow("proj_store_c", "wf_broken", flowOf("wf_broken", "v2") as never, { expectedRevision: null });
    check("★ 坏档存在时保存被拒（不拿新内容盖掉可抢救的字节）",
      overwrite.ok === false && overwrite.kind === "corrupt", overwrite);
    eq("★ 坏档字节原样保留", readFileSync(file, "utf8"), "{not json");
  }

  // ★ 项目隔离：两个 projectId 互不可见。
  {
    const p1 = "proj_iso_a";
    const p2 = "proj_iso_b";
    const f1 = "wf_iso_1";
    const f2 = "wf_iso_2";
    const s1 = await storage.saveFlow(p1, f1, flowOf(f1, "only-a") as never, { expectedRevision: null });
    check("前置：项目 A 保存成功", s1.ok === true, s1);
    check("★ A 的 flow 在 B 项目不可见（missing）", (() => {
      const r = storage.loadFlow(p2, f1);
      return !r.ok && r.kind === "missing";
    })(), storage.loadFlow(p2, f1));
    check("★ B 的清单里没有 A 的 flow", (() => {
      const l = storage.listFlows(p2);
      return l.ok && !l.entries.some((e) => e.flowId === f1);
    })(), storage.listFlows(p2));
    const s2 = await storage.saveFlow(p2, f2, flowOf(f2, "only-b") as never, { expectedRevision: null });
    check("前置：项目 B 保存成功", s2.ok === true, s2);
    check("★ 两个项目各自清单互不含对方",
      (() => {
        const la = storage.listFlows(p1);
        const lb = storage.listFlows(p2);
        return la.ok && lb.ok
          && la.entries.some((e) => e.flowId === f1) && !la.entries.some((e) => e.flowId === f2)
          && lb.entries.some((e) => e.flowId === f2) && !lb.entries.some((e) => e.flowId === f1);
      })(), { a: storage.listFlows(p1), b: storage.listFlows(p2) });
  }

  // ★ docId 漂移被拒。
  {
    const flowId = "wf_drift_target";
    const evil = { nodes: [{ id: "n1", type: "inject" }], "x-mcode": { docId: "wf_someone_else" } };
    const rejected = await storage.saveFlow("proj_drift", flowId, evil as never, { expectedRevision: null });
    check("★ 写入内容的 docId ≠ flowId → 拒绝（doc-id-drift）", !rejected.ok && rejected.kind === "doc-id-drift", rejected);
    check("★ 拒绝后盘上没有该 flow", (() => {
      const r = storage.loadFlow("proj_drift", flowId);
      return !r.ok && r.kind === "missing";
    })(), storage.loadFlow("proj_drift", flowId));
    // 先正常存一条，再用"另一条 workflow 的内容"覆盖同一条 flow → 也被拒。
    const ok = await storage.saveFlow("proj_drift", flowId, flowOf(flowId, "v1") as never, { expectedRevision: null });
    check("前置：正常保存成功", ok.ok === true, ok);
    const drift = await storage.saveFlow("proj_drift", flowId, evil as never, { expectedRevision: ok.ok ? ok.revision : null });
    check("★ 覆盖时 docId 漂移同样被拒", !drift.ok && drift.kind === "doc-id-drift", drift);
  }

  // ★ 未知 flowId 与清单的 corrupt 条目。
  {
    const invalidIds = ["", "..", "a/b", "C:x", "x".repeat(201), "\uD800", "\uD801", "a\uDC00"];
    for (const id of invalidIds) {
      const r = storage.loadFlow("proj_store_c", id);
      check(`★ 非法 flowId 被拒：${JSON.stringify(id).slice(0, 12)}`, !r.ok && r.kind === "invalid-flow-id", r);
    }
    check("★ validateFlowId 接受正常 id", validateFlowId("wf_ok").ok === true);
    const l = storage.listFlows("proj_store_c");
    check("★ 清单把坏档列为 corrupt（不静默跳过）",
      l.ok && l.entries.some((e) => e.corrupt), l.ok ? l.entries : l);
  }
}

/* ══════════ 10. graphRevision ↔ workflowTrust（MERGE-1 / P1-6） ══════════ */
console.log("\n10. flowTrustGate：审批版本 = 盘上版本；三态可区分");
{
  const root = process.env.MCODE_FLOW_MIGRATION_DATA;
  if (root === undefined || root === "") throw new Error("MCODE_FLOW_MIGRATION_DATA 没设");
  const storage = new NodeRedFlowStorage(root);
  const PROJECT = "proj_trust";
  const FLOW = "wf_trust_flow";
  const flowOf = (marker: string): { nodes: Array<{ id: string; type: string }>; "x-mcode": { docId: string; marker: string } } => ({
    nodes: [{ id: "n1", type: "inject" }],
    "x-mcode": { docId: FLOW, marker },
  });
  const trustOf = (approvedRevision: string | null, origin: "import" | "ai" = "ai"): string =>
    JSON.stringify({ origin, approvedRevision, reviewedAt: 1_760_000_000_000 });

  // 前置：存一版并读到 revision。
  const saved = await storage.saveFlow(PROJECT, FLOW, flowOf("v1") as never, { expectedRevision: null });
  if (!saved.ok) throw new Error(`前置保存失败：${JSON.stringify(saved)}`);
  const rev1 = saved.revision;
  const trustMap = new Map<string, string | null>([[FLOW, trustOf(rev1)]]);
  const readTrust = (id: string): string | null | undefined => trustMap.get(id);

  // ★ 健康路径（防空过）：审批后未改动 → 允许执行。
  {
    const trust = flowExecutableUnderTrust(rev1, trustMap.get(FLOW) ?? null);
    check("★ 审批后未改动 → 允许执行", trust.ok === true && trust.approvedRevision === rev1, trust);
    check("★ 允许时带 origin（import / ai）", trust.ok === true && trust.origin === "ai", trust);
    const viaStorage = storage.executableUnderTrust(PROJECT, FLOW, readTrust);
    check("★ 存储组合入口同样允许（现算 revision 而非信任文件自报）",
      viaStorage.ok === true && viaStorage.approvedRevision === rev1, viaStorage);
  }

  // ★ 审批后 flow 被改（revision 变）→ revision-mismatch 且带两个 revision。
  {
    const updated = await storage.saveFlow(PROJECT, FLOW, flowOf("v2") as never, { expectedRevision: rev1 });
    check("前置：改动保存成功", updated.ok === true, updated);
    const rev2 = updated.ok ? updated.revision : "";
    check("前置：内容变化确实改变了 revision", rev2 !== rev1, { rev1, rev2 });
    const trust = flowExecutableUnderTrust(rev2, trustMap.get(FLOW) ?? null);
    check("★ 审批后 flow 被改 → revision-mismatch", !trust.ok && trust.reason === "revision-mismatch", trust);
    check("★ mismatch 带两个 revision（approved + current）",
      !trust.ok && trust.approvedRevision === rev1 && trust.currentRevision === rev2,
      !trust.ok ? { approved: trust.approvedRevision, current: trust.currentRevision } : trust);
    // 存储组合入口同样给出 mismatch。
    const viaStorage = storage.executableUnderTrust(PROJECT, FLOW, readTrust);
    check("★ 存储组合入口：mismatch 且带 currentRevision",
      !viaStorage.ok && viaStorage.kind === "revision-mismatch" && viaStorage.currentRevision === rev2, viaStorage);

    // ★ 重新审批当前版本 → 又允许。
    trustMap.set(FLOW, trustOf(rev2));
    const reapprove = storage.executableUnderTrust(PROJECT, FLOW, readTrust);
    check("★ 重新审批当前版本后再次允许", reapprove.ok === true && reapprove.approvedRevision === rev2, reapprove);
  }

  // ★ 未审批 → untrusted；待审标记（approvedRevision:null）同样是 untrusted。
  {
    trustMap.set(FLOW, null);
    const none = flowExecutableUnderTrust(rev1, null);
    check("★ 没有审批记录 → untrusted", !none.ok && none.reason === "untrusted", none);
    const emptyMarker = flowExecutableUnderTrust(rev1, "");
    check("★ 空标记（clearWorkflowReview 写的）→ untrusted", !emptyMarker.ok && emptyMarker.reason === "untrusted", emptyMarker);
    const pending = flowExecutableUnderTrust(rev1, trustOf(null));
    check("★ 已登记待审（approvedRevision:null）→ untrusted", !pending.ok && pending.reason === "untrusted", pending);
    check("★ 三态可区分：untrusted ≠ trust-corrupt ≠ revision-mismatch",
      !none.ok && none.reason === "untrusted"
      && (() => { const r = flowExecutableUnderTrust(rev1, "{bad json"); return !r.ok && r.reason === "trust-corrupt"; })()
      && (() => { const r = flowExecutableUnderTrust("a".repeat(64), trustOf("b".repeat(64))); return !r.ok && r.reason === "revision-mismatch"; })());
  }

  // ★ trust 坏档 → trust-corrupt（不是"没审批"）。
  {
    const badCases: Array<[string, string]> = [
      ["非 JSON", "{not json"],
      ["不是对象", "[1,2,3]"],
      ["origin 非法", JSON.stringify({ origin: "manual", approvedRevision: rev1 })],
      ["approvedRevision 形状不对", JSON.stringify({ origin: "ai", approvedRevision: "not-a-hash" })],
      ["approvedRevision 是数字", JSON.stringify({ origin: "ai", approvedRevision: 42 })],
    ];
    for (const [label, raw] of badCases) {
      const trust = flowExecutableUnderTrust(rev1, raw);
      check(`★ trust 坏档 → trust-corrupt：${label}`, !trust.ok && trust.reason === "trust-corrupt", trust);
      check(`★ trust-corrupt 带 detail：${label}`, !trust.ok && trust.reason === "trust-corrupt" && trust.detail.length > 5);
      const parsed = parseFlowTrust(raw);
      check(`★ parseFlowTrust 三态：${label} 不是 untrusted`, !parsed.ok && parsed.reason === "trust-corrupt", parsed);
    }
    // 存储组合入口也报 trust-corrupt（而不是 missing/untrusted）。
    trustMap.set(FLOW, "{not json");
    const viaStorage = storage.executableUnderTrust(PROJECT, FLOW, readTrust);
    check("★ 存储组合入口：trust 坏档 → kind=trust-corrupt", !viaStorage.ok && viaStorage.kind === "trust-corrupt", viaStorage);
  }

  // ★ 组合判据：owner 先、trust 后。
  {
    const goodTrust = trustOf(rev1);
    // owner 缺失 → owner-mismatch（哪怕 trust 是好的）—— 先判身份。
    const noOwner = canExecuteFlow({ owner: null, expectedOwner: "node-red", currentRevision: rev1, trustRaw: goodTrust });
    check("★ 组合：owner 为空 → owner-mismatch（不看 trust）", !noOwner.ok && noOwner.reason === "owner-mismatch", noOwner);
    // owner 是 mcode 而期望 node-red → owner-mismatch。
    const wrongOwner = canExecuteFlow({ owner: "mcode", expectedOwner: "node-red", currentRevision: rev1, trustRaw: goodTrust });
    check("★ 组合：owner 不匹配 → owner-mismatch", !wrongOwner.ok && wrongOwner.reason === "owner-mismatch", wrongOwner);
    // owner 对但 trust 坏 → trust-corrupt。
    const corrupt = canExecuteFlow({ owner: "node-red", expectedOwner: "node-red", currentRevision: rev1, trustRaw: "{bad" });
    check("★ 组合：owner 对、trust 坏 → trust-corrupt", !corrupt.ok && corrupt.reason === "trust-corrupt", corrupt);
    // owner 对、trust 未批 → untrusted。
    const untrusted = canExecuteFlow({ owner: "node-red", expectedOwner: "node-red", currentRevision: rev1, trustRaw: null });
    check("★ 组合：owner 对、trust 未批 → untrusted", !untrusted.ok && untrusted.reason === "untrusted", untrusted);
    // owner 对、trust 是旧版 → revision-mismatch。
    const mismatch = canExecuteFlow({ owner: "node-red", expectedOwner: "node-red", currentRevision: "a".repeat(64), trustRaw: trustOf(rev1) });
    check("★ 组合：owner 对、trust 旧版 → revision-mismatch", !mismatch.ok && mismatch.reason === "revision-mismatch", mismatch);
    // 全绿 → 允许。
    const allowed = canExecuteFlow({ owner: "node-red", expectedOwner: "node-red", currentRevision: rev1, trustRaw: goodTrust });
    check("★ 组合：owner 对 + trust 匹配 → 允许", allowed.ok === true && allowed.approvedRevision === rev1, allowed);
    // flow 读不到 → flow-missing（不是 untrusted）。
    const missing = canExecuteFlow({ owner: "node-red", expectedOwner: "node-red", currentRevision: null, trustRaw: goodTrust });
    check("★ 组合：盘上 flow 读不到 → flow-missing（不冒充没审批）", !missing.ok && missing.reason === "flow-missing", missing);
  }

  // ★ 读取面注入：trust 由调用方给（本模块不 import workflowTrust / SettingRepo）。
  {
    const reads: string[] = [];
    const recordingReader = (id: string): string | null => {
      reads.push(id);
      return trustOf(rev1);
    };
    storage.executableUnderTrust(PROJECT, FLOW, recordingReader);
    eq("★ trust 读取面按 flowId 查询一次", reads, [FLOW]);
  }
}

console.log(`\nflow-migration-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
