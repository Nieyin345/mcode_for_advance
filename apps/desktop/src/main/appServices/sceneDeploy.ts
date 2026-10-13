/**
 * **场景部署执行端(dry-run + apply)** —— 把 `SceneCommands` 分派到**既有服务**并记录
 * `SceneDeployment`(MC-058 / ARC-002 的第五片,即「执行端」)。
 *
 * ## 它在链上的位置
 *
 * ```text
 * SceneSpec(声明) → compileScenePlan() → ScenePlan(有序变更列表)
 *                  → compileSceneCommands() → SceneCommands(命令描述符)
 *                  → 本文件 dryRunScene() / applyScene()  ← 执行端
 *                       │ 逐步 callRpc 到**唯一一个既有服务**
 *                       └ 逐步 advanceDeployment + saveDeployment(durable)
 * ```
 *
 * 在这之前,`compileSceneCommands` **没有任何生产调用方** —— 一条只在 smoke 里活着的判据;`saveDeployment`
 * 也只有测试调用方。本文件给它们第一个真实消费者:把一份声明落成「有序命令 → 逐步执行 → 记录事实」。
 *
 * ## 两条硬边界(写在文件头,免得被当成疏漏)
 *
 *  1. **不另造 runtime。** 每一步都经 `appControl/tools.ts` 的 `findEntry` + `callRpc` 派发 —— 那是
 *     `app_api_call` 走的**同一条**通路(同一批 handler、同一份授权判定核)。本文件不长第二套执行引擎。
 *  2. **没有授权绝不执行。** `applyScene` 必须带一枚**计划级授权**(`@contracts/policyEngine` 的
 *     `Grant`),并且这枚授权必须**绑定这一次要跑的计划 digest**。判定走**唯一**那份判定核
 *     `policyEngine.evaluate` —— 绝不在这里手写第二套「准不准」。授权缺失 / 非用户签发 / 撤销 /
 *     过期 / 绑的是另一份计划 → **拒绝执行,连部署记录都不建**。
 *
 * ## 授权为什么是「绑计划 digest」而不是「绑 spec」
 *
 * `plan.digest = scenePlanDigest({ sceneId, specDigest, steps })`,而 `specDigest` 覆盖**整份 spec
 * (含每条资源的载荷正文)**。所以钉住 `plan.digest` 就传递性地钉住了「这一次要跑的每一条命令、带什么
 * 载荷」—— 批准之后偷改 spec 的任一载荷,重编译得到的 `plan.digest` 就变,授权立即失效(ARC-004 的
 * 「审批对象是计划,不是 spec」)。因此本执行端可以放心地对每一步直接 `callRpc`(不经逐次审批卡):
 * 计划级授权**就是**覆盖整个计划的授权。
 *
 * ## 这一层**不做**什么(MC-058 仍未关闭的部分,如实列出)
 *
 *  - **授权签发端未接**:本层只**消费**一枚计划级授权(校验它是否绑定本计划并放行)。**谁**在
 *    用户点头后为场景签出这枚 `scene.apply` 授权(ARC-004 的签发口目前只签 `app_api_call` 的单方法
 *    指纹授权),是**下一片** —— 在那之前,本层的真实调用方必须先持有一枚绑定本计划的用户授权,
 *    否则一律拒绝。**这是有意的缺口,不是静默放行。**
 *  - **真实资源回读未做**:`evaluateAcceptance` 的 `observed` 取自**本次部署记录里走到 `done` 的
 *    步骤**,不是独立回读宿主真实资源(工作流是否真存在)。独立回读是后续切片。
 *  - **resourceUid 未落**:各服务返回形状不统一,本层**不猜**一个 uid(免得把 A 服务的返回当 B
 *    服务的 id),留待后续切片按服务逐个接。
 *  - **needsResolution(plugin/panel/scaffold)未决议**:这些 kind 无单条确定入口,本层**明确**
 *    记为「未执行」并写清原因,**绝不**猜一个入口去跑。
 */
import {
  validateSceneSpec,
  type SceneSpecProblem,
} from "@contracts/sceneSpec";
import { compileScenePlan, type ScenePlan } from "@contracts/scenePlan";
import { compileSceneCommands } from "@contracts/sceneCommands";
import {
  advanceDeployment,
  createDeployment,
  evaluateAcceptance,
  type SceneDeployment,
  type SceneDeploymentActor,
  type SceneStepStatus,
} from "@contracts/sceneDeployment";
import type { Grant } from "@contracts/policyEngine";
import { evaluate, scenePlanCoreIntent } from "@main/appControl/policyEngine.js";
import { callRpc, findEntry } from "@main/appControl/tools.js";
import { log } from "@main/lib/logger.js";
import { saveDeployment } from "./sceneDeploymentStore.js";

