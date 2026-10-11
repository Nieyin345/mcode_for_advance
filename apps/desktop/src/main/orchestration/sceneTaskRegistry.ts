/**
 * 场景任务注册表 + 场景级预算账户 —— **纯内存核心**。
 *
 * ## 这是 ARC-013 的第一片:契约与记账,不接线
 *
 * 台账 ARC-013 要的是「Agent 创建/唤醒其他 Agent 后,场景级父子任务治理
 * 与跨会话总预算」。这一片**只做**纯逻辑的两块核心,不碰 RuntimeManager,
 * 也不建第二个 Agent loop / 调度器:
 *
 * 1. `SceneTaskRegistry` —— 记父子链、查 DAG,派生时强制 `maxDepth` /
 *    `maxFanout` / 截止时刻 / 场景一致,超限一律**结构化拒绝**(不静默放行);
 *    取消 / 暂停**传播到子任务**。
 * 2. `SceneBudgetAccounts` —— 场景级预算账户:启动子任务前**预留** token /
 *    花费 / 并发,跑完按**实际用量结算**;成本**未知时退化为保守上限**(见
 *    `UNKNOWN_*` 常量),绝不把"未知"当 0 处理。不同场景账户相互独立。
 *
 * ## 安全铁律:origin / budgetOwner 由宿主铸造,模型不可伪造
 *
 * `spawn(parentTaskId, invocation)` 里,无论调用方在 `invocation` 里塞了什么
 * `originAgentId` / `budgetAccountId` / `sceneId`,落成的子任务一律**采信父任务
 * 上的真值**(`deriveChild`)。这样"模型在参数里伪造预算归属"这条路在契约层
 * 就被堵死 —— 即使有人绕过上层直接调这个函数也伪造不了。
 *
 * ## 与 RuntimeManager 的关系(此片刻意不接线)
 *
 * `RuntimeManager.turnBudget` 每轮 `sendTurn` 归零,限制单轮;本核心提供的是
 * **跨多轮多会话的场景总账**。接线到真实 `sendTurn` 的"起子任务前 reserve、
 * 收轮后 settle"是后续切片,这里**不 import** RuntimeManager / store / electron,
 * 所以能无头直测。
 *
 * 本文件是纯函数 + 内存 Map,**没有持久化**(schema 落 DB 留给后续切片)。
 */
import type {
  SceneTask,
  SceneTaskState,
  TaskInvocation,
  SceneBudgetAccount,
  SceneBudgetLimits,
  SceneBudgetEstimate,
  SceneBudgetUsage,
  SceneBudgetReservation,
  RegistryResult,
  RegistryRefusal,
} from "@contracts/sceneTask.js";
import { SCENE_TASK_TERMINAL_STATES } from "@contracts/sceneTask.js";

/**
 * 成本 / token **未知时**预留用的保守上限。
 *
 * 为什么不取 0:0 会让"这一维没报"看起来免费,预留就不拦任何东西,多 Agent
 * 一起派发时把场景预算击穿。保守上限让"未知"按最坏情况占账 —— 宁可拒绝也
 * 不静默超支。结算时若实际用量低于它,差额退回(见 `settle`)。
 */
export const UNKNOWN_TOKENS_UPPER_BOUND = 100_000;
export const UNKNOWN_COST_USD_UPPER_BOUND = 1.0;

/** 一个原子计数器 + 上限的统一比较:`committed + reserved + incoming > limit` 即超。 */
function exceeds(current: number, incoming: number, limit: number | undefined): boolean {
  if (limit === undefined) return false;
  return current + incoming > limit;
}

/** isTerminal 的判定与契约里的 `SCENE_TASK_TERMINAL_STATES` 对齐(单一真源)。 */
export function isTerminalState(state: SceneTaskState): boolean {
  return SCENE_TASK_TERMINAL_STATES.includes(state);
}

/* ══════════════════════════ SceneTaskRegistry ══════════════════════════ */

