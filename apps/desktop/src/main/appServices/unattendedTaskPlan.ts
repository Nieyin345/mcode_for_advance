/**
 * **无人值守任务计划** —— MC-059 的授权生产端(「一次讲需求、自主搭建」的那半)。
 *
 * ## 它在补哪个洞(源码可确认)
 *
 * `sessionCommands.ts` 的 `createSessionAndSend` 已经能**消费**一枚覆盖 `session.create` 的
 * 计划级授权(ARC-001 步④:`permissionGrant` 由宿主从目标项目解析权威资源身份、拿 grantId
 * 去 `getGrantStore()` 取回、交唯一判定核 `evaluate` 核对,核不过即拒)。但全仓**没有任何
 * 生产签发口铸得出**这类授权 —— 现有签发口只签 `app_api_call` 的单方法指纹授权
 * (`tools.ts` 的 `signPlanGrantForUserApproval`)与场景部署的 `scene.apply` 计划授权
 * (`sceneDeploy.ts`)。于是那条「无人值守建会话」的路**有消费者、没有生产者**,字段只在
 * 显式带 grantId 时才有意义(而没人带得出来)。
 *
 * 本模块补上那件「铸」:用户在**一次计划**上点头之后,把一个**有界的操作序列**
 * (一组 `session.create`)铸成**一枚** `Grant` —— 绑定 `planId` / 目标项目(资源身份)/
 * 签发主体(必须用户本人)/ 有效期 / 次数上限。之后计划里的每条操作**跑在它之下**,
 * 逐次核、逐次记账(`maxCount` 真承重):批了三次就只能是三次,超界即拒(交回重新批准),
 * 绝不静默续跑。
 *
 * ## 为什么是「计划」而不是「一句 grantId」
 *
 * MC-059 的原话是「缺少可无人值守执行的**授权任务计划**」—— 计划的语义是:① 有界(声明了
 * 哪些操作、几步);② 可核(绑的是**计划内容 + 资源身份**,不是一句"用户点过头了");
 * ③ 可停(任一步被拒即停在**那一条**,不静默重试、不假装跑完)。这三条缺一,「无人值守」
 * 就退化成「给 agent 一个万能授权」。所以本模块**不采信**调用方自报的任何身份:主体、项目
 * 路径、有效期都由**宿主**在签发起核实。
 *
 * ## 边界(诚实划定)
 *
 *   - **不绕过审批**:本模块从不弹卡、也不让 agent 给自己发授权 —— 它只在「用户本人点头」
 *     之后由宿主调用(判据 `subject.kind === "user"` 由 `issueGrant` 兜底,这里再显式前置
 *     一道 `not_user_actor` 拒绝,让「谁不能签」是本模块**显式**的事,不是只靠兜底);
 *   - **有界**:计划声明的操作条数不得超过它声明的 `maxCount`(否则拒绝签发 —— 一棵声明了
 *     3 步却要 5 次上限的计划本身就是坏计划);`maxCount` 落进 grant,由 `policyEngine.evaluate`
 *     逐次核;
 *   - **不新建一套判定**:授权判定仍走**唯一**那份核 `policyEngine.evaluate`(消费端在
 *     `sessionCommands.ts`),本模块只**生产**授权,不另写一套"准不准";
 *   - **执行端** `executeUnattendedPlan` 只把计划逐条交给**唯一业务命令** `createSessionAndSend`
 *     (硬规矩 2:共享实现只有一份),自己不内联建会话/发首条;任一步抛(修订冲突 / 授权
 *     核不过 / 计划过期)→ **停在那一条并如实报**,绝不静默重试或假装跑完。
 */
import { createHash } from "node:crypto";
import type { ActorRef, CoreIntent, Grant } from "@contracts/policyEngine";
import { countBudgetExhausted } from "@contracts/policyEngine";
import { createSessionAndSend, SESSION_CREATE_METHOD, sessionCreateCore } from "./sessionCommands.js";
import { getGrantStore } from "@main/appControl/grantStoreRuntime.js";
import {
  getUnattendedPlanStore,
  type UnattendedPlanRecord,
  type UnattendedPlanStatus,
} from "./unattendedPlanStore.js";

/**
 * **读侧守卫**(MC-029)—— 存档读不懂时,列出 / 续跑 / 执行 / 签发 / 放弃都不许把它
 * 当成「没有计划」。
 *
 * 写侧闸(存档核 `commit` 的 corrupt 拒绝)只保住了**原字节**;但消费端若把
 * `load()` 的「读不懂 → 空表」继续转述给用户,用户看到的仍是「没有等待中的计划 /
 * 这份计划不存在」—— 与「真的没有计划」无法区分,恢复(修好 JSON)也就无从谈起。
 * 「用户没有计划」与「存档读不懂」对用户的含义完全不同:前者无需动作,后者是一个
 * 需要修复的**损坏**。判据不另写一套 —— 直接问存档核自己(`isArchiveCorrupt`,与写侧
 * 闸同一枚标记、同一份 `classify*` 判据)。
 *
 * 文案里必须带「unattended-plans.json 读不懂」这层意思(稳定子串,两个副本的拒绝话
 * 都含它);「续跑报 no_record」那句「存档里没有计划」恰恰是这里要消除的谎。
 */
export const UNATTENDED_ARCHIVE_CORRUPT_CODE = "archive_corrupt";

function unattendedArchiveCorruptReason(): string {
  return (
    "unattended-plans.json 读不懂(可能写入中断被截断)—— 计划存档已停用写入,也列不出 / " +
    "续跑任何计划;原文件保留在 <数据根>/appControl/ 下,修复或删除它后重启即可。"
  );
}