/**
 * 一次场景部署的「apply」动作在授权核里的**方法名**。计划级授权(`Grant.allowedActions`)必须含它,
 * 且 `scopedCore.scenePlan` 必须等于本计划的 digest —— 两条都由 `evaluate` 判。
 */
export const SCENE_APPLY_METHOD = "scene.apply";

/** 审批主体引用 —— 与 `app_api_call` 侧同取向:批准主体必须是**用户本人**,agent/system 不能自批。 */
const SCENE_APPROVAL_REF = { kind: "user", id: "scene.apply" } as const;

/* ───────────────────────── dry-run ───────────────────────── */

/** dry-run 里一步的静态预判结果(不执行任何东西)。 */
export interface SceneDryRunStep {
  actionId: string;
  kind: string;
  order: number;
  /** 该 kind 映射到的既有服务入口标签(如 `workflow.save`);无法稳妥给出时为 `null`。 */
  serviceLabel: string | null;
  needsResolution: boolean;
  resolutionHint: string | null;
  dependsOn: string[];
  /** 静态判定这一步**会不会**被执行(见 {@link dryRunScene} 的说明)。 */
  willRun: boolean;
  /** 不会执行的原因(会执行时为 `null`);不会静默—— 必给一句人读原因。 */
  notAppliedReason: string | null;
}

/**
 * dry-run 结果:要么是**全部校验问题**,要么是一份「要按什么顺序建什么、哪几步不会跑」的静态预判。
 * 二选一,不并存。
 */
export type SceneDryRunResult =
  | { ok: false; problems: SceneSpecProblem[] }
  | {
      ok: true;
      sceneId: string;
      planDigest: string;
      commandsDigest: string;
      /** 需要部署器进一步决议的 commandId 清单(needsResolution 的那些)。 */
      unresolved: string[];
      steps: SceneDryRunStep[];
    };

/**
 * **dry-run** —— 校验 → 编译计划 → 编译命令 → 逐条静态预判,**不执行任何东西**(不建资源、不碰磁盘、
 * 不写部署记录、不申请授权)。
 *
 * 「哪几步会跑」的判据(纯静态,不能预知运行期失败):
 *  - `service.needsResolution` 为真 → 该步**不会**跑(需先决议,本层不猜入口);
 *  - 否则,若它**依赖的任一步静态判定为「不会跑」** → 该步也**不会**跑(依赖不成立则不执行)。
 *
 * 依赖的传递性按计划拓扑序逐条推进 —— 与运行期 {@link applyScene} 的依赖闸同一判据,只是不带真实失败。
 *
 * @param spec 一份**候选** SceneSpec(形状先宽松收下,业务校验交给 `validateSceneSpec` 一次报全)。
 */
export function dryRunScene(spec: unknown): SceneDryRunResult {
  const validation = validateSceneSpec(spec);
  if (!validation.ok) return { ok: false, problems: validation.problems };
  const plan = compileScenePlan(validation.spec);
  const commands = compileSceneCommands(plan, validation.spec);

  const willRunById = new Map<string, boolean>();
  const steps: SceneDryRunStep[] = commands.commands.map((c) => {
    let willRun = !c.service.needsResolution;
    let reason: string | null = null;
    if (c.service.needsResolution) {
      reason = `需要先按「${c.service.resolutionHint ?? "资源声明"}」进一步决议才能选定服务入口,本层不猜入口、不执行`;
    } else {
      const badDep = c.dependsOn.find((dep) => willRunById.get(dep) === false);
      if (badDep !== undefined) {
        willRun = false;
        reason = `依赖的步骤「${badDep}」静态判定不会执行,本步也不执行`;
      }
    }
    willRunById.set(c.actionId, willRun);
    return {
      actionId: c.actionId,
      kind: c.kind,
      order: c.order,
      serviceLabel: c.service.serviceLabel,
      needsResolution: c.service.needsResolution,
      resolutionHint: c.service.resolutionHint,
      dependsOn: [...c.dependsOn],
      willRun,
      notAppliedReason: reason,
    };
  });

  return {
    ok: true,
    sceneId: plan.sceneId,
    planDigest: plan.digest,
    commandsDigest: commands.digest,
    unresolved: [...commands.unresolved],
    steps,
  };
}

/* ───────────────────────── apply ───────────────────────── */

/** `applyScene` 的入参。 */
export interface SceneApplyInput {
  /** 本次部署的稳定 id(重试是同一 id 的覆盖,不是新部署)。 */
  deploymentId: string;
  /** 一份**候选** SceneSpec(执行前会重新校验并重编译,得到与授权对账的 plan digest)。 */
  spec: unknown;
  /** 谁发起的(结构化身份,进部署记录)。 */
  actor: SceneDeploymentActor;
  /**
   * **计划级授权** —— 必给。必须:① 用户本人签发;② 仍有效(未撤销 / 未过期);
   * ③ `allowedActions` 含 {@link SCENE_APPLY_METHOD};④ `scopedCore.scenePlan` == 本计划 digest。
   * 任一条不满足 → 拒绝执行,连部署记录都不建(见文件头「授权为什么绑计划 digest」)。
   */
  grant: Grant;
  /** 可注入时钟(便于确定性测;缺省 `Date.now`)。纯函数不读系统时钟的取向。 */
  now?: () => number;
}

