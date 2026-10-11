/**
 * 场景任务拓扑(SceneTask / TaskInvocation)与场景级预算账户(SceneBudgetAccount)。
 *
 * ## 它解决什么
 *
 * 今天 Agent 能开新会话(`app_session_new`)、能给别的会话发消息
 * (`app_session_send`),但**没有场景级的父子任务与预算归属**:
 * `RuntimeManager.turnBudget` 每轮 `sendTurn` 归零,限制的是**一轮**,不是
 * 一个横跨多个 chat / 工作流 / 自动化的**场景**。于是 A 派 B、B 再派 C 这样
 * 的树没有任何稳定身份可以回答:这套东西归谁、总花了多少、谁来一次叫停。
 *
 * 这一层补的就是那条**归属链**与**总预算**。它**只管**任务归属、预算预留
 * 与故障生命周期 —— 真正跑模型的仍是三个 SDK 的原生 loop,这里既不是第二个
 * Agent loop,也不是平行调度器。
 *
 * ## 安全铁律:origin / budgetOwner 由宿主铸造,模型不可伪造
 *
 * `originAgentId`(谁派生的)与 `budgetAccountId`(预算从哪个账户出)是
 * **宿主事实**,不是模型参数。`TaskInvocation` 是宿主(`CommandService`)在
 * 承认一次派生时铸出来的完整记录;即便有人硬塞一份被改过 origin/budgetOwner
 * 的 invocation,`SceneTaskRegistry.spawn` 也会用**父任务**上的这两个值覆盖它,
 * 绝不采信 invocation 里带来的。契约层这样定义,`SceneTaskRegistry` 里落成不变量。
 *
 * ## 与既有字段的关系(兼容迁移)
 *
 * 旧普通 chat 保持 user-owned,不凭空补父任务;`Session.parentSessionId` /
 * `workflowId` 的既有语义原样保留,新增的 task lineage 是独立一层,不改写
 * 现有会话归属。用户手工开的新对话仍允许没有 `sceneId`。
 *
 * 本文件**只放类型**,不留任何运行期逻辑(纯契约),避免 session.ts 反向依赖
 * 之外再绕出环。
 */

/**
 * 一个场景任务的生命周期状态。
 *
 * - `pending` —— 已登记、还没开跑(预算此时可能已预留)。
 * - `running` —— 正在跑。
 * - `paused` —— 被暂停(连同子任务一起);保留在"活跃子任务"计数里,占用
 *   父任务的 fan-out 名额,但不继续烧预算。
 * - `completed` / `failed` —— 终态(成功 / 失败);释放父任务的 fan-out 名额。
 * - `cancelled` —— 终态,被动取消;子任务整体传播取消。
 */
export type SceneTaskState =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** 终态 —— 进这些状态后 fan-out 名额释放、不再可能派生新的子任务。 */
export const SCENE_TASK_TERMINAL_STATES: readonly SceneTaskState[] = [
  "completed",
  "failed",
  "cancelled",
];

/**
 * 这次任务**由什么触发**(来源分类)。
 *
 * 与 `Session.kind` 不同:那是会话的角色,这是**任务的来源**。一个来自
 * 自动化的任务与一个用户亲手发起、但同样跑在 chat 里的任务,归属链可能相同、
 * 来源不同 —— 审计时要能分开。
 */
export type TriggerOrigin = "user" | "agent" | "scene" | "workflow" | "automation";

/**
 * 一个**场景任务** —— 场景拓扑里的一个节点。
 *
 * 它不是会话(`sessionId` 只是绑定的会话,派生时可能还没有),也不是工作流
 * 节点。它是"这个场景这一件事"的持久身份:谁派的、归哪个账户、允不允许
 * 继续派生、什么时候到点。
 */
