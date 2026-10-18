/**
 * **无人值守任务计划的审批入口** —— IPC 契约(MC-059 的用户可达通道)。
 *
 * ## 它在补哪个洞(源码可确认)
 *
 * `main/appServices/unattendedTaskPlan.ts` 早就有**生产端**:`issueUnattendedTaskPlan`
 * 把一个有界操作序列铸成一枚覆盖 `session.create` 的计划级授权,`executeUnattendedPlan`
 * 逐条把它交给唯一业务命令 `createSessionAndSend`、被拒即停。但它**只落在 appServices**,
 * **没有三层 IPC 入口** —— 用户够不到,agent 更不该够到,于是「无人值守建会话」这条通道
 * 事实上没有用户可达的落点。
 *
 * ## 这一套照 MC-058 的 `scene.approve` / `scene.apply` 范式抄,不另发明一套
 *
 *   - `unattended.approve` —— 用户看过 dry-run 之后点「批准」的落点。宿主据入参铸一枚
 *     计划级授权,**签发主体由 handler 写死为 `user`**(调用方给不了身份);返回绑定这份
 *     计划的 `grantId`。
 *   - `unattended.run`     —— 正式执行:只给 `grantId` **不给授权内容**。授权由宿主从
 *     `GrantStore` **取回**(含失效态),取不到一律拒绝执行、一步不建。
 *
 * ## 为什么这两条**不能**开给 agent(钉在 `policy.ts` 的 blocked)
 *
 * 与 `scene.approve` / `scene.apply` 同一条纪律:批准一份会真的建会话、发首条消息的**计划**,
 * 是「用户点头」这件事本身。agent 任何理由都不该自己批自己的计划(批了就等于自己给自己
 * 授权去建会话)。这两条**不在 `API_CATALOG` 的 `POLICY` 兜底之外** —— 若不显式钉 blocked,
 * `policyFor` 的动词兜底会把它们猜成 `write` 并弹卡,那就是「agent 能自己批自己的计划」死角。
 *
 * ## schema 里**没有** `actor` 字段
 *
 * 签发主体是治理事实,只能由宿主产生(ARC-004:ActionContext 不可让 Agent 模型参数填写)。
 * 调用方给的是「批准哪份计划、在哪个项目、几步、多久」这些**它本来就看得见**的坐标,
 * `actor` / `grantId` / 时间戳一律由宿主补。于是「自签一份主体是 agent 的授权」从**契约层**
 * 就断了(即便调用方多塞一个 `actor` 字段,`.object` 默认也把它 strip 掉,handler 从不读它)。
 */
import { z } from "zod";

/**
 * 计划里**一条操作**的入参。`method` **不在契约里** —— 当前无人值守计划唯一支持
 * `session.create`,由 handler **写死**;调用方给不了别的动作,也就夹带不了别的方法。
 */
export const UnattendedOperationInputSchema = z.object({
  /** 这条操作在计划内的稳定 id(进执行报告,用于对账"停在哪一条")。 */
  operationId: z.string().min(1),
  /** 这条操作显式给会话的标题(给非默认标题 = 不复用项目里的空壳,各自建一条新行)。 */
  title: z.string().optional(),
  /** 首条消息(省略 = 只建会话,与 `createSessionAndSend` 同义)。 */
  prompt: z.string().optional(),
  /** 复用某条已存在空壳时的乐观并发修订号;对不上即拒,不静默新建。 */
  expectedRevision: z.string().optional(),
});
export type UnattendedOperationInput = z.infer<typeof UnattendedOperationInputSchema>;

/**
 * 审批入参 —— 一份**候选**无人值守计划的声明。**不含 `actor` / `grantId`**:签发主体与授权
 * 都由宿主在 handler 里补,调用方给不了(见文件头)。
 *
 * `operations` 是一条有界的操作序列(至少一条);`maxCount` 是次数量上限(签发口要求它 ≥
 * 操作条数 —— 声明不得超过自己声明的边界);`ttlMs` 是有效期(签发口只拒非正数与超上限)。
 */
