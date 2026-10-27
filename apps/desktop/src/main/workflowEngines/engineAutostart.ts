/**
 * 【Q8 / 批次 1】**引擎常驻：应用启动时按需拉起 Node-RED。**
 *
 * ## 为什么需要这一层
 *
 * 在此之前，引擎只有一条启动路径：用户在「设置 → 工作流 → 引擎」页点「启动」
 * （`EngineRuntimePanel` → `workflowEngine.start`）。后果是产品承诺与实现脱节 ——
 * 功能文档第八节说自动化「像 cron / 文件监听」一样在后台跑，而 `engine=node-red`
 * 的图在应用重启后**根本不会执行**：引擎没起。
 *
 * 本模块补的就是这一段：应用启动时，如果库里存在任何归 Node-RED 的图，
 * 就把引擎拉起来。没有这样的图就**不启动**（不为一个用不到的功能付常驻内存）。
 *
 * ## 它不是什么
 *
 * - **不是第二个执行器**：启动走的仍是 `startWorkflowEngine`（`ipc/workflowEngine.ts`），
 *   也就是 UI 按钮那条**同一条**路 —— `beforeStart` 前置校验、`launchSpec` 完整性
 *   校验一个都不跳过。这里只决定"什么时候起"。
 * - **不是绕过审批**：`engine-trust.json` 的写入不在这一层（见
 *   `engineTrustMarker.ts`）。引擎起来了但 flow 未获信任时 `safeMode` 仍然开着，
 *   图照样不执行 —— 两个决定互相独立。
 *
 * ## 失败必须可见
 *
 * 引擎起不来（没装、vendor 校验失败、端口冲突）时**不能让自动化悄悄哑掉**。
 * 结果原样返回给调用方记账；这里不吞任何失败。
 *
 * ## 判据为什么是「有没有 node-red 图」而不是「有没有自动化」
 *
 * 普通工作流（无触发器）也要能跑 —— 用户在对话里选它发消息就走图。判据放宽到
 * 「任何 engine=node-red 的图」更简单，也更符合"引擎是工作流内核"的定位；
 * 代价是只用普通图的人也会拉起引擎，而这本来就是他要用的东西。
 */
import { listWorkflows } from "@main/orchestration/library.js";
import { startWorkflowEngine, type WorkflowEngineHandlerPorts } from "@main/ipc/workflowEngine.js";

/** 启动判定需要的宿主事实 —— 注入而非直接 import，便于无头套件验判据。 */
export interface EngineAutostartPorts {
  /** 库里全部工作流的引擎归属（只看 `engine` 字段）。 */
  hasNativeWorkflows(): boolean;
  /** 与 UI 按钮同一条启动路径（`startWorkflowEngine` 的依赖面）。 */
  engine: Pick<WorkflowEngineHandlerPorts, "registry" | "launchSpec" | "beforeStart">;
}

export interface EngineAutostartResult {
  /** 这次调用是否真的发起了一次启动。 */
  started: boolean;
  /** 没启动的原因。`null` = 本来就不需要（无 node-red 图 / 已在运行）；
   *  非 null = 需要但起不来，调用方必须记下来。 */
  reason: string | null;
}

/**
 * 库里有任何归 Node-RED 的图吗？
 *
 * 判据直接读 `listWorkflows()` 的 `engine` 字段 —— 那是**保存时写下的归属**，
 * 与执行期 `effectiveWorkflowEngine` 的归一（`doc.engine ?? "mcode"`）在
 * `library.ts:49` 已经做过一次。这里不重复实现"缺省算哪个引擎"。
 */
export function hasNativeWorkflows(): boolean {
  return listWorkflows().some((entry) => entry.engine === "node-red");
}

/**
 * 需要就启动引擎。**幂等**：已经在 running 就直接返回。
 *
 * 三态返回，调用方必须分开处理：
 * - `{ started: true }` —— 这次真的起了；
 * - `{ started: false, reason: null }` —— 本来就不需要（无原生图 / 已在跑），静默；
 * - `{ started: false, reason: "..." }` —— 需要但起不来，**必须记账**。
 */
export async function startEngineIfNeeded(
  ports: EngineAutostartPorts,
  engineId: "node-red" = "node-red",
): Promise<EngineAutostartResult> {
  if (!ports.hasNativeWorkflows()) return { started: false, reason: null };
  return ensureEngineStarted(ports, engineId);
}

/**
 * **不管库里有没有图，都确保引擎在跑** —— 用户正在用工作流界面时调它。
 *
 * ## 与 {@link startEngineIfNeeded} 的分工
 *
 * | 时机 | 用哪个 | 判据 |
 * |---|---|---|
 * | 应用启动 | `startEngineIfNeeded` | 有 node-red 图才起（不为用不到的功能付常驻内存） |
 * | **用户打开工作流面板 / 新建第一张图** | **本函数** | **用户要用了就起** |
 *
 * ## 为什么需要这一条（产品要求：下载即可用）
 *
 * 全新用户的库里一张图都没有，`startEngineIfNeeded` 会判定「不需要」而静默返回 ——
 * 于是用户第一次点开工作流，看到的是「引擎未就绪」，必须先按一次「启动」才能画。
 * 那不是「下载就能用」。
 *
 * 这里**不改变**启动时机上的内存取舍（面板打开那一刻才起，不是开机就起），
 * 只是把「用户已经走到这一页」当成明确的使用信号。
 *
 * **失败不抛**：界面要把原因显示出来，而不是让一次列表查询炸掉整页。
 */
export async function ensureEngineStarted(
  ports: EngineAutostartPorts,
  engineId: "node-red" = "node-red",
): Promise<EngineAutostartResult> {
  const runtime = ports.engine.registry.get(engineId);
  if (runtime === null) return { started: false, reason: `未知工作流引擎：${engineId}` };
  const state = runtime.status().state;
  if (state === "running" || state === "starting") return { started: false, reason: null };
  const result = await startWorkflowEngine(ports.engine, engineId);
  if (!result.ok) return { started: false, reason: result.reason };
  return { started: true, reason: null };
}
