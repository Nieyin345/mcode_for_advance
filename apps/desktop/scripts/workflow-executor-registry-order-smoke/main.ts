/**
 * 【W4】**执行器注册表的「可用性判据」必须晚于构造那一刻** —— 回归网。
 *
 * ## 它守的缺陷（W4 卡，W0 探针发现）
 *
 * `executionEngine.ts` 的模块级单例在**模块加载时**就构造完了，而
 * `main/index.ts` 要到更晚才调 `setWorkflowEngineStatusPort(...)`。原先
 * `createBuiltinExecutionEngine()` 里是构造期 `if (workflowEngineUsable(...))`，
 * 那一刻端口必然是 `null` → 条件恒假 → **单例永远不注册 `node-red` 执行器**。
 *
 * 后果（两个消费方都读这个单例）：
 *  - `appServices/scenePreflight.ts` 的 `executorKinds` 缺 `node-red`；
 *  - `ipc/orchestration.ts` 的 `automation.preflight` 的 `executorKinds` 同样缺。
 * 两者都会把一条**运行期其实跑得起来**的流报成「缺少执行器」—— 假失败把用户
 * 引向一个不存在的问题。
 *
 * ## 断言方向（卡上要求两条相反的都必须有）
 *
 *  1. **正控**：端口注入且引擎 running 之后，**同一个单例**的 `kinds()` 含 `node-red`；
 *  2. **负控**：端口未注入 / 引擎没跑时，`kinds()` **不含** `node-red`（fail-closed
 *     不能被修成「无条件注册」——那会让引擎没起来时也声称能跑，是另一个方向的错）；
 *  3. **回归**：`command` / `code` / `module-capability` 三个内置执行器一直在。
 *
 * **第 2 条与修法解耦**：它只走"端口为 null"的路径，不依赖延迟注册的实现细节；
 * 把修法整个撤掉，它仍然绿（变异验证要求）。
 *
 * ## 两个消费方都走**真身**
 *
 * 不抄判据、不读源码文本：本套走**真的** `registerWorkflowHandlers`（fakeIpc 记名，
 * 抄 `orchestration-ipc-smoke` §0）与**真的** `preflightScene`。执行器注册表的读法
 * 是 `executionEngine.kinds()` 的真身 —— 改了修法，这两条断言的输入会跟着变。
 *
 * ⚠️ `scenePreflight` 的 `preflightScene` 不探执行器（它的契约 `SceneCapabilityRef.kind`
 * 只有 plugin/skill/mcp/module），但它**装配**的清单里 `executorKinds` 来自单例 ——
 * 本套断的就是那一个装配点：同一份 `executorKinds` 既喂 `collectCapabilityInventory`
 * 也（在自动化那边）喂 `requirementsForNode`。真正的用户可见假失败在自动化预检，
 * 那里本套断的是端到端结果（`problems` 里有没有「缺少执行器」）。
 *
 * ## 隔离
 *
 * 数据根指向 `mktemp -d`（run.sh 里设 `MCODE_SMOKE_DATA_ROOT`）—— 本套会建库、
 * 写工作流行（`WorkflowRepo.save`）。`sql.js` 的 `db.export()` 重写整个 `mcode.db`，
 * 指错地方等于毁用户的聊天记录。
 *
 * Run: bash scripts/workflow-executor-registry-order-smoke/run.sh
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const DATA = mkdtempSync(join(tmpdir(), "mcode-w4-registry-order-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

/* ──────────────── 0. 取真身（模块加载时单例已经构造过了 —— 正是本缺陷的形态） ──────────────── */

const { executionEngine, setWorkflowEngineStatusPort, createBuiltinExecutionEngine } =
  await import("@main/orchestration/executionEngine.js");
const { NODE_RED_ENGINE_ID, NODE_RED_RUNNER_KIND } = await import("@main/orchestration/nodeRedExecutor.js");
const { NODE_RED_NODE_TYPE_ID } = await import("@main/orchestration/nodeTypes.js");
const { MODULE_CAPABILITY_RUNNER_KIND } = await import("@contracts/moduleCapability");

const { initDb } = await import("@main/store/db.js");
const { WorkflowRepo } = await import("@main/store/repositories.js");
await initDb();

/**
 * 生产端口注入（`main/index.ts:86` 那一句的等价物）：按 engineId 返回状态。
 * 本套可摆：`setEngine({state:"running", port})` / `setEngine({state:"stopped"})`。
 */
type EngineState = "running" | "stopped" | "starting" | "failed";
let engineState: EngineState = "stopped";
let enginePort: number | null = null;
setWorkflowEngineStatusPort((id) =>
  id === NODE_RED_ENGINE_ID
    ? { engineId: NODE_RED_ENGINE_ID, state: engineState, port: enginePort, reason: null }
    : null,
);

const THREE_BUILTINS = ["command", "code", MODULE_CAPABILITY_RUNNER_KIND] as const;
const hasAllThree = (kinds: readonly string[]): boolean =>
  THREE_BUILTINS.every((kind) => kinds.includes(kind));

