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

/**
 * 把「一次运行**当时**记下的哈希表」（`RunConfigSnapshot.profiles`）翻译成**声明的
 * 配置绑定** —— 每个当时锁下了哈希的资源都是一条 `PINNED` + `RUN_START` 绑定。
 *
 * 供运行史 readback 走一遍 {@link resolveConfigBinding} 解析：于是「这一轮实际用了
 * 哪一版」与「源是否已经越过它」由**同一份锁版判定**回答（`effectiveHash` = 当时锁下的
 * 旧值、`stale` = 源此后被改过），而不是在调用方各写一遍 —— 这正是 ARC-016 要把
 * 「运行存档里那张哈希表」与「显式声明的 `ConfigBinding`」统一到一处的那一步。
 *
 * `null` 锁定值（当时没绑到这个资源）**不产出绑定**：`PINNED` 必须有 `pinnedHash`，
 * 缺了就是契约错误（见 {@link resolveConfigBinding}）。那种「当时没有、现在有了」的
 * 情形由 {@link configDrift} 的 `added` 覆盖，两者互补不重复。返回按 `assetId` 升序，
 * 变更计划才好稳定 diff（与 {@link configDrift} 同一条规矩）。
 */
export function runStartBindings(
  locked: Readonly<Record<string, string | null>>,
): ConfigBinding[] {
  const out: ConfigBinding[] = [];
  for (const assetId of Object.keys(locked)) {
    const hash = locked[assetId];
    if (typeof hash === "string" && hash.length > 0) {
      out.push({ assetId, pinnedHash: hash, bindingPolicy: "PINNED", effectiveAt: "RUN_START" });
    }
  }
  out.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
  return out;
}

/** 一条资源在「当时锁下」与「现在」之间的差异性质。 */
export type ConfigDriftKind =
  /** 当时绑到了某个版本，现在源变了另一个版本。 */
  | "changed"
  /** 当时绑到了某个版本，现在源没了（档案被删）。 */
  | "removed"
  /** 当时没绑到（`null`），现在源有了 —— 这轮跑的时候它其实没生效。 */
  | "added";

/** 一条资源版本差异 —— 供预检生成「源比运行当时新了」的变更计划。 */
export interface ConfigDriftEntry {
  assetId: string;
  /** 运行当时锁下的哈希（`null` = 当时没绑到）。 */
  lockedHash: string | null;
  /** 现在源档案的哈希（`null` = 现在没了）。 */
  currentHash: string | null;
  kind: ConfigDriftKind;
}

/**
 * 比较「一次运行**当时**记下的档案哈希表」与「现在的档案哈希表」，挑出**落后项** ——
 * ARC-016 预检要的「源档案比声明的 scene lock 新」的变更计划。
 *
 * 与 {@link staleBindings} 互补，不是重复：那个走的是**显式声明**的 `ConfigBinding`
 * 列表（用户在 SceneSpec 里写了 PINNED/LIVE），这里走的是**运行存档里已记下的**那张
 * 哈希表（`RunConfigSnapshot.profiles`）—— 用来回答「这一轮实际用了哪一版、现在还一样吗」。
 *
 * 判据（只对**运行当时的**资源集合做判定，**绝不为运行没用过的资源**造条目）：
 *  - 遍历 `locked` 的每个键（= 这一轮声明要用的资源；值可为 `null` = 当时没绑到）；
 *  - `current` **没有**这个键 → **跳过**，不判（调用方没告诉我们就别猜「删了」还是「没变」）；
 *  - 锁了值、现值相同 → 无差异；值不同 → `changed`；现值 `null` → `removed`；
 *  - 当时是 `null`、现在有值 → `added`（这轮跑时它其实没生效，现在补上了）。
 *
 * `current` 里**多出来**、`locked` 里没有的资源**不产生条目** —— 运行没用过它，
 * 说「这轮用了它」就是编。返回按 `assetId` 升序，好让变更计划稳定可 diff。
 */
export function configDrift(
  locked: Readonly<Record<string, string | null>>,
  current: Readonly<Record<string, string | null>>,
): ConfigDriftEntry[] {
  const out: ConfigDriftEntry[] = [];
  for (const assetId of Object.keys(locked)) {
    // 调用方没给的资源不判 —— 分不清「删了」与「没变」，猜任何一个都是编。
    if (!Object.prototype.hasOwnProperty.call(current, assetId)) continue;
    const lockedHash = locked[assetId] ?? null;
    const currentHash = current[assetId] ?? null;
    if (lockedHash === currentHash) continue;
    const kind: ConfigDriftKind =
      lockedHash === null ? "added" : currentHash === null ? "removed" : "changed";
    out.push({ assetId, lockedHash, currentHash, kind });
  }
  out.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
  return out;
}
