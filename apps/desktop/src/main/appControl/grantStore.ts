/**
 * **GrantStore —— 计划级授权(Grant)的持有与签发核心**(ARC-004 实施步 ④ 的前置最小切片)。
 *
 * 步① 交付了纯函数判定核 `policyEngine.evaluate(intent, grant|null, context)`;但全仓
 * **没有任何生产代码产出过 `Grant`** —— 没有 store、没有签发口、没有撤销/过期。本模块补上
 * 这三件里**纯逻辑**的那一层:
 *   - 存 / 取 grant by id;
 *   - **撤销**(revoke,幂等)、**过期**(expiresAt,过期即视为不存在);
 *   - **按资源身份查**(给定动作的资源身份 + method,找匹配的、仍有效的 grant);
 *   - 一个**签发口** `issueGrant(decision, subject, now)` —— **只有它**能产 `Grant`。
 *
 * ## 硬约定
 * 1. **纯逻辑。** 内存 `Map` + 由调用方传入的 `now`(可注入时钟)。**不 import electron / sql**。
 *    若需持久化,走**可注入**的 `GrantStorePersist`(set/get 接口),不在这里拉 sql.js。
 * 2. **签发口唯一。** 别的模块拿不到「构造 grant 并举着 grantId」的途径 —— `Grant` 只能由
 *    `issueGrant` 产出。**绝不**把现有 `ApprovalBridge` 里那个「按工具名的 `Set`」冒充 Grant
 *    (那是 ARC-004 明令禁止的假授权:空 `scopedCore`、可写任意资源、无过期)。
 * 3. **无效即查不出。** 撤销过的 / 过期了的 / 不存在的 grant,`get` / `findFor` **一律返回 null**;
 *    调用方(执行点)因此只会拿到有效授权,或拿不到(→ 回到「重新批准」)。
 *    ★ **唯一的例外是 `findBoundFor`**:它专门把「绑定的那枚授权(含失效态)」交回给
 *    `evaluate` 判 —— 否则 `evaluate` 的三条 deny 分支(撤销 / 过期 / 非用户)会成死代码。
 *    想要「只给我有效授权」的调用方仍用 `get` / `findFor`。
 *
 * ⚠️ 本模块**不接最终执行点**,也不做持久化落盘 —— 那是后续切片。这里只交付可无头测的持有核
 * 与签发口,让步③(执行点迁移)有东西可拿。
 */
import type {
  ActionIntent,
  ActorRef,
  CoreIntent,
  Grant,
  PolicyDecision,
} from "@contracts/policyEngine";
import { invalidationsFor } from "./policyEngine.js";

/**
 * 签发一份 Grant 所需的**判定输入** —— `PolicyDecision` 的超集。
 *
 * 为什么不是裸的 `PolicyDecision`:evaluate 只回答「准不准」,它**不携带**
 * `allowedActions` / `scopedCore` / `configHash` / 有效期。这些是「这次批准到底批了什么」,
 * 由宿主展开的预览决定。把它们留在 Grant 之外、由调用方事后补,正是 ARC-004 要消灭的
 * 「资源绑定缺席」。所以签发口要求它们**与判定一起**交进来 —— 少一个都签不出有效授权。
 */
export interface GrantDecision extends PolicyDecision {
  sceneId: string;
  /** 允许的动作(method 名)。空表签不出(一个什么都不允许的授权无意义)。 */
  allowedActions: string[];
  /** 批准时钉住的核心意图(资源身份)。 */
  scopedCore: CoreIntent;
  /** 审批时的配置摘要。 */
  configHash: string;
  /** 有效期(从签发时刻起算的毫秒数)。必须为正。 */
  ttlMs: number;
  /** 费用上限(可空 = 不限)。 */
  maxBudget?: number;
  /** 次数量上限(可空 = 不限)。 */
  maxCount?: number;
}

/** 可注入的持久化接口 —— 本模块不实现落盘,只认这个窄接口(不拉 sql.js / electron)。 */
export interface GrantStorePersist {
  /** 载入已存的 grant(无则 null)。 */
  load(): Grant[] | null;
  /** 落盘全量 grant。 */
  save(grants: Grant[]): void;
}