export const UnattendedApproveInputSchema = z.object({
  /** 一次批准 / 执行的稳定 id(重试是同一 id 的覆盖,不是新计划)。 */
  planId: z.string().min(1),
  /** 这些操作跑在**哪个项目**里(权威路径由签发口从项目行解析,不采信调用方给的路径)。 */
  projectId: z.string().min(1),
  /** 有界的操作序列(至少一条)。 */
  operations: z.array(UnattendedOperationInputSchema).min(1),
  /** 授权有效期的毫秒数(签发口只拒非正数;具体上限由签发口策略定)。 */
  ttlMs: z.number().int().positive(),
  /** 次数量上限(签发口要求 ≥ 操作条数)。 */
  maxCount: z.number().int().positive(),
});
export type UnattendedApproveInput = z.infer<typeof UnattendedApproveInputSchema>;

/**
 * 审批结果 —— 两态分开,调用方不必解析人读文案:
 *  - `granted`:签出了一枚计划级授权,带上它的 `grantId` / 绑定的资源路径 / 到期时刻;
 *  - `refused`:**没签**(主体不是用户 / 空计划 / 有效期非法 / 条数超界 / 项目解析不出路径),
 *    `code` 是签发口给出的稳定短码,`reason` 说清为什么。
 */
export type UnattendedApproveResult =
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
 * 执行入参 —— **不给授权内容,只给 `grantId`**。与 `scene.apply` 同一条纪律:授权是治理
 * 事实,只能由宿主产生;收一份自填的授权等于把授权判定整个绕过。宿主拿 `grantId` 从
 * `GrantStore` 取回授权(含失效态),取不到 = 没有可判的治理事实 → **拒绝执行,一步不建**。
 *
 * 计划正文(操作序列 / 项目 / 上限)要**再给一遍** —— 执行端要按它逐条派发(与 `scene.apply`
 * 重发 spec 同义)。`ttlMs` 不在执行入参里:授权有效期住在 grant 上,不在计划正文里。
 */
export const UnattendedRunInputSchema = z.object({
  planId: z.string().min(1),
  projectId: z.string().min(1),
  operations: z.array(UnattendedOperationInputSchema).min(1),
  maxCount: z.number().int().positive(),
  /** 上一次 `unattended.approve` 签出的授权 id。 */
  grantId: z.string().min(1),
  /**
   * **发起者坐标**(MC-059 残余 ②)—— 渲染端坐在哪条会话里点的「执行」。它**不是**发起者
   * 身份本身,只是一枚宿主**能核实**的坐标:宿主拿它去 `SessionRepo.get` 取回那条会话,取得到
   * 才据此产出可信的发起者标识(`session:<id>`);取不到 = 一枚伪造的坐标 → **拒绝执行**,
   * 绝不静默采信成一个身份字符串。
   *
   * ⚠️ 与 `actor` 一样**不给身份、只给坐标**:调用方给不了"我是谁",只能指一条**真实存在**
   * 的会话(「用户本人发起的那个 UI 动作」的落点),身份由宿主产生(ARC-004:ActionContext
   * 由宿主产生,不可让 Agent 模型参数填写)。省缺时宿主退回按 IPC 事件的 `sender` 派生
   * (见 `ipc/unattended.ts`)。**绝不**让调用方直接填一个 `actorId` 字符串。
   */
  initiatorSessionId: z.string().min(1).optional(),
});
export type UnattendedRunInput = z.infer<typeof UnattendedRunInputSchema>;

/** 执行报告里**单条操作**的结果(过 IPC 的形状;与 `UnattendedStepResult` 同形)。 */
export interface UnattendedStepResultWire {
  operationId: string;
  ok: boolean;
  sessionId: string | null;
  code: string | null;
  reason: string | null;
}

/** 一次计划执行的报告(过 IPC 的形状;与 `UnattendedExecutionReport` 同形)。 */
export interface UnattendedExecutionReportWire {
  planId: string;
  grantId: string;
  started: number;
  results: UnattendedStepResultWire[];
  /** 遇拒时停在**哪一条操作**;没遇拒为 `null`。 */
  stoppedAt: string | null;
  /** 停住的稳定短码;没遇拒为 `null`。 */
  stopCode: string | null;
}

/**
 * 执行结果 —— 两态(`refused` / `ran`),`kind` 区分,不靠 `ok` 猜。
 *  - `refused`:授权取不到(不存在 / 已撤销 / 已过期)→ 一步未建,`code` = `no_grant`;
 *  - `ran`:逐条派发完毕(报告里 `stoppedAt` 说明是否停在某条 —— 停住是**有意的**语义,
 *    不是错误:某条被拒即就地停,绝不静默重试或假装跑完)。
 */