/**
 * 存档健康度不是 `ok` → 抛可诊断错误(供返回值类入口;`refused` 类入口直接返回拒绝结果)。
 *
 * 【MC-029 剩余项】判据从 `isArchiveCorrupt()` 升级为 `archiveHealth()` —— **`unreadable`
 * (文件在但读不了)与 `corrupt` 同样不许被当成「没有计划」**。从前那条只认 corrupt,
 * 权限坏了时 list 会静默回空表(与真·没有计划无法区分),正是本条要消灭的谎。
 */
function assertPlanArchiveReadable(): void {
  const health = unattendedArchiveHealth();
  if (health.state !== "ok") {
    throw new Error(health.reason ?? unattendedArchiveCorruptReason());
  }
}

/**
 * 【MC-029 剩余项】**结构化健康度** —— 给 `unattendedPlans.list` 的成功返回与只读
 * `unattendedPlans.health` 共用。判据只有一份:直接问存档核(`archiveHealth()`),
 * `corrupt` / `unreadable` 分开(一种修内容、一种修权限),`absent` 归 `ok`(真空无需动作)。
 */
export function unattendedArchiveHealth(): { state: "ok" | "corrupt" | "unreadable"; reason?: string } {
  const state = getUnattendedPlanStore().archiveHealth();
  if (state === "ok") return { state };
  const reason = state === "corrupt"
    ? unattendedArchiveCorruptReason()
    : "unattended-plans.json 读不了(权限不足或磁盘错误)—— 计划存档暂时不可用;请检查 <数据根>/appControl/ 下该文件的读取权限后重启。";
  return { state, reason };
}

/** 一条**无人值守操作** —— 计划里一次有界的动作。当前只支持 `session.create`。 */
export interface UnattendedOperation {
  /** 这条操作在计划内的稳定 id(记进执行报告,便于对账"停在哪一条")。 */
  operationId: string;
  /** 动作方法。当前唯一支持 `session.create`(计划授权的 `allowedActions`)。 */
  method: typeof SESSION_CREATE_METHOD;
  /** 首条消息(省略 = 只建会话,与 `createSessionAndSend` 同义)。 */
  prompt?: string;
  /**
   * 这条操作**显式给会话的标题**。给非默认标题 = 不复用项目里的空壳 = 每次操作各自建一条
   * 新行(见 `lib/sessionStart.ts` 的复用判据)—— 无人值守的一串操作通常**互不共用**空壳,
   * 故这里把它摆成一等字段,而不是靠复用逻辑碰运气。
   */
  title?: string;
  /** 这条操作可选的乐观并发修订号(复用某条**已存在**空壳时用);对不上即拒,不静默新建。 */
  expectedRevision?: string;
}

/**
 * 一份**无人值守任务计划** —— 用户在**一次批准**里授权的有界操作序列。
 *
 * 它不是"一串要跑的命令",而是"用户批准了这份计划"的**声明**:哪一步、在哪个项目、
 * 谁被授权、有效期多久、最多几步。签发口据此铸一枚 `Grant`。
 */
export interface UnattendedTaskPlan {
  /** 计划 id(宿主生成;进 grant 的 `sceneId`,便于把这枚授权对回它所属的计划)。 */
  planId: string;
  /** 计划授权在授权核里的 scene id(缺省 `unattended.<planId>`)。 */
  sceneId?: string;
  /** 这些操作跑在**哪个项目**里(资源身份由签发口从项目行解析,不采信调用方给的路径)。 */
  projectId: string;
  /** **谁被授权**(必须用户本人;agent / system 一律拒绝签发)。 */
  actor: ActorRef;
  /** 有界的操作序列(非空;条数不得超过 `maxCount`)。 */
  operations: UnattendedOperation[];
  /** 有效期(从签发时刻起算的毫秒数)。必须为正。 */
  ttlMs: number;
  /** 次数量上限。必须 ≥ `operations.length`(声明不得超过自己声明的边界)。 */
  maxCount: number;
}

/** 签发成功后交回的**计划句柄** —— 计划里的每条操作带上它的 `grantId` 跑。 */
export interface IssuedUnattendedPlan {
  planId: string;
  sceneId: string;
  grantId: string;
  projectId: string;
  /** 授权钉住的权威资源身份(=`sessionCreateCore(projectId)`,`{projectPath}`)。 */
  scopedCore: CoreIntent;
  /** 授权允许的动作(含 `session.create`)。 */
  allowedActions: string[];
  /** 授权次数上限(= 计划的 `maxCount`)。 */
  maxCount: number;
  /** 授权到期时刻(ms epoch)。 */
  expiresAt: number;
  /** 计划声明的操作条数(≤ maxCount)。 */
  operationCount: number;
}

/**
 * 签发一份计划**被拒**的信号 —— 显式报出来,绝不静默签出一枚"看着像授权"的东西。
 * 短码便于调用方分派(不解析人读 reason)。
 */
export class UnattendedPlanRefusedError extends Error {
  readonly code = "plan_refused";
  readonly reason_code:
    | "not_user_actor"
    | "empty_plan"
    | "invalid_ttl"
    | "count_exceeds_bound"
    | "unresolvable_scope";
  constructor(reason_code: UnattendedPlanRefusedError["reason_code"], message: string) {
    super(message);
    this.name = "UnattendedPlanRefusedError";
    this.reason_code = reason_code;
  }
}

/** 计划授权有效期的缺省上限(30 分钟)—— 与 `tools.ts` 的 `PLAN_GRANT_TTL_MS` 同量级。 */
export const UNATTENDED_PLAN_MAX_TTL_MS = 30 * 60 * 1000;

