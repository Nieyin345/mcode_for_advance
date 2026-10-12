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
import { SceneTaskRegistry } from "./sceneTaskRegistry.js";
import type { CancelOutcome, CancelledTask, RegistryResult, SceneTask } from "@contracts/sceneTask.js";

/**
 * 装配一个场景任务注册表,**并令其成为进程单例**(与 `assembleGrantStore` 同姿势 ——
 * 装配即生效,读取口 `getSceneRegistry()` 随后拿到的是同一个实例)。`now` 可注入,
 * 默认真实时钟。
 */
export function assembleSceneRuntime(now: () => number = () => Date.now()): SceneTaskRegistry {
  activeRegistry = new SceneTaskRegistry(now);
  return activeRegistry;
}

/**
 * 当前生效的场景任务注册表。**默认是一个进程内存版**;生产在 `main/index.ts` 的启动路径上
 * 用 `assembleSceneRuntime()` 装一次。装上之后就统一从这个读取口取 —— 见文件头「各 new 一份」
 * 那条理由。
 */
let activeRegistry: SceneTaskRegistry = new SceneTaskRegistry();

export function getSceneRegistry(): SceneTaskRegistry {
  return activeRegistry;
}

/** 装配 / 测试用。传 null 重置回一个**全新**的内存版(每个用例前清一次,免得串味)。 */
export function setSceneRuntime(registry: SceneTaskRegistry | null): void {
  activeRegistry = registry ?? assembleSceneRuntime();
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