/** 一条场景任务的内部登记(公开形态就是 SceneTask 本身)。 */
export class SceneTaskRegistry {
  private readonly tasks = new Map<string, SceneTask>();
  /** 父 taskId → 子 taskId 列表(按派生顺序)。 */
  private readonly childIndex = new Map<string, string[]>();
  /** 注入时钟,便于截止时刻的可复现测试。 */
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /**
   * 建一个**场景根任务**(没有父)。根任务的 origin / budget 来自宿主传入的
   * invocation —— 到这里就是宿主铸的,没有可被伪造的父值。
   */
  createRootTask(inv: TaskInvocation): RegistryResult<SceneTask> {
    if (inv.parentTaskId !== null) {
      return refuse("PARENT_NOT_FOUND", `根任务不能带 parentTaskId(${inv.parentTaskId})`);
    }
    if (this.tasks.has(inv.taskId)) {
      return refuse("DUPLICATE_TASK", `任务 id 已存在:${inv.taskId}`);
    }
    const task: SceneTask = {
      sceneId: inv.sceneId,
      taskId: inv.taskId,
      parentTaskId: null,
      sessionId: inv.sessionId,
      originAgentId: inv.originAgentId,
      providerId: inv.providerId,
      triggerOrigin: inv.triggerOrigin,
      allowedCapabilities: [...inv.allowedCapabilities],
      budgetAccountId: inv.budgetAccountId,
      maxFanout: inv.maxFanout,
      maxDepth: inv.maxDepth,
      depth: 0,
      deadline: inv.deadline,
      state: "pending",
      generation: 0,
    };
    this.tasks.set(task.taskId, task);
    this.childIndex.set(task.taskId, []);
    return { ok: true, value: task };
  }

  /**
   * 从 `parentTaskId` 派生一个子任务。
   *
   * 校验顺序(任一不过即结构化拒绝,不落任何状态):
   * 1. 父存在 → `PARENT_NOT_FOUND`
   * 2. 父非终态 → `PARENT_TERMINAL`
   * 3. 场景一致(inv.sceneId === 父.sceneId) → `SCENE_MISMATCH`
   * 4. 未过父的截止时刻 → `DEADLINE_PASSED`
   * 5. 深度未超:`parent.maxDepth >= 1` → `MAX_DEPTH_EXCEEDED`
   * 6. 活跃子任务数 < `parent.maxFanout` → `MAX_FANOUT_EXCEEDED`
   *
   * 落成的子任务:origin / budgetAccountId / sceneId **一律取父的真值**,
   * `depth = parent.depth + 1`,`maxDepth = parent.maxDepth - 1`。
   */
  spawn(parentTaskId: string, inv: TaskInvocation): RegistryResult<SceneTask> {
    const parent = this.tasks.get(parentTaskId);
    if (!parent) return refuse("PARENT_NOT_FOUND", `父任务不存在:${parentTaskId}`);
    if (isTerminalState(parent.state)) {
      return refuse("PARENT_TERMINAL", `父任务已处于终态(${parent.state}),不能再派生`);
    }
    if (inv.sceneId !== parent.sceneId) {
      return refuse("SCENE_MISMATCH", `派生场景(${inv.sceneId})与父任务场景(${parent.sceneId})不一致`);
    }
    if (parent.deadline !== null && this.now() > parent.deadline) {
      return refuse("DEADLINE_PASSED", `父任务已过截止时刻(${parent.deadline})`);
    }
    if (parent.maxDepth < 1) {
      return refuse("MAX_DEPTH_EXCEEDED", `已达最大深度(父 depth=${parent.depth},maxDepth 已耗尽)`);
    }
    if (this.activeChildCount(parentTaskId) >= parent.maxFanout) {
      return refuse(
        "MAX_FANOUT_EXCEEDED",
        `活跃子任务数已达上限(${this.activeChildCount(parentTaskId)}/${parent.maxFanout})`,
      );
    }
    if (this.tasks.has(inv.taskId)) {
      return refuse("DUPLICATE_TASK", `任务 id 已存在:${inv.taskId}`);
    }

    // 关键:origin / budget / scene 全部从**父值**推导,不采信 inv 里带来的。
    const child: SceneTask = {
      sceneId: parent.sceneId,
      taskId: inv.taskId,
      parentTaskId: parent.taskId,
      sessionId: inv.sessionId,
      originAgentId: parent.originAgentId,
      providerId: inv.providerId,
      triggerOrigin: inv.triggerOrigin,
      allowedCapabilities: [...inv.allowedCapabilities],
      budgetAccountId: parent.budgetAccountId,
      maxFanout: inv.maxFanout,
      maxDepth: parent.maxDepth - 1,
      depth: parent.depth + 1,
      deadline: inv.deadline,
      state: "pending",
      generation: 0,
    };
    this.tasks.set(child.taskId, child);
    this.childIndex.set(child.taskId, []);
    this.childIndex.get(parent.taskId)!.push(child.taskId);
    return { ok: true, value: child };
  }

  /** 直接读取一条任务(返回**副本**,外部改不到内部状态)。 */
  getTask(taskId: string): SceneTask | undefined {
    const t = this.tasks.get(taskId);
    return t ? cloneTask(t) : undefined;
  }