/**
 * **唯一的计划签发口。** 把一个有界操作序列铸成一枚覆盖 `session.create` 的计划级授权。
 *
 * 判据(全部由**宿主**在签发起核实,不采信调用方自报):
 *   ① 主体必须是**用户本人**(agent / system 不能给自己发授权)→ 否则 `not_user_actor`;
 *   ② 操作序列非空 → 否则 `empty_plan`;
 *   ③ `ttlMs` 为正(且不超过上限)→ 否则 `invalid_ttl`;
 *   ④ 操作条数 ≤ `maxCount` → 否则 `count_exceeds_bound`;
 *   ⑤ 目标项目的权威路径解析得出(`sessionCreateCore` 非空)→ 否则 `unresolvable_scope`
 *      —— 绝不签一枚**没有资源绑定**的空核心授权(`evaluate` 对它形同虚设)。
 *
 * 全部通过 → 走**唯一**签发口 `GrantStore.issueGrant`(那里还有一道 `subject.kind === "user"`
 * 兜底),`scopedCore` = 目标项目的权威路径,`maxCount` = 计划声明的次数上限,`ttlMs` = 有效期。
 *
 * @throws {@link UnattendedPlanRefusedError} —— 任一判据不过(见上)。
 */
export function issueUnattendedTaskPlan(plan: UnattendedTaskPlan, now: number): IssuedUnattendedPlan {
  if (!plan.actor || plan.actor.kind !== "user") {
    throw new UnattendedPlanRefusedError(
      "not_user_actor",
      "无人值守计划只能由用户本人签发 —— agent / system 不能给自己发授权。",
    );
  }
  if (!Array.isArray(plan.operations) || plan.operations.length === 0) {
    throw new UnattendedPlanRefusedError("empty_plan", "无人值守计划至少要声明一条操作(空计划签不出)。");
  }
  if (!(plan.ttlMs > 0) || plan.ttlMs > UNATTENDED_PLAN_MAX_TTL_MS) {
    throw new UnattendedPlanRefusedError(
      "invalid_ttl",
      `无人值守计划必须有正的有效期,且不超过 ${UNATTENDED_PLAN_MAX_TTL_MS} ms。`,
    );
  }
  if (!Number.isInteger(plan.maxCount) || plan.maxCount < plan.operations.length) {
    throw new UnattendedPlanRefusedError(
      "count_exceeds_bound",
      `计划声明了 ${plan.operations.length} 条操作,但次数上限只有 ${plan.maxCount} —— ` +
        "计划的次数上限不得小于它声明的操作条数(声明不得超过自己声明的边界)。",
    );
  }
  const scopedCore = sessionCreateCore(plan.projectId);
  if (!scopedCore.projectPath) {
    throw new UnattendedPlanRefusedError(
      "unresolvable_scope",
      `计划的目标项目「${plan.projectId}」解析不出权威路径 —— 拒绝签一枚没有资源绑定的空核心授权。`,
    );
  }
  const sceneId = plan.sceneId ?? `unattended.${plan.planId}`;
  const allowedActions = [...new Set(plan.operations.map((op) => op.method))];
  // ★ MC-001 复核补漏:**授权绑的是这份计划正文**(`planDigest`),不只是项目 scope + 次数上限。
  //   从前 `scopedCore` 只有 `{projectPath}`,同一枚授权下执行端可以拿**另一份** operations
  //   正文去跑(只要还在同一项目、次数没超)—— 「批准的是这一份计划」没有落到可判定的数据上。
  //   现在把计划摘要钉进 `scopedCore.scenePlan`,执行端用**同一份** digest 重建意图交
  //   `evaluate` 核对;正文被换 → 核心意图不符 → 拒绝。
  const planDigest = unattendedPlanDigest(plan);
  const grant = getGrantStore().issueGrant(
    {
      verdict: "allow",
      reason: `用户在计划「${plan.planId}」上本人批准了这份无人值守操作序列。`,
      compatibilityLevel: "write",
      sceneId,
      allowedActions,
      scopedCore: { ...scopedCore, scenePlan: planDigest },
      configHash: "",
      ttlMs: plan.ttlMs,
      maxCount: plan.maxCount,
    },
    plan.actor,
    now,
  );
  return {
    planId: plan.planId,
    sceneId,
    grantId: grant.grantId,
    projectId: plan.projectId,
    // 返回**实际签发进授权**的那份核心意图(含计划摘要),执行端据此把摘要带进意图。
    scopedCore: grant.scopedCore,
    allowedActions,
    maxCount: plan.maxCount,
    expiresAt: grant.expiresAt,
    operationCount: plan.operations.length,
  };
}

/** 计划执行里**单条操作**的结果。 */
export interface UnattendedStepResult {
  operationId: string;
  /** 这条操作是否真的建出了会话(没被拒、没发失败)。 */
  ok: boolean;
  /** 建出的会话 id(被拒 / 失败时为 null)。 */
  sessionId: string | null;
  /** 拒绝 / 失败的稳定短码(`revision_conflict` / `grant_refused` / `plan_expired` / `send_failed`)。 */
  code: string | null;
  reason: string | null;
}

/**
 * 一次计划执行的**报告** —— 不是一句 ok。逐条列出结果,并点明**停在哪一条、为什么停**。
 *
 * `stoppedAt === null` = 计划里的操作**全部按序跑完**(没遇拒)。非 null = 在**那一条**
 * 被拒了、计划**就地停住** —— 剩下的操作**没跑**(绝不静默重试或跳过继续)。
 */
export interface UnattendedExecutionReport {
  planId: string;
  grantId: string;
  started: number;
  results: UnattendedStepResult[];
  /** 遇拒时停在**哪一条操作**;没遇拒为 `null`。 */
  stoppedAt: string | null;
  /** 停住的稳定短码(见 {@link UnattendedStepResult.code});没遇拒为 `null`。 */
  stopCode: string | null;
}

/** 把一步抛出的异常翻成执行报告的稳定短码(判据是异常带的 `code`,不解析人读文案)。 */
function stepCodeOf(thrown: unknown): string {
  const code = (thrown as { code?: unknown })?.code;
  if (code === "revision_conflict") return "revision_conflict";
  if (code === "grant_refused") return "grant_refused";
  return "unexpected";
}

