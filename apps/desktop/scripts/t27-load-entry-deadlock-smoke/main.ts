/**
 * T27 — 「库 → Node-RED 画布」装载入口不再拒绝一切可保存的图。
 *
 * ## T8 实测的缺陷（不是推测）
 *
 * 生产装载入口 `loadWorkflowIntoNative` 在迁移预检之后再跑一道**更严**的判据：
 * `migrateWorkflowDoc` 的报告里只要有 `lossy` / `needsHumanDecision` 条目就拒绝，
 * 且没有任何确认路径。而**任何能保存的图**都会触发这些条目：
 *
 *   - 保存闸门（`workflowValidation` + `deriveTrigger`）要求普通图恰好一个
 *     `mcode.main`、自动化至少一个触发器节点 —— 这是**旧调度器**的入口要求；
 *   - 迁移器对 `mcode.main`（conversation runner）必报 needs-human-decision，
 *     对每个触发器必报 lossy（manual/schedule→inject）或 needs-human-decision
 *     （event → mcode-trigger），`mcode.agent` 带产出契约时另有 lossy。
 *
 * 于是"可保存"与"可装载"两个集合的交集为空 —— 联合类型的死亡。
 *
 * ## 本套件钉住的行为（T27 之后的契约）
 *
 * 1. **普通 trigger 工作流**（manual 与 schedule 各一）走**生产函数**成功装载，且
 *    画布/装载记录里就是迁移器的产物；
 * 2. 首次装载前要求**一次确认**，确认文案**点名具体损失**（不是"两者冲突"）；
 * 3. **含 Mcode 特有节点**（condition、code、branch-model、module-capability…）的图：
 *    已知损失同样只升确认，确认后装载；
 * 4. **真正不可迁移的**（未知节点类型 → 预检 REJECT）仍被拒，理由可读；
 * 5. **HUMAN 的审批/在途事实**仍要求确认（T21 的判据没有被放宽）；
 * 6. 真 `node-red@5.0.8` 引擎：把两次生产装载写出的画布**真的启动并读回**
 *    （`GET /flows`），节点/类型/连线都在 —— 这不是"迁移器自测"，是画布真跑。
 *
 * ## 隔离
 *
 * 全部落在 `mkdtemp` 出来的临时数据根；不起 Electron；真引擎用仓库 vendor 的
 * `node-red/`（`resolveNodeRedPackage` 生产解析，`resourcesPath` 指向临时 junction 根），
 * 未安装时显式 SKIP 并以 0 退出（全量套件在无网机器上不能红）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDoc } from "@contracts/workflow";
import type { NodeTypeManifest } from "@contracts/nodeType";
import { initDb } from "@main/store/db.js";
import { WorkflowRepo } from "@main/store/repositories.js";
import { loadNodeTypes } from "@main/orchestration/nodeTypes.js";
import { saveWorkflow } from "@main/orchestration/library.js";
import { workflowReviewOf } from "@main/orchestration/workflowTrust.js";
import { loadWorkflowIntoNative, type NativeLoadPorts } from "@main/workflowEngines/nativeLibraryLoad.js";
import { migrateWorkflowDoc } from "@main/workflowEngines/flowMigration.js";
import { evaluateWorkflowMigration } from "@main/workflowEngines/workflowMigrationGate.js";
import { NodeRedFlowStorage, FLOWS_SUBDIR, safeFlowFileName, readNativeCanvas } from "@main/workflowEngines/nodeRedStorage.js";
import {
  EngineRuntime,
  defaultEngineRuntimePorts,
  createEngineLaunchSpec,
  type EngineRuntimeStatus,
} from "@main/workflowEngines/runtimeSupervisor.js";
import { createInMemoryExecutorOwnership } from "@main/workflowEngines/executorOwnership.js";
import { ProductionWorkflowEngineRegistry, OwnedNodeRedRuntime } from "@main/workflowEngines/registry.js";
import { ensureNodePack } from "@main/workflowEngines/nodePackManifest.js";

let total = 0;
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  total++;
  if (ok) console.log("  ok   " + name);
  else {
    failures++;
    console.error("  FAIL " + name + (detail === undefined ? "" : " — " + JSON.stringify(detail)));
  }
}

const dataRoot = process.env.MCODE_SMOKE_DATA_ROOT;
if (!dataRoot) throw new Error("MCODE_SMOKE_DATA_ROOT 没设（见 run.sh）");
mkdirSync(join(dataRoot, "workflows", "node-types"), { recursive: true });

/* ══════════ 夹具：真实的主进程类型表 + 真的过保存闸门 ══════════ */

