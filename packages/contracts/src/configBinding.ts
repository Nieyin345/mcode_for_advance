/**
 * **配置绑定（ConfigBinding）** —— ARC-016 的推荐契约：把「一个资源引用到底用哪个版本、
 * 什么时候生效」讲清楚，让场景版本可复现、可审计。
 *
 * ## 为什么需要它
 *
 * 同一个 Agent 档案 id 在两类上下文里生效时点不同：
 *   - 普通 chat 新建时把档案指令**快照**存进会话，之后源档案编辑**不会**改这条会话（PINNED）；
 *   - 工作流 node 按**每轮读当前**档案参数，改源文件会影响下一次执行（LIVE）。
 *
 * 两者各自合理，但用户说「用研究助理 v1 跑多阶段任务」时，同一个 id 可能对应不同时刻的
 * 真实提示与工具限制 —— 审计时答不出「这轮到底用了哪个版本」。`ConfigBinding` 就是那个
 * 缺失的显式规则。
 *
 * ## 安全边界
 *
 * 这里**只记引用与内容哈希**（`sourceHash`），绝不拷贝档案正文或密钥。日志只暴露哈希。
 */

/** 绑定策略：这个引用是**锁版**（PINNED）还是**随源实时**（LIVE）。 */
export type ConfigBindingPolicy = "PINNED" | "LIVE";

/** 生效时点：实时绑定时，新 revision 从什么时候起被采用。 */
export type ConfigEffectiveAt =
  /** 只在部署（Scene deploy）那一刻取一次。 */
  | "DEPLOY"
  /** 每次运行（run）开始时取。 */
  | "RUN_START"
  /** 每轮（turn）开始时取。 */
  | "NEXT_TURN";

/**
 * 一条资源的配置绑定。
 *
 * - `assetId`：资源身份（档案 id / 技能名 / …）。
 * - `pinnedHash`：`PINNED` 时锁定的内容哈希；`LIVE` 时可缺省（不锁）。
 * - `bindingPolicy` / `effectiveAt`：见上。
 */
export interface ConfigBinding {
  assetId: string;
  /** `PINNED` 时锁定的内容哈希（`sha256:` 形状或裸 hex）；`LIVE` 时通常缺省。 */
  pinnedHash?: string;
  bindingPolicy: ConfigBindingPolicy;
  effectiveAt: ConfigEffectiveAt;
}

/** 一次绑定解析的结果 —— 这一轮/这次运行**实际**该用哪个哈希，以及它是否已落后于源。 */
export interface ResolvedConfigBinding {
  assetId: string;
  /** 实际生效的哈希（`PINNED` = 锁定值；`LIVE` = 当前源哈希）。 */
  effectiveHash: string | null;
  /** 采用的策略。 */
  policy: ConfigBindingPolicy;
  /**
   * 源档案当前哈希与生效值**不一致**：锁版绑定的源此后被改过。**不改写生效值**（锁版就是
   * 要旧值），只如实报出来，供预检生成「源档案比声明的锁新」的变更计划（ARC-016）。
   */
  stale: boolean;
}

/**
 * 解析一条绑定在当前源哈希下**实际生效**的版本 —— 纯函数，是 ARC-016 语义的唯一落点。
 *
 * 判据：
 *   - `PINNED`：生效值 = `pinnedHash`（锁定的旧值）；若 `currentHash` 与 `pinnedHash` 不同，
 *     `stale = true`（源被改过，但**不改写生效值** —— 锁版的意义就是不随源变）。
 *   - `LIVE`：生效值 = `currentHash`（随源）；`stale` 恒 `false`（本来就是实时的）。
 *
 * `PINNED` 但**没给** `pinnedHash` 是**契约错误** → 抛错（不许静默退化成 LIVE；那会让一个
 * 本该复现的场景悄悄跟着源漂）。
 */
export function resolveConfigBinding(
  binding: ConfigBinding,
  currentHash: string | null,
): ResolvedConfigBinding {
  if (binding.bindingPolicy === "PINNED") {
    if (binding.pinnedHash === undefined) {
      throw new Error(
        `配置绑定 ${binding.assetId} 声明为 PINNED 却没给 pinnedHash —— 不许静默退化成 LIVE` +
          `(那会让本该复现的场景跟着源漂)。`,
      );
    }
    return {
      assetId: binding.assetId,
      effectiveHash: binding.pinnedHash,
      policy: "PINNED",
      // 源与锁定值不同 = 源此后被改过;锁版仍用旧值,只如实报「落后了」。
      stale: currentHash !== null && currentHash !== binding.pinnedHash,
    };
  }
  // LIVE:随源,永远用当前哈希、永远不 stale。
  return {
    assetId: binding.assetId,
    effectiveHash: currentHash,
    policy: "LIVE",
    stale: false,
  };
}

/** 一批绑定里的「落后项」—— 供预检生成变更计划（哪些锁版绑定的源已经变了）。 */
export function staleBindings(
  resolved: ReadonlyArray<ResolvedConfigBinding>,
): ResolvedConfigBinding[] {
  return resolved.filter((r) => r.stale);
}
