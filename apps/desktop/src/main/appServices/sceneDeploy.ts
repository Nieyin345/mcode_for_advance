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
 *  - **失败补偿**({@link compensateDoneSteps}):中途某步失败时,**逆序**对之前已建成、**本次新建**
 *    且声明 `compensable` 的步调**逆操作**撤销其资源(该步迁到 `compensated`),不让失败的部署留
 *    下孤儿。**补偿安全闸**:派发前先探测目标资源是**本次新建**(`created`)还是**覆盖了既有资源**
 *    (`preExisting`)—— **只撤本次新建的**;覆盖既有的 / 探测未知的**绝不删除**(`workflow.save`
 *    的 id 是主键,盲目补偿会把用户原有工作流整个删掉)。建成后又被别的写者改过(修订号变)也
 *    **不删**(CAS)。不可补偿 / 无稳妥逆操作 / 逆操作失败 / **既有资源不删** → **保持 `done` 但
 *    如实记一条 `compensation`**(`applied:false` + 人读原因),**绝不静默**(硬规矩 3),也绝不
 *    猜一个入口去删(免得删错东西)。
 *
 * ## 崩溃续跑(resume 入口,MC-058 残余已补)
 *
 * `applyScene` 每一步都 `saveDeployment({durable:true})`,所以一份**部分执行**的部署记录真的在盘上。
 * {@link resumeScene} 是**读它、跳过已 `done` 的步、只跑剩下的**入口(不是从头再跑一遍 —— 那会把已
 * 建成的步再派发一次,即重复的外部副作用)。判据:读回记录(读不到 → `no_record`)、plan digest 必须
 * 与盘上那份**一致**(改了 → `resume_plan_changed`,绝不把新计划套到旧记录上)、授权走**同一份**判定核
 * (不因「是 resume」放宽)。已 `done` 的步不重跑;`failed`/`pending`/`compensated` 的步重试
 * (`compensated` 的资源已被撤销,必须重建 —— 见 {@link resumeScene} 的说明)。执行核与 `applyScene`
 * **共用**(`runPlanSteps`),不长第二套。
 *
 * ## 这一层**不做**什么(MC-058 仍未关闭的部分,如实列出)
 *
 *  - **授权签发端未接**:本层只**消费**一枚计划级授权(校验它是否绑定本计划并放行)。**谁**在
 *    用户点头后为场景签出这枚 `scene.apply` 授权(ARC-004 的签发口目前只签 `app_api_call` 的单方法
 *    指纹授权),是**下一片** —— 在那之前,本层的真实调用方必须先持有一枚绑定本计划的用户授权,
 *    否则一律拒绝。**这是有意的缺口,不是静默放行。**
 *  - **回读入口已逐个按真实契约钉死身份**(MC-058 残余②已补):回读与补偿都用该资源在**它自己的
 *    服务**里的稳定身份({@link sceneResourceIdentity},按 kind 的 `identityPath` 从声明正文取
 *    —— workflow/automation→`doc.id`、skill/mcp→`name`、hook→`id`、module→`manifest.id`),**不是**
 *    场景内的资源 id。**声明里推不出稳定身份**的 kind(plugin / panel / scaffold:`identityPath`
 *    为 null)回读时**如实记 `unverifiable`**,绝不拿一个永远匹配不上的值假装回读过了。`resourceUid`
 *    随之落进部署步骤(有稳定身份的服务才落)。
 *  - **补偿未覆盖 plugin/panel/scaffold**:plugin 仍 needsResolution(不执行,无建成可撤;且插件名
 *    来自插件 manifest,声明时未知);panel / scaffold 无撤销入口,如实记未补偿。skill 亦无稳妥逆
 *    操作(需 `source`)。
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
  sceneResourceIdentity,
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
  type SceneStepPriorExistence,
  type SceneStepStatus,
} from "@contracts/sceneDeployment";
import type { Grant } from "@contracts/policyEngine";
import { evaluate, scenePlanCoreIntent } from "@main/appControl/policyEngine.js";
import { getGrantStore } from "@main/appControl/grantStoreRuntime.js";
import { callRpc, findEntry } from "@main/appControl/tools.js";
import {
  readbackScene,
  probeExistingResource,
  type SceneStepReadback,
  type SceneReadbackResult,
} from "./sceneReadback.js";
export { readbackScene } from "./sceneReadback.js";
// ★ 业务结果判定(MC-058)—— 与 `app_api_call` 的 `invokeAppTool` 复用**同一份**结果解码器
//   (硬规矩 2:判定只有一份)。RPC resolve ≠ 业务成功:若干 IPC 合法返回 `{ok:false,error}`
//   表达业务拒绝,不抛异常 —— 不检查它,一步被拒也会被记成 done(洞)。
import { decodeDomainOutcome, type DomainOutcome } from "@main/appControl/commandOutcome.js";
import { log } from "@main/lib/logger.js";
import { loadDeployment, readDeploymentOutcome, saveDeployment } from "./sceneDeploymentStore.js";

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
  /**
   * 载荷**投影**失败的问题(声明缺该服务真实入参的必需字段 / 未知 kind);空 = 投影成功。
   * 与 `needsResolution` 分开:那是「入口不定」,这是「入口定了但声明填不全」—— 两类都不会跑,但原因不同。
   */
  payloadProblems: Array<{ path: string; message: string }>;
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
    let willRun = true;
    let reason: string | null = null;
    if (c.service.needsResolution) {
      willRun = false;
      reason = `需要先按「${c.service.resolutionHint ?? "资源声明"}」进一步决议才能选定服务入口,本层不猜入口、不执行`;
    } else if (c.rpcInput === null) {
      // 入口定了,但声明填不全该服务真实入参的必需字段 → 派发会在真实 Schema.parse 处被拒。
      // 与其跑一个必然失败的命令,不如**明确说这一步不会跑**并给出缺什么(不静默)。
      willRun = false;
      reason = `声明缺该服务真实入参的必需字段,无法投影成可派发的 RPC 入参(本层不派发半成品):${c.payloadProblems.map((p) => `${p.path ? `${p.path}:` : ""}${p.message}`).join("; ")}`;
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
      payloadProblems: c.payloadProblems.map((p) => ({ ...p })),
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
  code:
    | "not_user"
    | "revoked"
    | "expired"
    | "method_not_allowed"
    | "plan_mismatch"
    | "no_grant"
    /** 部署存档的**初始那一笔** durable 落盘失败 —— 建了也记不住,故不建(MC-058)。 */
    | "archive_not_durable"
    /** 存档读取失败，而非记录真正不存在；应显示可恢复的存储故障。 */
    | "archive_read_failed"
    /** 存档行存在但 payload 损坏，绝不能当不存在而诱导新部署覆盖。 */
    | "archive_corrupt"
    /** 崩溃续跑时盘上**没有**这份部署记录 —— 无从续跑,需作为一次全新部署重新预览批准(MC-058 残余)。 */
    | "no_record"
    /**
     * 崩溃续跑时本次声明编译出的计划 digest 与**盘上那份记录**不一致 —— 声明在崩溃后被改过,
     * 拒绝把新计划套到旧记录上续跑(MC-058 残余)。这与授权绑计划 digest 是**两条独立**判定。
     */
    | "resume_plan_changed";
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

/**
 * 把 {@link decodeDomainOutcome} 的领域判定翻成这一步的**失败文案**(REJECTED / UNCERTAIN 分得开,
 * 硬规矩 3:坏东西显式报出来)。
 *
 * 判据只有「业务是否接受」一条,由**共享解码器**给(与 `app_api_call` 的 `invokeAppTool` 同源,
 * 硬规矩 2:判定只有一份)。**只有 `accepted` 才算这一步没失败** —— 凡是业务层拒绝 / 无法确认的,
 * 都算这一步**没建成资源**:
 *
 *  - `rejected`(服务合法返回 `{ok:false,error}` 且语义是「没执行」,如 `workflow.save` 结构化校验不过)
 *    —— 命令未执行、无资源建成 → 如实记「明确拒绝」;
 *  - `partial`(ok:false 可能已部分提交,如 `mcp.save` 写了一半回滚也失败)—— 无法确认是否落定 →
 *    如实记「可能已部分提交,重试前先查真实状态」。
 *
 * 两种都让调用方把该步记 **`failed`**(不是 `done`),部署随之落 `partial` / `failed`(不是
 * `active`),验收也不会被当成「这一步建成了」。
 */
function failureTextFromOutcome(method: string, outcome: Exclude<DomainOutcome, { kind: "accepted" }>): string {
  if (outcome.kind === "rejected") {
    return `服务「${method}」业务层**明确拒绝**了这一步(命令未执行,无资源建成):${outcome.reason}`;
  }
  return `服务「${method}」的结果**无法确认是否已落定**(可能已部分提交,重试前先查真实状态):${outcome.reason}`;
}


/* ───────────────────────── 补偿(失败时撤销已建成资源) ───────────────────────── */

/**
 * **补偿** —— 某步失败时,把之前**本次新建**(`done` 且派发前探测为 `created`)的步骤按**逆序**
 * 逐个尝试撤销(MC-058 的补偿路径,「失败不留下孤儿」)。
 *
 * ## 补偿安全闸:只撤**本次新建**的,绝不误删既有资源(MC-058 点名的危险)
 *
 * `workflow.save` 的 `id` 是**主键** —— 往一个已存在的 id 存就是**覆盖**它(内置工作流也能被覆盖,
 * 见 `ipc/workflow.ts`)。若补偿盲目对之前走到 `done` 的步全调 `workflow.remove({id})`,那么一次
 * **覆盖了用户原有 `wf` 之后失败**的部署,会在补偿时**把用户那条工作流整个删掉** —— 覆盖已经毁了
 * 一份,补偿再补一刀,用户数据就没了。故本函数**只撤派发前探测为 `created`(本次新建)**的步:
 *
 *  - 该步派发前 **`preExisting`**(覆盖了既有资源)→ **不删除**,记 `applied:false` + 「覆盖了部署前
 *    已存在的资源,不删除(免得毁掉用户原有数据)」——**覆盖已经毁了原内容,删除只会雪上加霜**;
 *  - 该步派发前 **`unknown`**(探测不可用)→ **不删除**,记 `applied:false` + 「为免误删保守不撤销」;
 *  - 只有 **`created`** 才继续走下面「有没有稳妥逆操作」的判定。
 *
 * ## CAS:建成本次新建的资源后又被别的写者改过 → 也不删
 *
 * 即便某步是 `created`,若它建成后**回读到的修订号**(`createdRevision`)与**补偿时**再查到的修
 * 订号不一致,说明建成后**被别的写者改过** —— 那时删除会毁掉别人的改动,故**不删除**,记
 * `applied:false` + 「建成后已被改动」。修订号拿不到(该 kind 回读入口不给)时跳过这道 CAS
 * (仅凭「本次新建」仍可撤)。
 *
 * ## 其余逐条判据(**不静默**)
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
    const step = doneByAction.get(command.actionId);
    if (step === undefined) continue;
    const kind = command.kind;
    const entry = serviceForKind(kind).compensation;

    // ① 补偿安全闸(MC-058 危险):**只撤本次新建的资源**。覆盖既有 / 探测未知 → 绝不删除。
    if (step.priorExistence !== "created") {
      const reason =
        step.priorExistence === "preExisting"
          ? "该步**覆盖了部署前已存在的资源**(同 id 主键),补偿**不删除**它 —— 删除会毁掉用户原有数据;被覆盖的原有内容需人工核对 / 恢复"
          : "派发前探测不到该资源是否本次新建(无回读入口 / 入口未注册 / 查询出错),为免误删,**保守不撤销**,请人工核对";
      d = advanceDeployment(d, {
        actionId: command.actionId,
        status: "done",
        compensation: { applied: false, inverseLabel: null, reason },
      }, clock());
      continue;
    }

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

    // ★ 按真实契约钉死身份(MC-058 残余②③):撤销用的是该资源在**它自己的服务**里的稳定身份
    //   (workflow→doc.id、mcp→name、hook→id、module→manifest.id),不是场景内的资源 id。
    //   声明里推不出稳定身份 → 不撤(记 applied:false + 原因),绝不拿场景 id 冒充服务身份去删
    //   —— 那要么删不掉、要么删错。
    const identity = sceneResourceIdentity(kind, command.payload);
    if (identity === null) {
      d = advanceDeployment(d, {
        actionId: command.actionId,
        status: "done",
        compensation: {
          applied: false,
          inverseLabel: null,
          reason:
            serviceForKind(kind).identityPath === null
              ? `该 kind「${kind}」的声明里没有可从声明推出的稳定身份,无从按服务身份撤销,保守不撤销,请人工核对`
              : `声明正文里缺稳定身份字段「${serviceForKind(kind).identityPath}」,无从定位要撤销的真实资源,保守不撤销,请人工核对`,
        },
      }, clock());
      continue;
    }

    // ② CAS:建成后又被别的写者改过 → 不删(删了会毁掉别人的改动)。
    if (step.createdRevision != null) {
      const now = await probeExistingResource(kind, command.payload);
      if (now.existence === "preExisting" && now.revision !== null && now.revision !== step.createdRevision) {
        d = advanceDeployment(d, {
          actionId: command.actionId,
          status: "done",
          compensation: {
            applied: false,
            inverseLabel: entry.label,
            reason: `该步本次新建,但建成后资源已被**改动**(修订号 ${step.createdRevision} → ${now.revision}),补偿**不删除**,以免毁掉后来的改动;请人工核对`,
          },
        }, clock());
        continue;
      }
    }

    try {
      const inv = findEntry(entry.label);
      if (!inv) throw new Error(`逆操作入口「${entry.label}」在当前版本里没有注册`);
      await callRpc(inv, { [entry.arg]: identity });
      d = advanceDeployment(d, {
        actionId: command.actionId,
        status: "compensated",
        compensation: { applied: true, inverseLabel: entry.label, reason: `已用 ${entry.label} 撤销本次新建的「${identity}」` },
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

  // ④ 建记录 + 初始落盘。**初始那一笔落不下去就不开工** —— 见下面 `persistStep` 的第一个参数。
  // 【MC-002】把**声明本身**随部署记录一起落盘:重启后渲染端没有任何别处能拿到当初那份
  // spec(`deploymentId` 只在它内存里)。快照的 digest 与 plan.specDigest 同源,读侧会复核。
  const d = createDeployment({
    deploymentId: input.deploymentId, plan, actor: input.actor, now: clock(),
    specSnapshot: { spec, specDigest: plan.specDigest },
  });
  if (!persistStepOrRefuse(d)) {
    // 「存档都写不进去还照样建资源」= 建完就没人记得建过什么,崩溃后无法回读、无法补偿。
    // 这与「没有授权绝不执行」是同一条纪律:治理事实落不了地,就不执行。
    const reason = `部署存档无法 durable 落盘(${input.deploymentId}),为避免建完资源却无记录可回读 / 无补偿依据,本次不执行任何一步。请检查磁盘空间与数据目录可写性后重试。`;
    log.warn(`scene deploy ${input.deploymentId}: ${reason}`);
    return { ok: false, kind: "refused", refusal: { code: "archive_not_durable", reason } };
  }

  // ⑤ 逐条命令 + ⑤b 补偿 + ⑥ 收尾验收(与 `resumeScene` **共用**同一条执行核 `runPlanSteps` /
  //     `finishDeployment` —— 硬规矩 2:执行判据只有一份,绝不为 resume 再长一套)。
  const d2 = await runPlanSteps(d, commands, clock, input.compensateOnFailure ?? true);
  return finishDeployment(d2, spec, clock);
}

/**
 * **按计划拓扑序执行尚未建成的步** —— `applyScene`(全新部署,起点全 `pending`)与
 * {@link resumeScene}(崩溃续跑,起点含已 `done` 的步)**共用**的同一条执行核。
 *
 * ## ★ 跳过已 `done` 的步(MC-058 残余:崩溃续跑的 resume 入口)
 *
 * 盘上那份部署记录里**已 `done`** 的步**不重跑** —— 重跑就是**重复的外部副作用**(再 `callRpc` 一次
 * `workflow.save` / `hooks.save` …)。本函数对每一步先查它在记录里的当前状态,`done` 的直接 `continue`
 * (既不派发、也不改它的记录)。于是「续跑」只跑剩下的,而不是从头再来一遍。全新部署的起点全是
 * `pending`,这一条对它是空操作(不改变原行为)。
 *
 * `failed` / `pending`(以及 `compensated`,见 {@link resumeScene})都**不是** `done` → 照常走下面
 * 的重试路径(重建资源)。
 *
 * 逐条判据与落盘时机见 {@link applyScene} 的说明(依赖闸 / needsResolution / 载荷投影 / 派发前探测 /
 * 业务结果解码 / 建成后 CAS 回读),这里一字不差地复用。
 *
 * @param d 起始记录(全新部署给全 `pending` 的记录;续跑给盘上读回的记录)。
 * @param commands 该计划的命令集(顺序取自计划,不重排)。
 * @param clock 可注入时钟。
 * @param doCompensate 有步失败时是否补偿(见 {@link SceneApplyInput.compensateOnFailure})。
 */
async function runPlanSteps(
  d: SceneDeployment,
  commands: SceneCommandPlan,
  clock: () => number,
  doCompensate: boolean,
): Promise<SceneDeployment> {
  let anyFailed = false;

  // 逐条命令,按计划拓扑序(依赖必先于被依赖者,故到某步时它的依赖都已处理完)。
  for (const command of commands.commands) {
    // ★ 已建成的步**跳过重跑**(MC-058 残余)—— 不派发、不改记录。`compensated` 不在此列:它的
    //   资源已被撤销,记录不是 `done`,下面照常重试(重建)。
    if (stepStatusOf(d, command.actionId) === "done") continue;

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

    // 载荷投影失败(声明缺该服务真实入参的必需字段 / 未知 kind)→ 不派发半成品,如实记「未执行」。
    // MC-058 点名的缺陷正是这里:过去把声明逐字当入参派发,必然在真实 Schema.parse 处被拒。
    if (command.rpcInput === null) {
      d = advanceDeployment(
        d,
        {
          actionId: command.actionId,
          status: "failed",
          error: `声明缺该服务「${command.service.serviceLabel ?? "(无)"}」真实入参的必需字段,无法投影成可派发的 RPC 入参,本次未执行(不派发半成品):${command.payloadProblems.map((p) => `${p.path ? `${p.path}:` : ""}${p.message}`).join("; ")}`,
        },
        clock(),
      );
      persistStep(d);
      anyFailed = true;
      continue;
    }

    // 派发前探测(MC-058 补偿安全闸):目标资源是**本次新建**还是**覆盖既有**?只有本次新建的
    // 才敢在补偿时撤销 —— 往一个已存在的 id 存就是**覆盖**它(workflow.save 的 id 是主键),
    // 盲目补偿会把用户原有资源整个删掉。探测不可用一律记 `unknown`(绝不猜成 created)。
    // 探测用**服务侧稳定身份**(见 `sceneResourceIdentity`),不是场景 id;探测到的 uid 落进
    // 部署记录的 `resourceUid`(补偿按它撤真实资源)。
    const prior = await probeExistingResource(command.kind, command.payload);

    // 派发:running → 落盘 → callRpc(既有服务)→ done/failed → 落盘。
    d = advanceDeployment(d, {
      actionId: command.actionId,
      status: "running",
      priorExistence: prior.existence,
      priorRevision: prior.revision,
      ...(prior.uid !== null ? { resourceUid: prior.uid } : {}),
    }, clock());
    persistStep(d);

    const label = command.service.serviceLabel;
    try {
      const entry = label === null ? undefined : findEntry(label);
      if (!entry) {
        throw new Error(`服务入口「${label ?? "(无)"}」在当前版本里没有注册`);
      }
      // 与 `app_api_call` **同一条**通路:同一批 handler、同一份授权判定核。这里直连 `callRpc`
      // (不经逐次审批卡)—— 计划级授权**就是**覆盖整个计划的授权(见文件头)。
      // ★ 派发的是**投影后的真实 RPC 入参**(`rpcInput`,已过该服务的真实 schema),不是声明正文
      //   `payload` —— 后者是记账/digest 的真相,形状与下游入参不是一回事(MC-058)。
      const result = await callRpc(entry, command.rpcInput);
      // ★★ MC-058 点名的缺陷:**RPC resolve ≠ 业务成功**。若干既有服务(如 `workflow.save`
      //    结构化校验不过 / `mcp.save` 同名已存在)合法返回 `{ok:false,error}` 而非抛异常 ——
      //    从前只要没抛就记 `done`(还据此报 `acceptancePassed:true`)。这里用**共享**解码器
      //    `decodeDomainOutcome` 判业务到底成没成(与 `app_api_call` 的 `invokeAppTool` 同源,
      //    硬规矩 2):`accepted` = 这一步真被服务接受;`rejected` / `partial` = 没建成资源,
      //    如实把该步记 `failed`(带服务的真实错误),部署随之落 `partial` / `failed`,验收也不
      //    会被当成「这一步建成了」。
      if (label !== null) {
        const outcome = decodeDomainOutcome(label, result);
        if (outcome.kind !== "accepted") {
          throw new Error(failureTextFromOutcome(label, outcome));
        }
      }
      // 建成后**再回读一次**修订号,作为补偿时的 CAS 判据(建成后又被别的写者改过 → 不删)。
      const after = await probeExistingResource(command.kind, command.payload);
      d = advanceDeployment(d, {
        actionId: command.actionId,
        status: "done",
        createdRevision: after.revision,
        ...(after.uid !== null ? { resourceUid: after.uid } : {}),
      }, clock());
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

  // 补偿(MC-058):有步失败且开启补偿 → 逆序撤销之前已建成、可补偿的步,不让失败留下孤儿。
  // 补偿结果写进各步的 `compensation`(成功撤销的步迁到 `compensated`),逐条不静默。
  if (anyFailed && doCompensate) {
    d = await compensateDoneSteps(d, commands, clock);
    persistStep(d);
  }

  return d;
}

/**
 * **收尾验收** —— 独立回读宿主真实资源(MC-058 点名的缺口)并写进记录。`applyScene` / `resumeScene`
 * 共用:`observed` 取自 {@link readbackScene} 的**实际查询结果**,不是「记录里走到 done 的步」——
 * 资源被带外删掉 / 补偿撤销后 → 查不到。
 */
async function finishDeployment(
  d: SceneDeployment,
  spec: SceneSpec,
  clock: () => number,
): Promise<SceneApplyResult> {
  const readback = await readbackScene(d, spec);
  const d2 = evaluateAcceptance(d, spec.acceptance.expectResourceIds, readback.observed, clock());
  persistStep(d2);
  return { ok: true, kind: "applied", deployment: d2, readback };
}

/**
 * 逐步落盘 —— durable 写。失败如实记警告,**不假报成功**(记录以调用方拿到的内存 `d` 为准)。
 *
 * ⚠️ **开跑前那一笔(初始 `deploying`)走的是 {@link persistStepOrRefuse}** —— 那一笔落不下去
 * 就整个不执行(见调用点)。中途某一笔落不下去不中止:那一步的**真实结果**已经在内存 `d` 里,
 * 中止反而会让「已建成的资源」没有任何记录。返回 `false` 只表示「这一笔没落盘」,由调用方决定。
 */
function persistStep(d: SceneDeployment): void {
  if (!saveDeployment(d, { durable: true })) {
    log.warn(`scene deploy ${d.deploymentId}: 步骤「${d.steps.map((s) => s.status).join(",")}」的 durable 落盘失败,本次以内存记录为准`);
  }
}

/**
 * 开跑前的**第一笔** durable 落盘 —— 返回值直接决定「要不要开工」。
 * 这是 MC-058 点名的那条缺口:从前初始那一笔落不下去也只是 `log.warn` 然后照常执行,
 * 于是「存档 durable 失败仍可能执行」,建出来的资源没有任何可回读的凭据。
 */
function persistStepOrRefuse(d: SceneDeployment): boolean {
  if (saveDeployment(d, { durable: true })) return true;
  log.warn(`scene deploy ${d.deploymentId}: 初始存档 durable 落盘失败,拒绝开工(不建任何资源)`);
  return false;
}


/* ───────────────────────── MC-058:用户签发 + 正式部署入口 ───────────────────────── */

/**
 * 一次 `scene.apply` 授权的**默认有效期**。10 分钟:用户在预览页点「批准」到真正点「部署」之间,
 * 通常就是几分钟 —— 够用,又不至于一枚授权在盘上躺一整天(那是「批准的对象还是这一份计划吗」
 * 这个问题随时间失去意义的坏味道)。到期即回到「没有可用授权」,重新预览批准。
 */
const SCENE_APPLY_GRANT_TTL_MS = 10 * 60 * 1000;

/** 审批结果 —— 三态,调用方不必解析人读文案(与 `@contracts/ipc/scene.js` 同形)。 */
export type SceneApprovalOutcome =
  | { ok: true; kind: "granted"; grantId: string; expiresAt: number }
  | { ok: false; kind: "refused"; reason: string }
  | { ok: false; kind: "invalid"; problems: SceneSpecProblem[] };

/**
 * **用户签发一枚计划级授权**(MC-058 的执行端入口的前一半)。
 *
 * ## 为什么必须由宿主重编译、并且与调用方递进来的 digest 对账
 *
 * 渲染端只该说「我批准的是这份 spec,我看到它的计划摘要是 X」。宿主**不信**这个 X —— 它自己
 * `validateSceneSpec` + `compileScenePlan` 重算一遍,拿**真实** digest 与 X 比:
 *  - 不同 → 拒签(「批准的那份」与「要跑的那份」不是同一份,可能是 TOCTOU 或前端 bug);
 *  - 相同 → 才用 `GrantStore.issueGrant` 签一枚 `scopedCore = scenePlanCoreIntent(plan)` 的授权。
 *
 * 于是「批准的对象是**这一份计划**」这件事在数据上是可判定的(ARC-004),而签发口仍然只有一个
 * (`GrantStore.issueGrant`),它自己还会拒掉:非用户签发、deny 判定、空动作表、非正有效期。
 *
 * @param input.spec        候选声明(与 `scene.plan` 收到的是同一份)。
 * @param input.planDigest  调用方声称的、它批准的那份计划的摘要 —— 用来对账。
 * @param input.ttlMs       授权有效期。
 * @param now               可注入时钟(缺省 `Date.now`)。
 */
export function approveSceneDeployment(
  input: { spec: unknown; planDigest: string; ttlMs: number },
  now: number = Date.now(),
): SceneApprovalOutcome {
  const validation = validateSceneSpec(input.spec);
  if (!validation.ok) return { ok: false, kind: "invalid", problems: validation.problems };
  const plan = compileScenePlan(validation.spec);
  // 对账:调用方批准的摘要必须**等于**宿主重编译得到的摘要。不等 = 偷换审批对象 → 拒签。
  if (plan.digest !== input.planDigest) {
    return {
      ok: false,
      kind: "refused",
      reason: `批准的计划摘要与当前声明编译出的计划不一致(批准 ${input.planDigest.slice(0, 12)}…,实际 ${plan.digest.slice(0, 12)}…)—— 声明在批准后可能被改过,请重新预览后再批准。`,
    };
  }
  const decision = {
    verdict: "allow" as const,
    reason: "用户在场景预览页本人批准了这一份计划。",
    compatibilityLevel: "write" as const,
    sceneId: plan.sceneId,
    allowedActions: [SCENE_APPLY_METHOD],
    // ★ 绑的是**计划 digest** —— spec 在批准后被改一个字节,重编译 digest 就变,这枚授权立即失效。
    scopedCore: scenePlanCoreIntent(plan),
    configHash: "",
    ttlMs: input.ttlMs,
  };
  // 签发主体**由宿主写死为「用户本人」** —— 调用方(渲染端)给不了、也改不了这个身份。
  // agent 侧这条通道在契约层就 null 掉了(见 ipc/scene.ts 与 policy.ts),够不到这里。
  try {
    const grant = getGrantStore().issueGrant(decision, { kind: "user", id: "scene.approval" }, now);
    return { ok: true, kind: "granted", grantId: grant.grantId, expiresAt: grant.expiresAt };
  } catch (err) {
    return { ok: false, kind: "refused", reason: (err as Error).message };
  }
}

/**
 * **正式部署入口** —— 把「按 `grantId` 取回授权」和「执行」接起来(MC-058 的另一半)。
 *
 * ## 为什么入参只给 `grantId`,不给授权内容
 *
 * 授权是**治理事实**,只能由宿主产生(ARC-004:ActionContext 不可让 Agent 模型参数填写)。
 * 如果这个入口收一份「grant 对象」,调用方就能自己拼一份 `{approvalSource:{kind:'user'}, revoked:false,
 * expiresAt: 很大, scopedCore:{scenePlan: 任意}}` —— 授权判定整个被绕过。所以这里只收一个 id:
 * 宿主用 `GrantStore` **取回**那枚授权(**含失效态**,`findBoundFor`/`get` 会把已撤销/已过期的也交出来),
 * 再原样交给 `applyScene` 的 `authorizeApply` → `policyEngine.evaluate` 去判。已撤销 → `deny`;
 * 绑的是另一份计划 → `require-approval`(被 `authorizeApply` 翻成 `refused`)。
 *
 * ## 找不到 id 时
 *
 * **不留后门**:取不到 → 返回 `refused` 且**不建部署记录、不执行任何一步**。这与「没有授权绝不执行」
 * 是同一条纪律,不是「退化到默认放行」。
 *
 * @param input.deploymentId 一次部署的稳定 id(重试是同一 id 的覆盖)。
 * @param input.grantId      上一次 {@link approveSceneDeployment} 签出的授权 id。
 * @param input.spec         候选声明(执行前会重新校验重编译)。
 * @param input.actor        发起者身份(进部署记录;不参与授权判定 —— 判定看的是 grant)。
 */
export async function applySceneWithGrant(input: {
  deploymentId: string;
  grantId: string;
  spec: unknown;
  actor: SceneDeploymentActor;
  compensateOnFailure?: boolean;
  now?: () => number;
}): Promise<SceneApplyResult> {
  const clock = input.now ?? Date.now;
  // 校验先做一次 —— 不合法的 spec 连授权都不必查(报「哪里不合法」比「没授权」有用得多)。
  const validation = validateSceneSpec(input.spec);
  if (!validation.ok) return { ok: false, kind: "invalid", problems: validation.problems };

  // 取回授权(**含失效态**)。取不到 = 没有可供判定的治理事实 → 明确拒绝,不静默放行。
  const plan = compileScenePlan(validation.spec);
  const intent = { method: SCENE_APPLY_METHOD, core: scenePlanCoreIntent(plan) };
  const grant = getGrantStore().findBoundFor(intent, clock());
  if (grant === null || grant.grantId !== input.grantId) {
    log.warn(`scene deploy ${input.deploymentId}: 授权 ${input.grantId} 取不到(不存在 / 与本次计划不匹配),拒绝执行`);
    return {
      ok: false,
      kind: "refused",
      refusal: {
        code: "no_grant",
        reason: `授权「${input.grantId}」不存在,或它绑的不是这一次要跑的计划 —— 需要重新预览并批准。`,
      },
    };
  }

  return applyScene({
    deploymentId: input.deploymentId,
    spec: input.spec,
    actor: input.actor,
    grant,
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.compensateOnFailure !== undefined ? { compensateOnFailure: input.compensateOnFailure } : {}),
  });
}

/* ───────────────────────── MC-058 残余:崩溃续跑的 resume 入口 ───────────────────────── */

/** `resumeScene` 的入参 —— 与 {@link SceneApplyInput} 同形,但**不**新建记录:起点是盘上那份。 */
export interface SceneResumeInput {
  /** 要续跑的那次部署的 id(盘上那份记录的键)。 */
  deploymentId: string;
  /** 该部署基于的声明(与原来那次是**同一份** —— digest 变了会被拒,见 {@link resumeScene})。 */
  spec: unknown;
  /** 谁续跑的(进本次执行的授权判定;记录里的 actor 保持原样不被改)。 */
  actor: SceneDeploymentActor;
  /** 计划级授权 —— 与 {@link applyScene} **同一份**判定核,**不因「是 resume」放宽**。 */
  grant: Grant;
  /** 可注入时钟(缺省 `Date.now`)。 */
  now?: () => number;
  /** 续跑中某步仍失败时是否补偿(缺省 `true`,与 {@link applyScene} 同取向)。 */
  compensateOnFailure?: boolean;
}

/**
 * **崩溃续跑的 resume 入口**(MC-058 的残余项)—— 把盘上那份**部分执行**的部署记录读完,
 * **跳过已建成的步**、只跑剩下的。
 *
 * ## 它补的洞
 *
 * `applyScene` 每一步都 `saveDeployment({durable:true})`,所以崩溃后盘上**真的**留着一份「哪几步
 * 走到了 `done`、哪几步 `failed`」的记录 —— 但此前**没有任何入口**能把它读完只跑剩下的:唯一的执行
 * 入口 `applyScene` 是「从全 `pending` 重新开始」,拿它续跑会把**已建成的步再派发一次**(重复的
 * 外部副作用 —— 再 `callRpc` 一次 `workflow.save` / 装一次钩子),这正是本项要防的。
 *
 * ## 判据(「跳过已建成、只跑剩下的」,不是「从头再来一遍」)
 *
 *  1. **读回**盘上的部署记录({@link loadDeployment});读不到(没这条 / 解码失败)→ 拒绝
 *     (`no_record`,需作为一次全新部署重新预览批准 —— **不**静默当成新部署去建)。
 *  2. **plan digest 必须与盘上那份一致**:本次声明重编译出的 `plan.digest` 与记录里的
 *     `planDigest` 不等 → 拒绝(`resume_plan_changed`)。**声明在崩溃后被改过就拒绝续跑** ——
 *     绝不把新计划套到旧记录上(那会让「哪些步已建成」的记录与新计划对不上,续跑出的部署是两半
 *     拼的)。这与授权绑计划 digest 是**两条独立**判定:授权管「这次该不该跑」,这条管「续跑的是
 *     不是盘上那个计划」。
 *  3. **授权走同一份判定核**({@link authorizeApply} → `policyEngine.evaluate`)—— 与
 *     {@link applyScene} **一字不差**,绝不因为「是 resume」就放宽(已撤销 / 过期 / 非用户签发 /
 *     绑另一份计划 → 一律拒绝,一步都不跑)。
 *  4. **逐步执行**交给与 `applyScene` **共用**的执行核 {@link runPlanSteps}:它对每一步先查记录,
 *     **已 `done` 的步直接跳过**(不派发、不改记录),`failed` / `pending` 的步照常重试。
 *
 * ## `compensated` 的步:续跑时**重试(重建)**,不跳过
 *
 * `compensated` 表示该步**本已成功建成,但后续某步失败触发了补偿,它的资源已被逆操作撤销** ——
 * 资源**当下已不在**。故续跑时它与 `pending` / `failed` 同类:**必须重试重建**。理由:
 *  - 场景**声明**了这条资源,补偿把它撤了 ⇒ 现在场景里**缺**这条资源;跳过它,续跑结束后的部署会
 *    少建一条 —— 与 `evaluateAcceptance` 的判据(`compensated` 归入「没留下资源」)直接冲突,验收
 *    永远过不了,且用户拿到一份「说有这条、实际没有」的假记录(硬规矩 3)。
 *  - 重试**安全**:补偿只撤**本次新建**(`created`)的资源(见 {@link compensateDoneSteps} 的安全闸),
 *    所以「这条资源的由头是本次部署新建、现在已不存在」是有保证的;重建不会覆盖用户既有资源。
 *  - 执行核 {@link runPlanSteps} 判据只有「`done` 才跳过」,`compensated` 自然落进重试路径;重试时
 *    `advanceDeployment` 迁到 `running` 会**丢掉旧的 `compensation` 字段**(新记录只从 prev 继承
 *    `priorExistence` / `priorRevision` / `createdRevision`),不会把「撤销过」的痕迹错记到重建后的步上。
 *
 * ## 找不到记录 / digest 不符时
 *
 * 两者都**不留后门**:拒绝且**不执行任何一步**、**不改盘上那份记录**。拒绝码分别是 `no_record` /
 * `resume_plan_changed`(见 {@link SceneApplyRefusal})。
 */
export async function resumeScene(input: SceneResumeInput): Promise<SceneApplyResult> {
  const clock = input.now ?? Date.now;

  // ① 校验(一次报全)—— 不合法不执行任何东西。
  const validation = validateSceneSpec(input.spec);
  if (!validation.ok) return { ok: false, kind: "invalid", problems: validation.problems };
  const spec = validation.spec;

  // ② 编译计划 + 命令(与原来那次同一份 spec,digest 才对得上)。
  const plan = compileScenePlan(spec);
  const commands = compileSceneCommands(plan, spec);

  // ③ 授权判定 —— 与 applyScene **同一份**判定核,**不因「是 resume」放宽**。不放行不碰记录。
  const refusal = authorizeApply(plan, input.actor, input.grant, clock());
  if (refusal !== null) {
    log.warn(`scene resume ${input.deploymentId}: 拒绝续跑(${refusal.code})—— ${refusal.reason}`);
    return { ok: false, kind: "refused", refusal };
  }

  // ④ Read through the same decoder as ordinary loads, but retain whether
  // this row is genuinely absent or present with a corrupt payload.
  let loaded: ReturnType<typeof readDeploymentOutcome>;
  try {
    loaded = readDeploymentOutcome(input.deploymentId);
  } catch (err) {
    const reason = `部署记录「${input.deploymentId}」读取存储时出错，请检查数据文件并重试：${err instanceof Error ? err.message : String(err)}`;
    log.warn(`scene resume ${input.deploymentId}: ${reason}`);
    return { ok: false, kind: "refused", refusal: { code: "archive_read_failed", reason } };
  }
  if (loaded.kind === "corrupt") {
    const reason = `部署记录「${input.deploymentId}」仍在存储中，但内容损坏无法恢复；请保留原档并检查备份，不要把它当成全新部署覆盖。`;
    log.warn(`scene resume ${input.deploymentId}: ${reason}`);
    return { ok: false, kind: "refused", refusal: { code: "archive_corrupt", reason } };
  }
  if (loaded.kind === "missing") {
    const reason = `盘上没有部署记录「${input.deploymentId}」,无从续跑。若这是一次全新部署,请走正常预览批准流程,而不是 resume。`;
    log.warn(`scene resume ${input.deploymentId}: ${reason}`);
    return { ok: false, kind: "refused", refusal: { code: "no_record", reason } };
  }
  const record = loaded.deployment;

  // ⑤ plan digest 必须与盘上那份一致 —— 声明在崩溃后被改过就拒绝续跑(绝不把新计划套到旧记录上)。
  if (record.planDigest !== plan.digest) {
    const reason = `本次声明编译出的计划摘要(${plan.digest.slice(0, 12)}…)与盘上部署记录的不一致(记录 ${record.planDigest.slice(0, 12)}…)—— 声明在崩溃后可能被改过,拒绝把新计划套到旧记录上续跑。请重新预览并批准。`;
    log.warn(`scene resume ${input.deploymentId}: ${reason}`);
    return { ok: false, kind: "refused", refusal: { code: "resume_plan_changed", reason } };
  }

  // ⑥ 逐步执行(共用执行核):已 `done` 的步**跳过重跑**、`failed`/`pending`/`compensated` 的步重试,
  //    再收尾验收。落盘沿用同一份 `persistStep`(durable)。
  const d = await runPlanSteps(record, commands, clock, input.compensateOnFailure ?? true);
  return finishDeployment(d, spec, clock);
}

/**
 * **resume 的正式生产入口** —— 与 {@link applySceneWithGrant} 同形:只收 `grantId`,宿主自己从
 * `GrantStore` 取回那枚授权(**含失效态**)交给 {@link resumeScene} 的判定核。取不到 / 与本次计划
 * 不匹配 → 拒绝(`no_grant`),**不**执行任何一步、**不**改盘上记录。
 *
 * 为什么另开一条而不复用 `applySceneWithGrant`:那条会把「续跑的起点」当全新部署(**全 `pending`**),
 * 于是已建成的步会被**再建一次** —— 正是 resume 要防的重复副作用。这条把起点钉在**盘上那份记录**上。
 */
export async function resumeSceneWithGrant(input: {
  deploymentId: string;
  grantId: string;
  spec: unknown;
  actor: SceneDeploymentActor;
  compensateOnFailure?: boolean;
  now?: () => number;
}): Promise<SceneApplyResult> {
  const clock = input.now ?? Date.now;
  const validation = validateSceneSpec(input.spec);
  if (!validation.ok) return { ok: false, kind: "invalid", problems: validation.problems };

  const plan = compileScenePlan(validation.spec);
  const intent = { method: SCENE_APPLY_METHOD, core: scenePlanCoreIntent(plan) };
  const grant = getGrantStore().findBoundFor(intent, clock());
  if (grant === null || grant.grantId !== input.grantId) {
    log.warn(`scene resume ${input.deploymentId}: 授权 ${input.grantId} 取不到(不存在 / 与本次计划不匹配),拒绝续跑`);
    return {
      ok: false,
      kind: "refused",
      refusal: {
        code: "no_grant",
        reason: `授权「${input.grantId}」不存在,或它绑的不是这一次要续跑的计划 —— 需要重新预览并批准。`,
      },
    };
  }

  return resumeScene({
    deploymentId: input.deploymentId,
    spec: input.spec,
    actor: input.actor,
    grant,
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.compensateOnFailure !== undefined ? { compensateOnFailure: input.compensateOnFailure } : {}),
  });
}
