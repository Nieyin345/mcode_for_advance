/**
 * **场景规划(只读)** —— ARC-002 / MC-058 的 dry-run 规划入口。
 *
 * ## 它是什么
 *
 * 给定一份候选 `SceneSpec`(通常由某个 SDK Agent 把用户的一句话目标翻出来),**只做两件事**:
 *   1. 用 `validateSceneSpec` 做**确定性校验**(一次报全,不是遇到第一个就停);
 *   2. 校验通过时用 `compileScenePlan` **编译**出一份有序变更计划(拓扑排序 + 稳定 digest)。
 *
 * ## 它是**只读**的,这条写在名字里
 *
 * `scene.plan` 只规划、**不执行** —— 它不建任何资源、不碰磁盘、不申请授权。这正是 MC-058
 * 拒绝验收的那条假方案的反面:「模型提出计划 ≠ 获得执行权限」。真正的部署(apply)是**另一条**
 * 命令,且必须有独立的计划级授权(见 `@contracts/policyEngine` 与 ARC-004);本契约刻意**没有**
 * `apply`。
 *
 * ## 为什么要有它
 *
 * 在这之前,`validateSceneSpec` / `compileScenePlan` 是**没有任何生产调用方**的纯函数 ——
 * 一条只在 smoke 里活着的判据。本条 IPC 给了它们第一个真实消费者:Agent 把候选声明递进来,
 * 拿到「哪里不合法」或「会按什么顺序建什么」,再决定要不要请用户批准。
 */
import { z } from "zod";

/**
 * 规划入参:一份**候选** SceneSpec(形状先宽松收下,由 `validateSceneSpec` 做**业务**校验
 * 并把全部问题报回来 —— 用 zod 在这里卡形状只会把「哪里不合法」变成一句笼统的 parse error)。
 */
export const ScenePlanInputSchema = z.object({
  spec: z.unknown(),
});
export type ScenePlanInput = z.infer<typeof ScenePlanInputSchema>;

/** 规划结果:要么带上「全部问题」,要么带上一份编译好的计划。二选一,不并存。 */
export type ScenePlanResult =
  | { ok: false; problems: Array<{ path: string; message: string }> }
  | { ok: true; plan: ScenePlanWire };

/**
 * 预检入参:一份**候选** SceneSpec(通常就是刚 `scene.plan` 过的那份)。与规划一样先宽松收下,
 * 由 `validateSceneSpec` 做业务校验并把全部问题报回来。
 */
export const ScenePreflightInputSchema = z.object({
  spec: z.unknown(),
});
export type ScenePreflightInput = z.infer<typeof ScenePreflightInputSchema>;

/**
 * 预检结果。三态全在 `ok` 之外显式给出,便于调用方区分「声明不合法」「能力缺」:
 *  - 声明不合法 → `{ ok:false, problems }`(与规划同一形状,不重复第二套);
 *  - 声明合法 → `{ ok:true, plan, preflight }`,`preflight.ok` 才是能力是否就位。
 */
export type ScenePreflightIpcResult =
  | { ok: false; problems: Array<{ path: string; message: string }> }
  | { ok: true; plan: ScenePlanWire; preflight: ScenePreflightWire };

/** 过 IPC 的能力预检形状(与 `@contracts/scenePreflight` 同形,这里显式给出契约面)。 */
export interface ScenePreflightWire {
  ok: boolean;
  gaps: Array<{
    kind: string;
    id: string;
    reason: "missing" | "incompatible";
    missingCapabilities: string[];
    required: boolean;
    detail: string;
  }>;
  requiredGaps: Array<{
    kind: string;
    id: string;
    reason: "missing" | "incompatible";
    missingCapabilities: string[];
    required: boolean;
    detail: string;
  }>;
  checkedCapabilities: number;
}


/** 过 IPC 的计划形状(与 `@contracts/scenePlan` 的 `ScenePlan` 同形,这里显式给出契约面)。 */
export interface ScenePlanWire {
  sceneId: string;
  specDigest: string;
  digest: string;
  steps: Array<{
    actionId: string;
    resourceId: string;
    kind: string;
    order: number;
    dependsOn: string[];
    compensable: boolean;
    verifier: { kind: "exists"; resourceId: string };
  }>;
}


/* ───────────────────────── MC-058 部署(写) ───────────────────────── */

/**
 * **场景部署的审批单** —— 用户在渲染端看过 dry-run 之后点「批准」时递进来的东西。
 *
 * ## 为什么审批的对象是「计划 digest」而不是「spec 正文」
 *
 * `applyScene` 拿到 spec 会**重新校验 + 重编译**,得到一份计划与它的 `digest`。授权里钉住的
 * `scopedCore.scenePlan` 必须等于那个 digest —— 于是「用户批准的是**这一份**计划」变成可判定的
 * 数据:批准之后 spec 被偷改一个载荷字节,重编译得到的 digest 就变,`evaluate` 里的
 * `invalidationsFor` 点名 `scenePlan`,授权立即失效,回到重新预览批准(ARC-004 的
 * 「审批对象是计划,不是 spec」)。所以这里**必须**带 `planDigest`,让宿主在签发前对账:
 * 渲染端看到的那份计划,和这次要跑的那份,是不是同一份。
 */