export interface GrantStoreDeps {
  persist?: GrantStorePersist;
  /** grantId 生成器,便于测试确定性;缺省 `grant-<seq>`。 */
  newId?: (seq: number) => string;
}

/** 签发口拒绝一项输入的信号 —— 显式报出来,不静默跳过。 */
export class GrantStoreError extends Error {}

/** 一份 grant 此刻是否有效:未撤销 **且** 未过期(`now < expiresAt`,与 evaluate 同一判据)。 */
export function isGrantActive(grant: Grant, now: number): boolean {
  return !grant.revoked && now < grant.expiresAt;
}

export class GrantStore {
  private readonly grants = new Map<string, Grant>();
  private readonly persist?: GrantStorePersist;
  private readonly newId: (seq: number) => string;
  private seq = 0;

  constructor(deps: GrantStoreDeps = {}) {
    this.persist = deps.persist;
    this.newId = deps.newId ?? ((n) => `grant-${n}`);
    const loaded = this.persist?.load();
    if (loaded) for (const g of loaded) this.grants.set(g.grantId, g);
  }

  /**
   * **唯一的签发口。** 从判定结果 + 主体身份构造一份 `Grant`(含 id / 时间 / 过期)。
   *
   * 只认**用户本人**签发:`subject.kind !== "user"` 一律拒(agent / system 不能给自己发授权);
   * 判定为 `deny` 的动作签不出;空动作表 / 非正有效期一律拒。
   */
  issueGrant(decision: GrantDecision, subject: ActorRef, now: number): Grant {
    if (!subject || subject.kind !== "user") {
      throw new GrantStoreError("授权只能由用户本人签发 —— agent / system 不能给自己发授权。");
    }
    if (decision.verdict === "deny") {
      throw new GrantStoreError("判定为拒绝(deny)的动作不能被签成授权。");
    }
    if (!Array.isArray(decision.allowedActions) || decision.allowedActions.length === 0) {
      throw new GrantStoreError("授权至少要允许一个动作(allowedActions 不能为空)。");
    }
    if (!(decision.ttlMs > 0)) {
      throw new GrantStoreError("授权必须有正的有效期(ttlMs > 0)。");
    }
    this.seq += 1;
    const grant: Grant = {
      grantId: this.newId(this.seq),
      sceneId: decision.sceneId,
      allowedActions: [...decision.allowedActions],
      scopedCore: { ...decision.scopedCore },
      configHash: decision.configHash,
      expiresAt: now + decision.ttlMs,
      maxBudget: decision.maxBudget,
      budgetUsed: 0,
      maxCount: decision.maxCount,
      usedCount: 0,
      approvalSource: { ...subject },
      revoked: false,
    };
    this.grants.set(grant.grantId, grant);
    this.flush();
    return grant;
  }

  /**
   * 撤销一份授权。**幂等** —— 重复撤销、撤销不存在的 id 都是安全的 no-op(不改状态、不抛)。
   * 返回 `true` 表示这次调用真的把它从「有效」翻成了「已撤销」。
   */
  revoke(grantId: string): boolean {
    const g = this.grants.get(grantId);
    if (!g || g.revoked) return false;
    g.revoked = true;
    this.flush();
    return true;
  }

  /** 按 id 取一份**仍有效**的授权;撤销过的 / 过期了的 / 不存在的一律 `null`。 */
  get(grantId: string, now: number): Grant | null {
    const g = this.grants.get(grantId);
    if (!g || !isGrantActive(g, now)) return null;
    return g;
  }

  /**
   * 按**资源身份 + 动作**查匹配的、仍有效的授权:返回第一份
   * ① 当前有效、② 由用户签发、③ `allowedActions` 含 `intent.method`、④ 核心意图未被
   * `intent.core` 改动(`invalidationsFor` 为空)的 grant;没有则 `null`。
   *
   * 传入 `ActionIntent` 即是「资源身份(intent.core)+ 动作(intent.method)」——
   * 例如 SSH 的 `intent.core.sshHostKey` + `intent.method`。
   */
  findFor(intent: ActionIntent, now: number): Grant | null {
    for (const g of this.grants.values()) {
      if (!isGrantActive(g, now)) continue;
      if (g.approvalSource.kind !== "user") continue;
      if (!g.allowedActions.includes(intent.method)) continue;
      if (invalidationsFor(intent.core, g.scopedCore).length > 0) continue;
      return g;
    }
    return null;
  }