/**
 * **执行一份已签发的无人值守计划** —— 逐条把操作交给**唯一业务命令** `createSessionAndSend`
 * (硬规矩 2),每条都带 `permissionGrant = issued.grantId`(跑在计划授权之下)。
 *
 * ## 三条硬语义(缺一就是假无人值守)
 *
 *   1. **有界**:只跑计划里**声明过**的那几条,一条不多(计划的 `maxCount` 由授权核逐次承重,
 *      超界会被 `sessionCommands` 拒 —— 这里不会**偷偷扩容**)。
 *   2. **拒绝即停**:任一步抛(`revision_conflict` 修订号对不上 / `grant_refused` 授权核不过)
 *      → 记进报告、**就地停住**,剩下的操作**不跑**。绝不静默重试(重试会把"用户断言的那一版"
 *      换成"另一版",正是 OCC 要堵的口子)、绝不假装跑完。
 *   3. **过期即停**:计划过了有效期(`now >= issued.expiresAt`)→ 在**下一条**前停住报
 *      `plan_expired`,不拿一枚过期授权继续建会话。
 *
 * @param now 判定"计划是否已过期"的时刻(可注入,便于确定性测);缺省真实时钟。
 * @param opts 可选的执行监督钩子(MC-059 残余 ④ 的续跑依据):
 *   - `skipOperationIds` —— **续跑时跳过已建成的操作**(不重跑 = 不重复外部副作用,与
 *     `sceneDeploy` 的 `runPlanSteps` 跳过 `done` 步同取向);
 *   - `onStepSettled` —— 每步**落定后**回写进度(续跑崩溃可再续;缺省不回写)。
 */
export interface ExecuteUnattendedOptions {
  /** 续跑时**跳过**已建成的操作 id 集合(不重跑)。 */
  skipOperationIds?: ReadonlySet<string>;
  /** 每步落定后的回写钩子(进执行报告的**该步结果**;缺省无操作)。 */
  onStepSettled?: (result: UnattendedStepResult) => void;
}

export async function executeUnattendedPlan(
  plan: UnattendedTaskPlan,
  issued: IssuedUnattendedPlan,
  actorId: string,
  now: number = Date.now(),
  opts: ExecuteUnattendedOptions = {},
): Promise<UnattendedExecutionReport> {
  const results: UnattendedStepResult[] = [];
  let stoppedAt: string | null = null;
  let stopCode: string | null = null;
  for (const op of plan.operations) {
    // 续跑:已建成的操作**直接跳过** —— 不重跑(重跑就是重复建会话 / 重复发首条),
    // 如实记一条 `skipped_done`,不进 `stoppedAt`(它不是一次失败)。
    if (opts.skipOperationIds?.has(op.operationId)) {
      const skipped: UnattendedStepResult = {
        operationId: op.operationId,
        ok: true,
        sessionId: null,
        code: "skipped_done",
        reason: "此操作在上一次执行中已建成,续跑跳过(不重跑,避免重复的外部副作用)。",
      };
      results.push(skipped);
      opts.onStepSettled?.(skipped);
      continue;
    }
    // ③ 过期即停:不拿过期授权继续。
    if (now >= issued.expiresAt) {
      stoppedAt = op.operationId;
      stopCode = "plan_expired";
      results.push({
        operationId: op.operationId,
        ok: false,
        sessionId: null,
        code: "plan_expired",
        reason: `计划已在 ${issued.expiresAt} 到期,不继续执行未跑的操作。`,
      });
      break;
    }
    try {
      const { session, sendError } = await createSessionAndSend(
        {
          input: {
            projectId: plan.projectId,
            kind: "chat",
            effort: "default",
            permissionMode: "default",
            ...(op.title ? { title: op.title } : {}),
          },
          ...(op.prompt !== undefined ? { prompt: op.prompt } : {}),
        },
        {
          // 计划执行由宿主驱动,跑在计划授权之下;actorId 由调用方给(发起这次无人值守运行的会话/主体)。
          actorKind: "agent",
          actorId,
          operationId: op.operationId,
          scope: plan.projectId,
          permissionGrant: issued.grantId,
          // 【MC-001】把**这一刻实际要执行的这份计划**的摘要带进意图 —— `evaluate` 拿它与
          // 授权钉住的 `scopedCore.scenePlan`(批准时那份正文的摘要)比较:
          //   - 正文一致 → 摘要相等 → 放行;
          //   - 调用方递来另一份 operations / 标题 / maxCount → 摘要不同 → `invalidationsFor`
          //     判 `scenePlan` 被改 → **拒绝**(不会再拿同一枚授权去跑用户没批过的正文)。
          // 摘要由宿主从 plan 现算,不采信调用方给的任何摘要字段。
          coreScenePlan: unattendedPlanDigest(plan),
          ...(op.expectedRevision ? { expectedRevision: op.expectedRevision } : {}),
        },
      );
      const settled: UnattendedStepResult = {
        operationId: op.operationId,
        ok: sendError === null,
        sessionId: session.id,
        code: sendError === null ? null : "send_failed",
        reason: sendError,
      };
      results.push(settled);
      opts.onStepSettled?.(settled);
    } catch (thrown) {
      // ② 拒绝即停:修订冲突 / 授权核不过 —— 记下来、就地停,不静默重试。
      const code = stepCodeOf(thrown);
      stoppedAt = op.operationId;
      stopCode = code;
      const settled: UnattendedStepResult = {
        operationId: op.operationId,
        ok: false,
        sessionId: null,
        code,
        reason: String((thrown as Error)?.message ?? thrown),
      };
      results.push(settled);
      opts.onStepSettled?.(settled);
      break;
    }
  }
  return { planId: plan.planId, grantId: issued.grantId, started: now, results, stoppedAt, stopCode };
}

