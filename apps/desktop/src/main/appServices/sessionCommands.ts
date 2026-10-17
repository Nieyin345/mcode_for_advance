/**
 * **唯一的会话业务命令** —— 「建一条对话(或复用同项目里那份还新鲜的空壳),可选地把它
 * 的第一条消息发出去」这一条**业务动作**只有这一处实现。
 *
 * ## 为什么要有这个文件(硬规矩 2:共享实现只有一份)
 *
 * 同一件事从前在两处**各写一遍**:桌面 `claude:startSession` IPC 建会话;而 agent 那条
 * 「无渲染窗口也能开对话」的路(`appControl/tools.ts` 的 `headlessNewSession`)把
 * 「查项目 → `createOrReuseSession` → 解析 cwd → `runtimeManager.sendTurn` 发首条」又内联
 * 拼了一遍。两处只要有一处漏了后半截(比如忘了把 `workflowId` 随轮下发),同一条命令经
 * 桌面走和经 agent 走就会**行为漂移** —— 这正是 ARC-001 要收的口子。
 *
 * 现在这一段收成一个函数:桌面 IPC 与 agent headless 都调它,各端只把自己那份**传输形状**
 * (IPC 返回 `{session}` / Agent 返回 ToolResult)留给自己。命令的**业务动作**只有一份。
 *
 * ## 边界(这里**不**做)
 *
 *   - 不碰审批:审批在各自入口(`gateAppAction` / IPC 侧无审批)做,与本函数无关;
 *   - 不做纯 UI 动作(切对话、开文件、截图)—— 那些仍属界面(`uiBridge`);
 *   - 不改结果形状:调用方拿到的仍是它们各自原来的东西。
 *
 * ## 【ARC-001 步②】ActionContext —— 「谁在调」是结构化事实,不是裸字符串
 *
 * 从前本函数的第二个入参是一个裸的 `source: "desktop" | "mobile" | "agent"` —— 它能
 * 表达"经哪条路进来",却表达不了"**谁**在调":桌面用户、Agent、手机端三者的身份/作用域
 * 全被压成一个渠道名。台账 remaining 第②条点名的「ActionContext(actorKind / actorId /
 * scope / operationId / expectedRevision)」就是要把它升成结构化事实。
 *
 * 本切片落**能立即兑现**的那几个字段:`actorKind`(谁)、`actorId`(哪个主体)、
 * `operationId`(这一次操作的幂等键)、可选 `scope`(作用域,当前 = 项目 id)。两条调用方
 * **各填自己的身份**:桌面 IPC = `user`、agent headless = `agent`(mobile 由本函数按
 * actorKind 直接支持)。`source` 这个渠道名由 `actorKind` **派生**出来喂给
 * `createOrReuseSession` —— 结果形状与行为**一律不变**(mobile → mobile,其余 → desktop)。
 *
 * ## 【ARC-001 步③】expectedRevision —— 复用前的乐观并发修订号
 *
 * 步②落了「谁在调」(actorKind / actorId / operationId / scope)。步③落 remaining 点名的
 * `expectedRevision`:调用方读了一条「新对话」空壳、拿到它的**行修订号**(会话行的
 * `updatedAt`),把那份修订号带进来;本命令在复用前**先核对**,对不上就抛
 * `SessionRevisionConflictError` —— **什么都不建、什么都不发**,绝不静默复用/新建一条调用方
 * 没预期的会话。判据只有一处(`lib/sessionStart.ts` 的 `assertSessionRevision`),本函数只
 * 把它透传下去。
 *
 * 为什么修订号是**会话行的 `updatedAt`** 而不是整库的 `durableRevision`、以及这个选法诚实的
 * 残余,写在 `lib/sessionStart.ts` 的 `sessionRevisionOf` 文件头 —— 别在这里再抄一遍。
 *
 * ## 【ARC-001 步④】permissionGrant —— 计划级授权句柄(宿主核对,不是模型自报)
 *
 * 步②落了「谁在调」、步③落了 `expectedRevision`。步④落 remaining 点名的最后一个字段
 * `permissionGrant`(计划级授权句柄)。授权判定核(`policyEngine.evaluate` + `grantStore` +
 * `grantStoreRuntime.getGrantStore`)与「计划 digest 绑 `scopedCore.scenePlan`」的接缝
 * (`scenePlanCoreIntent`)已经铺好,所以这个字段**不再**是「无消费者的空字段」。
 *
 * 语义:调用方(可信边界)可以带上一枚 `grantId` —— 本命令**不采信**它是"授权"(那不是把
 * 授权交给模型自报名),而是**由宿主自己**从目标项目解析出这次「建会话」动作的**权威资源身份**
 * (`{ method: "session.create", core: { projectPath } }`,路径经 `physicalPath` 规范化),
 * 再拿这个 grantId 去 `getGrantStore()` 取回授权、交给**唯一**那份判定核 `evaluate` 核对。
 *   - 授权不存在 / 已撤销 / 已过期 / 不覆盖这次动作(方法不在表内、核心意图被换)→ **拒绝**
 *     (抛 {@link SessionGrantRefusedError},什么都不建/不发)—— 「拒绝无法核实的授权」;
 *   - 授权真的覆盖 → 这次建会话就**跑在它之下**:记为 `lastPermissionGrant`(可观测),
 *     且**在建任何一行之前**按唯一领取口 `claimUse` **原子领取**一次额度(检查与递增在同一
 *     同步临界区、且同步落盘)—— 于是 `maxCount` / `maxBudget` 真承重,不是只声明不兑现的
 *     死字段;**领取失败(已用尽 / 失效 / 落盘失败)同样抛 `SessionGrantRefusedError`,
 *     什么都不建**(fail-closed)。
 *
 * ## 【MC-021】为什么要「领取 → 建 → 结算」而不是「先建后记账」
 *
 * 从前的时序是「核过授权 → 建行 → `recordUse` 记一次(记账失败 catch 成静默跳过)」——
 * 两个缺口:① 记账在**副作用之后**:建行与绑定都落定、进程在记账前崩溃 → 这次使用不计数,
 * `maxCount` 的额度被崩溃路径穿透;② 记账失败被**静默吞掉**(记账是"旁路"的旧口径),
 * 磁盘写不进去时调用方毫无察觉,照样返回成功 —— 额度在磁盘故障下直接失效。
 * 新时序把这两条反过来:**派发前领取**(领取失败 = 拒绝执行)、**按结果结算**(见下),
 * 计数先于副作用耐久落盘,宁可多记不可少记。
 *
 * ## 【MC-021】结算:修订冲突 → 退还
 *
 * `createOrReuseSession` 对**修订号对不上**抛 {@link SessionRevisionConflictError},而它
 * 明确「什么都没建、什么都没发」(见 `lib/sessionStart.ts` 的 OCC 语义)= 确定**没执行**
 * → 把刚领的那次额度**退还**(`releaseUse`),重抛异常。其余抛错(建行/绑定途中出错)可能
 * 已部分落定 → **保留**计数(与 UNCERTAIN 同口径,宁可多记不可少记)。退还本身再失败
 * (落盘故障)不回退已抛的异常,只记 `log.warn` 显式报告 —— 偏差是"多占了一次额度",
 * 不静默(硬规矩 3)。
 *
 * ⚠️ **本切片诚实划定的边界**:① 它**不绕过审批** —— 本命令从不做审批(审批在各自入口:
 * agent 路在 `gateAppAction`、桌面/手机是用户本人动作);带授权只是"授权核覆盖了这次动作"
 * 这一条**可核对的宿主事实**,不是"跳过审批"。② 目前**没有生产签发口**签出覆盖
 * `session.create` 的授权(现有签发口只签 `app_api_call` 的单方法指纹授权、及场景部署的
 * `scene.apply` 计划授权)—— 字段的**消费者**在本命令(写入前核对、拒绝不可核实者),
 * 但给「无人值守建会话」签发这类授权的**生产者**属后续切片;缺生产者时该字段缺席,既有
 * 调用方一律不受影响。
 */