  /**
   * 按**资源身份 + 动作**找**绑定的那枚授权**(不管死活),交回给调用方(执行点)自己去判。
   *
   * ## 为什么需要它(而不是直接用 `findFor`)
   *
   * `findFor` 只回**仍有效**的授权 —— 已撤销 / 已过期 / 非用户签发的授权会被它**藏成 `null`**。
   * 执行点若拿 `findFor` 的结果去喂 `evaluate`,`evaluate` 里那三条 deny 分支(撤销 / 过期 /
   * 来源非用户)**永远不可达**:要么拿到有效授权放行、要么拿到 null 走「重新批准」——
   * 「硬拒绝」成了死代码,**变异也变不红**(这就是「接上了却没用」的假接线)。
   *
   * 要让它真承重,执行点必须能拿到**治理该动作的原始授权(含失效态)**,再交给 `evaluate`
   * 判。本方法就是那把「不管死活的取回口」:返回第一份 ① `allowedActions` 含 `intent.method`、
   * ② 核心意图未被 `intent.core` 改动(`invalidationsFor` 为空)的授权 —— **有效且用户签发者
   * 优先**,否则退回**第一个匹配的失效 / 非用户授权**;一个都匹配不到才 `null`。
   *
   * 于是 `evaluate(intent, store.findBoundFor(intent, now), ctx)` 能走到**全部** deny 分支。
   */
  findBoundFor(intent: ActionIntent, now: number): Grant | null {
    let fallback: Grant | null = null;
    for (const g of this.grants.values()) {
      if (!g.allowedActions.includes(intent.method)) continue;
      if (invalidationsFor(intent.core, g.scopedCore).length > 0) continue;
      // ① 仍有效 **且** 用户签发 = 最优,直接回。
      if (g.approvalSource.kind === "user" && isGrantActive(g, now)) return g;
      // ② 否则记住第一份匹配的(已撤销 / 已过期 / 非用户签发),作为退路 —— 让 evaluate 去判它。
      if (fallback === null) fallback = g;
    }
    return fallback;
  }

  /**
   * **记一次使用** —— 一次动作在授权下真的执行了,把 `usedCount`(+1)与 `budgetUsed`(加上这次的
   * 估算费用)回写。**必须在动作执行**成功**之后**调,不是审批通过时 —— 记账记的是"真的用掉了",
   * 不是"打算用"。
   *
   * ## 为什么非要这个口
   *
   * `evaluate` 会读 `grant.usedCount` / `grant.budgetUsed` 来判「超次数 / 超预算」,但它们**只有
   * 签发时置的 0** —— 全仓没有一处回写。于是 `maxCount: 3` 的授权可以**无限次**执行(每次读到
   * 的都是 0),`maxBudget` 同理。这正是 ARC-004 要的「计划级授权」最核心的一条约束:批了三次
   * 就只能是三次。没有这个口,`maxCount` / `maxBudget` 是**只声明不兑现**的死字段。
   *
   * ## 判据
   *
   *  - 撤销 / 过期 / 不存在 → 抛 `GrantStoreError`(执行点不该在无效授权下记一笔;这会让调用方
   *    把 bug 静默带过去)。
   *  - `cost` 省略 = 0(次数仍 +1);只对**有上限**的 `budgetUsed` 累加(没有 `maxBudget` 的授权
   *    不必记费用,免得一个恒增的死字段)。
   *  - 到期后(`now >= expiresAt`)拒绝记账 —— 与 `get` / `findFor` 同一道有效判据。
   */
  recordUse(grantId: string, cost = 0, now: number): Grant {
    const g = this.grants.get(grantId);
    if (!g) throw new GrantStoreError(`记账失败:授权 ${grantId} 不存在。`);
    if (!isGrantActive(g, now)) {
      throw new GrantStoreError(`记账失败:授权 ${grantId} 已撤销或已过期,不该在它下面执行动作。`);
    }
    g.usedCount = (g.usedCount ?? 0) + 1;
    if (g.maxBudget !== undefined) g.budgetUsed = (g.budgetUsed ?? 0) + cost;
    this.flush();
    return g;
  }

  private flush(): void {
    this.persist?.save([...this.grants.values()]);
  }
}