/* ───────────────────── MC-059:用户签发 + 正式执行入口(IPC 三层落点) ───────────────────── */

/**
 * 计划的**正文**(去掉主体与有效期处置的那部分)—— 批准与执行两半共用的坐标。两个入口都
 * **不含** `actor`:主体是治理事实,由宿主补(见 {@link approveUnattendedPlan})。
 */
export interface UnattendedPlanBody {
  planId: string;
  /** 计划授权在授权核里的 scene id(缺省 `unattended.<planId>`)。 */
  sceneId?: string;
  projectId: string;
  operations: UnattendedOperation[];
  maxCount: number;
}

/**
 * 审批结果 —— 两态分开,调用方不必解析人读文案(与 `@contracts/ipc/unattended.js` 同形)。
 */
export type UnattendedApprovalOutcome =
  | {
      ok: true;
      kind: "granted";
      planId: string;
      grantId: string;
      projectId: string;
      /** 授权钉住的权威资源路径(= 目标项目规范化后的 `projectPath`)。 */
      scopedProjectPath: string;
      maxCount: number;
      operationCount: number;
      expiresAt: number;
    }
  | { ok: false; kind: "refused"; code: string; reason: string };

/**
 * **用户签发一枚计划级授权**(MC-059 的用户可达通道的前一半 —— 与 `sceneDeploy.ts` 的
 * `approveSceneDeployment` 同取向)。
 *
 * ## 为什么签发主体在**这里**写死为 `user`
 *
 * 授权是**治理事实**,只能由宿主产生(ARC-004:ActionContext 不可让 Agent 模型参数填写)。
 * 本函数的入参**没有** `actor` 字段 —— 它自己把 `actor` 补成「用户本人」。于是「自签一份
 * 主体是 agent 的授权」从**这层**就断了(handler 那层也一样:契约 schema 里根本没有 `actor`)。
 * 签发口 `issueGrant` 另有一道 `subject.kind === "user"` 兜底。
 *
 * ## 判据全在签发口
 *
 * 本函数不重复判 ⑤ 条判据(空计划 / 有效期 / 条数 / 项目路径),只把它们的稳定短码**翻译**成
 * `refused` 结果 —— 判定只有一份({@link issueUnattendedTaskPlan})。
 *
 * @param input.planId / projectId / operations / ttlMs / maxCount —— 调用方给的**坐标**。
 * @param now 可注入时钟(缺省 `Date.now`)。
 */
export function approveUnattendedPlan(
  input: UnattendedPlanBody & { ttlMs: number },
  now: number = Date.now(),
): UnattendedApprovalOutcome {
  // ★ MC-029(读侧):存档读不懂时**先拒** —— 正文记不进去,签出去的授权就是「有授权、
  //   列不出、续不了」的孤儿(台账触发链的「重启后又创建另一个 p2」正是这一步)。
  //   放在签发**之前**:拒绝时不产生任何新授权。
  {
    const health = unattendedArchiveHealth();
    if (health.state !== "ok") return { ok: false, kind: "refused", code: UNATTENDED_ARCHIVE_CORRUPT_CODE, reason: health.reason ?? unattendedArchiveCorruptReason() };
  }
  // 签发主体**写死为用户本人** —— 调用方给不了、也改不了这个身份(见上)。
  const plan: UnattendedTaskPlan = {
    ...input,
    ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
    actor: { kind: "user", id: "unattended.approval" },
  };
  try {
    const issued = issueUnattendedTaskPlan(plan, now);
    // 【MC-059 残余 ④】把计划**正文**落盘(与授权同源地走 `appControl/` 下的独立 JSON)—— 授权
    // 只记 sceneId,靠这份记录才能把「sceneId ↔ 哪份计划」对回来、重启后列得出「待执行」。签发
    // 成功即写一条 `pending` 记录(`completedOperationIds` 空)。写失败不回滚授权(授权已铸出、
    // 是本机事实),但**如实**在返回里不含这份记录 —— 调用方据此知道跨重启列表会缺它。
    getUnattendedPlanStore().put({
      planId: issued.planId,
      sceneId: issued.sceneId,
      projectId: issued.projectId,
      grantId: issued.grantId,
      operations: input.operations,
      maxCount: issued.maxCount,
      createdAt: now,
      status: "pending",
      completedOperationIds: [],
      lastStoppedAt: null,
      lastStopCode: null,
    });
    return {
      ok: true,
      kind: "granted",
      planId: issued.planId,
      grantId: issued.grantId,
      projectId: issued.projectId,
      scopedProjectPath: issued.scopedCore.projectPath ?? "",
      maxCount: issued.maxCount,
      operationCount: issued.operationCount,
      expiresAt: issued.expiresAt,
    };
  } catch (err) {
    if (err instanceof UnattendedPlanRefusedError) {
      return { ok: false, kind: "refused", code: err.reason_code, reason: err.message };
    }
    return { ok: false, kind: "refused", code: "unexpected", reason: (err as Error)?.message ?? String(err) };
  }
}

/** 正式执行入口的结果(与 `@contracts/ipc/unattended.js` 的 `UnattendedRunIpcResult` 同形)。 */
export type UnattendedRunOutcome =
  | { ok: false; kind: "refused"; code: string; reason: string }
  | { ok: true; kind: "ran"; report: UnattendedExecutionReport };

/**
 * 从**取回的授权**重建执行端的 `IssuedUnattendedPlan`(只喂 `executeUnattendedPlan` 真读的字段:
 * `grantId` 与 `expiresAt` 承重;其余如实带回,便于报告对账)。执行(首次)与续跑共用。
 */