import type { StartSessionInput } from "@contracts/ipc";
import type { Session } from "@contracts/session";
import type { ActorRef, CoreIntent } from "@contracts/policyEngine";
import { createOrReuseSession, SessionRevisionConflictError } from "@main/lib/sessionStart.js";
import { ProjectRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { evaluate } from "@main/appControl/policyEngine.js";
import { getGrantStore } from "@main/appControl/grantStoreRuntime.js";
import { physicalPath } from "@main/lib/realPathWithin.js";
import { log } from "@main/lib/logger.js";

/**
 * 发起一条会话业务命令的**主体种类**。
 *
 *   - `user` —— 桌面界面的用户本人(点「新建对话」等);
 *   - `agent` —— 本地 Agent 经 mcode-app 工具(无窗口 headless 路)代用户发起;
 *   - `mobile` —— 手机端经无 preload 的 HTTP 桥发起。
 */
export type ActorKind = "user" | "agent" | "mobile";

/**
 * **谁在调这条业务命令**的结构化事实。由**调用方**(可信边界)填,受管命令只**读**它,
 * 不自己从别处再推导一遍 —— 与 `PublicActionContext` 同一条信任边界取向。
 */
export interface ActionContext {
  /** 主体种类:用户 / Agent / 手机端。决定渠道语义(`createOrReuseSession` 的 source)。 */
  actorKind: ActorKind;
  /** 主体身份标识(桌面固定 `desktop`;agent = 发起调用的会话 id;mobile = 设备/会话 id)。 */
  actorId: string;
  /** 这一次操作的幂等键(跨端对账 / 幂等去重用)。调用方生成。 */
  operationId: string;
  /** 作用域(当前 = 目标项目 id);可选,调用方拿得到就带上。 */
  scope?: string;
  /**
   * **乐观并发修订号**(ARC-001 步③)—— 可选的 OCC 令牌。调用方读了一条"新对话"空壳、
   * 拿到它的修订号(会话行的 `updatedAt`,见 `lib/sessionStart.ts` 的
   * `sessionRevisionOf`),把那份修订号带进来;命令在复用前**先核对**它还是不是那一版,
   * **对不上就拒绝**(抛 `SessionRevisionConflictError`,什么都不建/不发),绝不静默
   * 复用/新建一条调用方没预期的会话。缺席 = 不启用,既有调用方行为一律不变。
   *
   * ⚠️ **本切片如实划定的边界**:这里**不是**整库的 `durableRevision`
   * (`@contracts/commit` 那份进程内 fsync 序号)。两条理由都可核对:那个计数器住在
   * `store/db.ts` 的模块私有 `let` 里、**没有纯读取出口**,且本切片改动面不含 `store/db.ts`;
   * 会话命令真正自然的修订号是**会话行自己的 `updatedAt`**。为什么、以及残余,见
   * `lib/sessionStart.ts` 的 `sessionRevisionOf` 文件头。
   */
  expectedRevision?: string;
  /**
   * **计划摘要**(MC-001 复核补漏)—— 可选的 `CoreIntent.scenePlan` 覆盖值。
   *
   * 无人值守计划的授权绑的是**这份计划正文**的摘要(`unattendedPlanDigest`),而建会话的
   * 普通核心意图只有 `{projectPath}` —— 若不给这一项,`evaluate` 的 `invalidationsFor`
   * 会看到「批准时 core 有 scenePlan、执行时 wanted 没有」→ 判核心意图被改 → 拒绝所有
   * 计划内建会话。计划执行端(且**只有**它)带上批准时的摘要,判据就回到「执行的是不是
   * 同一份计划」上。普通调用方(桌面/手机/直接建会话)不带 —— 行为不变。
   */
  coreScenePlan?: string;
  /**
   * **计划级授权句柄**(ARC-001 步④)—— 一枚 `Grant.grantId`。**宿主核对,不是模型自报**:
   * 本命令**不采信**这个字符串本身是授权,而是从**目标项目**解析出「建会话」动作的权威资源
   * 身份(见 {@link SESSION_CREATE_METHOD} + {@link sessionCreateCore}),拿它去
   * `getGrantStore()` 取回授权、交唯一判定核 `evaluate` 核对。覆盖了 → 这次建会话跑在它之下;
   * 核不到 / 失效 / 不覆盖 → **拒绝**(抛 {@link SessionGrantRefusedError},什么都不建/不发)。
   *
   * ⚠️ 它**不绕过审批**:审批在各自入口做,本命令从不弹卡。带授权只是"授权核覆盖了这次动作"
   * 这一条宿主事实。缺席 = 不启用,既有调用方一律不受影响(见文件头步④的诚实边界)。
   */
  permissionGrant?: string;
}

/**
 * 「建会话」这次动作在授权核里的**方法名** —— 计划级授权(`Grant.allowedActions`)含它,
 * 且 `scopedCore.projectPath` 等于目标项目的权威路径时,这次建会话才算跑在它之下。
 */
export const SESSION_CREATE_METHOD = "session.create";

/**
 * 从**目标项目**解析出「建会话」动作的**权威核心意图** —— 与 `appControl/tools.ts` 的
 * `resolveActionCore` 同一份路径规范化(`physicalPath`:resolve + 跟真实目的地 + 折叠大小写),
 * 让「批准了项目 A、却来建项目 B 的会话」判得出核心意图被换。
 *
 * 项目路径取不到规范化身份时退回**空核心** —— 空核心对任何带路径的授权都判为"核心意图不符"
 * (见 `invalidationsFor`:`wanted.projectPath === undefined` 时 grant 的 projectPath 若存在
 * 即判改动),于是**拒绝**而不是误放行(硬规矩 3:坏东西显式报出来)。
 */
export function sessionCreateCore(projectId: string): CoreIntent {
  const project = ProjectRepo.get(projectId);
  const id = project ? physicalPath(project.path) : null;
  return id ? { projectPath: id } : {};
}

/**
 * 计划级授权**核实不过** —— 调用方带来的 `permissionGrant` 核不到 / 失效(撤销 / 过期)/
 * 不覆盖这次建会话动作(方法不在授权表内、或核心意图——项目路径——被换)。**什么都没执行**:
 * 没建行、没复用、没发首条。上层据此拒绝(与 `SessionRevisionConflictError` 同取向:
 * 坏东西显式报出来,绝不静默按"没有授权"照旧执行)。
 *
 * ⚠️ 与 `SessionRevisionConflictError` 一样,**只在调用方主动带了 grantId 时才可能抛** ——
 * 没带这个字段的既有调用方一律不受影响。
 */
export class SessionGrantRefusedError extends Error {
  readonly code = "grant_refused";
  /** 调用方带来的 grantId(原样带回,便于上层/日志点名)。 */
  readonly grantId: string;
  /** 稳定短码,便于调用方按 code 分派(不解析人读 reason)。 */
  readonly reason_code: "grant_not_found" | "grant_invalid" | "grant_scope_mismatch" | "grant_denied";
  constructor(grantId: string, reason_code: SessionGrantRefusedError["reason_code"], message: string) {
    super(message);
    this.name = "SessionGrantRefusedError";
    this.grantId = grantId;
    this.reason_code = reason_code;
  }
}

/**
 * 【ARC-001 步④】**核实**这次建会话是否跑在一枚计划级授权之下 —— 由**宿主**核,不采信
 * 调用方带来的字符串。
 *
 * 判据只有一处在做:唯一判定核 `policyEngine.evaluate`。本函数只负责**组装**(从 grantId
 * 取回授权、从目标项目解析权威核心意图、注入时钟),不手写第二套"准不准"。
 *
 * @returns 覆盖这次动作、且有效的授权 grantId;调用方**没带** grantId 时返回 `null`(不启用)。
 * @throws  {@link SessionGrantRefusedError} —— 带了 grantId 却核不过(核不到 / 失效 / 不覆盖)。
 */
function resolvePermissionGrant(projectId: string, grantId: string | undefined, coreScenePlan?: string): string | null {
  if (grantId === undefined) return null;
  const store = getGrantStore();
  const base = sessionCreateCore(projectId);
  // 【MC-001】计划执行端带批准时的计划摘要 → 意图的 core 与授权钉住的那份**同一形状**;
  // 摘要不符(正文被换)→ invalidationsFor 判 scenePlan 被改 → 拒绝。
  const core = coreScenePlan !== undefined ? { ...base, scenePlan: coreScenePlan } : base;
  const intent = { method: SESSION_CREATE_METHOD, core };
  // 调用方带来的是**具体某一枚** grantId,故按 id 取回(`get`)—— 它对"不存在 / 已撤销 /
  // 已过期"一律回 null:调用方指名要跑在授权 X 之下、X 却不可用 → 没有授权可交 evaluate
  // 判 scope,这里显式拒绝(绝不静默按"无授权"照旧执行)。这与 appControl 的
  // planGrantPrecheck 不同:那边是**按资源 / 方法找**授权、需要 `findBoundFor` 让失效态也
  // 能被取出交 evaluate 判死活;这里已由调用方指名 id,按 id 取 + 不可用即拒是同一条判据
  // 的另一种落法(撤销 / 过期在本函数就拦下,故 `grant_not_found` 一并承载这两态)。
  const bound = store.get(grantId, Date.now());
  if (!bound) {
    // 核不到 / 已撤销 / 已过期 —— get 对这三种一律回 null。此时**没有**授权可交 evaluate
    // 判 scope,故这里显式拒绝(绝不静默按"无授权"照旧执行)。
    throw new SessionGrantRefusedError(
      grantId,
      "grant_not_found",
      `这次建会话要跑在授权「${grantId}」之下,但该授权不存在 / 已撤销 / 已过期 —— 拒绝执行,什么都没建。`,
    );
  }
  const decision = evaluate(intent, bound, {
    now: Date.now(),
    requester: { kind: "agent", id: "session.create" },
    approver: { kind: "user", id: "session.create" },
    compatibilityLevel: "write",
  });
  if (decision.verdict === "allow") return bound.grantId;
  // 授权在、但不覆盖这次动作(方法不在表内 / 核心意图被换 / 超次数 / 超预算)。
  const code = decision.invalidatedBy?.length ? "grant_scope_mismatch" : "grant_denied";
  throw new SessionGrantRefusedError(
    grantId,
    code,
    `这次建会话要跑在授权「${grantId}」之下,但该授权不覆盖它:${decision.reason}`,
  );
}

/**
 * 建会话 + (可选)发首条消息的入参。
 *
 * `input` 就是桌面 `claude:startSession` 的那份 `StartSessionInput` —— 复用同一份 schema,
 * 不再为 agent 那条路另造一套「建会话要什么」的字段(那样早晚又漂开)。
 */
export interface CreateSessionAndSendArgs {
  /** 建会话的配置(与桌面 `claude:startSession` 同一份)。 */
  input: StartSessionInput;
  /**
   * 首条消息。**省略 = 只建会话,不派发回合**(与桌面「新建对话」一致:建完等用户打字)。
   * 传了(含空串)就发 —— 空串也发,保持与既有 headless 路径逐字同行为。
   */
  prompt?: string;
  /** 让这条首消息按某个工作流跑。 */
  workflowId?: string;
}

/** 命令结果。`sendError` 为 null 表示「没发」或「发成功」。 */
export interface CreateSessionAndSendResult {
  session: Session;
  reused: boolean;
  /** 首条消息没发出去时的**原因**;null = 发成功,或本来就没让发。 */
  sendError: string | null;
}

/** 建会话+发首条这条命令被调了几次 —— 让回归能证「两条路真的都走这一个函数」(硬规矩 2)。 */
let createSessionAndSendCount = 0;
/** 最近一次收到的 ActionContext —— 让回归能证「各端各填了自己的身份」(ARC-001 步②)。 */
let lastActionContext: ActionContext | null = null;
/** 最近一次**真的核实通过**的计划级授权 grantId —— 让回归能证「授权被宿主核对过、不是自报」(ARC-001 步④)。 */
let lastPermissionGrant: string | null = null;

/**
 * 建一条对话(或复用项目里那份还新鲜的「新对话」空壳),可选地把它第一条消息发出去。
 *
 * 解析链:**项目 → 计划级授权核实(步④,可选)→ `createOrReuseSession`(唯一复用判据)→
 * cwd(会话自己的工作树优先,否则项目根)→ `runtimeManager.sendTurn`**。`sendTurn` 返回 null
 * = 上一轮还在运行、这轮没接 —— 如实落进 `sendError`,不假装发成功(硬规矩 3:坏东西显式报出来)。
 *
 * `action` 就是「谁在调」的结构化事实(见 {@link ActionContext})—— 本函数只**读**它,
 * 把它派生成 `createOrReuseSession` 要的渠道名(mobile → mobile,其余 → desktop),
 * **不改任何业务行为、不改结果形状**。
 */
export async function createSessionAndSend(
  args: CreateSessionAndSendArgs,
  action: ActionContext,
): Promise<CreateSessionAndSendResult> {
  createSessionAndSendCount += 1;
  lastActionContext = action;
  lastPermissionGrant = null;
  // 【ARC-001 步④】**先核计划级授权**(在写任何一行之前)——带了 `permissionGrant` 就由宿主
  // 拿目标项目的权威资源身份去 `getGrantStore()` 取回授权、交唯一判定核 `evaluate` 核对:
  // 覆盖了才继续(记为 lastPermissionGrant),核不到 / 失效 / 不覆盖**一律拒绝**
  // (抛 `SessionGrantRefusedError`,什么都不建/不发)。缺席 = 不启用,既有调用方不受影响。
  const grantId = resolvePermissionGrant(args.input.projectId, action.permissionGrant, action.coreScenePlan);
  // 【MC-021】**派发前原子领取**一次额度(在建任何一行之前)—— 检查(有效 / 未用尽 / 未超
  // 预算)与 `usedCount` +1 在 `claimUse` 的同一同步临界区内完成、并同步落盘。领取失败
  // (核过后被并发用尽 / 撤销 / 过期 / 落盘失败)→ 与核不过同取向:**拒绝,什么都不建**。
  // 于是"核过授权 → 建行 → 事后记账"那条额度可被崩溃 / 并发穿透的旧时序不存在了。
  if (grantId !== null) {
    try {
      getGrantStore().claimUse(grantId, 0, Date.now());
    } catch (err) {
      throw new SessionGrantRefusedError(
        grantId,
        "grant_denied",
        `这次建会话要跑在授权「${grantId}」之下,但该授权此刻无法领取额度:${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // 【ARC-001 步③】把 `expectedRevision` 交给唯一的复用判据 `createOrReuseSession` —— 它对
  // 不上就抛 `SessionRevisionConflictError`(什么都不建/不发)。异常**不在这里吞**:桌面 IPC
  // 让它变成 IPC 错误、手机端变成 RpcError、agent 侧由 `headlessNewSession` 的调用方翻成
  // REJECTED(没执行,可安全重来)。`undefined` 一律照旧(既有调用方不受影响)。
  let created: { session: Session; reused: boolean };
  try {
    created = createOrReuseSession(
      args.input,
      action.actorKind === "mobile" ? "mobile" : "desktop",
      action.expectedRevision,
    );
  } catch (err) {
    // 【MC-021】**按结果结算**:修订冲突 = 调用方断言的那一版根本不在,`createOrReuseSession`
    // 明确「什么都没建、什么都没发」= 确定**没执行** → 把刚领的额度**退还**(额度还能再用)。
    // 其余抛错(建行 / 绑定途中出错)可能已部分落定 → **保留**计数(宁可多记不可少记,
    // 与 UNCERTAIN 同口径)。退还再失败只显式报告(偏差方向 = 多占一次,绝不静默)。
    if (grantId !== null && err instanceof SessionRevisionConflictError) {
      try {
        getGrantStore().releaseUse(grantId);
      } catch (refundErr) {
        log.warn(
          `建会话授权「${grantId}」的额度退还失败(${refundErr instanceof Error ? refundErr.message : String(refundErr)}):` +
            "这次建会话因修订冲突没执行,但授权额度仍占用了 1 次(偏差方向=多占,不影响任何已落定状态)。",
        );
      }
    }
    throw err;
  }
  const { session, reused } = created;
  // 【ARC-001 步④】授权覆盖的这次建会话**真落定了** → 保留派发前领取的那笔计数
  // (`claimUse` 已记,这里只记可观测事实)。【MC-021】不再有"事后补记 + catch 吞掉":
  // 计数在派发前已经耐久落盘,记账失败不再是静默旁路。
  if (grantId !== null) {
    lastPermissionGrant = grantId;
  }
  if (args.prompt === undefined) {
    // 只建会话 —— 与桌面「新建对话」同一条:不因为这里少发一条消息而改变落库/广播行为。
    return { session, reused, sendError: null };
  }
  const project = ProjectRepo.get(session.projectId);
  const cwd = session.worktreePath ?? project?.path;
  if (!cwd) {
    return { session, reused, sendError: `对话 ${session.id} 没有可用的工作目录` };
  }
  const handle = await runtimeManager.sendTurn(session, {
    prompt: args.prompt,
    cwd,
    ...(args.workflowId ? { workflowId: args.workflowId } : {}),
  });
  return {
    session,
    reused,
    sendError: handle === null ? "上一轮还在运行,消息没发出去" : null,
  };
}

/* ───────────────────────── 测试观测(与 appControl 的 __clearOperationLog 同一取向) ───────────────────────── */

/** 建会话+发首条这条命令被调了几次 —— 让回归能证「两条路真的都走这一个函数」。 */
export function __createSessionAndSendCount(): number {
  return createSessionAndSendCount;
}
/** 每个用例前清一次,免得跨用例串味。 */
export function __resetCreateSessionAndSendCount(): void {
  createSessionAndSendCount = 0;
  lastActionContext = null;
  lastPermissionGrant = null;
}
/**
 * 最近一次收到的 ActionContext(ARC-001 步②)—— 让回归能证「桌面传 user / agent 传 agent /
 * mobile 传 mobile」,而不是只断言计数。返回的是**那次调用**的原样对象(只读用途)。
 */
export function __lastActionContext(): ActionContext | null {
  return lastActionContext;
}
/**
 * 最近一次**真的核实通过**的计划级授权 grantId(ARC-001 步④)—— 让回归能证「授权是宿主从
 * `getGrantStore()` 取回、经唯一判定核 `evaluate` 核对过的」,而不是把模型自报的字符串当成
 * 授权。`null` = 最近一次建会话没跑在授权之下(缺席 / 核不过时不会到这里)。
 */
export function __lastPermissionGrant(): string | null {
  return lastPermissionGrant;
}