await initDb();
const types = new Map((await loadNodeTypes()).entries.map((entry) => [entry.id, entry.manifest]));
const node = (
  id: string, type: string, title: string, params: Record<string, unknown>, x = 100,
): WorkflowDoc["nodes"][number] =>
  ({ id, type, title, params, position: { x, y: 100 } }) as WorkflowDoc["nodes"][number];
const edge = (id: string, from: string, to: string, label?: string): WorkflowDoc["edges"][number] =>
  ({ id, from, to, ...(label === undefined ? {} : { label }) }) as WorkflowDoc["edges"][number];

/** ① 普通自动化：manual 触发器 → 两个子 agent。保存闸门接受（触发器存在、无主节点要求）。 */
function manualTriggerDoc(id: string): WorkflowDoc {
  return {
    id, engine: "node-red", name: "T27 普通触发器自动化", builtin: false, trigger: "manual", updatedAt: 1,
    nodes: [
      node("t", "mcode.trigger", "入口", { triggerKind: "manual", task: "跑一下 T27", project: "proj_t27" }),
      node("a1", "mcode.agent", "检查", { instruction: "检查 README" }, 320),
      node("a2", "mcode.agent", "汇总", { instruction: "压成一句话" }, 540),
    ],
    edges: [edge("e1", "t", "a1"), edge("e2", "a1", "a2")],
  };
}

/** ② 定时自动化：schedule 触发器 → 条件 → 子 agent（condition 必有 true/false 两出边）。 */
function scheduleConditionDoc(id: string): WorkflowDoc {
  return {
    id, engine: "node-red", name: "T27 定时+条件自动化", builtin: false, trigger: "schedule", updatedAt: 2,
    nodes: [
      node("t", "mcode.trigger", "定时", { triggerKind: "schedule", cron: "0 9 * * *", task: "晨报", project: "proj_t27" }),
      // 条件引用的是**触发器载荷**（可用键由 triggerFactKeysOf 给出：kind / at）。
      node("c", "mcode.condition", "判", { expression: { logic: "and", rules: [{ ref: "{{trigger.kind}}", op: "exists" }] } }, 320),
      node("a1", "mcode.agent", "True 分支", { instruction: "有结果时做这个" }, 540),
      node("a2", "mcode.agent", "False 分支", { instruction: "没结果时做那个" }, 540),
    ],
    edges: [edge("e1", "t", "c"), edge("e2", "c", "a1", "true"), edge("e3", "c", "a2", "false")],
  };
}

/** ③ 含 Mcode 特有节点：branch(decider=model) + module-capability + code(node)。 */
function mcodeSpecificDoc(id: string): WorkflowDoc {
  return {
    id, engine: "node-red", name: "T27 Mcode 特有节点", builtin: false, trigger: "manual", updatedAt: 3,
    nodes: [
      node("t", "mcode.trigger", "入口", { triggerKind: "manual", task: "分流", project: "proj_t27" }),
      node("b", "mcode.branch", "模型选路", { decider: "model", prompt: "选最合适的一条" }, 320),
      node("m", "mcode.module-capability", "读文件", { moduleId: "core.file-report", contributionId: "inspect", path: "README.md" }, 540),
      node("code", "mcode.code", "脚本", { language: "node", code: "return msg;" }, 760),
    ],
    edges: [
      edge("e1", "t", "b"),
      edge("e2", "b", "m", "读文件"),
      edge("e3", "b", "code", "脚本"),
    ],
  };
}

/** ④ 真正不可迁移：未知节点类型（且无论怎么确认都不许放行）。 */
function unknownTypeDoc(id: string): WorkflowDoc {
  return {
    id, engine: "node-red", name: "T27 未知节点", builtin: false, trigger: "manual", updatedAt: 4,
    nodes: [
      node("t", "mcode.trigger", "入口", { triggerKind: "manual", task: "x", project: "proj_t27" }),
      node("u", "vendor.mystery-node", "未知", {}),
    ],
    edges: [edge("e1", "t", "u")],
  };
}