function issuedFromGrant(plan: UnattendedTaskPlan, grant: Grant, now: number): IssuedUnattendedPlan {
  return {
    planId: plan.planId,
    sceneId: grant.sceneId,
    grantId: grant.grantId,
    projectId: plan.projectId,
    scopedCore: grant.scopedCore,
    allowedActions: [...grant.allowedActions],
    maxCount: grant.maxCount ?? plan.maxCount,
    expiresAt: grant.expiresAt,
    operationCount: plan.operations.length,
  };
}

/**
 * 执行一份计划并**回写进度到存档**(首次与续跑共用的一条执行核 —— 硬规矩 2:判定只有一份)。
 *
 * 判据:
 *   - 起始跳过集 = 存档里那份记录的 `completedOperationIds`(**续跑跳过已建成**;首次为空);
 *   - 每步落定后把成功建成的 operationId 收进集合;
 *   - 收尾:全部建成 → 记录 status = `completed`(且保留已建成集);否则 `pending` +
 *     记 `lastStoppedAt` / `lastStopCode`(如实记「停在哪一条」)。
 *
 * 存档**只**记进度事实(建成了哪几条),**不自带**「还能不能跑」的判断 —— 那仍由授权核现取现判。
 */
async function executeAndRecordProgress(
  plan: UnattendedTaskPlan,
  issued: IssuedUnattendedPlan,
  actorId: string,
  now: number,
  store: ReturnType<typeof getUnattendedPlanStore>,
): Promise<UnattendedExecutionReport> {
  const record = store.get(plan.planId);
  const completed = new Set<string>(record?.completedOperationIds ?? []);
  const report = await executeUnattendedPlan(plan, issued, actorId, now, {
    skipOperationIds: completed,
    onStepSettled: (r) => {
      if (r.ok && r.code !== "plan_expired") completed.add(r.operationId);
    },
  });
  const allDone = plan.operations.every((op) => completed.has(op.operationId));
  const status: UnattendedPlanStatus = allDone ? "completed" : "pending";
  store.put({
    planId: plan.planId,
    sceneId: issued.sceneId,
    projectId: plan.projectId,
    grantId: issued.grantId,
    operations: plan.operations,
    maxCount: issued.maxCount,
    createdAt: record?.createdAt ?? now,
    status,
    completedOperationIds: [...completed],
    lastStoppedAt: allDone ? null : report.stoppedAt,
    lastStopCode: allDone ? null : report.stopCode,
  });
  return report;
}

/**
 * **正式执行一份已批准的无人值守计划**(MC-059 用户可达通道的后一半)。
 *
 * ## 为什么入参只给 `grantId`,不给授权内容
 *
 * 与 `sceneDeploy.ts` 的 `applySceneWithGrant` 同一条纪律:授权是**治理事实**,只能由宿主
 * 产生。收一份自填的授权,调用方就能拼一份 `{approvalSource:{kind:'user'}, ...}` 把判定整个
 * 绕过。所以这里只收一个 id:宿主用 `GrantStore.get(grantId, now)` **取回**那枚授权
 * (**已撤销 / 已过期 / 不存在的 `get` 一律回 `null`**),取不到 = 没有可判的治理事实 →
 * **明确拒绝,一步不建**(与「没有授权绝不执行」同一条纪律,不是「退化到默认放行」)。
 *
 * ⚠️ **这里只把「授权取得到」当作入口闸**;「这枚授权真的覆盖这次建会话吗」(方法 / 项目路径 /
 * 次数上限)由 `executeUnattendedPlan` 逐条交给**唯一业务命令** `createSessionAndSend` 去核
 * (`resolvePermissionGrant` → `policyEngine.evaluate`)—— 判定只有一份。于是批准项目 A、却
 * 来跑项目 B 的计划,会在第一条操作处被判 `grant_scope_mismatch` 并**就地停住**。
 *
 * ## 执行主体
 *
 * 逐条操作跑在**计划授权**之下(`actorKind: "agent"`,与本文件既有的 `executeUnattendedPlan`
 * 同一取向)—— 授权才是治理单位,`actorId` 只用于执行报告 / 对账,不参与判定。
 *
 * @param input 计划正文(与批准时同一份)+ 上一次 {@link approveUnattendedPlan} 签出的 `grantId`。
 * @param actorId 发起这次无人值守运行的会话 / 主体 id(进执行报告,不参与判定)。
 * @param now 可注入时钟(缺省 `Date.now`;既用于取授权,也用于判断计划是否过期)。
 */
export async function runUnattendedPlanWithGrant(
  input: UnattendedPlanBody & { grantId: string },
  actorId: string,
  now: number = Date.now(),
): Promise<UnattendedRunOutcome> {
  // ★ MC-029(读侧):存档读不懂 → **建任何会话之前**就拒绝。执行完回写不了进度,重启后
  //   续跑会重跑已建成的步(重复的外部副作用)—— 与「授权取不到」同一档,先拒再说。
  {
    const health = unattendedArchiveHealth();
    if (health.state !== "ok") return { ok: false, kind: "refused", code: UNATTENDED_ARCHIVE_CORRUPT_CODE, reason: health.reason ?? unattendedArchiveCorruptReason() };
  }
  // 取回授权。`get` 对「不存在 / 已撤销 / 已过期」一律回 null —— 取不到就明确拒绝,不静默放行。
  const grant = getGrantStore().get(input.grantId, now);
  if (grant === null) {
    return {
      ok: false,
      kind: "refused",
      code: "no_grant",
      reason: `授权「${input.grantId}」不存在 / 已撤销 / 已过期 —— 需要重新批准这次无人值守计划。`,
    };
  }
  // 从取回的授权重建执行端的 `IssuedUnattendedPlan`(与续跑入口**共用**同一份重建逻辑)。
  const plan: UnattendedTaskPlan = {
    ...input,
    ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
    ttlMs: grant.expiresAt - now,
    actor: { kind: "user", id: "unattended.approval" },
  };
  const issued = issuedFromGrant(plan, grant, now);
  // 首次执行也**回写进度**:计划跑到一半崩了,存档里那份记录带着 `completedOperationIds`,
  // 下次开机就能列出来续跑(不是从头再跑一遍)。
  const report = await executeAndRecordProgress(plan, issued, actorId, now, getUnattendedPlanStore());
  return { ok: true, kind: "ran", report };
}