export const SceneApprovalInputSchema = z.object({
  /** 一次部署的稳定 id(重试是同一 id 的覆盖,不是新部署)。 */
  deploymentId: z.string().min(1),
  /** 一份**候选** SceneSpec(与 `scene.plan` 收到的是同一份;执行前会重新校验重编译)。 */
  spec: z.unknown(),
  /**
   * 用户在预览里看到的**计划摘要**。宿主会拿它与重编译结果对账 —— 不一致 = 「批准的那份」
   * 与「要跑的那份」不是同一份,拒绝签发(不静默按新计划发一份授权,那是偷换审批对象)。
   */
  planDigest: z.string().min(1),
  /** 授权有效期的毫秒数(调用方给;`issueGrant` 只拒非正数,具体上限由宿主策略定)。 */
  ttlMs: z.number().int().positive(),
});
export type SceneApprovalInput = z.infer<typeof SceneApprovalInputSchema>;

/**
 * 审批结果 —— 三态分开,调用方不必解析人读文案:
 *  - `granted`:签出了一枚计划级授权,`expiresAt` 是它的到期时刻;
 *  - `refused`:**没签**(spec 不合法 / 计划摘要对不上 / 判定为 deny),`reason` 说清为什么;
 *  - `invalid`:spec 本身不合法,`problems` 是**全部**问题(与 `scene.plan` 同一形状)。
 */
export type SceneApprovalResult =
  | { ok: true; kind: "granted"; grantId: string; expiresAt: number }
  | { ok: false; kind: "refused"; reason: string }
  | { ok: false; kind: "invalid"; problems: Array<{ path: string; message: string }> };

/**
 * 部署入参 —— **不给 grant**。授权由宿主从自己的 `GrantStore` 里按 `grantId` 取回
 * (`applyScene` 的执行点要的是**原始授权含失效态**,让 `evaluate` 能走到全部 deny 分支)。
 * 渲染端能给的只有一个 id:一个「自填 grant 内容」的入口等于把授权判定整个绕过。
 */
export const SceneApplyInputSchema = z.object({
  deploymentId: z.string().min(1),
  spec: z.unknown(),
  /** 上一次 `scene.approve` 签出的授权 id。 */
  grantId: z.string().min(1),
  /** 谁发起的(结构化身份;渲染端只能声明「这是桌面用户点的」,宿主不复核它,判定看的是 grant)。 */
  actorKind: z.enum(["user", "agent", "system"]),
  actorId: z.string().min(1),
  /** 某步失败时是否补偿(缺省由主进程定 = true)。 */
  compensateOnFailure: z.boolean().optional(),
});
export type SceneApplyInput = z.infer<typeof SceneApplyInputSchema>;

/** 一条资源的独立回读(**过 IPC 的形状**;判据是「查得到才算 present」)。 */
export interface SceneStepReadbackWire {
  actionId: string;
  kind: string;
  observed: boolean;
  readLabel: string | null;
  unverifiableReason: string | null;
}

/** 独立回读汇总(过 IPC)。 */
export interface SceneReadbackWire {
  steps: SceneStepReadbackWire[];
  observed: string[];
  unverifiable: string[];
}

/** 部署结果 —— 三态(不合法 / 被拒 / 已执行),`kind` 区分。 */
export type SceneApplyIpcResult =
  | { ok: false; kind: "invalid"; problems: Array<{ path: string; message: string }> }
  | { ok: false; kind: "refused"; code: string; reason: string }
  | {
      ok: true;
      kind: "applied";
      deployment: SceneDeploymentWire;
      readback: SceneReadbackWire;
    };

/**
 * 过 IPC 的部署记录形状(与 `@contracts/sceneDeployment` 的 `SceneDeployment` 同形,
 * 这里显式给出契约面 —— 部署记录会进渲染端展示,契约不引用主进程实现)。
 */
export interface SceneDeploymentWire {
  deploymentId: string;
  sceneId: string;
  specDigest: string;
  planDigest: string;
  actor: { actorKind: "user" | "agent" | "system"; actorId: string };
  createdAt: number;
  status: "deploying" | "active" | "partial" | "failed";
  steps: Array<{
    actionId: string;
    status: "pending" | "running" | "done" | "failed" | "compensated";
    resourceUid?: string;
    error?: string;
    startedAt?: number;
    finishedAt?: number;
    priorExistence?: "created" | "preExisting" | "unknown";
    priorRevision?: string | null;
    createdRevision?: string | null;
    compensation?: { applied: boolean; inverseLabel: string | null; reason: string };
  }>;
  acceptance: {
    expected: string[];
    observed: string[];
    missing: string[];
    passed: boolean;
    checkedAt: number;
  } | null;
}
