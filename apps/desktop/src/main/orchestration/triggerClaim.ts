/**
 * 定时触发的 **durable claim(领取)状态机**(MC-051)。
 *
 * ## 它在补哪个洞
 *
 * 「同一分钟只跑一次」原本只靠一张 `lastMinute` 去重表(见 `automationRunner` 的
 * `LAST_MINUTE_SETTING_KEY`)。2026-10-11 已经把它做成**派发前同步落盘** —— 于是
 * "内存已记、文件未写"那个窗口里被杀不会重复执行了。**但那只是一张去重表,不是一条
 * 可追踪的领取记录**:它只回答"这一分钟碰过没有",回答不了台账 MC-051 点名的那几个
 * 问题 —— *这一分钟到底是"领了、执行了、完成了",还是"领了、进程就没了"?*
 *
 * 这里把定时派发做成一条**显式领取**:派发之前先 durable 写一条 `CLAIMED`;运行
 * 真正完成之后再 durable 结算成 `SUCCEEDED`。重启时,盘上任何**不是 `SUCCEEDED`** 的
 * 领取都属于"上一个进程在执行途中消失了" —— 它**绝不重复执行**(幂等红线),但也
 * **不被静默丢弃**:交给人看到「上一次的运行结果不确定」。这与台账建议的
 * `durable trigger-claim / dispatch ledger`(PENDING/CLAIMED/RUNNING/SUCCEEDED/
 * FAILED/UNCERTAIN)是同一套设计,只是本切片把 RUNNING 折进 CLAIMED(见下),用最少
 * 的状态覆盖"领取→执行→完成"这条跨崩边界的全部语义。
 *
 * ## 为什么落盘走 settings,不是新开一张表(与 `lastMinute` 同一条理由)
 *
 * 形状是**一张小映射**(`claimId → {status, minute, at}`),不是"一次运行的存档" ——
 * 与 `browser.addressHistory` / `automation.lastMinute` 同类,都走 `SettingRepo`。
 * 开新表要动 `store/db.ts`(建表 + 迁移)再加一个 Repo,换来的只是"能按列查",而这里
 * 没有任何按列查的需求(每次都是整张读进来、整张写回去)。**落盘仍走唯一那条 durable
 * 通路**(`SettingRepo.set` + `persistNowOrThrow`,与 MC-084 的 `DurableOperationLedger`
 * 共用 `commitNow`)—— 不另立一套写盘机制。
 *
 * ## 为什么没有独立的 RUNNING 态
 *
 * 台账那套完整状态机里 `CLAIMED`(领了、还没派发)与 `RUNNING`(派发了、在跑)是分开的。
 * 这里刻意折进一个 `CLAIMED`:**每一个状态都要一次同步 fsync 整库**,而"派发前一写、
 * 派发后一写、完成后再一写"就是每个定时运行三次整库重写 —— 对"每分钟一次"的自动化
 * 是纯浪费。两态(`CLAIMED` / `SUCCEEDED`)已足够回答"这一条到底确认完成了没有",而
 * 那正是崩溃恢复唯一要问的问题。真要分 `RUNNING`,是将来接 `workflow_runs` 运行史
 * 做精确对账时的事(见 `automationRunner` 的 `recoverIncompleteClaims`)。
 *
 * 这个文件**只放纯判定**,不碰进程 / 文件系统 / 数据库 —— 与 `automationStatus.ts`
 * 同一条分法,冒烟可以直接钉住每一条规则。
 */

/**
 * 一条定时领取的状态。
 *
 *  - `CLAIMED` —— 已 durable 领取、**还没确认完成**(正在执行 / 进程崩在这条缝里);
 *  - `SUCCEEDED` —— 这一次派发已经走完(工作流本身成功或失败都算"走完了"),唯一**成功终态**;
 *  - `UNCERTAIN` —— 重启时发现上一个进程把 `CLAIMED` 留在了盘上:`CLAIMED` 经恢复**转成**
 *    它 —— 既不重复执行,也不再每次重启反复报告同一件事。它同样是**终态**,但说的事实是
 *    "上次那次没确认完成,已告诉人,等人处置",与 `SUCCEEDED` 不是一回事。
 */
