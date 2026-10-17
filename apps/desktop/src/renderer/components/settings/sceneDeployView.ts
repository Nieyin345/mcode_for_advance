/**
 * 场景部署面板的**视图模型 + 状态机** —— 全是纯函数,不 import React、不碰 `api`、不读 i18n
 * (`hooksView.ts` / `pluginHookGrantsView.ts` 同一条)。
 *
 * ## 为什么单拎出来
 *
 * 「粘贴一份 SceneSpec → 预览 → 批准 → 部署」这条链最容易错的地方**不在画面上**,而在
 * 三个**判据**:
 *
 *  1. **批准绑的是哪一份计划**。`scene.approve` 的对象是 `plan.digest`(计划级授权),
 *     不是 spec 正文 —— 用户改一个字节再点「部署」,重编译出的 digest 就变,那枚授权立即
 *     失效。渲染端把「用户看到的那份计划的 digest」原样递进去,是这条链的**全部要害**:
 *     递错一份(比如现算一个)就等于让用户批准了一份他从没看过的计划。
 *  2. **编辑即失效**。spec 文本一改,之前的预览与授权都作废 —— 界面必须**收回**「部署」
 *     按钮,而不是留着一枚绑旧计划的授权让用户点下去撞 `plan_mismatch`。这是一条状态迁移,
 *     埋在组件里只能靠手点排查。
 *  3. **部署只给 `grantId`**。`scene.apply` 的入参**不含授权内容**(宿主从 GrantStore 按 id
 *     取回)—— 渲染端若多带一个 `grant` 字段,等于把授权判定整个绕过。
 *
 * 这三条都是"看着点了一下、其实授错了信",拎成纯函数后 `scene-deploy-view-smoke` 能逐条钉住。
 *
 * ## 预览的两半来源(为什么既走 IPC 又本地编译)
 *
 *  - **能力缺口**只有宿主算得出(要宿主已装配的能力清单),所以走 `api.scene.preflight`;
 *  - **每一步会不会跑(`willRun` + 原因)**只依赖声明与**契约**的编译链(`validateSceneSpec`
 *    → `compileScenePlan` → `compileSceneCommands`,与主进程 `dryRunScene` **同一批契约函数**),
 *    渲染端本地就能确定性地算出来,不必过 IPC 往返。
 *
 * 两半都基于**同一份 spec**:本地编译出的 `planDigest` 与主进程重编译的**逐字节相同**(同一份
 * 确定性契约),所以本地预览的 digest 就是「用户看到的那份」,可以直接拿去签授权。
 */
import {
  validateSceneSpec,
  type SceneSpecProblem,
} from "@contracts/sceneSpec";
import { compileScenePlan } from "@contracts/scenePlan";
import { compileSceneCommands } from "@contracts/sceneCommands";
import type {
  SceneApprovalInput,
  SceneApplyInput,
  SceneResumeInput,
  SceneDeploymentWire,
  ScenePlanWire,
} from "@contracts/ipc";

/* ───────────────────────── 解析 ───────────────────────── */

/** 把粘贴的文本解析成一份候选 SceneSpec。区分「空」与「JSON 坏了」两类。 */
export type SceneSpecParse =
  | { ok: true; spec: unknown }
  | { ok: false; code: "empty" }
  | { ok: false; code: "parse"; message: string };

/**
 * 解析用户粘贴的文本。**只做 JSON 解析** —— 声明是否合法(`schemaVersion`、引用闭环…)交给
 * `validateSceneSpec`(经 {@link buildScenePreview}),那里一次报全。空文本单独成一类,
 * 让面板给出「先粘一份声明」而不是一句 JSON 解析错误。
 */
export function parseSceneSpecText(text: string): SceneSpecParse {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, code: "empty" };
  try {
    return { ok: true, spec: JSON.parse(trimmed) };
  } catch (err) {
    return { ok: false, code: "parse", message: (err as Error).message };
  }
}

/* ───────────────────────── 计划预览 ───────────────────────── */

/**
 * 一步**不会跑**的结构化原因 —— 给 i18n 渲染用,**不含用户可见的硬编码文案**(硬规矩:
 * 用户可见字符串不许硬编码;文案由渲染端从 MessageId 取)。
 * 三种 `code` 与主进程 `dryRunScene` 的静态判据**一一对应**:
 *  - `needsResolution`:该 kind 无单条确定服务入口,部署器须先决议(不猜入口);
 *  - `payloadProjection`:入口定了,但声明缺该服务真实入参的必需字段,投影不出可派发的入参;
 *  - `dependency`:依赖的某一步静态判定不会跑,故本步也不跑(拓扑传递)。
 */