  /**
   * 迁移一条任务的状态,`generation` 自增。终态只能进不能出(已是终态 → 拒绝)。
   * 返回新状态的任务副本。
   */
  setState(taskId: string, state: SceneTaskState): RegistryResult<SceneTask> {
    const t = this.tasks.get(taskId);
    if (!t) return refuse("TASK_NOT_FOUND", `任务不存在:${taskId}`);
    if (isTerminalState(t.state) && t.state !== state) {
      return refuse("TASK_NOT_FOUND", `任务已处于终态(${t.state}),不能迁到 ${state}`);
    }
    t.state = state;
    t.generation += 1;
    return { ok: true, value: cloneTask(t) };
  }

  /** 直接子任务 id(派生顺序)。 */
  childrenOf(taskId: string): string[] {
    return [...(this.childIndex.get(taskId) ?? [])];
  }

  /** 活跃(非终态)直接子任务数 —— fan-out 就用它判。 */
  activeChildCount(taskId: string): number {
    return this.childrenOf(taskId).filter((id) => {
      const c = this.tasks.get(id);
      return c !== undefined && !isTerminalState(c.state);
    }).length;
  }

  /**
   * 取消一条任务及其**所有后代**(深度优先),返回被取消的 id(含自身)。
   *
   * 已是终态的任务跳过(不重复取消);取消是幂等的。这是"用户点停整套系统"
   * 的落点 —— 传播到子任务后才不会留下继续烧预算的孤儿。
   */
  cancel(taskId: string): RegistryResult<string[]> {
    const t = this.tasks.get(taskId);
    if (!t) return refuse("TASK_NOT_FOUND", `任务不存在:${taskId}`);
    const cancelled: string[] = [];
    this.cancelInto(taskId, cancelled);
    return { ok: true, value: cancelled };
  }

  private cancelInto(taskId: string, acc: string[]): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    for (const childId of this.childIndex.get(taskId) ?? []) {
      this.cancelInto(childId, acc);
    }
    if (!isTerminalState(t.state)) {
      t.state = "cancelled";
      t.generation += 1;
      acc.push(t.taskId);
    }
  }

  /**
   * 暂停一条任务及其所有**活跃**后代,返回被暂停的 id。已终态的后代不动。
   * 暂停不是终态:仍占用父的 fan-out 名额,但通常不再烧预算。
   */
  pause(taskId: string): RegistryResult<string[]> {
    const t = this.tasks.get(taskId);
    if (!t) return refuse("TASK_NOT_FOUND", `任务不存在:${taskId}`);
    const paused: string[] = [];
    this.pauseInto(taskId, paused);
    return { ok: true, value: paused };
  }

  private pauseInto(taskId: string, acc: string[]): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    if (!isTerminalState(t.state) && t.state !== "paused") {
      t.state = "paused";
      t.generation += 1;
      acc.push(t.taskId);
    }
    for (const childId of this.childIndex.get(taskId) ?? []) {
      this.pauseInto(childId, acc);
    }
  }

  /** 某场景下的全部任务(用于回读整棵 DAG)。 */
  tasksOfScene(sceneId: string): SceneTask[] {
    return [...this.tasks.values()].filter((t) => t.sceneId === sceneId).map(cloneTask);
  }
}

function cloneTask(t: SceneTask): SceneTask {
  return { ...t, allowedCapabilities: [...t.allowedCapabilities] };
}

/** 结构化拒绝的构造(窄类型,避免各处手拼)。 */
function refuse(code: RegistryRefusal["code"], message: string): RegistryRefusal {
  return { ok: false, code, message };
}

/* ══════════════════════════ SceneBudgetAccounts ══════════════════════════ */

/**
 * 场景级预算账户集合 —— 纯内存。一个 accountId 对应一个账户,账户之间
 * **完全独立**(A 场景超支不影响 B 场景)。
 */
export class SceneBudgetAccounts {
  private readonly accounts = new Map<string, SceneBudgetAccount>();
  private readonly reservations = new Map<string, SceneBudgetReservation>();
  private seq = 0;

  /** 建账户。重复 id → 上次的先卸掉(测试里方便重建),不静默叠加。 */
  createAccount(accountId: string, sceneId: string, limits: SceneBudgetLimits): SceneBudgetAccount {
    const account: SceneBudgetAccount = {
      accountId,
      sceneId,
      limits: { ...limits },
      reservedTokens: 0,
      reservedCostUsd: 0,
      reservedConcurrency: 0,
      committedTokens: 0,
      committedCostUsd: 0,
      settledCount: 0,
    };
    this.accounts.set(accountId, account);
    return { ...account, limits: { ...account.limits } };
  }

  getAccount(accountId: string): SceneBudgetAccount | undefined {
    const a = this.accounts.get(accountId);
    return a ? { ...a, limits: { ...a.limits } } : undefined;
  }