/** 拒绝执行的理由(带简短码,便于断言与展示)。 */
export interface SceneApplyRefusal {
  /** 稳定的短码,便于调用方按 code 分派(不解析人读 reason)。 */
  code: "not_user" | "revoked" | "expired" | "method_not_allowed" | "plan_mismatch" | "no_grant";
  /** 给用户 / 模型看的一句人话。 */
  reason: string;
}

/** `applyScene` 的结果。三态用 `kind` 区分,不靠 `ok` 猜。 */
export type SceneApplyResult =
  | { ok: false; kind: "invalid"; problems: SceneSpecProblem[] }
  | { ok: false; kind: "refused"; refusal: SceneApplyRefusal }
  | { ok: true; kind: "applied"; deployment: SceneDeployment };

/**
 * **授权判定** —— 走**唯一**那份判定核 `policyEngine.evaluate`(绝不在这里手写第二套)。
 *
 * 意图身份:`method = scene.apply`,`core = scenePlanCoreIntent(plan)`(= `{ scenePlan: plan.digest }`)。
 * 于是 `evaluate` 会把「批准的是这一份计划吗」变成它已有的 `invalidationsFor` 里那条 `scenePlan` 比较 ——
 * 绑的是另一份计划就被判 `require-approval`,不做任何执行。
 *
 * @returns `null` = 放行;否则是拒绝理由(含稳定码)。
 */
function authorizeApply(
  plan: ScenePlan,
  actor: SceneDeploymentActor,
  grant: Grant,
  now: number,
): SceneApplyRefusal | null {
  const intent = { method: SCENE_APPLY_METHOD, core: scenePlanCoreIntent(plan) };
  const decision = evaluate(intent, grant, {
    now,
    requester: { kind: actor.actorKind, id: actor.actorId },
    approver: { ...SCENE_APPROVAL_REF },
    // 兼容档显式给 write:`scene.apply` 是有副作用的动作(建工作流 / 装钩子 / 写配置)。
    compatibilityLevel: "write",
  });
  if (decision.verdict === "allow") return null;
  return { code: classifyRefusal(grant, plan, now), reason: decision.reason };
}

/**
 * 把 `evaluate` 的拒绝翻成一个**稳定码**(仅供调用方分派 / 断言,不参与授权判定 —— 判定只有一份)。
 * 判据与 `evaluate` 各分支一一对应,顺序也照它。
 */
function classifyRefusal(grant: Grant, plan: ScenePlan, now: number): SceneApplyRefusal["code"] {
  if (grant.approvalSource.kind !== "user") return "not_user";
  if (grant.revoked) return "revoked";
  if (!(now < grant.expiresAt)) return "expired";
  if (!grant.allowedActions.includes(SCENE_APPLY_METHOD)) return "method_not_allowed";
  if (grant.scopedCore.scenePlan !== plan.digest) return "plan_mismatch";
  return "no_grant";
}

/** 读一个 actionId 在部署记录里的当前步骤状态(不存在为 `null`)。 */
function stepStatusOf(d: SceneDeployment, actionId: string): SceneStepStatus | null {
  const step = d.steps.find((s) => s.actionId === actionId);
  return step ? step.status : null;
}

/**
 * **执行一次场景部署** —— 建部署记录 → 逐步(按计划拓扑序)分派到既有服务 → 逐步落盘 → 收尾验收。
 *
 * 执行顺序与闸门(每一步都在自己的状态迁移后 `saveDeployment({durable:true})`,崩溃可续):
 *  1. 校验 spec(一次报全)—— 不合法直接返回,**不建记录、不执行**;
 *  2. 编译计划 + 命令;
 *  3. **授权判定**(见 {@link authorizeApply})—— 不放行直接返回,**不建记录、不执行**;
 *  4. `createDeployment` → 落盘(初始 `deploying`,崩溃在第一步前也可续);
 *  5. 逐条命令:
 *     - 依赖的任一步**不是 `done`** → 记为 **failed**(未执行,写清是哪个依赖),落盘,下一条;
 *     - `service.needsResolution` → 记为 **failed**(明确「需要决议、未执行」),落盘,下一条;
 *     - 否则 `running` → 落盘 → `findEntry(serviceLabel)` 解析通道 → `callRpc(entry, payload)`
 *       → 成功记 `done` / 抛错记 `failed`(带上服务的真实错误)→ 落盘;
 *  6. `evaluateAcceptance`:`observed` = 本次走到 `done` 的步骤 id(**不是**独立回读,见文件头),
 *     写入验收结果 → 落盘。
 *
 * **整体状态由各步推导**(`deriveDeploymentStatus`):有失败也有成功 → **`partial`**;全失败 → `failed`;
 * 全成 → `active`。**绝不**把部分成功报成 `active`(MC-058 明确拒绝的假方案)。
 *
 * `saveDeployment` 的 durable 写若返回 false(磁盘故障),如实记一条 warn 但**不假报成功** ——
 * 部署记录以内存 `d` 为准,调用方拿到的是**真实**的 `deployment`。
 */
