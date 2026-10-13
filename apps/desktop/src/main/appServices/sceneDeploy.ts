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
 * ## 真实资源回读 + 补偿(MC-058 已补上的两块)
 *
 *  - **独立回读**({@link readbackScene}):收尾验收的 `observed` **不再**取自「本次部署记录里走到
 *    `done` 的步」,而是按 kind 调**既有回读入口**重新查询宿主真实资源,只把查得到的收进 observed。
 *    资源被带外删掉 / 入口报成功却没真建成时,记录仍说 done,但回读查不到 → 验收不通过。
 *  - **失败补偿**({@link compensateDoneSteps}):中途某步失败时,**逆序**对之前已建成、声明
 *    `compensable` 的步调**逆操作**撤销其资源(该步迁到 `compensated`),不让失败的部署留下孤儿。
 *    不可补偿 / 无稳妥逆操作 / 逆操作失败 → **保持 `done` 但如实记一条 `compensation`**(`applied:false`
 *    + 人读原因),**绝不静默**(硬规矩 3),也绝不猜一个入口去删(免得删错东西)。
 *
 * ## 这一层**不做**什么(MC-058 仍未关闭的部分,如实列出)
 *
 *  - **授权签发端未接**:本层只**消费**一枚计划级授权(校验它是否绑定本计划并放行)。**谁**在
 *    用户点头后为场景签出这枚 `scene.apply` 授权(ARC-004 的签发口目前只签 `app_api_call` 的单方法
 *    指纹授权),是**下一片** —— 在那之前,本层的真实调用方必须先持有一枚绑定本计划的用户授权,
 *    否则一律拒绝。**这是有意的缺口,不是静默放行。**
 *  - **回读入口未逐个按真实契约钉死身份**:byList 的匹配字段取各列表返回的形状(skills 按 `name`、
 *    mcp 按 `name`、hooks/modules 按 `id`);各服务返回形状不统一时未逐个核对到真实资源身份。
 *  - **resourceUid 未落**:各服务返回形状不统一,本层**不猜**一个 uid(免得把 A 服务的返回当 B
 *    服务的 id),留待后续切片按服务逐个接。
 *  - **补偿未覆盖 plugin/panel/scaffold**:plugin 仍 needsResolution(不执行,无建成可撤);panel /
 *    scaffold 无撤销入口,如实记未补偿。skill 亦无稳妥逆操作(需 `source`)。
 *  - **needsResolution(plugin/panel/scaffold)未决议**:这些 kind 无单条确定入口,本层**明确**
 *    记为「未执行」并写清原因,**绝不**猜一个入口去跑。
 */