/* ───────────────────── MC-059 残余 ④:跨重启 WAITING_APPROVAL 闭环 ───────────────────── */

/**
 * 一条**等待批准 / 待执行**计划的**跨重启视图** —— 重启后从存档读回,配它此刻的授权死活。
 *
 * `kind` 三态,调用方不必自己拼判据(判据只有一份,在 {@link listUnattendedPlans}):
 *   - `waiting_approval` —— 记录在,但**授权取不到 / 已过期 / 已撤销 / 次数已用尽** →
 *     这条计划需要**重新批准**(绝不复用一枚失效授权继续跑);
 *   - `resumable` —— 记录在、授权仍有效、且**还有没建成的操作** → 可从**下一条**续跑;
 *   - `completed` —— 所有操作都已建成(或记录已标记完成)。
 *
 * ⚠️ **过期 / 已撤销的绝不复活**:`waiting_approval` 只是「列出来让用户重新决定」,不是
 * 「续跑入口放行」。续跑入口({@link resumeUnattendedPlanWithGrant})照样从 `GrantStore` 取
 * 授权,**取不到即拒**——列表状态与执行闸是两条独立判定,列表宽松、执行严格。
 */
export interface PendingUnattendedPlanView {
  planId: string;
  sceneId: string;
  projectId: string;
  grantId: string;
  /** 计划声明的操作总数。 */
  operationCount: number;
  /** **已建成**的操作数(跨重启从存档读回)。 */
  completedCount: number;
  /** 剩余未建成的操作 id(可续跑的就是这些)。 */
  remainingOperationIds: string[];
  /** 上面三态之一。 */
  kind: "waiting_approval" | "resumable" | "completed";
  /** 授权此刻到期时刻;授权取不到(已撤销 / 不存在)时为 `null`。 */
  expiresAt: number | null;
  createdAt: number;
  /** 上次执行停在哪一条 / 为什么(没跑过或没停过为 `null`)。 */
  lastStoppedAt: string | null;
  lastStopCode: string | null;
}

/**
 * **列出「等待批准 / 待执行」的计划**(MC-059 残余 ④:重启后读得回)。
 *
 * ## 判据(只有一处 —— 这里)
 *
 * 对存档里**每一条**记录(`UnattendedPlanStore.listAll`,含完成 / 放弃的)算一次:
 *  1. 记录 `status === "abandoned"` → **不出现在列表里**(用户已明确放弃,不再提示);
 *  2. 已建成的操作集 = `completedOperationIds`;剩余 = 声明里未建成的那些;
 *  3. 剩余为空(或 status 已 `completed`)→ `completed`;
 *  4. 否则,授权经 `getGrantStore().get(grantId, now)` 取回:取不到(不存在 / 已撤销 /
 *     已过期)→ `waiting_approval`;取得到但 `maxCount` 已用尽(`countBudgetExhausted`)→
 *     也 `waiting_approval`(授权核已判它「需重新批准」);取得到且有余量 → `resumable`。
 *
 * ⚠️ 授权死活一律走 `GrantStore.get` + 唯一预算判据 `countBudgetExhausted` —— **本函数不另写
 * 一套「还能不能跑」**,与执行端核的是同一份。
 *
 * @param now 可注入时钟(缺省 `Date.now`)。
 */
export function listUnattendedPlans(now: number = Date.now()): PendingUnattendedPlanView[] {
  const store = getUnattendedPlanStore();
  // ★ MC-029(读侧):存档读不懂 → **拒绝**(抛),不是回一张空表。空表在这里是一句谎 ——
  //   界面会把它翻成「没有等待中的计划」,与「真的没有」无法区分;抛错会落进渲染端
  //   `useRpc` 的 listError(ErrorNote 现有路径),用户看到的是「读不懂、怎么修」。
  assertPlanArchiveReadable();
  const grantStore = getGrantStore();
  const out: PendingUnattendedPlanView[] = [];
  for (const rec of store.listAll()) {
    if (rec.status === "abandoned") continue;
    const completed = new Set(rec.completedOperationIds);
    const remaining = rec.operations.filter((op) => !completed.has(op.operationId)).map((op) => op.operationId);
    const grant = grantStore.get(rec.grantId, now);
    let kind: PendingUnattendedPlanView["kind"];
    if (remaining.length === 0 || rec.status === "completed") {
      kind = "completed";
    } else if (grant === null || countBudgetExhausted(grant.maxCount, grant.usedCount)) {
      // 授权取不到 / 次数已用尽 —— 这条计划**需要重新批准**(绝不复活失效授权去续跑)。
      kind = "waiting_approval";
    } else {
      kind = "resumable";
    }
    out.push({
      planId: rec.planId,
      sceneId: rec.sceneId,
      projectId: rec.projectId,
      grantId: rec.grantId,
      operationCount: rec.operations.length,
      completedCount: completed.size,
      remainingOperationIds: remaining,
      kind,
      expiresAt: grant?.expiresAt ?? null,
      createdAt: rec.createdAt,
      lastStoppedAt: rec.lastStoppedAt,
      lastStopCode: rec.lastStopCode,
    });
  }
  return out;
}

