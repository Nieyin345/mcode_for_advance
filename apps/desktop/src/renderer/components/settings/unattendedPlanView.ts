/**
 * 无人值守任务计划的**渲染端视图模型**(MC-001 —— 后端三层全通却**没有用户入口**)。
 *
 * ## 它补的是哪个洞
 *
 * `appServices/unattendedTaskPlan.ts`(773 行)+ `ipc/unattended.ts`(五个 handler)+
 * preload 两个命名空间**全都齐了**,`policy.ts` 也正确地把它对 agent 钉成 blocked ——
 * 但 `apps/desktop/src/renderer` 全树**零调用**:`approveUnattendedPlan` 的唯一生产
 * 调用端就是那个没人调的 IPC。整条「用户签发计划级授权 → 有界执行」永远无法被触发,
 * 而它自称是**审批落点**。
 *
 * ## 它与 `sceneDeployView` 的分工(不重复造)
 *
 * 台账的系统性修复要求「复用 `SceneDeployPanel` 那套『预览 → 批准(绑 digest)→ 执行
 * (只递 grantId)』的现成形态与判据」。本文件只负责**这个功能自己的形状**:
 *
 *  - 计划正文从**结构化行**来(标题 / 首条消息 / 复用修订号),不是一份 JSON 文本 ——
 *    无人值守的"计划"就是一张操作清单,让人填 JSON 是把机器格式推给人;
 *  - 提交前的**本地预判**只做能做的:条数 ≥ 1、标题/正文至少一个、`maxCount ≥ 条数`
 *    (与签发口同一条界,前置提示而不是让用户撞 `refused`);
 *  - 入参构造**只给坐标不给身份 / 授权内容**(与 `scene.apply` 同一条纪律)。
 *
 * 判定核(能不能签发、授权够不够)一律在主进程 —— 这里不做第二份判定,只做
 * 「点了会明显失败的就别发」那一层。**纯函数,不 import 主进程、不 import React**
 * (与 `sceneDeployView` 同规矩,喂得进无头 smoke)。
 */
import type {
  PendingUnattendedPlanWire,
  UnattendedApproveInput,
  UnattendedExecutionReportWire,
  UnattendedRunInput,
} from "@contracts/ipc/unattended";

/* ───────────────────────── 计划 id ───────────────────────── */

let planSeq = 0;

/** 一次批准 / 执行的稳定 id(重试是同一 id 的覆盖,不是新计划 —— 与 `newDeploymentId` 同语义)。 */
export function newUnattendedPlanId(now: number = Date.now()): string {
  planSeq = (planSeq + 1) % 0xffffff;
  return `unattended-${now.toString(36)}-${planSeq.toString(36)}`;
}

/* ───────────────────────── 操作行(表单) ───────────────────────── */

/** 一行操作 —— 表单里的形状。`operationId` 在**加入时**分配、之后不变(它是执行报告的对账键)。 */
export interface UnattendedOperationRow {
  operationId: string;
  title: string;
  prompt: string;
  /** 复用一条已存在空壳时的乐观并发修订号;空串 = 不复用(新建)。 */
  expectedRevision: string;
}

/** 新一行操作(operationId 稳定、可读)。 */
export function newOperationRow(seq: number): UnattendedOperationRow {
  return { operationId: `op-${seq}`, title: "", prompt: "", expectedRevision: "" };
}

/**
 * 计划正文的**本地预判** —— 只报"这份声明本身不完整",不猜主进程的判定。
 *
 * 判据与签发口**同一条界**的地方(比如 `maxCount ≥ 条数`)在这里前置说清楚,是为了
 * 让用户在本地点「批准」之前就知道,而不是收一份 `refused` 再去猜。措辞留给界面
 * (返回稳定的 code,不返回人读文案 —— 文案进 i18n 词典)。
 */
export type UnattendedPlanProblem =
  | { code: "no_operations" }
  | { code: "empty_operation"; operationId: string }
  | { code: "max_count_below_operations"; operationCount: number; maxCount: number }
  | { code: "ttl_out_of_range"; ttlMs: number };

export interface UnattendedPlanDraft {
  planId: string;
  projectId: string;
  operations: UnattendedOperationRow[];
  ttlMs: number;
  maxCount: number;
}