export type TriggerClaimStatus = "CLAIMED" | "SUCCEEDED" | "UNCERTAIN";

/** 盘上一条领取记录。 */
export interface TriggerClaim {
  status: TriggerClaimStatus;
  /** 这条领取对应的分钟(毫秒 / 60000,与 `lastMinute` 同一把尺)。 */
  minute: number;
  /** 领取 / 最后一次更新的时刻(ms)。修剪按它排"最近"。 */
  at: number;
}

/**
 * 定时领取的**幂等键**:一条触发器在**某一个分钟**上最多领取一次。
 *
 * 形状 `${workflowId}:${nodeId}@${minute}` —— 与 `automationTriggerKey` 的
 * `workflowId:nodeId` 一致,后面挂 `@minute`。`@` 不会出现在 workflowId / nodeId 里
 * (它们是 `uid()` / 有约束的 id),所以解析回 `(workflowId, nodeId)` 是无歧义的。
 */
export function scheduleClaimId(triggerKey: string, minute: number): string {
  return `${triggerKey}@${minute}`;
}

/** 从一个 claimId 拆回触发器 key(`workflowId:nodeId`)。拆不出来返回 null。 */
export function triggerKeyOfClaim(claimId: string): string | null {
  const at = claimId.lastIndexOf("@");
  return at > 0 ? claimId.slice(0, at) : null;
}

/** 落盘那份能读的判据。读不回来**不抛**,当空表 —— 同 `isLastMinutes` 的立场。 */
export function isTriggerClaims(raw: unknown): raw is Record<string, TriggerClaim> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  return Object.entries(raw).every(([key, value]) => {
    if (key.length === 0 || typeof value !== "object" || value === null) return false;
    const c = value as Record<string, unknown>;
    if (c.status !== "CLAIMED" && c.status !== "SUCCEEDED" && c.status !== "UNCERTAIN") return false;
    return typeof c.minute === "number" && Number.isFinite(c.minute) &&
      typeof c.at === "number" && Number.isFinite(c.at);
  });
}

/**
 * 还**没有确认完成**的领取 id —— 重启时,这些就是"上一个进程在执行途中消失了"的那些。
 * 只有 `CLAIMED` 算"待恢复";`SUCCEEDED` 与已处置过的 `UNCERTAIN` 都是终态。
 */
export function pendingClaims(claims: ReadonlyMap<string, TriggerClaim>): string[] {
  return [...claims.entries()].filter(([, c]) => c.status === "CLAIMED").map(([id]) => id);
}

/** 重启恢复时给用户看的一句话。 */
export function claimRecoveryReason(): string {
  return "上一次的定时运行领取了但没有确认完成(进程可能在执行途中退出了),这一次不重复执行;如需重跑请手动运行一次";
}

/**
 * 修剪:未处置的 `CLAIMED` 与 `UNCERTAIN` **一律保留**(要留着被恢复消费 / 等人看到,
 * 按容量淘汰会丢掉"没确认完成"这件事);`SUCCEEDED` 最多留 `keep` 条,按"最近更新"排。
 * 与 `lastMinute` 的历史封顶同一条思路。
 */
export function pruneClaims(
  claims: ReadonlyMap<string, TriggerClaim>,
  keep: number,
): Map<string, TriggerClaim> {
  const entries = [...claims.entries()];
  const keepAlways = entries.filter(([, c]) => c.status !== "SUCCEEDED");
  const succeeded = entries
    .filter(([, c]) => c.status === "SUCCEEDED")
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, keep);
  return new Map([...keepAlways, ...succeeded]);
}
