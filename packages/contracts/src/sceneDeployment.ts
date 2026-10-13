/**
 * **SceneDeployment —— 一次场景部署的持久事实**(ARC-002 / MC-058 的第三片)。
 *
 * ## 它在链上的位置
 *
 * ```text
 * SceneSpec(声明) → compileScenePlan() → ScenePlan(有序变更列表) → SceneDeployment(部署事实)
 * ```
 *
 * `SceneSpec` 说「要什么」,`ScenePlan` 说「按什么顺序建」,`SceneDeployment` 记「**真的建成了什么、
 * 哪一步失败、资源 uid 是什么、验收过没过**」。它是一份**可持久、可回读、可审计**的记录 ——
 * 后续切片把它落进 DB,渲染端 / 报告 / 重试都读它。
 *
 * ## 为什么整体状态是**推导**出来的(Map 里的那类坑)
 *
 * 把部分成功报成 `active` 是 MC-058 明确拒绝的假方案:用户看到「部署成功」,实际有个触发器没建
 * 起来。所以整体状态**不允许调用方手填** —— 它由各步真实状态**推导**(见 {@link deriveDeploymentStatus}):
 *
 *  - 任一步还在 `running`/`pending` → `deploying`;
 *  - 全 `done` → `active`;
 *  - 有 `failed` 也有 `done` → **`partial`**(部分成功就是部分成功);
 *  - 有 `failed` 且没有 `done` → `failed`。
 *
 * ## 判据窄
 *
 * 只做「记录形状 + 纯状态迁移 + 验收判定」,**不**碰 DB / IPC / 网络(后续切片)。纯函数、无依赖。
 */
import type { ScenePlan } from "./scenePlan.js";

/** 单个步骤在部署里的状态。 */
export type SceneStepStatus = "pending" | "running" | "done" | "failed";

/** 部署整体状态 —— 由各步状态推导,不由调用方决定。 */
export type SceneDeploymentStatus = "deploying" | "active" | "partial" | "failed";

/** 发起本次部署的身份 —— 结构化事实(对齐 `@contracts/policyEngine` 的 {@link ActorRef} 取向)。 */
export interface SceneDeploymentActor {
  /** `user`(用户本人)/ `agent`(AI 发起)/ `system`(宿主)。 */
  actorKind: "user" | "agent" | "system";
  /** 具体身份 id(桌面 `desktop` / 会话 id / 系统组件名)。 */
  actorId: string;
}

/** 部署里的一步 —— 对应计划里的一条 {@link import("./scenePlan.js").ScenePlanStep}。 */
export interface SceneDeploymentStep {
  /** = 计划步骤的 actionId(资源 id)。 */
  actionId: string;
  status: SceneStepStatus;
  /** 建成后回读到的真实资源 uid(成功才有)。 */
  resourceUid?: string;
  /** 失败原因(人读)。 */
  error?: string;
  /** 本步开始/结束时刻(ms epoch)。 */
  startedAt?: number;
  finishedAt?: number;
}

/** 验收结果 —— 描述「凭什么说这次部署成了」。 */
export interface SceneAcceptanceResult {
  /** 期望回读的资源 id 列表(来自 spec.acceptance.expectResourceIds)。 */
  expected: string[];
  /** 实际回读到的资源 id 集合(部署器回读所得)。 */
  observed: string[];
  /** 期望里**没**回读到的 id(空 = 全回读到)。 */
  missing: string[];
  /** 验收是否通过(= missing 为空且没有步骤失败)。 */
  passed: boolean;
  /** 判定时刻(ms epoch)。 */
  checkedAt: number;
}

/** 一条部署记录。 */
export interface SceneDeployment {
  /** 本次部署的稳定 id(一次部署一个;重试是新的 advance,不是新 id)。 */
  deploymentId: string;
  sceneId: string;
  /** 部署基于的 spec 语义摘要(见 `@contracts/scenePlan` 的 `sceneSpecDigest`)。 */
  specDigest: string;
  /** 部署基于的计划摘要(ARC-004 计划级授权绑定它)。 */
  planDigest: string;
  /** 谁部署的。 */
  actor: SceneDeploymentActor;
  /** 创建时刻(ms epoch)。 */
  createdAt: number;
  /** 整体状态 —— **始终由 steps 推导**,见 {@link deriveDeploymentStatus}。 */
  status: SceneDeploymentStatus;
  /** 各步实际状态(顺序 = 计划拓扑序)。 */
  steps: SceneDeploymentStep[];
  /** 验收结果(还没验收时为 null)。 */
  acceptance: SceneAcceptanceResult | null;
}

/** 一次步骤状态迁移的输入。 */
export interface SceneStepAdvance {
  actionId: string;
  status: SceneStepStatus;
  /** 成功时回读到的资源 uid。 */
  resourceUid?: string;
  /** 失败原因。 */
  error?: string;
}