/** 所有夹具先过**真的**保存闸门 —— 它们必须是"用户可保存的图"，否则本卡的前提不成立。 */
const fixtures = [manualTriggerDoc("wf_t27_manual"), scheduleConditionDoc("wf_t27_schedule"), mcodeSpecificDoc("wf_t27_specific")];
for (const doc of fixtures) {
  const saved = await saveWorkflow(doc);
  check(`前置：夹具「${doc.name}」本身能被保存闸门接受（否则测的不是"可保存的图"）`, saved.ok, saved);
}
/** 库里存下的那一版（保存闸门会归一化：deriveTrigger 等）；没有就返回原夹具 ——
 *  上面的前置断言已经报红，后续段落不该再因为读空而崩。 */
function storedDoc(doc: WorkflowDoc): WorkflowDoc {
  return WorkflowRepo.get(doc.id)?.doc ?? doc;
}

/* ══════════ 生产装载入口的判定（假运行时 + 真磁盘） ══════════ */

interface Harness {
  dir: string;
  ports: NativeLoadPorts;
  starts: () => number;
  facts: { review: ReturnType<typeof workflowReviewOf>; inFlightWorkflowIds: ReadonlySet<string> };
  /** 最后一次真实交给 runtime.start 的原生节点（生产入口写的画布就是从这来的）。 */
  lastStartFlows: () => unknown;
}
function harnessDocs(docs: WorkflowDoc[]): Harness {
  const dir = mkdtempSync(join(tmpdir(), "mcode-t27-"));
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  // 保存闸门会归一化（deriveTrigger 等）；装载读的是**库里存下的那一版**。
  const stored = new Map<string, WorkflowDoc>();
  for (const doc of docs) {
    const row = WorkflowRepo.get(doc.id);
    stored.set(doc.id, row === null ? doc : row.doc);
  }
  let status: EngineRuntimeStatus = { engineId: "node-red", state: "stopped", port: null, reason: null };
  let starts = 0;
  const facts: Harness["facts"] = { review: null, inFlightWorkflowIds: new Set<string>() };
  const ports: NativeLoadPorts = {
    get: (id) => stored.get(id) ?? byId.get(id) ?? null,
    types: async () => new Map(types),
    dataDir: () => dir,
    migrationFacts: () => facts,
    runtime: {
      status: () => status,
      stop: async () => {
        status = { engineId: "node-red", state: "stopped", port: null, reason: null };
        return status;
      },
      start: async () => {
        starts++;
        status = { engineId: "node-red", state: "running", port: 12345, reason: null };
        return status;
      },
    },
    beforeStart: async () => {},
    launchSpec: () => ({ command: "fake-node", dataDir: dir, args: () => [] }),
  };
  return {
    dir, ports, facts, starts: () => starts,
    lastStartFlows: () => {
      const bytes = readNativeCanvas(dir);
      return bytes === null ? null : JSON.parse(bytes);
    },
  };
}

