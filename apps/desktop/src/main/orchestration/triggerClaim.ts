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
 * 真正收尾之后再 durable 结算。**【MC-091 E3】结算不再是"promise 落地就记成功"** —— 它把
 * 运行结果映射成业务三态 `SUCCEEDED` / `FAILED` / `UNCERTAIN`(见 {@link TriggerClaimStatus}),
 * 于是"下游到底成功没有"这件事在账本里说得清,不再被一句笼统的 `SUCCEEDED` 盖住。重启时,
 * 盘上任何仍是 `CLAIMED` 的领取都属于"上一个进程在执行途中消失了" —— 它**绝不重复执行**
 * (幂等红线),但也**不被静默丢弃**:转成 `UNCERTAIN` 交给人看到「上一次的运行结果不确定」。
 * 这与台账建议的 `durable trigger-claim / dispatch ledger`(PENDING/CLAIMED/RUNNING/SUCCEEDED/
 * FAILED/UNCERTAIN)是同一套设计,只是本切片把 RUNNING 折进 CLAIMED(见下),用最少的
 * 状态覆盖"领取→执行→完成"这条跨崩边界的全部语义。
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
 * ## 【MC-091 E3】SUCCEEDED **就是**「下游业务成功」,不再等价于「Promise 落地」
 *
 * 从前这里只有两态 `CLAIMED` / `SUCCEEDED`,而 `SUCCEEDED` 在实现里被**每一条收尾路径**
 * (包括"派发被跳过 / 工作流删了 / 上一次还在跑")无差别地写下去 —— 于是它实际说的是
 * 「领取已终结 / promise 落地」,**不能**解释成「下游业务成功」。台账点名的正是这处语义混同:
 * 一场失败的运行也会显示成 `SUCCEEDED`,用户看不出它到底成功没有。
 *
 * 现在把它拆成**业务三态**,落成三个终态(与 `RunResult.status` 一一对应,见
 * {@link runOutcomeOfStatus}):
 *
 *  - `SUCCEEDED` —— 派发**成立**且那次运行以 `success` 收尾(唯一**业务成功**终态);
 *  - `FAILED` —— 派发成立但那次运行以 `failed` 收尾(节点失败 / 引擎预检失败等);
 *  - `UNCERTAIN` —— 拿不到确定结果:运行被**取消**,或重启时发现上一个进程把 `CLAIMED`
 *    留在盘上(进程在执行途中消失)。既不重复执行,也不假装成功。
 *
 * `CLAIMED` 仍是**进行中**(已 durable 领取、还没确认完成)。
 *
 * ⚠️ **明确的一处例外**:一条**没真的派发**的收尾(工作流被删 / 修订变了 / 用户关掉 /
 * 项目没了 / 上一次还在跑)**照旧结算成 `SUCCEEDED`** —— 它说的是"这一格领取被确定地
 * 关上、不会待恢复",**不是**下游业务成功。这类"决定不跑"的收尾由 `skip()` 把**原因**
 * 记进 `AutomationFacts.lastError`,业务结果**以事实表里的原因**为准,而不是从 claim 状态
 * 反推。派发真的成立那一路才是三态映射的来源。
 */
export type TriggerClaimStatus = "CLAIMED" | "SUCCEEDED" | "FAILED" | "UNCERTAIN";

/**
 * 【MC-091 E3】一次定时派发**下游业务结果**的三态 —— 与 `TriggerClaim` 终态是同一件事的
 * 两种叫法(见 {@link claimStatusOfRunOutcome}),冒烟直接钉住这条映射本身。
 */
export type AutomationRunOutcome = "success" | "failed" | "uncertain";

/**
 * 【MC-091 E3】运行结果(`RunResult.status`,可能拿不到)→ 业务三态。
 *
 * - `success` → 成功;
 * - `failed` → 失败;
 * - `cancelled` / `null` / `undefined`(结果拿不到)→ **不确定** —— 绝不把"取消"或
 *   "压根没拿到结果"当成功。
 */
export function runOutcomeOfStatus(
  status: "success" | "failed" | "cancelled" | null | undefined,
): AutomationRunOutcome {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  return "uncertain";
}