import {
  validateSceneSpec,
  type SceneSpec,
  type SceneSpecProblem,
  type SceneResourceKind,
} from "@contracts/sceneSpec";
import { compileScenePlan, type ScenePlan } from "@contracts/scenePlan";
import {
  compileSceneCommands,
  serviceForKind,
  type SceneCommandPlan,
} from "@contracts/sceneCommands";
import {
  advanceDeployment,
  createDeployment,
  evaluateAcceptance,
  type SceneDeployment,
  type SceneDeploymentActor,
  type SceneStepCompensation,
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
  /**
   * 某步失败时**是否补偿**(撤销之前已建成、且声明 `compensable` 的步)。缺省 **`true`** ——
   * MC-058 的既定行为:一次失败的部署**不留下孤儿**。设 `false` 则失败后就地停下(不退已建的),
   * 交人工处置。补偿走**同一枚计划级授权**(计划是授权单位,撤销本计划刚建成的资源属于同一计划的
   * 执行,不是第二套判定)。
   */
  compensateOnFailure?: boolean;
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
  | { ok: true; kind: "applied"; deployment: SceneDeployment; readback: SceneReadbackResult };

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

/* ───────────────────────── 独立回读(M-C058 的真实资源回读) ───────────────────────── */

/** 一条资源的**独立回读**结果。 */
export interface SceneStepReadback {
  actionId: string;
  kind: SceneResourceKind;
  /** 是否**独立回读**到了宿主真实资源(查得到才算 present)。 */
  observed: boolean;
  /** 回读所用入口标签(如 `workflow.get`);无回读入口时为 `null`。 */
  readLabel: string | null;
  /** 不能独立回读的原因(无回读入口 / 查询出错);能回读时为 `null`。 */
  unverifiableReason: string | null;
}

/** 一次部署的**独立回读**汇总 —— `observed` 直接喂给 `evaluateAcceptance`。 */
export interface SceneReadbackResult {
  steps: SceneStepReadback[];
  /** 独立回读到的资源 actionId 集合(= 喂给 `evaluateAcceptance` 的 observed)。 */
  observed: string[];
  /** 无法独立回读的资源 actionId(无回读入口 / 查询出错)—— 明确列出,不当成 present。 */
  unverifiable: string[];
}

/**
 * 对**一条**资源做独立回读 —— 调 `service.readback` 描述的既有入口,按 id/名单**重新查询**
 * 宿主真实资源。判据只有「查得到才 present」:绝不从部署记录里推。
 *
 * @param actionId 资源 id(= 计划步骤的 actionId)。
 * @param kind 资源种类(决定回读入口与匹配字段)。
 */
async function probeResource(actionId: string, kind: SceneResourceKind): Promise<SceneStepReadback> {
  const rb = serviceForKind(kind).readback;
  if (rb === null) {
    return {
      actionId,
      kind,
      observed: false,
      readLabel: null,
      unverifiableReason: `kind「${kind}」无单条确定回读入口,无法独立回读(如实记为「未验证」,不当成 present)`,
    };
  }
  try {
    const entry = findEntry(rb.label);
    if (!entry) {
      return { actionId, kind, observed: false, readLabel: rb.label, unverifiableReason: `回读入口「${rb.label}」在当前版本里没有注册` };
    }
    if (rb.mode === "byArg") {
      const res = (await callRpc(entry, { [rb.arg as string]: actionId })) as Record<string, unknown> | null;
      const node = res?.[rb.field];
      const observed = typeof node === "object" && node !== null && !Array.isArray(node);
      return { actionId, kind, observed, readLabel: rb.label, unverifiableReason: null };
    }
    const res = (await callRpc(entry, {})) as Record<string, unknown> | null;
    const list = res?.[rb.field];
    const observed =
      Array.isArray(list) && list.some((x) => typeof x === "object" && x !== null && (x as Record<string, unknown>)[rb.matchField] === actionId);
    return { actionId, kind, observed, readLabel: rb.label, unverifiableReason: null };
  } catch (err) {
    return { actionId, kind, observed: false, readLabel: rb.label, unverifiableReason: `回读查询出错:${(err as Error).message}` };
  }
}

/**
 * **独立回读一次部署的真实资源** —— 对部署里每一步的资源按 kind 调**既有回读入口**重新查询
 * 宿主是否真的存在它,收成 `observed`(可直接喂 `evaluateAcceptance`)。
 *
 * 与「本次走到 done 的步」的关键区别(MC-058 点名的缺口):**资源被带外删掉**时,部署记录里那步
 * 仍是 `done`,但这里**查不到** → 不进 `observed` → 验收不通过。只信记录会把这谎报成成功。
 *
 * @param deployment 要回读的部署记录(以它的 steps 为要回读的资源清单)。
 * @param spec 该部署基于的场景声明(提供每条资源的 kind)。
 */
export async function readbackScene(deployment: SceneDeployment, spec: SceneSpec): Promise<SceneReadbackResult> {
  const kindById = new Map<string, SceneResourceKind>(spec.resources.map((r) => [r.id, r.kind] as const));
  const steps: SceneStepReadback[] = [];
  for (const step of deployment.steps) {
    const kind = kindById.get(step.actionId);
    if (kind === undefined) {
      steps.push({
        actionId: step.actionId,
        kind: "workflow",
        observed: false,
        readLabel: null,
        unverifiableReason: `部署步骤「${step.actionId}」在声明里找不到对应资源,无法回读`,
      });
      continue;
    }
    steps.push(await probeResource(step.actionId, kind));
  }
  const observed = steps.filter((s) => s.observed).map((s) => s.actionId);
  const unverifiable = steps.filter((s) => s.unverifiableReason !== null).map((s) => s.actionId);
  return { steps, observed, unverifiable };
}

/* ───────────────────────── 补偿(失败时撤销已建成资源) ───────────────────────── */

/**
 * **补偿** —— 某步失败时,把之前**已建成**(`done`)的步骤按**逆序**逐个尝试撤销
 * (MC-058 的补偿路径,「失败不留下孤儿」)。
 *
 * 逐条判据(**不静默**):
 *  - 该步声明 `compensable === false` → **不撤销**,记为 `applied:false` + 「声明不可补偿」;
 *  - 该 kind 无稳妥逆操作(`compensation.label === null`,如 skill/panel/scaffold)→ **不撤销**,
 *    记为 `applied:false` + 「无稳妥逆操作」的原因(本层**不猜**一个入口去删,免得删错);
 *  - 有逆操作 → 调 `callRpc(逆操作入口, { [arg]: actionId })`:
 *    - 成功 → 该步迁到 **`compensated`**(资源已撤,不再算 `done`),记 `applied:true`;
 *    - 抛错 → 该步**保持 `done`**(资源大概率还在,保守),记 `applied:false` + 逆操作的真实错误。
 *
 * 逆序执行:先撤最后建成的,后撤最早建成的(与建的顺序相反)。
 *
 * @returns 补偿后的新部署记录(纯推进,不改入参)。
 */
async function compensateDoneSteps(d: SceneDeployment, commands: SceneCommandPlan, clock: () => number): Promise<SceneDeployment> {
  const doneByAction = new Map(d.steps.filter((s) => s.status === "done").map((s) => [s.actionId, s] as const));
  // 逆序:先撤最后建成的。
  for (const command of [...commands.commands].reverse()) {
    if (!doneByAction.has(command.actionId)) continue;
    const kind = command.kind;
    const entry = serviceForKind(kind).compensation;

    if (!command.compensable) {
      d = advanceDeployment(d, {
        actionId: command.actionId,
        status: "done",
        compensation: { applied: false, inverseLabel: null, reason: "该步声明为不可补偿(compensable=false),失败时按设计不撤销,请人工核对" },
      }, clock());
      continue;
    }
    if (entry.label === null || entry.arg === null) {
      d = advanceDeployment(d, {
        actionId: command.actionId,
        status: "done",
        compensation: { applied: false, inverseLabel: null, reason: `该 kind 无稳妥逆操作,未撤销:${entry.note}` },
      }, clock());
      continue;
    }

    try {
      const inv = findEntry(entry.label);
      if (!inv) throw new Error(`逆操作入口「${entry.label}」在当前版本里没有注册`);
      await callRpc(inv, { [entry.arg]: command.actionId });
      d = advanceDeployment(d, {
        actionId: command.actionId,
        status: "compensated",
        compensation: { applied: true, inverseLabel: entry.label, reason: `已用 ${entry.label} 撤销「${command.actionId}」` },
      }, clock());
    } catch (err) {
      d = advanceDeployment(d, {
        actionId: command.actionId,
        status: "done",
        compensation: { applied: false, inverseLabel: entry.label, reason: `逆操作 ${entry.label} 执行失败,资源可能仍存在:${(err as Error).message}` },
      }, clock());
    }
  }
  return d;
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
 *  5b. **补偿**(`compensateOnFailure` 缺省 true,且有步失败):逆序对之前已建成、`compensable` 的步
 *     调逆操作撤销(见 {@link compensateDoneSteps}),逐条不静默,落盘;
 *  6. `readbackScene` **独立回读**宿主真实资源 → `evaluateAcceptance`(observed 取自实际回读,
 *     **不是**记录里 done 的步),写入验收结果 → 落盘。
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

  const doCompensate = input.compensateOnFailure ?? true;
  let anyFailed = false;

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
      anyFailed = true;
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
      anyFailed = true;
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
      anyFailed = true;
    }
    persistStep(d);
  }

  // ⑤b 补偿(MC-058):有步失败且开启补偿 → 逆序撤销之前已建成、可补偿的步,不让失败留下孤儿。
  //     补偿结果写进各步的 `compensation`(成功撤销的步迁到 `compensated`),逐条不静默。
  if (anyFailed && doCompensate) {
    d = await compensateDoneSteps(d, commands, clock);
    persistStep(d);
  }

  // ⑥ 收尾验收:**独立回读**宿主真实资源(MC-058 点名的缺口)—— observed 取自 `readbackScene`
  //     的实际查询结果,**不是**「记录里走到 done 的步」。资源被带外删掉 / 补偿撤销后 → 查不到。
  const readback = await readbackScene(d, spec);
  d = evaluateAcceptance(d, spec.acceptance.expectResourceIds, readback.observed, clock());
  persistStep(d);

  return { ok: true, kind: "applied", deployment: d, readback };
}

/** 逐步落盘 —— durable 写。失败如实记警告,不假报成功(记录以调用方拿到的内存 `d` 为准)。 */
function persistStep(d: SceneDeployment): void {
  if (!saveDeployment(d, { durable: true })) {
    log.warn(`scene deploy ${d.deploymentId}: 步骤「${d.steps.map((s) => s.status).join(",")}」的 durable 落盘失败,本次以内存记录为准`);
  }
}