/* ══════════ 1. 普通 trigger 工作流：确认一次后真的装进去 ══════════ */
{
  const doc = manualTriggerDoc("wf_t27_manual");
  const stored = storedDoc(doc);
  const h = harnessDocs([doc]);
  try {
    // 先证明这个夹具在**旧判据**下必被拒：迁移器报告确实非空、预检不 REJECT。
    const migrated = migrateWorkflowDoc(stored, { types });
    const evaluation = evaluateWorkflowMigration({ doc: stored, types, facts: { review: null, inFlightWorkflowIds: new Set() } });
    check("★ 前提：普通 trigger 图迁移器确实报已知损失（旧代码正因此拒绝一切）",
      migrated.report.lossy.length > 0 || migrated.report.needsHumanDecision.length > 0,
      { lossy: migrated.report.lossy.length, human: migrated.report.needsHumanDecision.length });
    check("★ 前提：预检对它不 REJECT（HUMAN 只要求人工看一眼）",
      evaluation.decision === "HUMAN" && evaluation.reasons.every((r) => r.severity !== "reject"), evaluation);

    const first = await loadWorkflowIntoNative("wf_t27_manual", h.ports, false);
    check("★ 首次装载：要求一次确认（不再直接拒绝）",
      first.ok === false && first.requiresConfirmation === true, first);
    check("★ 确认文案点名具体损失（trigger 的 debounce/项目/task 留在 x-mcode.params）",
      first.ok === false && first.reason.includes("不会由 Node-RED 原生表达") && first.reason.includes("debounceMs"), first);
    check("★ 未确认前不动画布、不启动引擎", h.starts() === 0 && readNativeCanvas(h.dir) === null);

    const second = await loadWorkflowIntoNative("wf_t27_manual", h.ports, true);
    check("★ 用户确认后普通 trigger 图成功装载到 Node-RED 画布", second.ok === true, second);
    const canvas = h.lastStartFlows() as Array<Record<string, unknown>> | null;
    const canvasTypes = (canvas ?? []).map((n) => n["type"]);
    check("★ 画布上就是迁移器产物：tab + inject + 两个 mcode-agent",
      Array.isArray(canvas) && canvasTypes.join(",") === "tab,inject,mcode-agent,mcode-agent", canvasTypes);
    check("★ tab 的 x-mcode.docId 绑定这份文档（库镜像/归属都靠它）",
      (canvas?.[0] as { "x-mcode"?: { docId?: string } })?.["x-mcode"]?.docId === "wf_t27_manual",
      (canvas?.[0] as Record<string, unknown> | undefined)?.["x-mcode"]);
    const journal = new NodeRedFlowStorage(h.dir).loadFlow(null, "wf_t27_manual");
    check("★ 生产装载记录同步写出（NodeRedFlowStorage 路径仍被执行）",
      journal.ok && existsSync(join(h.dir, FLOWS_SUBDIR, `${safeFlowFileName("wf_t27_manual")}.json`)), journal);

    // 第二次装载（画布已是它自己）：画布未变时不再为"替换画布"要确认；但预检的
    // HUMAN（触发语义未证明等价）是**对文档本身**的判据，按 T21 契约仍需确认一次。
    // T27 只负责把"已知损失"从拒绝改为可确认 —— 这里钉住确认文案不再重复要求。
    const again = await loadWorkflowIntoNative("wf_t27_manual", h.ports, false);
    check("★ 同一文档再次装载：画布未变，但 HUMAN 预检仍要求确认（T21 判据未放宽）",
      again.ok === false && again.requiresConfirmation === true && again.reason.includes("迁移预检要求人工确认"), again);
    const againConfirmed = await loadWorkflowIntoNative("wf_t27_manual", h.ports, true);
    check("★ 再次确认后成功（没有「必须保存新版本才能再装」的死循环）", againConfirmed.ok === true, againConfirmed);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
}

/* ══════════ 2. 含 Mcode 特有节点：已知损失 → 一次确认 → 装载 ══════════ */
{
  const docs = [scheduleConditionDoc("wf_t27_schedule"), mcodeSpecificDoc("wf_t27_specific")];
  const h = harnessDocs(docs);
  try {
    for (const doc of docs) {
      const stored = storedDoc(doc);
      const migrated = migrateWorkflowDoc(stored, { types });
      const lossyNodes = new Set(migrated.report.lossy.map((i) => i.nodeId));
      const humanNodes = new Set(migrated.report.needsHumanDecision.map((i) => i.nodeId));
      check(`★「${doc.name}」迁移器报出已知损失/裁决（condition/trigger/branch 等）`,
        lossyNodes.size + humanNodes.size > 0, { lossy: [...lossyNodes], human: [...humanNodes] });

      const confirm = await loadWorkflowIntoNative(doc.id, h.ports, false);
      check(`★「${doc.name}」未确认时：requiresConfirmation + 可读理由（点名节点）`,
        confirm.ok === false && confirm.requiresConfirmation === true
        && /（节点 |主代理|触发器|condition|branch|code|trigger/.test(confirm.reason), confirm);
      // 确认文案必须列出**具体**损失（不是只说"两者冲突"）——这是 T27 的验收判据之一。
      check(`★「${doc.name}」确认文案列出具体不会原生表达的内容（x-mcode.params 保留）`,
        confirm.ok === false && confirm.reason.includes("不会由 Node-RED 原生表达")
        && confirm.reason.includes("x-mcode.params"), confirm);
      const loaded = await loadWorkflowIntoNative(doc.id, h.ports, true);
      check(`★「${doc.name}」确认后装载成功`, loaded.ok === true, loaded);
      const canvas = h.lastStartFlows() as Array<Record<string, unknown>>;
      check(`★「${doc.name}」画布含 Mcode 节点包类型（mcode-branch / mcode-module-capability 等不丢）`,
        canvas.some((n) => String(n["type"]).startsWith("mcode-")) || canvas.some((n) => n["type"] === "function" || n["type"] === "switch"),
        canvas.map((n) => n["type"]));
    }
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
}

/* ══════════ 3. 真正不可迁移的仍被拒（confirmReplace 不是后门） ══════════ */
{
  const doc = unknownTypeDoc("wf_t27_unknown");
  const h = harnessDocs([doc]);
  try {
    const refused = await loadWorkflowIntoNative("wf_t27_unknown", h.ports, true);
    check("★ 未知节点类型：无论确认与否都拒绝（REJECT）",
      refused.ok === false && refused.requiresConfirmation !== true, refused);
    check("★ 拒绝理由可读：点名缺失的类型与判据来源（迁移预检 / unmapped）",
      refused.ok === false && refused.reason.includes("迁移预检") && refused.reason.includes("vendor.mystery-node"), refused);
    check("★ REJECT 不碰引擎、不写画布", h.starts() === 0 && readNativeCanvas(h.dir) === null);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
}

/* ══════════ 4. T21 的审批/在途判据没有被放宽 ══════════ */
{
  const doc = manualTriggerDoc("wf_t27_pending");
  const h = harnessDocs([doc]);
  try {
    h.facts.review = { origin: "import", revision: "b".repeat(64), pending: true };
    const pending = await loadWorkflowIntoNative("wf_t27_pending", h.ports, false);
    check("★ 待审文档：仍要求确认（HUMAN 判据原样保留）",
      pending.ok === false && pending.requiresConfirmation === true
      && pending.reason.includes("迁移预检要求人工确认") && pending.reason.includes("approval-pending"), pending);
    h.facts.review = null;
    h.facts.inFlightWorkflowIds = new Set(["wf_t27_pending"]);
    const running = await loadWorkflowIntoNative("wf_t27_pending", h.ports, false);
    check("★ 正在执行中的文档：仍要求确认（不迁移在跑的图）",
      running.ok === false && running.requiresConfirmation === true && running.reason.includes("workflow-in-flight"), running);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
}

/* ══════════ 5. 真 node-red@5.0.8：生产装载写出的画布真的启动并读回 ══════════ */
const repoRoot = process.cwd().replace(/[\\/]apps[\\/]desktop$/, "");
const vendor = join(repoRoot, "node-red");
const vendorPkg = join(vendor, "packages", "node_modules", "node-red", "package.json");
if (!existsSync(vendorPkg)) {
  console.log("SKIP: 仓库 vendor node-red 缺失 —— 真引擎段跳过（不是失败）。期望 " + vendorPkg);
} else {
  const version = (JSON.parse(readFileSync(vendorPkg, "utf8")) as { version?: string }).version;
  if (version !== "5.0.8") {
    check(`★ 真引擎段要求的 vendor 版本是 5.0.8（实际 ${String(version)}）`, false);
  } else {
    // resourcesPath → 只含 node-red junction 的临时根；走生产 resolveNodeRedPackage。
    const resources = join(dataRoot, "t27-resources");
    mkdirSync(resources, { recursive: true });
    const staged = join(resources, "node-red");
    if (!existsSync(staged)) symlinkSync(vendor, staged, process.platform === "win32" ? "junction" : "dir");
    const originalResources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(process, "resourcesPath", { configurable: true, value: resources });

    const engineDir = join(dataRoot, "workflow-engines", "node-red");
    mkdirSync(engineDir, { recursive: true });
    let runtime: OwnedNodeRedRuntime | null = null;
    try {
      // 1) 先让生产装载入口把这个夹具的迁移产物写进 engineDir 的 flows.json。
      const doc = manualTriggerDoc("wf_t27_manual");
      const h = harnessDocs([doc]);
      const ports: NativeLoadPorts = { ...h.ports, dataDir: () => engineDir };
      const loaded = await loadWorkflowIntoNative("wf_t27_manual", ports, true);
      check("★ 真引擎段前置：生产装载入口写出画布", loaded.ok === true, loaded);
      const written = readNativeCanvas(engineDir);
      check("★ 真引擎段前置：flows.json 已落盘且含 tab/inject/mcode-agent",
        written !== null && ["tab", "inject", "mcode-agent"].every((t) => written.includes(`"${t}"`)),
        written === null ? null : written.slice(0, 200));
      rmSync(h.dir, { recursive: true, force: true });

      // 2) 生产注册表的 launchSpec（真 bootstrap.cjs + vendor 解析 + adminAuth +
      //    节点包清单）。engineDir 与上面写 flows.json 的目录是同一个（dataRoot 派生）。
      const registry = new ProductionWorkflowEngineRegistry(defaultEngineRuntimePorts, createInMemoryExecutorOwnership());
      check("★ 真引擎段前置：注册表引擎目录就是装载写画布的目录", registry.dataDirOf("node-red") === engineDir,
        { registry: registry.dataDirOf("node-red"), engineDir });
      const launch = registry.launchSpec("node-red");
      check("★ 真引擎段前置：生产注册表 launchSpec 解析到 vendor node-red",
        launch !== null && launch.env?.NODE_PATH?.includes("node-red") === true, launch?.env?.NODE_PATH);
      if (launch === null) throw new Error("launchSpec 返回 null（vendor / 节点包 / 引导脚本其一不可用）");
      check("★ 真引擎段前置：生产 bootstrap 落盘", existsSync(join(engineDir, "bootstrap.cjs")));
      const pack = ensureNodePack(engineDir, "node-red");
      check("★ 真引擎段前置：Mcode 节点包由生产清单铺进引擎数据目录", pack.ok, pack);

      // 3) 真启动（生产 OwnedNodeRedRuntime + 生产端口分配 + 真探针），读回画布。
      const runtimeOwner = createInMemoryExecutorOwnership();
      runtime = new OwnedNodeRedRuntime("node-red", defaultEngineRuntimePorts, runtimeOwner);
      const status = await runtime.start({
        engineId: "node-red",
        dataDir: launch.dataDir,
        command: launch.command,
        args: launch.args,
        ...(launch.env !== undefined ? { env: launch.env } : {}),
        ...(launch.probeIdentity !== undefined ? { probeIdentity: launch.probeIdentity } : {}),
        readyTimeoutMs: 30_000,
      });
      check("★ 真 node-red@5.0.8 引擎经生产路径就绪", status.state === "running" && status.port !== null, status);
      if (status.state === "running" && status.port !== null) {
        const token = launch.env?.MCODE_ENGINE_ADMIN_TOKEN ?? "";
        const res = await fetch(`http://127.0.0.1:${status.port}/flows`, {
          headers: { authorization: `Bearer ${token}`, "Node-RED-API-Version": "v2" },
          signal: AbortSignal.timeout(15_000),
        });
        const readFlows = (await res.json() as { flows?: Array<Record<string, unknown>> }).flows ?? [];
        const readTypes = [...new Set(readFlows.map((n) => n["type"]))].sort();
        check("★ 真引擎 GET /flows 读回生产装载写出的图", res.status === 200 && readFlows.length > 0, { status: res.status, readTypes });
        check("★ 读回里 tab/inject/mcode-agent 全在（Mcode 节点包真的注册了，不是 unknown）",
          readTypes.includes("tab") && readTypes.includes("inject") && readTypes.includes("mcode-agent"), readTypes);
        const readTab = readFlows.find((n) => n["type"] === "tab") as { "x-mcode"?: { docId?: string } } | undefined;
        check("★ 读回里 tab 仍绑定 docId（引擎侧身份不丢）", readTab?.["x-mcode"]?.docId === "wf_t27_manual", readTab?.["x-mcode"]);
        const inject = readFlows.find((n) => n["type"] === "inject") as Record<string, unknown> | undefined;
        check("★ 读回里 inject 保留迁移器写入的 once 语义（manual 触发器）", inject?.["once"] === true, inject);
      }
    } finally {
      if (runtime !== null) {
        try { await runtime.stop(2_000); } catch { /* 已停 */ }
      }
      if (originalResources) Object.defineProperty(process, "resourcesPath", originalResources);
      else Reflect.deleteProperty(process, "resourcesPath");
    }
  }
}

console.log(`\nt27-load-entry-deadlock-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