export type SceneStepHoldReason =
  | { code: "needsResolution"; hint: string | null }
  | { code: "payloadProjection"; problems: Array<{ path: string; message: string }> }
  | { code: "dependency"; dependencyId: string };

/** 预览里的一步(计划步骤 + 静态「会不会跑」预判)。 */
export interface ScenePreviewStep {
  actionId: string;
  kind: string;
  order: number;
  dependsOn: string[];
  /** 映射到的既有服务标签(如 `workflow.save`);无法稳妥给出时为 `null`。 */
  serviceLabel: string | null;
  needsResolution: boolean;
  /** 静态判定这一步**会不会**被执行(纯静态,不能预知运行期失败)。 */
  willRun: boolean;
  /** 不会跑的原因(会跑时为 `null`)。 */
  holdReason: SceneStepHoldReason | null;
}

/** 计划预览结果:要么**全部校验问题**,要么一份带「会不会跑」的计划。二选一,不并存。 */
export type ScenePreviewResult =
  | { ok: false; problems: SceneSpecProblem[] }
  | {
      ok: true;
      sceneId: string;
      specDigest: string;
      planDigest: string;
      steps: ScenePreviewStep[];
    };

/**
 * **本地静态预判**一份候选声明 —— 与主进程 `dryRunScene` **同一判据**(同一批契约编译函数
 * `compileScenePlan` / `compileSceneCommands`),不带运行期副作用。
 *
 * 「哪几步会跑」的规则(逐字对齐 `dryRunScene`):
 *  - `service.needsResolution` 为真 → 不会跑;
 *  - 否则 `rpcInput === null`(载荷投影失败)→ 不会跑;
 *  - 否则若它依赖的任一步静态判定为「不会跑」→ 也不跑(按拓扑序逐条推进,传递)。
 *
 * ⚠️ **这是展示用的预览**,不是执行判定 —— 真正的执行由主进程在 `applyScene` 时重新按运行期
 * 事实决定。两者判据同源(同一批契约),但本函数**不执行**任何东西、不写任何记录。
 *
 * @param spec 一份**候选** SceneSpec(形状先宽松收下,业务校验交给 `validateSceneSpec` 一次报全)。
 */
export function buildScenePreview(spec: unknown): ScenePreviewResult {
  const validation = validateSceneSpec(spec);
  if (!validation.ok) return { ok: false, problems: validation.problems };
  const plan = compileScenePlan(validation.spec);
  const commands = compileSceneCommands(plan, validation.spec);

  const willRunById = new Map<string, boolean>();
  const steps: ScenePreviewStep[] = commands.commands.map((c) => {
    let willRun = true;
    let holdReason: SceneStepHoldReason | null = null;
    if (c.service.needsResolution) {
      willRun = false;
      holdReason = { code: "needsResolution", hint: c.service.resolutionHint };
    } else if (c.rpcInput === null) {
      willRun = false;
      holdReason = {
        code: "payloadProjection",
        problems: c.payloadProblems.map((p) => ({ path: p.path, message: p.message })),
      };
    } else {
      const badDep = c.dependsOn.find((dep) => willRunById.get(dep) === false);
      if (badDep !== undefined) {
        willRun = false;
        holdReason = { code: "dependency", dependencyId: badDep };
      }
    }
    willRunById.set(c.actionId, willRun);
    return {
      actionId: c.actionId,
      kind: c.kind,
      order: c.order,
      dependsOn: [...c.dependsOn],
      serviceLabel: c.service.serviceLabel,
      needsResolution: c.service.needsResolution,
      willRun,
      holdReason,
    };
  });

  return {
    ok: true,
    sceneId: plan.sceneId,
    specDigest: plan.specDigest,
    planDigest: plan.digest,
    steps,
  };
}

/**
 * 用**主进程 `scene.preflight` 返回的那份计划线格**(权威 wire 形状)替换本地编译出来的
 * 步骤来源 —— 但保留本地算出的 `willRun` / `holdReason`(`plan` 里没有这两样)。
 *
 * 存在的理由:预览要么完整取自 IPC 的 `plan`(缺 willRun)、要么完整取自本地编译(缺能力缺口),
 * 而面板两样都要展示。本函数把两半**按 actionId 合并**,以 IPC 的 wire 为准取展示字段、以本地
 * 预判取「会不会跑」。两边的 `planDigest` 来自同一份确定性契约,必然一致;万一不一致(理论上
 * 不可能),**以 IPC 的为准**并在 `digestMismatch` 标出来(坏东西显式报出来,不静默)。
 */