export async function applyScene(input: SceneApplyInput): Promise<SceneApplyResult> {
  const clock = input.now ?? Date.now;

  // ① 校验(一次报全)—— 不合法不执行任何东西。
  const validation = validateSceneSpec(input.spec);
  if (!validation.ok) return { ok: false, kind: "invalid", problems: validation.problems };
  const spec = validation.spec;

  // ② 编译计划 + 命令。
  const plan = compileScenePlan(spec);
  const commands = compileSceneCommands(plan, spec);

  // ③ 授权判定 —— 不放行连部署记录都不建。
  const refusal = authorizeApply(plan, input.actor, input.grant, clock());
  if (refusal !== null) {
    log.warn(`scene deploy ${input.deploymentId}: 拒绝执行(${refusal.code})—— ${refusal.reason}`);
    return { ok: false, kind: "refused", refusal };
  }

  // ④ 建记录 + 初始落盘。
  let d = createDeployment({ deploymentId: input.deploymentId, plan, actor: input.actor, now: clock() });
  persistStep(d);

  // ⑤ 逐条命令,按计划拓扑序(依赖必先于被依赖者,故到某步时它的依赖都已处理完)。
  for (const command of commands.commands) {
    // 依赖闸:任一依赖没走到 done → 本步不执行(failed + 明说原因)。
    const failedDep = command.dependsOn.find((dep) => stepStatusOf(d, dep) !== "done");
    if (failedDep !== undefined) {
      d = advanceDeployment(
        d,
        {
          actionId: command.actionId,
          status: "failed",
          error: `依赖的步骤「${failedDep}」未成功(状态 ${stepStatusOf(d, failedDep) ?? "未知"}),本步未执行`,
        },
        clock(),
      );
      persistStep(d);
      continue;
    }

    // needsResolution:无单条确定入口 → 明确「未执行」,绝不猜一个入口去跑。
    if (command.service.needsResolution) {
      d = advanceDeployment(
        d,
        {
          actionId: command.actionId,
          status: "failed",
          error: `需要先按「${command.service.resolutionHint ?? "资源声明"}」进一步决议才能选定服务入口,本次未执行(不猜入口)`,
        },
        clock(),
      );
      persistStep(d);
      continue;
    }

    // 派发:running → 落盘 → callRpc(既有服务)→ done/failed → 落盘。
    d = advanceDeployment(d, { actionId: command.actionId, status: "running" }, clock());
    persistStep(d);

    const label = command.service.serviceLabel;
    try {
      const entry = label === null ? undefined : findEntry(label);
      if (!entry) {
        throw new Error(`服务入口「${label ?? "(无)"}」在当前版本里没有注册`);
      }
      // 与 `app_api_call` **同一条**通路:同一批 handler、同一份授权判定核。这里直连 `callRpc`
      // (不经逐次审批卡)—— 计划级授权**就是**覆盖整个计划的授权(见文件头)。
      await callRpc(entry, command.payload);
      d = advanceDeployment(d, { actionId: command.actionId, status: "done" }, clock());
    } catch (err) {
      d = advanceDeployment(
        d,
        { actionId: command.actionId, status: "failed", error: (err as Error).message },
        clock(),
      );
    }
    persistStep(d);
  }

  // ⑥ 收尾验收:expected 来自声明,observed 取自本次走到 done 的步骤(非独立回读,见文件头)。
  const observed = d.steps.filter((s) => s.status === "done").map((s) => s.actionId);
  d = evaluateAcceptance(d, spec.acceptance.expectResourceIds, observed, clock());
  persistStep(d);

  return { ok: true, kind: "applied", deployment: d };
}

/** 逐步落盘 —— durable 写。失败如实记警告,不假报成功(记录以调用方拿到的内存 `d` 为准)。 */
function persistStep(d: SceneDeployment): void {
  if (!saveDeployment(d, { durable: true })) {
    log.warn(`scene deploy ${d.deploymentId}: 步骤「${d.steps.map((s) => s.status).join(",")}」的 durable 落盘失败,本次以内存记录为准`);
  }
}