/**
 * **整体状态推导** —— 纯函数,只由各步状态决定。
 *
 * 优先级从「最不确定」到「最确定」:`deploying`(还在跑)→ `failed`(全败)→ `partial`(成败并存)
 * → `active`(全成)。**`partial` 必须在 `active` 之前判** —— 只要有一处失败就不能说成功。
 */
export function deriveDeploymentStatus(
  steps: ReadonlyArray<{ status: SceneStepStatus }>,
): SceneDeploymentStatus {
  if (steps.length === 0) return "deploying";
  let done = 0;
  let failed = 0;
  for (const s of steps) {
    if (s.status === "running" || s.status === "pending") return "deploying";
    if (s.status === "done") done += 1;
    else if (s.status === "failed") failed += 1;
  }
  if (failed === 0) return "active";
  if (done === 0) return "failed";
  return "partial";
}

/**
 * **从一份计划新建一条部署记录** —— 所有步骤 `pending`,整体 `deploying`。
 * 绑定 `sceneId` / `specDigest` / `planDigest` / `actor`(可追溯「这次部署基于哪一版计划、谁发起」)。
 */
export function createDeployment(input: {
  deploymentId: string;
  plan: ScenePlan;
  actor: SceneDeploymentActor;
  now: number;
}): SceneDeployment {
  const steps: SceneDeploymentStep[] = input.plan.steps.map((s) => ({
    actionId: s.actionId,
    status: "pending",
  }));
  return {
    deploymentId: input.deploymentId,
    sceneId: input.plan.sceneId,
    specDigest: input.plan.specDigest,
    planDigest: input.plan.digest,
    actor: { actorKind: input.actor.actorKind, actorId: input.actor.actorId },
    createdAt: input.now,
    status: deriveDeploymentStatus(steps),
    steps,
    acceptance: null,
  };
}

/**
 * **推进一个步骤的状态** —— 纯函数,**不改入参**,返回 нового记录。
 *
 * - 找不到 `actionId`(计划里没这一步)→ **抛错**(不静默跳过,硬规矩 3);
 * - `running` 记 `startedAt`;`done`/`failed` 记 `finishedAt` 并清掉相反字段(`done` 清 `error`,
 *   重试成功不残留旧 `error`);
 * - 整体 `status` 由推进后的各步**重新推导**(不是调用方给的)。
 *
 * @param record 当前部署记录(不被修改)。
 * @param advance 这一步要迁到什么状态。
 * @param now 迁移时刻(ms epoch;纯函数不读系统时钟)。
 */
export function advanceDeployment(
  record: SceneDeployment,
  advance: SceneStepAdvance,
  now: number,
): SceneDeployment {
  const idx = record.steps.findIndex((s) => s.actionId === advance.actionId);
  if (idx < 0) {
    throw new Error(`advanceDeployment:部署 ${record.deploymentId} 没有步骤 ${advance.actionId}`);
  }
  const prev = record.steps[idx];
  const next: SceneDeploymentStep = { actionId: prev.actionId, status: advance.status };
  if (advance.status === "running") {
    next.startedAt = now;
    // 重试:保留原 startedAt 语义不需要,这里以本次运行为准;清掉上次的终态字段。
  } else if (advance.status === "done") {
    next.startedAt = prev.startedAt ?? now;
    next.finishedAt = now;
    if (advance.resourceUid !== undefined) next.resourceUid = advance.resourceUid;
  } else if (advance.status === "failed") {
    next.startedAt = prev.startedAt ?? now;
    next.finishedAt = now;
    if (advance.error !== undefined) next.error = advance.error;
    // 失败时若之前成功回读过 uid,保留(资源仍可能存在)→ 不复制 prev.resourceUid 以免误导。
  }
  const steps = record.steps.map((s, i) => (i === idx ? next : s));
  return { ...record, status: deriveDeploymentStatus(steps), steps };
}

/**
 * **验收判定** —— 纯函数。给定部署、期望回读的资源 id 列表、实际回读到 id 集合,判通过与否,
 * 并把结果写成新的 `acceptance`(返回新记录,不改入参)。
 *
 * 判据:**期望的每个 id 都在 observed 里**才算通过(`missing` 为空)。额外的 observed id 不算错
 * (回读到别的资源不影响本场景验收)。
 *
 * @param record 当前部署记录。
 * @param expectedResourceIds 期望回读的资源 id(= spec.acceptance.expectResourceIds)。
 * @param observedResourceIds 实际回读到的资源 id 集合。
 * @param now 判定时刻(ms epoch)。
 */
export function evaluateAcceptance(
  record: SceneDeployment,
  expectedResourceIds: readonly string[],
  observedResourceIds: readonly string[],
  now: number,
): SceneDeployment {
  const observedSet = new Set(observedResourceIds);
  const expected = [...expectedResourceIds];
  const observed = [...observedResourceIds];
  const missing = expected.filter((id) => !observedSet.has(id));
  const passed = missing.length === 0;
  const acceptance: SceneAcceptanceResult = { expected, observed, missing, passed, checkedAt: now };
  return { ...record, acceptance };
}
