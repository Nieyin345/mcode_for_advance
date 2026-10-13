/**
 * **场景任务运行期入口 —— 装配点 + 诚实的取消报告**(ARC-013 实施步②)。
 *
 * ## 它在补哪个洞
 *
 * 步①交了纯核心 `SceneTaskRegistry`(含 `cancel` 的 `uncertain` 诚实性、`markExternalAction`),
 * 可**全仓没有一处生产代码消费它** —— 没有实例化、没有装配点、没有任何调用端。于是那条
 * 「外部动作在飞行中时取消 → 记 `uncertain` 而不是谎称 `cancelled`」的语义只活在纯核心里,
 * **真实取消入口一个都没接上**。本模块补上那件「接」,与 ARC-004 的 `grantStoreRuntime.ts`
 * 同一条姿势:
 *
 *   - 一个**纯装配函数** `assembleSceneRuntime(now?)`,建一个 `SceneTaskRegistry` 并令其
 *     成为单例;时钟可注入,便于无头复现截止时刻相关的判定;
 *   - 一个进程内**单例读取口** `getSceneRegistry()`,让真实调用端(取消入口 / 后续派发点)
 *     统一从这里取注册表,**绝不在各自模块里各 new 一份**(各 new 一份 = 各看各的 Map,
 *     派发在一处、取消在另一处 = 取消停不住任何东西);
 *   - **唯一一个真实取消调用端** `cancelSceneTask(taskId)` —— 它调 registry 的 `cancel`,
 *     把结构化拒绝原样透出,**把 `CancelOutcome` 逐条如实报出来**;
 *   - `sceneCancelReport(outcome)` —— 把 `CancelOutcome` 折成一句**人能读懂、且不撒谎**的
 *     结论:`.uncertain` 非空就**不是干净的全停**,必须讲出来(绝不静默吞成「已取消」)。
 *   - `markSceneExternalAction(taskId, inFlight)` —— 宿主在起 / 收一个不可中断外部动作
 *     (git push / SSH / 建远程资源)前后调它。**由宿主填,不是模型参数**。
 *
 * ## 为什么在这里、不 import electron / 存储
 *
 * `sceneTaskRegistry.ts` 是纯内存核心(不 import RuntimeManager / store / electron),
 * 所以本模块能无头直接 bundle —— 断言测**纯装配与取消报告**即可,不必起 Electron、
 * 更不必碰用户数据根。真正的持久化(schema 落 DB)、真实 `sendTurn` 接线(起子任务前
 * reserve、收轮后 settle)仍是后续切片;本片只把「取消的 uncertain 语义接到真实调用端」
 * 这一件事做完。
 */
import { SceneBudgetAccounts, SceneTaskRegistry } from "./sceneTaskRegistry.js";
import type {
  CancelOutcome,
  CancelledTask,
  RegistryResult,
  SceneBudgetAccount,
  SceneBudgetEstimate,
  SceneBudgetLimits,
  SceneBudgetReservation,
  SceneTask,
  SceneBudgetUsage,
} from "@contracts/sceneTask.js";

/**
 * 装配一个场景任务注册表,**并令其成为进程单例**(与 `assembleGrantStore` 同姿势 ——
 * 装配即生效,读取口 `getSceneRegistry()` 随后拿到的是同一个实例)。`now` 可注入,
 * 默认真实时钟。
 */
export function assembleSceneRuntime(now: () => number = () => Date.now()): SceneTaskRegistry {
  activeRegistry = new SceneTaskRegistry(now);
  // 预算账户也一起重置:装配 = 「一套全新的场景运行期」,注册表与总账是同一件事的两半,
  // 只换一半会让「取消停住了任务、但它的预留还挂在旧账上」这种半死不活的状态出现。
  activeBudgetAccounts = new SceneBudgetAccounts();
  return activeRegistry;
}

/**
 * 当前生效的场景任务注册表。**默认是一个进程内存版**;生产在 `main/index.ts` 的启动路径上
 * 用 `assembleSceneRuntime()` 装一次。装上之后就统一从这个读取口取 —— 见文件头「各 new 一份」
 * 那条理由。
 */
let activeRegistry: SceneTaskRegistry = new SceneTaskRegistry();
/** 场景级总账的单例(与 `activeRegistry` 同生命周期,见 `assembleSceneRuntime`)。 */
let activeBudgetAccounts: SceneBudgetAccounts = new SceneBudgetAccounts();

export function getSceneRegistry(): SceneTaskRegistry {
  return activeRegistry;
}