export function mergePreviewWithPlan(
  preview: Extract<ScenePreviewResult, { ok: true }>,
  plan: ScenePlanWire,
): { steps: ScenePreviewStep[]; planDigest: string; digestMismatch: boolean } {
  const holdById = new Map(preview.steps.map((s) => [s.actionId, s] as const));
  const steps: ScenePreviewStep[] = plan.steps.map((p) => {
    const local = holdById.get(p.actionId);
    return {
      actionId: p.actionId,
      kind: p.kind,
      order: p.order,
      dependsOn: [...p.dependsOn],
      serviceLabel: local?.serviceLabel ?? null,
      needsResolution: local?.needsResolution ?? false,
      // 计划线格里没有 willRun —— 本地没有这一步(理论上不会)时**保守判会跑**,让实际执行去判。
      willRun: local?.willRun ?? true,
      holdReason: local?.holdReason ?? null,
    };
  });
  return { steps, planDigest: plan.digest, digestMismatch: plan.digest !== preview.planDigest };
}

/* ───────────────────────── 状态机(预览 → 批准 → 部署) ───────────────────────── */

/**
 * 一次批准的默认有效期(毫秒)—— 与主进程 `sceneDeploy.ts` 的 `SCENE_APPLY_GRANT_TTL_MS`
 * **同值**(10 分钟)。渲染端不 import 主进程,故在此复述这个数;两侧一旦分家,最坏情况是
 * 渲染端等一个主进程早已判过期的授权 —— 故值保持一致是硬要求,smoke 钉住它。
 */
export const SCENE_APPROVAL_TTL_MS = 10 * 60 * 1000;

/** 一枚计划级授权(渲染端只持有 id + 到期时刻 + 它绑的计划摘要;**不含**授权内容)。 */
export interface SceneGrant {
  grantId: string;
  expiresAt: number;
  /** 这枚授权**绑定**的计划摘要 —— 等于批准时用户看到的那份计划。 */
  planDigest: string;
}

/** 一次部署的结局(渲染端只展示结果,不改记录)。 */
export type SceneApplyOutcome =
  | { ok: true; deployment: SceneDeploymentWire; observed: string[] }
  | { ok: false; reason: string };

/** 面板状态。所有分支的派生都从这几个字段算,不另存冗余标志。 */
export interface SceneDeployState {
  /** 粘贴框里的文本(唯一真相;编辑它即作废预览与授权)。 */
  specText: string;
  /** 一次部署的稳定 id —— 首次预览时分配,之后的批准 / 部署复用同一 id(重试是覆盖,不是新部署)。 */
  deploymentId: string | null;
  /** 当前 specText 的预览结果(未预览 / 已被编辑作废时为 `null`)。 */
  preview: ScenePreviewResult | null;
  /** 已签发的授权(绑 `preview.planDigest`;编辑作废后为 `null`)。 */
  grant: SceneGrant | null;
  /** 上一次批准失败 / 被拒的原因(给用户看;成功或编辑后清空)。 */
  grantError: string | null;
  /** 上一次部署的结局。 */
  apply: SceneApplyOutcome | null;
  /** 上一次部署失败 / 被拒的原因。 */
  applyError: string | null;
}

export const INITIAL_SCENE_DEPLOY_STATE: SceneDeployState = {
  specText: "",
  deploymentId: null,
  preview: null,
  grant: null,
  grantError: null,
  apply: null,
  applyError: null,
};

let deploymentSeq = 0;
/** 生成一次部署的稳定 id(`scene-deploy-` 前缀 + 时间戳 + 递增序号)。 */
export function newDeploymentId(now: number = Date.now()): string {
  deploymentSeq = (deploymentSeq + 1) % 0xffffff;
  return `scene-deploy-${now.toString(36)}-${deploymentSeq.toString(36)}`;
}