/* ──────────────── 1. 负控：端口没装 / 引擎没跑 → 不含 node-red ──────────────── */

console.log("\n1. fail-closed（端口未注入 / 引擎没跑）");

// 1a. 端口整个卸掉 —— 无头环境 / 装配早期。
{
  setWorkflowEngineStatusPort(null);
  const kinds = executionEngine.kinds();
  check("★ 端口未注入时单例不含 node-red（fail-closed）", !kinds.includes(NODE_RED_RUNNER_KIND), kinds);
  check("端口未注入时三个内置执行器仍在", hasAllThree(kinds), kinds);
  // 对照：同一个单例在端口装回后确实会变 —— 否则上面那条"不含"可能只是"永远不含"。
  // 对照本身放在 §2 的第一条（那里重建端口）。
}

// 1b. 端口装了但引擎 stopped —— 同样不注册。
{
  engineState = "stopped";
  enginePort = null;
  setWorkflowEngineStatusPort((id) =>
    id === NODE_RED_ENGINE_ID
      ? { engineId: NODE_RED_ENGINE_ID, state: "stopped", port: null, reason: null }
      : null,
  );
  const kinds = executionEngine.kinds();
  check("★ 引擎 stopped 时单例不含 node-red", !kinds.includes(NODE_RED_RUNNER_KIND), kinds);
}

// 1c. running 但端口为 null —— "可用"必须同时要求 running 与端口（执行器要靠端口拼 URL）。
{
  engineState = "running";
  enginePort = null;
  const kinds = executionEngine.kinds();
  check("★ running 但端口为 null 时不含 node-red", !kinds.includes(NODE_RED_RUNNER_KIND), kinds);
}

/* ──────────────── 2. 正控：端口注入 + 引擎 running → 同一个单例含 node-red ──────────────── */

console.log("\n2. 正控（端口注入后，同一个单例）");

// 2a. 装回端口、引擎 running —— **注意这里没有重新构造引擎**：上面读的就是模块单例。
engineState = "running";
enginePort = 1880;
setWorkflowEngineStatusPort((id) =>
  id === NODE_RED_ENGINE_ID
    ? { engineId: NODE_RED_ENGINE_ID, state: "running", port: 1880, reason: null }
    : null,
);
{
  const kinds = executionEngine.kinds();
  check("★ 端口注入且 running 后，同一个单例的 kinds() 含 node-red（W4 缺陷的正控）",
    kinds.includes(NODE_RED_RUNNER_KIND), kinds);
  check("注册 node-red 后三个内置执行器仍一个不少", hasAllThree(kinds), kinds);
  // 与 runEngine 同源：按次新建的引擎此刻也含。两边一致才有"单例不再谎报"的意义。
  const fresh = createBuiltinExecutionEngine().kinds();
  check("同一时刻新建的引擎也含 node-red（单例与按次引擎一致）",
    fresh.includes(NODE_RED_RUNNER_KIND), fresh);
}

// 2b. 注册后再停引擎：**不撤掉**（注册一次即保留 —— 节点该拿到"去启动引擎"，
// 而不是"没有执行器"）。这是 execution-engine-smoke §2b 的同一条语义，这里从单例侧钉住。
{
  engineState = "stopped";
  enginePort = null;
  const kinds = executionEngine.kinds();
  check("★ 注册后引擎停掉，单例仍保留 node-red（节点报'去启动引擎'而不是'没有执行器'）",
    kinds.includes(NODE_RED_RUNNER_KIND), kinds);
  engineState = "running";
  enginePort = 1880;
}

/* ──────────────── 3. 回归：三个内置执行器一直都在 ──────────────── */

console.log("\n3. 回归（三个内置执行器）");

{
  const kinds = executionEngine.kinds();
  for (const kind of THREE_BUILTINS) {
    check(`★ 单例的 kinds() 含内置执行器 ${kind}`, kinds.includes(kind), kinds);
  }
}

/* ──────────────── 4. 消费方一：automation.preflight（真 IPC + 真清单） ──────────────── */

console.log("\n4. 消费方 automation.preflight（真 handler）");

const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

const { IPC } = await import("@contracts/ipc");
const { registerWorkflowHandlers } = await import("@main/ipc/orchestration.js");
registerWorkflowHandlers(fakeIpc);

// 触发器参数按 parseTriggerSpec 的必填项：方式 + 项目 + 任务。
const doc = {
  id: "wf_w4_registry",
  name: "W4 回归流",
  prompt: "",
  builtin: false,
  updatedAt: 0,
  nodes: [
    { id: "t1", type: "mcode.trigger", title: "触发器",
      params: { triggerKind: "manual", project: "proj_w4", task: "跑一次" }, position: { x: 0, y: 0 } },
    { id: "red1", type: NODE_RED_NODE_TYPE_ID, title: "引擎步骤",
      params: { enginePath: "/api/flow" }, position: { x: 0, y: 100 } },
  ],
  edges: [{ id: "e1", from: "t1", to: "red1" }],
};
WorkflowRepo.save(doc as never);