  /**
   * 启动一个子任务前**预留**额度。
   *
   * 未知成本 → 保守上限:token 用 `UNKNOWN_TOKENS_UPPER_BOUND`、花费用
   * `UNKNOWN_COST_USD_UPPER_BOUND`、并发至少 1。任一维 `committed + reserved
   * + 本次 > limit` 即 `BUDGET_EXCEEDED`,不落预留。通过则返回一张预留凭据,
   * 由 `settle` / `release` 收尾。
   */
  reserve(
    accountId: string,
    est: SceneBudgetEstimate,
    taskId: string,
  ): RegistryResult<SceneBudgetReservation> {
    const a = this.accounts.get(accountId);
    if (!a) return refuse("ACCOUNT_NOT_FOUND", `预算账户不存在:${accountId}`);

    const tokens = est.tokens ?? UNKNOWN_TOKENS_UPPER_BOUND;
    const costUsd = est.costUsd ?? UNKNOWN_COST_USD_UPPER_BOUND;
    const concurrency = est.concurrency ?? 1;

    const over: string[] = [];
    if (exceeds(a.committedTokens + a.reservedTokens, tokens, a.limits.maxTokens)) {
      over.push(`token ${a.committedTokens + a.reservedTokens}+${tokens}/${a.limits.maxTokens}`);
    }
    if (exceeds(a.committedCostUsd + a.reservedCostUsd, costUsd, a.limits.maxCostUsd)) {
      over.push(`花费 $${(a.committedCostUsd + a.reservedCostUsd + costUsd).toFixed(2)}/$${a.limits.maxCostUsd}`);
    }
    if (exceeds(a.reservedConcurrency, concurrency, a.limits.maxConcurrency)) {
      over.push(`并发 ${a.reservedConcurrency}+${concurrency}/${a.limits.maxConcurrency}`);
    }
    if (over.length > 0) {
      return refuse("BUDGET_EXCEEDED", `超出场景预算(${over.join("、")})`);
    }

    a.reservedTokens += tokens;
    a.reservedCostUsd += costUsd;
    a.reservedConcurrency += concurrency;
    this.seq += 1;
    const reservation: SceneBudgetReservation = {
      reservationId: `res_${this.seq}`,
      accountId,
      sceneId: a.sceneId,
      taskId,
      tokens,
      costUsd,
      concurrency,
      createdAt: 0,
    };
    this.reservations.set(reservation.reservationId, reservation);
    return { ok: true, value: { ...reservation } };
  }

  /**
   * 按**实际用量**结算一笔预留:预留的三维先全额退回,再把实际用量记进
   * `committed`。实际低于预留(通常如此)时差额自然释放。
   *
   * 结算**不做准入判定** —— 活儿已经干完了,这里只是记账;超支与否由下一次
   * `reserve` 拦。
   */
  settle(reservationId: string, usage: SceneBudgetUsage): RegistryResult<SceneBudgetAccount> {
    const r = this.reservations.get(reservationId);
    if (!r) return refuse("RESERVATION_NOT_FOUND", `预留不存在:${reservationId}`);
    const a = this.accounts.get(r.accountId);
    if (!a) return refuse("ACCOUNT_NOT_FOUND", `预算账户不存在:${r.accountId}`);

    // 退回预留(含并发槽)。
    a.reservedTokens -= r.tokens;
    a.reservedCostUsd -= r.costUsd;
    a.reservedConcurrency -= r.concurrency;
    // 记实际用量。
    a.committedTokens += usage.tokens;
    a.committedCostUsd += usage.costUsd;
    a.settledCount += 1;
    this.reservations.delete(reservationId);
    return { ok: true, value: { ...a, limits: { ...a.limits } } };
  }

  /**
   * **撤销**一笔预留(子任务被拒 / 取消,没跑,不计实际用量):三维全额退回,
   * 不增加 `committed`。
   */
  release(reservationId: string): RegistryResult<SceneBudgetAccount> {
    const r = this.reservations.get(reservationId);
    if (!r) return refuse("RESERVATION_NOT_FOUND", `预留不存在:${reservationId}`);
    const a = this.accounts.get(r.accountId);
    if (!a) return refuse("ACCOUNT_NOT_FOUND", `预算账户不存在:${r.accountId}`);
    a.reservedTokens -= r.tokens;
    a.reservedCostUsd -= r.costUsd;
    a.reservedConcurrency -= r.concurrency;
    this.reservations.delete(reservationId);
    return { ok: true, value: { ...a, limits: { ...a.limits } } };
  }

  /** 当前挂账(未结算)的预留数。 */
  openReservationCount(): number {
    return this.reservations.size;
  }
}