/**
 * 【MC-002】**重启后从盘上记录恢复输入框** —— 把一条可续跑的部署记录里的声明快照还原成
 * 面板状态。**只还原输入**,不还原授权:审批对象是一次性的计划 digest,重启后旧授权
 * (可能已过期/已撤销)绝不能静默复用 —— 用户必须重新预览 + 批准。这是台账要求的
 * 「发现 → 选择 → 重新预览批准 → 续跑」里"发现 + 选择"那一步。
 *
 * 没有声明快照的旧记录返回 `null`(UI 明说"这份旧记录没有声明快照",不猜)。
 */
export function restoreFromDeployment(entry: { deployment: SceneDeploymentWire | null }): { specText: string } | null {
  const snapshot = entry.deployment?.specSnapshot;
  if (!snapshot) return null;
  return { specText: JSON.stringify(snapshot.spec, null, 2) };
}

/** 状态迁移。见文件头:编辑作废、批准绑计划 digest、部署只认 grantId。 */
export type SceneDeployAction =
  /** 用户改了粘贴框文本 —— 作废预览与授权(spec 变了,旧计划与旧授权都失效)。 */
  | { type: "edit"; text: string }
  /** 预览完成(本地静态预判的结果)。新计划作废任何旧授权。 */
  | { type: "previewed"; result: ScenePreviewResult }
  /** 批准成功:拿回 grantId + 到期时刻,绑定到的计划 = 当前预览的 planDigest。 */
  | { type: "granted"; grantId: string; expiresAt: number }
  /** 批准被拒 / 声明不合法。 */
  | { type: "grantRefused"; reason: string }
  /** 部署成功。 */
  | { type: "applied"; deployment: SceneDeploymentWire; observed: string[] }
  /** 部署被拒 / 声明不合法。 */
  | { type: "applyRefused"; reason: string }
  /** 清空一切(面板上的「清空」)。 */
  | { type: "reset" }
  /** 【MC-002】重启后发现未完成部署 → 把它的声明放回输入框。**不恢复授权**(见 restoreFromDeployment)。 */
  | { type: "restored"; text: string; deploymentId: string };

/**
 * 状态机 —— 纯函数。四条不变量写在这里(而不是散在组件的 onClick 里):
 *  1. **编辑即作废**:`edit` 清掉 `preview` / `grant` / `apply`(spec 变了,旧预览不再对应它);
 *  2. **新预览作废旧授权**:`previewed` 清掉 `grant`(新计划 ≠ 旧计划,旧授权绑的是旧 digest);
 *  3. **批准绑当前预览的 digest**:`granted` 只在 `preview.ok` 时成立,且 `grant.planDigest` 取自
 *     当前 `preview.planDigest`(绝不是现算一个 —— 那会让用户批准一份没看过的计划);
 *  4. **未预览不许批准 / 未批准不许部署**:`granted` 无预览时不生效;`apply` 只在有 grant 时可达。
 *     (选按钮仍会在组件里禁用,这条是状态层的兜底。)
 */
export function sceneDeployReducer(state: SceneDeployState, action: SceneDeployAction): SceneDeployState {
  switch (action.type) {
    case "edit":
      return { ...INITIAL_SCENE_DEPLOY_STATE, specText: action.text };
    case "previewed":
      return {
        ...state,
        deploymentId: state.deploymentId ?? newDeploymentId(),
        preview: action.result,
        // 新计划作废旧授权 / 旧结局。
        grant: null,
        grantError: null,
        apply: null,
        applyError: null,
      };
    case "granted":
      // 只有当前预览成功时才认这枚授权(否则它绑的计划无从谈起)。
      if (state.preview === null || !state.preview.ok) {
        return { ...state, grant: null, grantError: null };
      }
      return {
        ...state,
        grant: { grantId: action.grantId, expiresAt: action.expiresAt, planDigest: state.preview.planDigest },
        grantError: null,
      };
    case "grantRefused":
      return { ...state, grant: null, grantError: action.reason };
    case "applied":
      return { ...state, apply: { ok: true, deployment: action.deployment, observed: action.observed }, applyError: null };
    case "applyRefused":
      return { ...state, apply: null, applyError: action.reason };
    case "reset":
      return INITIAL_SCENE_DEPLOY_STATE;
    case "restored":
      // 与 `edit` 同一条不变量(换声明 = 旧预览/旧授权作废),唯一的差别是 `deploymentId`
      // 保留盘上那个 —— 续跑必须复用同一次部署的 id(否则 `resumeScene` 报 no_record)。
      return { ...INITIAL_SCENE_DEPLOY_STATE, specText: action.text, deploymentId: action.deploymentId };
  }
}