/** 【MC-091 E3】业务三态 → 领取终态(一一对应;`success`/`failed`/`uncertain` 各有其态)。 */
export function claimStatusOfRunOutcome(outcome: AutomationRunOutcome): TriggerClaimStatus {
  switch (outcome) {
    case "success":
      return "SUCCEEDED";
    case "failed":
      return "FAILED";
    case "uncertain":
      return "UNCERTAIN";
  }
}

/** 一条领取记录状态是不是**终态**(`CLAIMED` 是唯一的进行中态)。 */
export function isTerminalClaimStatus(status: TriggerClaimStatus): boolean {
  return status !== "CLAIMED";
}

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

/**
 * 校验恢复记录的幂等 ID。只接受真正的十进制非负安全整数分钟：
 * 错乱的 @suffix / 精度溢出不能被拿去恢复到另一条触发器。
 * 旧数据允许不含 ':' 的触发器 key（例如 a@1），保持兼容。
 */
function parseClaimId(claimId: string): { triggerKey: string; minute: number } | null {
  const at = claimId.lastIndexOf("@");
  if (at <= 0) return null;
  const suffix = claimId.slice(at + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(suffix)) return null;
  const minute = Number(suffix);
  if (!Number.isSafeInteger(minute)) return null;
  return { triggerKey: claimId.slice(0, at), minute };
}

/** 从领取 id 还原触发器 key；非法/不安全的分钟后缀拒绝。 */
export function triggerKeyOfClaim(claimId: string): string | null {
  return parseClaimId(claimId)?.triggerKey ?? null;
}

/** 落盘的领取历史必须是规范 claimId + 对应分钟 + 有界时间戳；坏行由调用方 fail-closed。 */
export function isTriggerClaims(raw: unknown): raw is Record<string, TriggerClaim> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  return Object.entries(raw).every(([key, value]) => {
    const parsed = parseClaimId(key);
    if (parsed === null || typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const c = value as Record<string, unknown>;
    if (c.status !== "CLAIMED" && c.status !== "SUCCEEDED" && c.status !== "FAILED" && c.status !== "UNCERTAIN") return false;
    return typeof c.minute === "number" && Number.isSafeInteger(c.minute) &&
      c.minute >= 0 && c.minute === parsed.minute &&
      typeof c.at === "number" && Number.isSafeInteger(c.at) && c.at >= 0;
  });
}

/**
 * 还**没有确认完成**的领取 id —— 重启时,这些就是"上一个进程在执行途中消失了"的那些。
 * 只有 `CLAIMED` 算"待恢复";`SUCCEEDED` / `FAILED` / `UNCERTAIN` 都是终态。
 */
export function pendingClaims(claims: ReadonlyMap<string, TriggerClaim>): string[] {
  return [...claims.entries()].filter(([, c]) => c.status === "CLAIMED").map(([id]) => id);
}

/** 重启恢复时给用户看的一句话(结果不确定 —— 既没成功也没失败)。 */
export function claimRecoveryReason(): string {
  return "上一次的定时运行领取了但没有确认完成(进程可能在执行途中退出了),结果不确定,这次不重复执行;如需重跑请手动运行一次";
}

/**
 * 【MC-091 E3】一次**失败**收尾给用户看的一句话 —— 与 `claimRecoveryReason` 的 UNCERTAIN
 * 那句分开:这里下游业务**明确失败**(不是"拿不到结果")。
 */
export function claimFailureReason(): string {
  return "上一次的定时运行执行失败(工作流未成功收尾);如需重跑请手动运行一次";
}

/**
 * 【MC-091 E3】一次运行被**取消**收尾给用户看的一句话 —— 取消同样落 `UNCERTAIN`(既没
 * 成功也没失败),但措辞与"进程消失的恢复"分开,用户看得出是主动取消的。
 */
export function claimCancelledReason(): string {
  return "上一次的定时运行被取消了(结果不确定);如需重跑请手动运行一次";
}

/**
 * 修剪:未处置的 `CLAIMED` / `FAILED` / `UNCERTAIN` **一律保留**(要留着被恢复消费 / 等人
 * 看到「上一次失败了 / 结果不确定」,按容量淘汰会丢掉这条事实);`SUCCEEDED` 最多留 `keep`
 * 条,按"最近更新"排。与 `lastMinute` 的历史封顶同一条思路。
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