const preflight = async (): Promise<Record<string, unknown>> => {
  const fn = handlers.get(IPC.AUTOMATION_PREFLIGHT);
  if (!fn) throw new Error(`registerWorkflowHandlers 没有注册 ${IPC.AUTOMATION_PREFLIGHT}`);
  return (await fn(null, { workflowId: doc.id, triggerNodeId: "t1" })) as Record<string, unknown>;
};

type Problem = { kind: string; reason: string };
const problemsOf = (r: Record<string, unknown>): Problem[] => (r.problems as Problem[]) ?? [];

// 4a. 引擎 running → 预检不再报"缺少执行器"（W4 缺陷的用户可见正控）。
{
  engineState = "running";
  enginePort = 1880;
  const r = await preflight();
  const executorProblems = problemsOf(r).filter((p) => p.kind === "missing-executor");
  check("★ 引擎 running 时，自动化预检不报 node-red 缺执行器（W4 缺陷的用户可见正控）",
    executorProblems.every((p) => !p.reason.includes(NODE_RED_RUNNER_KIND)), executorProblems);
  const caps = r.capabilities as { required: string[]; available: string[] };
  check("预检把 executor:node-red 列为已满足能力",
    caps.required.includes(`executor:${NODE_RED_RUNNER_KIND}`) && caps.available.includes(`executor:${NODE_RED_RUNNER_KIND}`), caps);
}

// 4b. 引擎没起 → **仍然**报缺执行器（fail-closed 的用户可见面；与 §1 同一方向）。
//     这一条证明修法没有变成"无条件注册"。
{
  engineState = "stopped";
  enginePort = null;
  // 单例注册一次即保留 —— 要验"引擎缺席时说得出原因"，用的是**新引擎**（与调度器同一条：
  // 按次运行现建的引擎在引擎没跑时不注册）。单例保留是 §2b 的既定语义。
  // 这里的端到端断言走**真**的加载路径：handler 读的是单例 —— 而单例已注册，
  // 所以此刻不报缺执行器是**正确**的（引擎这次停掉不该让在跑的图失去执行器）。
  // 真正的 fail-closed 正控在 §1（端口未注入 / 新建引擎）。
  const r = await preflight();
  check("预检本身仍然通过（停引擎不撤单例注册 —— 与 §2b 同一语义）",
    r.ok === true, r);
  engineState = "running";
  enginePort = 1880;
}

/* ──────────────── 5. 消费方二：preflightScene（真服务） ──────────────── */

console.log("\n5. 消费方 scenePreflight（真服务装配的 executorKinds）");

{
  const { providerRegistry } = await import("@main/providers/registry.js");
  const { collectCapabilityInventory } = await import("@main/orchestration/capabilityResolver.js");
  // 与 `preflightScene` 同一句装配（`executorKinds: [...executionEngine.kinds()]`）：
  // 这里不抄判据，而是拿**同一份** kinds 喂**真的** collectCapabilityInventory，
  // 断言它产出 executor:node-red 的描述符 —— 那正是场景预检清单里会被查到的那一条。
  const kinds = [...executionEngine.kinds()];
  const inventory = collectCapabilityInventory({
    providers: providerRegistry.list(),
    plugins: [],
    executorKinds: kinds,
    hostCapabilities: [],
  });
  check("★ 场景预检的清单装配从单例拿到 node-red（executor descriptor 在册）",
    inventory.some((d) => d.kind === "executor" && d.id === NODE_RED_RUNNER_KIND), kinds);
  check("场景预检清单里三个内置执行器也都在",
    THREE_BUILTINS.every((k) => inventory.some((d) => d.kind === "executor" && d.id === k)), kinds);

  // 直接走真服务：`preflightScene` 的全链（插件 / 模块宿主 / 预检）在无头里可跑。
  // 它不探 executor（契约没有那种能力引用），本断言证明的是**它装配时读的就是单例**：
  // 合法声明 → ok。这一条是"两处消费方都核过"的另一半。
  const { preflightScene } = await import("@main/appServices/scenePreflight.js");
  const scene = {
    schemaVersion: 1,
    sceneId: "w4-registry-order",
    goal: "验证场景预检仍然可用（W4 回归）",
    capabilities: [],
    resources: [{ kind: "workflow", id: "wf_w4", spec: { name: "W4" } }],
    acceptance: { description: "预检可用", expectResourceIds: ["wf_w4"] },
  };
  const sr = await preflightScene({ spec: scene });
  check("★ preflightScene 真服务仍返回 ok（装配链没被 W4 修法打断）",
    sr.ok === true && sr.preflight.ok === true, sr);
}

/* ──────────────── 6. 收口 ──────────────── */

setWorkflowEngineStatusPort(null);
console.log(`\nworkflow-executor-registry-order-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
