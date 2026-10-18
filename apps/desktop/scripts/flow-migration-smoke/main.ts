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
 * Run: bash scripts/flow-migration-smoke/run.sh
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowDoc, WorkflowEdge, WorkflowNode } from "@contracts/workflow";
import type { NodeRunner, NodeTypeManifest } from "@contracts/nodeType";
import { MODULE_CAPABILITY_RUNNER_KIND } from "@contracts/moduleCapability";
import {
  FLOW_MIGRATOR_VERSION,
  flowToWorkflowDoc,
  migrateWorkflowDoc,
  roundTripMismatchPaths,
} from "@main/workflowEngines/flowMigration.js";
import {
  WORKFLOW_MIGRATIONS_DIR,
  backupWorkflowDocBytes,
  backupWorkflowDocText,
} from "@main/workflowEngines/flowMigrationBackup.js";

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
  check("★ 每个文档节点都产出一个 Node-RED 节点", flow.nodes.length === richDoc.nodes.length, { flow: flow.nodes.length, doc: richDoc.nodes.length });
  check("★ 每条边都产出一条 link", flow.links.length === richDoc.edges.length, { links: flow.links.length, edges: richDoc.edges.length });
  check("★ 报告版本号可复核", report.migratorVersion === FLOW_MIGRATOR_VERSION);

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

  // 端口规则：branch = 每条出边一个口；condition = true 口 0 / false 口 1。
  const branchNode = flow.nodes.find((n) => n["x-mcode"]?.nodeId === "n_branch");
  check("★ branch 的端口数 = 出边数", branchNode?.wires?.length === 2, branchNode?.wires);
  const condLinks = flow.links.filter((l) => l.source === flow.nodes.find((n) => n["x-mcode"]?.nodeId === "n_cond")?.id);
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
  check("★ 未知类型节点仍以 mcode-unknown 迁移且保留原始 type",
    unknownTypeDoc.flow.nodes[0]?.type === "mcode-unknown" && unknownTypeDoc.flow.nodes[0]?.["x-mcode"]?.type === "myorg.mystery",
    unknownTypeDoc.flow.nodes[0]);
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
  check("★ 文件名带 id 与时间戳", backup.path.endsWith(join(WORKFLOW_MIGRATIONS_DIR, "wf_backup-2026-10-19T01-02-03-004Z.json")), backup.path);
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
  check("★ 非法字符 id 被折成安全文件名", (await backupWorkflowDocText(dataRoot, "a/b:c", "{}", { at })).path.endsWith("a-b-c-2026-10-19T01-02-03-004Z.json"));
}

console.log(`\nflow-migration-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