export interface SceneTask {
  /** 所属场景。一次部署 / 一次无人值守运行 = 一个 sceneId。 */
  sceneId: string;
  /** 本任务在场景内的唯一 id(宿主生成)。 */
  taskId: string;
  /** 父任务 id;场景根任务为 `null`。 */
  parentTaskId: string | null;
  /** 绑定的会话(普通 chat / node / automation …);派生时可能尚未绑定 → null。 */
  sessionId: string | null;
  /**
   * 派生出这个任务的 **Agent / 会话身份**。**由宿主填**,派生时从父任务
   * 原样继承 —— 模型参数不能改它(见文件头"安全铁律")。
   */
  originAgentId: string;
  /** 这个任务用哪个引擎跑。 */
  providerId: string;
  /** 来源分类(用户 / Agent / 场景 / 工作流 / 自动化)。 */
  triggerOrigin: TriggerOrigin;
  /**
   * 本任务(及其子任务)被允许使用的能力 id 白名单。
   *
   * 语义同 ARC-003/ARC-014 的 `requiredCapabilities` 之一侧:子任务**只能
   * 收窄、不能放宽**父任务的这份清单。**这条收紧不再是「交给上游校验」的
   * 约定** —— `SceneTaskRegistry.spawn` 会拿它当纵深防线:子任务的
   * `allowedCapabilities` 若含父有效白名单之外的能力,直接结构化拒绝
   * `CAPABILITY_ESCALATION`,绝不静默补入。
   */
  allowedCapabilities: string[];
  /**
   * 预算账户 id。**由宿主填**,派生时从父任务原样继承 —— 模型不可伪造。
   * 同一场景的所有子 turn、插件工具、remote operation 都累计到这里。
   */
  budgetAccountId: string;
  /** 这个任务**最多能同时派生**多少个活跃子任务。超过即拒绝派生。 */
  maxFanout: number;
  /** 从这个任务往下**最多还能再深几层**。超过即拒绝派生。 */
  maxDepth: number;
  /** 相对场景根的深度(根 = 0)。派生时 `parent.depth + 1`。 */
  depth: number;
  /** 截止时刻(ms epoch);过了就不再允许派生 / 启动。`null` = 不限。 */
  deadline: number | null;
  /** 当前状态。 */
  state: SceneTaskState;
  /**
   * 本任务每次**状态迁移**自增的版本号(从 0 起)。
   *
   * 用途:重启恢复 / 乐观并发 —— 收尾事件、重复投递靠它去重,避免把一条
   * 早已取消的任务又"复活"。
   */
  generation: number;
}

/**
 * 一次"派生一个子任务"的**宿主铸造记录**。
 *
 * `SceneTaskRegistry.spawn(parentTaskId, invocation)` 拿它来校验并落成一条
 * 子 `SceneTask`。它比 `SceneTask` 少 `state` / `generation` / `depth` ——
 * 那三个是**落成时由注册表赋值**的。
 *
 * ⚠️ `originAgentId` / `budgetAccountId` / `sceneId` / `parentTaskId` 即便在
 * 这里写着,spawn 也会用**父任务上的真值**覆盖它们 —— 这是防伪造的纵深防线。
 */
export interface TaskInvocation {
  sceneId: string;
  taskId: string;
  parentTaskId: string | null;
  sessionId: string | null;
  /** 宿主填;spawn 会用父任务的值覆盖。 */
  originAgentId: string;
  providerId: string;
  triggerOrigin: TriggerOrigin;
  allowedCapabilities: string[];
  /** 宿主填;spawn 会用父任务的值覆盖。 */
  budgetAccountId: string;
  maxFanout: number;
  maxDepth: number;
  deadline: number | null;
}

/* ───────────────────────── 场景级预算账户 ───────────────────────── */

/** 一个场景预算账户的三维上限。缺哪一维,那一维不限。 */
export interface SceneBudgetLimits {
  /** 累计处理 token 上限。 */
  maxTokens?: number;
  /** 累计花费上限(USD)。 */
  maxCostUsd?: number;
  /** 同时进行的子任务数上限(并发)。 */
  maxConcurrency?: number;
}