/** 当前生效的场景级总账。**统一从这里取**,各模块不各 new 一份(理由同注册表)。 */
export function getSceneBudgetAccounts(): SceneBudgetAccounts {
  return activeBudgetAccounts;
}

/**
 * **场景级总预算设置键。** 一段 JSON `{ maxTokens?, maxCostUsd?, maxConcurrency? }`,
 * 挂在一个场景(这里 = 一条工作流运行的父会话)上。**不配 = 不启用场景总账** ——
 * 派发点于是完全走旧路径,一个字节都不变(这是「接线是加约束,不是改行为」的落点)。
 *
 * ⚠️ 值坏掉(非 JSON / 形状不对)**不能当成"设了 0 上限"** —— 那会把整套派发全拒。
 * 见 {@link parseSceneBudgetLimits}:坏值一律当作"没配",显式返回 null 让调用方走旧路。
 */
export const SCENE_BUDGET_SETTING_KEY = "workflow.sceneBudget";

/**
 * 解析一段场景预算 JSON。**坏值 / 缺省一律返回 `null`(视作没配)**,绝不返回一个
 * 会把派发全拒的空上限 —— "配置读不出来"与"预算就是 0"是两件事,不能混。
 */
export function parseSceneBudgetLimits(raw: string | null | undefined): SceneBudgetLimits | null {
  if (raw === null || raw === undefined || raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const limits: SceneBudgetLimits = {};
  const ints: Array<"maxTokens" | "maxConcurrency"> = ["maxTokens", "maxConcurrency"];
  for (const k of ints) {
    const v = obj[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) return null;
    limits[k] = v;
  }
  const cost = obj.maxCostUsd;
  if (cost !== undefined) {
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
    limits.maxCostUsd = cost;
  }
  // 三维全空 = 没配(空 `{}` 不该建一个"不限"的账户,那只是白白多一层)。
  if (limits.maxTokens === undefined && limits.maxCostUsd === undefined && limits.maxConcurrency === undefined) {
    return null;
  }
  return limits;
}

/** 装配 / 测试用。传 null 重置回一个**全新**的内存版(每个用例前清一次,免得串味)。 */
export function setSceneRuntime(registry: SceneTaskRegistry | null): void {
  activeRegistry = registry ?? assembleSceneRuntime();
  // 注册表被显式换掉时总账也跟着换:**只换一半**会让 `getSceneBudgetAccounts()` 还指着
  // 上一套账 —— 用例之间串味,而"预留挂在别人的账上"是查不出来的错。
  activeBudgetAccounts = new SceneBudgetAccounts();
}

/**
 * **预建 / 取回一个场景预算账户。** 同 id 同场景已存在 → 原样返回(不重置);已存在但
 * 绑的是别的场景 → 结构化拒绝(见 `SceneBudgetAccounts.createAccount`)。
 *
 * 派发点是**每轮都调**它拿账户的:第一轮建成,后面每轮 `createAccount` 得到
 * `ACCOUNT_ALREADY_EXISTS` 时改走 `getAccount` 读回同一本账 —— 于是约束跨轮累积,
 * 而不是每轮新开一本(那样总账永远归零,等于没接)。
 */
export function ensureSceneBudgetAccount(
  accountId: string,
  sceneId: string,
  limits: SceneBudgetLimits,
): RegistryResult<SceneBudgetAccount> {
  const created = activeBudgetAccounts.createAccount(accountId, sceneId, limits);
  if (created.ok) return created;
  if (created.code === "ACCOUNT_ALREADY_EXISTS") {
    const existing = activeBudgetAccounts.getAccount(accountId);
    if (existing) return { ok: true, value: existing };
  }
  return created;
}

/**
 * **起一个子任务前预留额度**(在真实 `RuntimeManager.sendTurn` 之前调)。透传到
 * {@link SceneBudgetAccounts.reserve} —— 未知成本退化为**保守上限**(不当 0),超预算
 * 结构化拒绝 `BUDGET_EXCEEDED`。返回的凭据由 {@link settleSceneReservation} /
 * {@link releaseSceneReservation} 收尾。
 */
export function reserveSceneBudget(
  accountId: string,
  est: SceneBudgetEstimate,
  taskId: string,
  sceneId?: string,
): RegistryResult<SceneBudgetReservation> {
  return activeBudgetAccounts.reserve(accountId, est, taskId, sceneId);
}

/**
 * **一轮收场后按实际用量结算**(在 `handle.done` 之后调)。透传到
 * {@link SceneBudgetAccounts.settle}:预留三维全额退回、实际用量记进 `committed`。
 *
 * 用量未知时**调用方不该调它** —— 该调 {@link releaseSceneReservation}(把预留原样退回)
 * 而不是 `settle(…, {tokens:0, costUsd:0})`:后者会把"这一轮其实花了钱但我们没读到"
 * **记成 0**,把已经消费的当免费(正是台账点名的"未知不当 0"反例)。
 */
export function settleSceneReservation(
  reservationId: string,
  usage: SceneBudgetUsage,
): RegistryResult<SceneBudgetAccount> {
  return activeBudgetAccounts.settle(reservationId, usage);
}

/** 撤销一笔预留(子任务没跑 / 被拒 / 取消,不计实际用量)。透传。 */
export function releaseSceneReservation(reservationId: string): RegistryResult<SceneBudgetAccount> {
  return activeBudgetAccounts.release(reservationId);
}

/**
 * **真实取消入口** —— 取消一条任务及其全部后代,返回 registry 的结构化结果。
 *
 * ⚠️ **不在这里做任何「吞掉 uncertain」的加工**:原样透出 `CancelOutcome`,让上层用
 * {@link sceneCancelReport} 如实报。从前没有这个调用端,纯核心里 `uncertain` 的诚实性
 * 只被单测钉着、真实取消入口一个都没接上 —— 这一句就是那条接线。
 */
export function cancelSceneTask(taskId: string): RegistryResult<CancelOutcome> {
  return activeRegistry.cancel(taskId);
}

/**
 * 宿主在**起 / 收一个不可中断的外部动作**前后调它,标记这条任务此刻是否握着一个
 * 停不掉的外部副作用(git push / SSH / 建远程资源)。**由宿主填,不是模型参数。**
 *
 * 透传到 registry 的同名口 —— 只对**非终态**任务有意义(终态调用结构化拒绝)。
 */
export function markSceneExternalAction(taskId: string, inFlight: boolean): RegistryResult<SceneTask> {
  return activeRegistry.markExternalAction(taskId, inFlight);
}

/**
 * 一次取消的**如实报告** —— 给人看的一句话 + 机器可判的两个集合。**不是**一句 ok。
 *
 * ## 为什么非得分出 `cleanStop`
 *
 * `CancelOutcome` 里 `.uncertain` 非空时,那次取消**不是**干净的全停:那几条任务握着
 * 不可中断的外部动作,停 JS 的 Promise 停不了已经发出去的那个副作用,**有没有生效无法
 * 从这里确认**。把它当成「已停」就是**假成功** —— 用户以为系统停了,那个 git push 可能
 * 照样落了地,且再没人核对。所以 `cleanStop` 只在 `.uncertain` 为空时为真,`message`
 * 必须把待核对的那些讲出来(见 ARC-005 的 UNCERTAIN 纪律)。
 */
export interface SceneCancelReport {
  /** 这次取消**是否干净全停**(确定停住、没有待核对的外部动作)。 */
  cleanStop: boolean;
  /** 确定停住的任务 id(含自身)。 */
  cancelled: string[];
  /** 取消时握着不可中断外部动作、终态为 `uncertain`、**状态待人工/外部系统核对**的任务 id。 */
  uncertain: string[];
  /** 给人看的一句话(可直接进通知 / 日志)。`uncertain` 非空时**必须**讲出来。 */
  message: string;
}

/** 把 `CancelOutcome` 折成一句**不撒谎**的结论。 */
export function sceneCancelReport(outcome: CancelOutcome): SceneCancelReport {
  const cancelled = [...outcome.cancelled];
  const uncertain = [...outcome.uncertain];
  const cleanStop = uncertain.length === 0;
  const message = cleanStop
    ? `已取消 ${cancelled.length} 个任务(含自身),无待核对的外部动作。`
    : `已取消 ${cancelled.length} 个任务,另有 ${uncertain.length} 个任务握着不可中断的外部动作、` +
      `已记为「不确定」——它们的终态为 uncertain,结果是停住的,` +
      `但那个在途外部动作(git push / SSH / 建远程资源)是否真的生效**无法确认**,请人工 / 外部系统核对:` +
      `${uncertain.join("、")}。**这不是干净的全停**。`;
  return { cleanStop, cancelled, uncertain, message };
}

/** 逐条终态(re-export 契约类型,方便调用端不绕道 contracts)。 */
export type { CancelledTask };