export type UnattendedRunIpcResult =
  | { ok: false; kind: "refused"; code: string; reason: string }
  | { ok: true; kind: "ran"; report: UnattendedExecutionReportWire };

/* ─────────── 【MC-059 残余 ④】跨重启:列出等待中的计划 / 续跑 / 放弃 ─────────── */

/**
 * 一条**等待批准 / 待执行**计划的跨重启视图(过 IPC 的形状;与
 * `PendingUnattendedPlanView` 同形)。宿主在**重启后**从计划存档 + `GrantStore` 现取现算。
 *
 * `kind` 三态由宿主算好(判据只有一处),调用方不必自己拼:
 *  - `waiting_approval` —— 授权取不到 / 已过期 / 已撤销 / 次数已用尽 → 需**重新批准**;
 *  - `resumable` —— 授权仍有效、且还有没建成的操作 → 可**续跑**(从下一条起);
 *  - `completed` —— 所有操作都已建成。
 */
export interface PendingUnattendedPlanWire {
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

/** 列出等待中计划的结果 —— **只读**(不执行任何一步)。 */
export interface UnattendedListIpcResult {
  plans: PendingUnattendedPlanWire[];
  /**
   * 【MC-029 剩余项】存档健康度。`list` 在坏档时**仍然拒绝**(抛 `archive_corrupt`,
   * 因为它是 blocked 的治理视图、且空列表在这里是一句谎);成功返回时这里恒为 `ok`。
   * 坏档/读不了的诊断由只读 `unattendedPlans.health` 提供(Agent 也能读)。
   */
  archiveHealth: UnattendedArchiveHealth;
}

/** 【MC-029 剩余项】只读健康查询的返回 —— 与 `UnattendedListIpcResult.archiveHealth` 同形。 */
export interface UnattendedHealthIpcResult {
  archiveHealth: UnattendedArchiveHealth;
}

/**
 * 【MC-029 剩余项】**存档健康度**的结构化诊断(四态里的三态;`absent`/`valid` 都归 `ok`)。
 *
 * - `ok` —— 文件不存在 / 空串(真空)或解析有效;无需动作;
 * - `corrupt` —— 文件在,但内容读不懂(非 JSON / 版本不符 / 信封形状坏) → 已停用写入,
 *   原字节保留;
 * - `unreadable` —— 文件在,但**读不了**(权限 / IO 错误)。与 `corrupt` **分开**:一种要
 *   修内容,一种要修权限;把两者混为一谈会让恢复动作指错方向。
 */
export interface UnattendedArchiveHealth {
  state: "ok" | "corrupt" | "unreadable";
  /** `state !== "ok"` 时给人看的一句话(含稳定子串「unattended-plans.json」)。 */
  reason?: string;
}

/**
 * 续跑入参 —— **只给 `planId`**:计划正文与授权 id 都已落盘,由宿主从存档 + `GrantStore`
 * 自己取回。调用方给不了正文(给了反而能偷换「续跑的是哪份计划」)。
 */
export const UnattendedResumeInputSchema = z.object({
  /** 要续跑的计划 id(存档里的键)。 */
  planId: z.string().min(1),
  /**
   * **发起者坐标**(与 `unattended.run` 的 `initiatorSessionId` 同义、同一条纪律)—— 渲染端
   * 坐在哪条会话里点的「续跑」。只是一枚宿主**能核实**的坐标(取得到才产出可信标识),省缺时
   * 宿主退回按 IPC 事件的 `sender` 派生。**绝不让调用方自填身份。**
   */
  initiatorSessionId: z.string().min(1).optional(),
});
export type UnattendedResumeInput = z.infer<typeof UnattendedResumeInputSchema>;

/** 放弃入参 —— 把一条等待中的计划**明确放弃**(不再列出、不再可续跑)。 */
export const UnattendedAbandonInputSchema = z.object({
  planId: z.string().min(1),
});
export type UnattendedAbandonInput = z.infer<typeof UnattendedAbandonInputSchema>;

/** 放弃结果 —— 幂等:`abandoned` 为 `false` 时表示记录不存在 / 已放弃(不是错误)。 */
export interface UnattendedAbandonIpcResult {
  planId: string;
  /** 这次调用是否真的把一条**未放弃**的计划标记为放弃(`false` = 记录不存在或已放弃)。 */
  abandoned: boolean;
}