/** 一次报全(不是遇到第一个就停 —— 与 `validateSceneSpec` 同一条纪律)。 */
export function validateUnattendedDraft(draft: UnattendedPlanDraft, maxTtlMs: number): UnattendedPlanProblem[] {
  const problems: UnattendedPlanProblem[] = [];
  const ops = draft.operations;
  if (ops.length === 0) problems.push({ code: "no_operations" });
  // 一条操作至少要有标题或首条消息之一 —— 两者都空 = 「建一条空会话」,那不是一次
  // 有意义的无人值守动作(与 `createSessionAndSend` 的语义对不上,签发口也会拒)。
  for (const op of ops) {
    if (op.title.trim() === "" && op.prompt.trim() === "") {
      problems.push({ code: "empty_operation", operationId: op.operationId });
    }
  }
  if (ops.length > 0 && draft.maxCount < ops.length) {
    problems.push({ code: "max_count_below_operations", operationCount: ops.length, maxCount: draft.maxCount });
  }
  if (!(draft.ttlMs > 0) || draft.ttlMs > maxTtlMs) {
    problems.push({ code: "ttl_out_of_range", ttlMs: draft.ttlMs });
  }
  return problems;
}

/**
 * 构造 `unattended.approve` 的入参 —— **只在预判全过时**给出(否则 `null`,界面据此
 * 不该发这条)。`operationId` 原样带上(执行报告按它对账);`expectedRevision` 只在
 * 非空时才给(空串 = 不复用,给一个空串 revision 会被签发口当"对不上"拒掉)。
 *
 * ⚠️ 形状里**没有** `actor` / `grantId` —— 签发主体由主进程写死为 `user`(契约层注释
 * 写明:调用方给不了身份)。
 */
export function buildUnattendedApproveInput(draft: UnattendedPlanDraft, maxTtlMs: number): UnattendedApproveInput | null {
  if (validateUnattendedDraft(draft, maxTtlMs).length > 0) return null;
  return {
    planId: draft.planId,
    projectId: draft.projectId,
    operations: draft.operations.map((op) => ({
      operationId: op.operationId,
      ...(op.title.trim() !== "" ? { title: op.title.trim() } : {}),
      ...(op.prompt.trim() !== "" ? { prompt: op.prompt.trim() } : {}),
      ...(op.expectedRevision.trim() !== "" ? { expectedRevision: op.expectedRevision.trim() } : {}),
    })),
    ttlMs: draft.ttlMs,
    maxCount: draft.maxCount,
  };
}

/**
 * 构造 `unattended.run` 的入参 —— **只给 `grantId`,`绝不给授权内容`**(与 `scene.apply`
 * 同一条纪律:授权是治理事实,只能由宿主从 `GrantStore` 取回)。
 *
 * `initiatorSessionId` 也**不给**:渲染端不知道自己"是哪条会话"(设置页不是会话)——
 * 省缺时主进程退回按 IPC 事件的 `sender` 派生(那也是宿主事实)。真从某条会话里发起
 * 时,由调用方把那条会话的 id 递进来(它只是一枚坐标,宿主会核实)。
 */
export function buildUnattendedRunInput(
  draft: UnattendedPlanDraft,
  grantId: string,
  maxTtlMs: number,
  initiatorSessionId?: string,
): UnattendedRunInput | null {
  const approve = buildUnattendedApproveInput(draft, maxTtlMs);
  if (approve === null) return null;
  return {
    planId: approve.planId,
    projectId: approve.projectId,
    operations: approve.operations,
    maxCount: approve.maxCount,
    grantId,
    ...(initiatorSessionId !== undefined ? { initiatorSessionId } : {}),
  };
}

/* ───────────────────────── 状态机 ───────────────────────── */

/**
 * 一次批准的默认有效期 —— 与主进程 `UNATTENDED_PLAN_MAX_TTL_MS`(30 分钟)**同值**
 * 的上限下取一个稳妥缺省(5 分钟)。渲染端不 import 主进程,故在此复述;两侧分家最坏
 * 情况是界面等一个主进程判过期的授权 —— 故上限值由 `scene-deploy-view-smoke` 的姊妹
 * 断言与主进程常量对照钉住。
 */
export const UNATTENDED_DEFAULT_TTL_MS = 5 * 60 * 1000;
/** 与主进程 `UNATTENDED_PLAN_MAX_TTL_MS` 同值 —— 界面用它做本地预判的上限。 */
export const UNATTENDED_MAX_TTL_MS = 30 * 60 * 1000;

/** 持在手里的一枚计划级授权(只有 id / 到期时刻 —— **不含**授权内容,与 scene 同规矩)。 */
export interface UnattendedGrant {
  grantId: string;
  expiresAt: number;
}

/** 一次执行的结局。 */
export type UnattendedRunOutcome =
  | { ok: true; report: UnattendedExecutionReportWire }
  | { ok: false; reason: string };

export interface UnattendedPlanState {
  /** 表单:目标项目(空串 = 未选)。 */
  projectId: string;
  /** 表单:操作行(增 / 删 / 改)。 */
  operations: UnattendedOperationRow[];
  /** 表单:有效期(毫秒)。 */
  ttlMs: number;
  /** 表单:次数量上限。 */
  maxCount: number;
  /** 一次计划的稳定 id —— 首次进入表单时分配(mount),之后的批准 / 执行复用同一 id。 */
  planId: string;
  /** 下一行的序号(operationId 用它,不复用已删的号)。 */
  nextRowSeq: number;
  /** 已签发的授权(编辑操作行后作废 —— 计划变了,旧授权绑的是旧计划)。 */
  grant: UnattendedGrant | null;
  /** 上一次批准被拒的原因(给人看;成功 / 编辑后清空)。 */
  approvalError: string | null;
  /** 上一次执行的结局。 */
  run: UnattendedRunOutcome | null;
}