/* ───────────────────────── 派生选择器 ───────────────────────── */

/** 面板当前处于哪一档(供渲染端决定展示哪一段)。 */
export type SceneDeployStage = "empty" | "invalid" | "previewed" | "approved" | "deployed";

export function sceneDeployStage(state: SceneDeployState): SceneDeployStage {
  if (state.apply !== null && state.apply.ok) return "deployed";
  if (state.preview === null) return "empty";
  if (!state.preview.ok) return "invalid";
  if (state.grant !== null) return "approved";
  return "previewed";
}

/** 有非空文本才谈得上预览(空文本时「预览」按钮该禁用)。 */
export function canPreview(state: SceneDeployState): boolean {
  return state.specText.trim().length > 0;
}

/** 预览成功才谈得上批准(声明不合法时给「批准」按钮是骗人)。 */
export function canApprove(state: SceneDeployState): boolean {
  return state.preview !== null && state.preview.ok;
}

/** 预览成功**且**已持一枚授权,才谈得上部署(未批准就部署 = 撞 `no_grant`)。 */
export function canDeploy(state: SceneDeployState): boolean {
  return state.preview !== null && state.preview.ok && state.grant !== null;
}

/**
 * 【MC-002】**能不能续跑** —— 预览成功 + 持有授权 + **上一次部署留下了部分执行记录**
 * (`partial` / `failed`)。`deploymentId` 在一次部署内是稳定的(重试是同一 id 的覆盖),
 * 所以续跑直接复用它 —— 主进程按它读回盘上那份「哪几步 done」的记录,跳过已完成的。
 *
 * `active`(全部完成)不显示续跑:没有剩余步骤可跑,按钮只会让用户以为还有事没做完。
 */
export function canResume(state: SceneDeployState): boolean {
  if (state.preview === null || !state.preview.ok || state.grant === null) return false;
  const outcome = state.apply;
  return outcome !== null && outcome.ok && (outcome.deployment.status === "partial" || outcome.deployment.status === "failed");
}

/* ───────────────────────── 入参构造 ───────────────────────── */

/**
 * 构造 `scene.approve` 的入参。**只在预览成功且已分配部署 id 时**给出(否则 `null`,组件据此
 * 不该发这条)。
 *
 * ★ 要害:`planDigest` **取自当前预览**(用户看到的那份计划),**绝不重算** —— 递一份现算的
 * digest 就等于让用户批准了他没看过的一份计划(ARC-004「审批对象是计划,不是 spec」)。
 */
export function buildSceneApprovalInput(
  spec: unknown,
  state: SceneDeployState,
  ttlMs: number = SCENE_APPROVAL_TTL_MS,
): SceneApprovalInput | null {
  if (state.preview === null || !state.preview.ok || state.deploymentId === null) return null;
  return {
    deploymentId: state.deploymentId,
    spec,
    planDigest: state.preview.planDigest,
    ttlMs,
  };
}

/**
 * 构造 `scene.apply` 的入参。**只在预览成功且已持授权时**给出(否则 `null`)。
 *
 * ★ 要害:只给 `grantId` —— **不给授权内容**(宿主从 GrantStore 按 id 取回,含失效态)。
 * 多带一个 grant 字段 = 把授权判定整个绕过。`deploymentId` 复用批准时那个(同一次部署,
 * 重试是覆盖)。
 */
export function buildSceneApplyInput(spec: unknown, state: SceneDeployState): SceneApplyInput | null {
  if (state.preview === null || !state.preview.ok || state.grant === null || state.deploymentId === null) {
    return null;
  }
  return {
    deploymentId: state.deploymentId,
    spec,
    grantId: state.grant.grantId,
    actorKind: "user",
    actorId: "desktop",
  };
}

/**
 * 【MC-002】构造 `scene.resume` 的入参 —— 与 {@link buildSceneApplyInput} **同一份形状、
 * 同一条纪律**(只给 `grantId`,不给授权内容;`deploymentId` 复用同一次部署那个)。
 * 单列一个函数只是因为**通道不同**:主进程按通道分派到 `resumeSceneWithGrant`,
 * 而它读回盘上那份部分执行的记录、跳过已 done 的步骤。
 */
export function buildSceneResumeInput(spec: unknown, state: SceneDeployState): SceneResumeInput | null {
  const base = buildSceneApplyInput(spec, state);
  if (base === null) return null;
  return { ...base };
}