/**
 * 启动一个子任务前的**预算预留请求**。
 *
 * 三维都可选。**关键**:当某一维缺省(成本未知)时,预留退化为该维的**保守
 * 上限**(见 `sceneTaskRegistry` 的 `UNKNOWN_*_UPPER_BOUND`),而不是 0 ——
 * 0 会让"未知成本"看起来免费,从而把场景预算击穿。
 */
export interface SceneBudgetEstimate {
  tokens?: number;
  costUsd?: number;
  concurrency?: number;
}

/** 一次子任务跑完回报的**实际用量**(用于结算预留)。 */
export interface SceneBudgetUsage {
  tokens: number;
  costUsd: number;
}

/** 一笔已成立的预留。可用 `release` 撤销,或用 `settle` 按实际用量结算。 */
export interface SceneBudgetReservation {
  reservationId: string;
  accountId: string;
  sceneId: string;
  taskId: string;
  /**
   * 立这张凭据时账户的 `generation`。
   *
   * 收尾(`settle`)会拿它和账户当前 `generation` 比对 —— 但【MC-080】`generation` 是账户的
   * **身份代际**(账户被替换 / 归属变化才变),**额度调整(`updateLimits`)不再自增它**。
   * 于是一次合法的改额不会让在途任务的旧凭据作废,已发生的真实用量照常结算。
   */
  accountGeneration: number;
  /** 本次预留占用的 token(未知成本时为保守上限)。 */
  tokens: number;
  costUsd: number;
  concurrency: number;
  createdAt: number;
}

/**
 * 一个**场景级预算账户** —— 该场景所有任务共用的中央额度。
 *
 * 分两笔账:`reserved*`(已预留、还没结算)与 `committed*`(已结算的实际
 * 用量)。判定是否还能再预留时,两笔都算进去(`committed + reserved + 本次`)。
 */
export interface SceneBudgetAccount {
  accountId: string;
  sceneId: string;
  limits: SceneBudgetLimits;
  reservedTokens: number;
  reservedCostUsd: number;
  reservedConcurrency: number;
  committedTokens: number;
  committedCostUsd: number;
  /** 已结算的子任务笔数(只增)。 */
  settledCount: number;
  /**
   * 账户**身份代际** —— 账户被替换 / 归属变化时自增。
   *
   * 【MC-080】**不是**"用户调整预算上限"的版本号 —— 改额走 `SceneBudgetAccount.limits`,
   * 不再动这里。两件事分开,合法的额度调整才不会让在途任务已发生的真实用量被迫丢弃。
   */
  generation: number;
}

/* ───────────────────────── 结果类型 ───────────────────────── */

/** 注册表 / 预算账户的**结构化拒绝** —— 绝不静默通过。 */
export interface RegistryRefusal {
  ok: false;
  /** 稳定的机器可判据代码(如 `MAX_FANOUT_EXCEEDED`)。 */
  code: RegistryRefusalCode;
  /** 给人看的一句话(可直接进通知 / 日志)。 */
  message: string;
}

/** 成功结果。 */
export interface RegistryOk<T> {
  ok: true;
  value: T;
}

/** 成功或结构化拒绝。 */
export type RegistryResult<T> = RegistryOk<T> | RegistryRefusal;

export type RegistryRefusalCode =
  | "PARENT_NOT_FOUND"
  | "PARENT_TERMINAL"
  | "ANCESTOR_INACTIVE"
  | "CAPABILITY_ESCALATION"
  | "SCENE_MISMATCH"
  | "DUPLICATE_TASK"
  | "MAX_DEPTH_EXCEEDED"
  | "MAX_FANOUT_EXCEEDED"
  | "DEADLINE_PASSED"
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_ALREADY_EXISTS"
  | "SCENE_CONFLICT"
  | "INVALID_LIMITS"
  | "LIMITS_BELOW_USAGE"
  | "INVALID_ESTIMATE"
  | "INVALID_USAGE"
  | "RESERVATION_STALE"
  | "BUDGET_EXCEEDED"
  | "RESERVATION_NOT_FOUND"
  | "TASK_NOT_FOUND";