/**
 * **续跑一份等待中的无人值守计划**(MC-059 残余 ④:重启后继续执行)。
 *
 * ## 为什么入参只给 `planId`(不给计划正文,也不给授权内容)
 *
 * 计划的正文与授权 id **都已落盘**(`approveUnattendedPlan` 写、{@link listUnattendedPlans} 读)。
 * 续跑时**宿主自己**从存档读回正文({@link UnattendedPlanStore.get})、从 `GrantStore` 取回授权
 * (`get`)—— 调用方给不了、也不需要给正文(给了反而能偷换「续跑的是哪份计划」)。取不到记录
 * (`no_record`)/ 取不到授权(`no_grant`)一律**明确拒绝、一步不建**(与「没有授权绝不执行」同一条
 * 纪律,不是「退化到默认放行」)。这与 `sceneDeploy.resumeScene` 的取向一致:**续跑不重新发明正文**。
 *
 * ## 续跑仍走评审核 + 唯一业务命令(不是第二套执行)
 *
 * 见 {@link executeAndRecordProgress} —— 它与首次执行**共用**一条执行核,起始跳过集取自存档的
 * `completedOperationIds`。已建成的操作**不重跑**(不重复外部副作用),`failed` / 未跑的重试。
 *
 * @param planId 要续跑的计划 id(存档里的键)。
 * @param actorId 发起这次续跑的会话 / 主体 id(进执行报告,不参与判定)。
 * @param now 可注入时钟(缺省 `Date.now`;既用于取授权,也用于判断计划是否过期)。
 */
export async function resumeUnattendedPlanWithGrant(
  planId: string,
  actorId: string,
  now: number = Date.now(),
): Promise<UnattendedRunOutcome> {
  const store = getUnattendedPlanStore();
  // ★ MC-029(读侧):存档读不懂 → 明确拒绝并说清,不是 `no_record`(「存档里没有计划」——
  //   那正是这个缺陷要消除的谎:计划很可能**还在坏字节里**,只是读不出来)。
  if (store.isArchiveCorrupt()) {
    return { ok: false, kind: "refused", code: UNATTENDED_ARCHIVE_CORRUPT_CODE, reason: unattendedArchiveCorruptReason() };
  }
  const rec: UnattendedPlanRecord | null = store.get(planId);
  if (rec === null) {
    return {
      ok: false,
      kind: "refused",
      code: "no_record",
      reason: `存档里没有计划「${planId}」—— 无从续跑。若这是一份全新计划,请走正常批准流程。`,
    };
  }
  if (rec.status === "abandoned") {
    return {
      ok: false,
      kind: "refused",
      code: "abandoned",
      reason: `计划「${planId}」已被明确放弃 —— 不续跑。要重新执行请走正常批准流程。`,
    };
  }
  // 取回授权(**含失效态**:`get` 对「不存在 / 已撤销 / 已过期」一律回 null)。取不到 → 拒绝。
  const grant = getGrantStore().get(rec.grantId, now);
  if (grant === null) {
    return {
      ok: false,
      kind: "refused",
      code: "no_grant",
      reason: `计划「${planId}」的授权「${rec.grantId}」不存在 / 已撤销 / 已过期 —— 需要重新批准后再续跑。`,
    };
  }
  // 从存档的正文 + 取回的授权重建执行端输入(与首次执行共用同一条重建 + 执行核)。
  const plan: UnattendedTaskPlan = {
    planId: rec.planId,
    ...(rec.sceneId !== undefined ? { sceneId: rec.sceneId } : {}),
    projectId: rec.projectId,
    operations: rec.operations,
    ttlMs: grant.expiresAt - now,
    maxCount: rec.maxCount,
    actor: { kind: "user", id: "unattended.approval" },
  };
  const issued = issuedFromGrant(plan, grant, now);
  const report = await executeAndRecordProgress(plan, issued, actorId, now, store);
  return { ok: true, kind: "ran", report };
}

/**
 * **明确放弃一份计划**(MC-059 残余 ④:可「继续执行**或**明确放弃」的那半)。
 *
 * 把存档里那条记录标成 `abandoned` —— 于是 {@link listUnattendedPlans} 不再列出它、
 * {@link resumeUnattendedPlanWithGrant} 也拒绝续跑(`abandoned`)。**不撤销授权**(授权是独立
 * 治理事实,由用户另行撤销;放弃的是「这份计划」,不是「这枚授权」),也不删记录(留痕可审计)。
 *
 * @returns `true` = 真的把一条**未放弃**的计划标记为放弃;`false` = 记录不存在或已放弃(幂等 no-op)。
 */
export function abandonUnattendedPlan(planId: string): boolean {
  const store = getUnattendedPlanStore();
  // ★ MC-029(读侧):存档读不懂 → 抛错,不谎报 `false`(「不存在或已放弃」在坏存档下
  //   无法证实 —— 计划可能还在坏字节里)。渲染端的 abandon 已有 catch 显示这条错。
  assertPlanArchiveReadable();
  const rec = store.get(planId);
  if (rec === null || rec.status === "abandoned") return false;
  store.put({ ...rec, status: "abandoned" });
  return true;
}

/**
 * 计划内容的**稳定摘要** —— 让「批准的是这一份计划吗」可核对(与 `scenePlanCoreIntent` 同取向:
 * 计划一旦被改,摘要就变,旧授权不该再覆盖它)。当前不参与 grant 的 `scopedCore`(那绑的是
 * 资源身份 `projectPath`),供调用方 / 审计把执行报告对回**它当初批准的那份计划**。
 */
export function unattendedPlanDigest(plan: UnattendedTaskPlan): string {
  const body = JSON.stringify({
    planId: plan.planId,
    projectId: plan.projectId,
    actor: plan.actor,
    operations: plan.operations.map((o) => ({ id: o.operationId, method: o.method, title: o.title ?? null, rev: o.expectedRevision ?? null })),
    maxCount: plan.maxCount,
  });
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}