export function initialUnattendedPlanState(now: number = Date.now()): UnattendedPlanState {
  return {
    projectId: "",
    operations: [newOperationRow(1)],
    ttlMs: UNATTENDED_DEFAULT_TTL_MS,
    maxCount: 1,
    planId: newUnattendedPlanId(now),
    nextRowSeq: 2,
    grant: null,
    approvalError: null,
    run: null,
  };
}

export type UnattendedPlanAction =
  /** 改项目 —— 作废授权(计划绑的项目变了)。 */
  | { type: "setProject"; projectId: string }
  /** 加一行。 */
  | { type: "addRow" }
  /** 删一行(至少保留一行 —— 空计划签不出,界面不该让它变成空)。 */
  | { type: "removeRow"; operationId: string }
  /** 改一行的某个字段 —— 作废授权(计划正文变了)。 */
  | { type: "editRow"; operationId: string; field: "title" | "prompt" | "expectedRevision"; value: string }
  | { type: "setTtl"; ttlMs: number }
  | { type: "setMaxCount"; maxCount: number }
  | { type: "granted"; grantId: string; expiresAt: number }
  | { type: "approvalRefused"; reason: string }
  | { type: "ran"; report: UnattendedExecutionReportWire }
  | { type: "runRefused"; reason: string }
  /** 重置:新计划 id、清空表单(与「开始一份新计划」同义)。 */
  | { type: "reset"; now?: number };

/** 编辑计划正文就作废授权 —— 与 `sceneDeployReducer` 的「编辑即作废」同一条判据。 */
function edited(state: UnattendedPlanState): UnattendedPlanState {
  return { ...state, grant: null, approvalError: null };
}

export function unattendedPlanReducer(state: UnattendedPlanState, action: UnattendedPlanAction): UnattendedPlanState {
  switch (action.type) {
    case "setProject":
      return edited({ ...state, projectId: action.projectId });
    case "addRow":
      return edited({ ...state, operations: [...state.operations, newOperationRow(state.nextRowSeq)], nextRowSeq: state.nextRowSeq + 1 });
    case "removeRow":
      if (state.operations.length <= 1) return state; // 至少一行
      return edited({ ...state, operations: state.operations.filter((op) => op.operationId !== action.operationId) });
    case "editRow":
      return edited({
        ...state,
        operations: state.operations.map((op) => (op.operationId === action.operationId ? { ...op, [action.field]: action.value } : op)),
      });
    case "setTtl":
      return edited({ ...state, ttlMs: action.ttlMs });
    case "setMaxCount":
      return edited({ ...state, maxCount: action.maxCount });
    case "granted":
      return { ...state, grant: { grantId: action.grantId, expiresAt: action.expiresAt }, approvalError: null };
    case "approvalRefused":
      return { ...state, grant: null, approvalError: action.reason };
    case "ran":
      return { ...state, run: { ok: true, report: action.report }, approvalError: null };
    case "runRefused":
      return { ...state, run: { ok: false, reason: action.reason } };
    case "reset":
      return initialUnattendedPlanState(action.now);
  }
}

/* ───────────────────────── 派生 ───────────────────────── */

/** 能不能批准:预判全过且选了项目(未选项目 = 签发口无从解析权威路径,必拒)。 */
export function canApproveUnattended(state: UnattendedPlanState): boolean {
  if (state.projectId.trim() === "") return false;
  return validateUnattendedDraft({ ...state, operations: state.operations }, UNATTENDED_MAX_TTL_MS).length === 0;
}

/** 能不能执行:已持授权且未过期(与 `sceneDeployView` 的 `canDeploy` + `grantActive` 同规矩)。 */
export function canRunUnattended(state: UnattendedPlanState, now: number = Date.now()): boolean {
  return canApproveUnattended(state) && state.grant !== null && now < state.grant.expiresAt;
}

/** 跨重启视图的展示排序:先可续跑的(有事可做)→ 等批准的 → 完成的。 */
export function sortPendingPlans(plans: readonly PendingUnattendedPlanWire[]): PendingUnattendedPlanWire[] {
  const rank = (k: PendingUnattendedPlanWire["kind"]): number => (k === "resumable" ? 0 : k === "waiting_approval" ? 1 : 2);
  return [...plans].sort((a, b) => rank(a.kind) - rank(b.kind) || b.createdAt - a.createdAt);
}
