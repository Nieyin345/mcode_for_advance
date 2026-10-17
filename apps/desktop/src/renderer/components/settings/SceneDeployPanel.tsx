/**
 * 设置 → 场景部署。
 *
 * ## 这一页面朝谁
 *
 * 面朝**要把一整套环境(工作流 / 触发器 / 钩子 / MCP / 技能… )作为一份声明一次建出来**
 * 的人。ARC-002 / MC-058 的链在这里合拢:上一轮已经把三层 IPC(`scene.plan` /
 * `scene.preflight` / `scene.approve` / `scene.apply`)打通,但**渲染端一个按钮都没有** ——
 * 通道到 preload 为止,用户够不到。本页补上那个用户可见的缺口。
 *
 * ## 三段动作,两条硬边界
 *
 *  1. **预览**(只读):`scene.preflight` 校验声明(一次报全)+ 编译计划 + 能力预检;同时渲染端
 *     本地按**同一批契约**静态预判每步「会不会跑」。**不建任何资源、不申请授权**。
 *  2. **批准**(写):`scene.approve` 让**用户本人**为一**这一份计划**(绑 `planDigest`)签一枚
 *     计划级授权,拿回 `grantId`。
 *  3. **部署**(写):`scene.apply` 只递 `grantId` —— 授权内容由宿主从 GrantStore 取回,渲染端
 *     给不了(给了就等于绕过授权判定)。
 *
 * 两条边界(**不静默跳过、不偷换审批对象**):
 *  - **编辑即作废**:粘贴框一改,预览与授权都作废(旧授权绑的是旧计划),「部署」按钮随之收回
 *    —— 不让用户拿一枚绑旧计划的授权去撞 `plan_mismatch`。这条落在 `sceneDeployView` 的状态机里。
 *  - **坏东西显式报出来**:声明不合法、能力缺失、批准被拒、某步不会跑(附原因)、部署每步状态与
 *    验收是否通过 —— 全部显示,没有一个"安静地什么都没发生"的分支。
 *
 * ## 读走 useRpc、写走显式 await(硬规矩 7)
 *
 * 预检是**读**(参数化:随「预览」这次点击的 spec),走 `useRpc`(enabled 门控,不在每次击键时
 * 发)。批准 / 部署是**写**(事件处理器里显式 `await api.*`)—— 藏进 useRpc 的自动重跑里就是
 * 重复签发 / 重复部署。
 */
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Spinner,
} from "@renderer/components/ui/index.js";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleXFilled,
  IconListCheck,
  IconRefresh,
  IconRocket,
  IconShieldCheck,
} from "@renderer/lib/icons.js";
import type {
  SceneApplyIpcResult,
  SceneDeploymentListEntryWire as SceneDeployListEntry,
  SceneResumeIpcResult,
  SceneApprovalResult,
  SceneDeploymentWire,
  ScenePlanWire,
  ScenePreflightWire,
} from "@contracts/ipc";
import { PanelHeader } from "./PanelHeader.js";
import { PlanApprovalBar } from "./PlanApprovalBar.js";
import { PANEL_MAX_W } from "./panelWidth.js";
import {
  buildSceneApplyInput,
  buildSceneResumeInput,
  restoreFromDeployment,
  buildSceneApprovalInput,
  buildScenePreview,
  canApprove,
  canDeploy,
  canResume,
  canPreview,
  INITIAL_SCENE_DEPLOY_STATE,
  mergePreviewWithPlan,
  newDeploymentId,
  parseSceneSpecText,
  SCENE_APPROVAL_TTL_MS,
  sceneDeployReducer,
  sceneDeployStage,
  type SceneDeployState,
  type ScenePreviewResult,
  type SceneStepHoldReason,
} from "./sceneDeployView.js";

/** 部署 / 步骤状态 → 徽标变体。 */
const DEPLOY_STATUS_VARIANT: Record<SceneDeploymentWire["status"], "neutral" | "accent" | "success" | "warning" | "danger"> = {
  deploying: "accent",
  active: "success",
  partial: "warning",
  failed: "danger",
};

const STEP_STATUS_VARIANT: Record<SceneDeploymentWire["steps"][number]["status"], "neutral" | "accent" | "success" | "warning" | "danger"> = {
  pending: "neutral",
  running: "accent",
  done: "success",
  failed: "danger",
  compensated: "warning",
};

export function SceneDeployPanel() {
  const { t } = useI18n();

  const [state, dispatch] = useReducer(sceneDeployReducer, INITIAL_SCENE_DEPLOY_STATE);
  /** 一次「预览」的坐标:解析后的 spec + 递增序号(序号让 useRpc 重取,即便 spec 没变)。 */
  const [previewRequest, setPreviewRequest] = useState<{ spec: unknown; nonce: number } | null>(null);
  /** 预览时的输入错误(空 / JSON 坏)—— 与「声明不合法」是两回事。 */
  const [previewError, setPreviewError] = useState<MessageId | null>(null);
  const [previewErrorParam, setPreviewErrorParam] = useState<string>("");
  const [busy, setBusy] = useState<"approve" | "apply" | "resume" | null>(null);
  /** 【MC-002】重启后发现未完成部署:场景 id 从当前文本解析(与预览同一份 parse);
   *  有合法 sceneId 时才查询。读失败**显式报出**(不伪装成"没有记录")。 */
  const [unfinishedRefresh, setUnfinishedRefresh] = useState(0);
  const sceneIdForList = useMemo(() => {
    const parsed = parseSceneSpecText(state.specText);
    if (!parsed.ok) return null;
    const id = (parsed.spec as { sceneId?: unknown }).sceneId;
    return typeof id === "string" && id.length > 0 ? id : null;
  }, [state.specText]);
  const {
    data: unfinished,
    loading: unfinishedLoading,
    error: unfinishedError,
  } = useRpc(
    () => api.scene.listDeployments({ sceneId: sceneIdForList! }),
    [sceneIdForList, unfinishedRefresh],
    { enabled: sceneIdForList !== null, toastOnError: false },
  );

  // ── 读:能力预检(参数化,门控在「预览」这次点击上;不在每次击键时发) ──
  const { data: preflight, loading: preflightLoading, error: preflightError } = useRpc(
    () => api.scene.preflight({ spec: previewRequest!.spec }),
    [previewRequest?.nonce ?? -1],
    { enabled: previewRequest !== null, toastOnError: false },
  );

  const stage = sceneDeployStage(state);
  const parsedSpec = previewRequest?.spec ?? null;

  /** 预览:解析 → 本地静态预判(同步,纯函数)→ 落进状态机;IPC 预检由 useRpc 顺带触发。 */
  const preview = useCallback((): void => {
    const parse = parseSceneSpecText(state.specText);
    if (parse.ok === false) {
      setPreviewError(parse.code === "empty" ? "sceneDeploy.emptySpec" : "sceneDeploy.invalidJson");
      setPreviewErrorParam(parse.code === "parse" ? parse.message : "");
      return;
    }
    setPreviewError(null);
    setPreviewErrorParam("");
    const result: ScenePreviewResult = buildScenePreview(parse.spec);
    dispatch({ type: "previewed", result });
    setPreviewRequest({ spec: parse.spec, nonce: Date.now() });
  }, [state.specText]);

  /** 批准(写):显式 await。入参的 planDigest 取自当前预览(用户看到的那份计划)。 */
  const approve = useCallback(async (): Promise<void> => {
    if (parsedSpec === null) return;
    const input = buildSceneApprovalInput(parsedSpec, state);
    if (input === null) return;
    setBusy("approve");
    try {
      const res: SceneApprovalResult = await api.scene.approve(input);
      if (res.ok) {
        dispatch({ type: "granted", grantId: res.grantId, expiresAt: res.expiresAt });
      } else if (res.kind === "refused") {
        dispatch({ type: "grantRefused", reason: res.reason });
      } else {
        dispatch({
          type: "grantRefused",
          reason: res.problems.map((p) => t("sceneDeploy.problemLine", { path: p.path, message: p.message })).join("; "),
        });
      }
    } catch (err) {
      dispatch({ type: "grantRefused", reason: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }, [parsedSpec, state, t]);

  /** 部署(写):显式 await。入参只给 grantId(grant 内容由宿主取回)。 */
  const apply = useCallback(async (): Promise<void> => {
    if (parsedSpec === null) return;
    const input = buildSceneApplyInput(parsedSpec, state);
    if (input === null) return;
    setBusy("apply");
    try {
      const res: SceneApplyIpcResult = await api.scene.apply(input);
      if (res.ok) {
        dispatch({ type: "applied", deployment: res.deployment, observed: res.readback.observed });
      } else if (res.kind === "refused") {
        dispatch({ type: "applyRefused", reason: res.reason });
      } else {
        dispatch({
          type: "applyRefused",
          reason: res.problems.map((p) => t("sceneDeploy.problemLine", { path: p.path, message: p.message })).join("; "),
        });
      }
    } catch (err) {
      dispatch({ type: "applyRefused", reason: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }, [parsedSpec, state, t]);

  /** 【MC-002】把盘上一条未完成部署的声明快照放回输入框(只还原输入,不还原授权 ——
   *  用户必须重新预览 + 批准;旧 grant 可能已过期/撤销)。没有快照的旧记录显式说明。 */
  const restoreRecord = useCallback((entry: SceneDeployListEntry) => {
    const restored = restoreFromDeployment(entry);
    if (restored === null) {
      dispatch({ type: "applyRefused", reason: t("sceneDeploy.unfinishedNoSnapshot") });
      return;
    }
    setPreviewError(null);
    setPreviewRequest(null);
    dispatch({ type: "restored", text: restored.specText, deploymentId: entry.deploymentId });
  }, [t]);

  /** 【MC-002】续跑(写):与部署同一条路,只是主进程按 `scene.resume` 跳过盘上已 done 的步骤。 */
  const resume = useCallback(async (): Promise<void> => {
    if (parsedSpec === null) return;
    const input = buildSceneResumeInput(parsedSpec, state);
    if (input === null) return;
    setBusy("resume");
    try {
      const res: SceneResumeIpcResult = await api.scene.resume(input);
      if (res.ok) {
        dispatch({ type: "applied", deployment: res.deployment, observed: res.readback.observed });
      } else if (res.kind === "refused") {
        dispatch({ type: "applyRefused", reason: res.reason });
      } else {
        dispatch({
          type: "applyRefused",
          reason: res.problems.map((p) => t("sceneDeploy.problemLine", { path: p.path, message: p.message })).join("; "),
        });
      }
    } catch (err) {
      dispatch({ type: "applyRefused", reason: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }, [parsedSpec, state, t]);

  // 文案:授权到期时刻格式化(本地时间)。
  const grantExpiresText = useMemo(() => {
    const g = state.grant;
    if (g === null) return "";
    const d = new Date(g.expiresAt);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }, [state.grant]);

  const localPreview = state.preview !== null && state.preview.ok ? state.preview : null;
  const authoritativePlan: ScenePlanWire | null = preflight !== undefined && preflight.ok ? preflight.plan : null;
  const merged = useMemo(() => {
    if (localPreview === null) return null;
    if (authoritativePlan === null) return { steps: localPreview.steps, planDigest: localPreview.planDigest, digestMismatch: false };
    return mergePreviewWithPlan(localPreview, authoritativePlan);
  }, [localPreview, authoritativePlan]);

  const grantActive = state.grant !== null && Date.now() < state.grant.expiresAt;

  return (
    <div className={cn("mx-auto flex h-full w-full min-h-0 flex-col overflow-y-auto", PANEL_MAX_W.form)}>
      <PanelHeader icon={IconRocket} title={t("sceneDeploy.title")} hint={t("sceneDeploy.intro")} />

      <p className="mb-3 border-l-2 border-warning/40 px-4 py-2 text-[0.7143em] leading-relaxed text-content-subtle">
        {t("sceneDeploy.specHint")}
      </p>

      {/* ───────── 【MC-002】未完成的部署(重启后仍可发现) ───────── */}
      {sceneIdForList !== null && (
        <section className="mb-3 rounded border border-edge bg-surface/50 p-2.5" data-testid="scene-unfinished">
          <div className="mb-1.5 flex items-center gap-1.5 text-[0.8571em] font-medium text-content">
            <IconListCheck size={14} className="text-accent" />
            {t("sceneDeploy.unfinishedTitle")}
            <Button variant="ghost" size="sm" disabled={unfinishedLoading} onClick={() => setUnfinishedRefresh((n) => n + 1)} className="ml-auto gap-1">
              <IconRefresh size={12} />
              {t("sceneDeploy.unfinishedRetry")}
            </Button>
          </div>
          {unfinishedError !== null ? (
            <ErrorNote tone="danger" icon={IconAlertTriangle}>
              {t("sceneDeploy.unfinishedLoadError", { reason: unfinishedError.message })}
            </ErrorNote>
          ) : unfinished?.ok === false ? (
            <ErrorNote tone="danger" icon={IconAlertTriangle}>
              {t("sceneDeploy.unfinishedLoadError", { reason: unfinished.reason })}
            </ErrorNote>
          ) : unfinished?.ok === true && unfinished.deployments.length === 0 ? (
            <div className="text-[0.7857em] text-content-subtle">{t("sceneDeploy.unfinishedEmpty")}</div>
          ) : unfinished?.ok === true ? (
            <ul className="space-y-1">
              {unfinished.deployments.map((entry) => (
                <li key={entry.deploymentId} className="flex items-center gap-2 rounded border border-edge bg-surface px-2 py-1.5 text-[0.7857em]">
                  <Badge variant={entry.resumable ? "warning" : "neutral"}>
                    {entry.resumable ? t("sceneDeploy.unfinishedResumable") : t("sceneDeploy.unfinishedNotResumable")}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-content-subtle" title={entry.deploymentId}>
                    {entry.deploymentId}
                  </span>
                  <span className="text-content-subtle">
                    {t("sceneDeploy.unfinishedRowMeta", {
                      status: t(`sceneDeploy.deployStatus.${entry.status}`),
                      updatedAt: new Date(entry.updatedAt).toLocaleString(),
                    })}
                  </span>
                  <Button variant="secondary" size="sm" disabled={busy !== null || entry.deployment === null} onClick={() => restoreRecord(entry)}>
                    {t("sceneDeploy.unfinishedRestore")}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <Spinner label={t("common.loading")} />
          )}
          <p className="mt-1.5 text-[0.7143em] leading-relaxed text-content-subtle">{t("sceneDeploy.unfinishedHint")}</p>
        </section>
      )}

      {/* ───────── 声明输入 ───────── */}
      <Field className="mb-3" label={t("sceneDeploy.specLabel")}>
        <textarea
          value={state.specText}
          spellCheck={false}
          placeholder={t("sceneDeploy.specPlaceholder")}
          onChange={(e) => {
            setPreviewError(null);
            setPreviewRequest(null);
            dispatch({ type: "edit", text: e.target.value });
          }}
          className="min-h-[160px] w-full resize-y rounded border border-edge bg-surface px-2 py-1.5 font-mono text-[0.7857em] leading-relaxed text-content placeholder:font-sans placeholder:text-content-subtle focus:border-accent focus:outline-none"
        />
      </Field>

      <PlanApprovalBar
        testId="scene-deploy-approval-bar"
        canApprove={canApprove(state)}
        canRun={canDeploy(state) && grantActive}
        grant={state.grant}
        busyApprove={busy === "approve"}
        busyRun={busy === "apply" || busy === "resume"}
        approveLabel={t("sceneDeploy.approve")}
        approvingLabel={t("sceneDeploy.approving")}
        runLabel={t("sceneDeploy.deploy")}
        runningLabel={t("sceneDeploy.deploying")}
        grantActiveLabel={t("sceneDeploy.stage.approved", { expiresAt: grantExpiresText })}
        grantExpiredLabel={t("sceneDeploy.stage.approvedExpired")}
        resetLabel={t("sceneDeploy.reset")}
        onApprove={() => void approve()}
        onRun={() => void apply()}
        onReset={() => {
          setPreviewRequest(null);
          setPreviewError(null);
          dispatch({ type: "reset" });
        }}
      >
        {/* 预览与「续跑」是场景面板特有的动作 —— 插在批准钮之前（顺序即语义）。 */}
        <Button variant="secondary" size="sm" disabled={!canPreview(state) || busy !== null} onClick={preview} className="gap-1">
          <IconRefresh size={12} />
          {t("sceneDeploy.preview")}
        </Button>
        {/* 【MC-002】部署中断(partial/failed)后才出现 —— 跳过已完成的步骤接着跑。 */}
        {canResume(state) ? (
          <Button variant="secondary" size="sm" disabled={!grantActive || busy !== null} onClick={() => void resume()}>
            {busy === "resume" ? t("sceneDeploy.resuming") : t("sceneDeploy.resume")}
          </Button>
        ) : null}
      </PlanApprovalBar>

      {/* 输入侧的即时错误(空 / JSON 坏)—— 与「声明不合法」分开报。 */}
      {previewError !== null && (
        <ErrorNote tone="warning" icon={IconAlertTriangle} className="mb-3">
          {t(previewError, { message: previewErrorParam })}
        </ErrorNote>
      )}

      {/* ───────── 阶段提示 ───────── */}
      {stage === "empty" && previewError === null && (
        <EmptyState icon={IconRocket} title={t("sceneDeploy.stage.empty")} />
      )}

      {/* ───────── 声明不合法:全部问题 ───────── */}
      {state.preview !== null && !state.preview.ok && (
        <ErrorNote tone="danger" icon={IconAlertTriangle} className="mb-3">
          <div className="font-medium">{t("sceneDeploy.problemsTitle")}</div>
          {state.preview.problems.map((p) => (
            <div key={`${p.path}:${p.message}`} className="font-mono">
              {t("sceneDeploy.problemLine", { path: p.path, message: p.message })}
            </div>
          ))}
        </ErrorNote>
      )}

      {/* ───────── 计划预览 ───────── */}
      {merged !== null && (
        <div className="mb-3 rounded border border-edge bg-surface/50 p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[0.8571em] font-medium text-content">
            <IconListCheck size={14} className="text-accent" />
            {t("sceneDeploy.planTitle")}
          </div>
          {state.deploymentId !== null && (
            <div className="mb-1 font-mono text-[0.7143em] text-content-subtle">
              {t("sceneDeploy.deploymentId", { id: state.deploymentId })}
            </div>
          )}
          <div className="mb-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.7143em] text-content-subtle">
            <span>{t("sceneDeploy.planSceneId", { id: localPreview?.sceneId ?? "" })}</span>
            <span className="font-mono" title={merged.planDigest}>
              {t("sceneDeploy.planDigest", { digest: merged.planDigest.slice(0, 12) })}
            </span>
          </div>
          {merged.digestMismatch && (
            <ErrorNote tone="warning" icon={IconAlertTriangle} className="mb-2">
              {t("sceneDeploy.digestMismatch")}
            </ErrorNote>
          )}
          {merged.steps.map((s) => (
            <div
              key={s.actionId}
              className="mb-1 flex items-start gap-2 rounded border border-edge bg-surface px-2 py-1.5 text-[0.7857em]"
            >
              <span className="mt-0.5 shrink-0 tabular-nums text-content-subtle">#{s.order}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-content">{s.actionId}</span>
                  <Badge variant="neutral" className="shrink-0">{s.kind}</Badge>
                  {s.willRun ? (
                    <Badge variant="success" className="shrink-0">{t("sceneDeploy.stepWillRun")}</Badge>
                  ) : (
                    <Badge variant="warning" className="shrink-0">{t("sceneDeploy.stepWillNotRun")}</Badge>
                  )}
                </div>
                <div className="mt-0.5 text-content-subtle">
                  {s.serviceLabel !== null
                    ? t("sceneDeploy.serviceLabel", { label: s.serviceLabel })
                    : t("sceneDeploy.noServiceLabel")}
                </div>
                {s.dependsOn.length > 0 && (
                  <div className="text-content-subtle">{t("sceneDeploy.dependsOn", { ids: s.dependsOn.join(", ") })}</div>
                )}
                {!s.willRun && s.holdReason !== null && (
                  <HoldReason reason={s.holdReason} />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ───────── 能力预检 ───────── */}
      {previewRequest !== null && (preflightLoading || preflightError !== null || preflight !== undefined) && (
        <div className="mb-3 rounded border border-edge bg-surface/50 p-2.5 text-[0.7857em]">
          <div className="mb-1 flex items-center gap-1.5 font-medium text-content">
            <IconShieldCheck size={13} className="text-accent" />
            {t("sceneDeploy.preflightTitle")}
            {preflightLoading && <Spinner size="xs" label={t("sceneDeploy.preflightChecking")} />}
          </div>
          {preflightError !== null ? (
            <ErrorNote tone="warning" className="mt-1">
              {t("sceneDeploy.preflightUnavailable", { error: preflightError.message })}
            </ErrorNote>
          ) : preflight !== undefined && preflight.ok ? (
            <PreflightReport preflight={preflight.preflight} />
          ) : null}
        </div>
      )}

      {/* ───────── 授权 / 批准状态 ───────── */}
      {state.grantError !== null && (
        <ErrorNote tone="danger" icon={IconAlertTriangle} className="mb-3">
          {t("sceneDeploy.approveRefused", { reason: state.grantError })}
        </ErrorNote>
      )}
      {stage === "previewed" && (
        <ErrorNote tone="warning" icon={IconAlertTriangle} className="mb-3">
          {t("sceneDeploy.stage.needsApproval")}
        </ErrorNote>
      )}
      {stage === "approved" && (
        <div className={cn("mb-3 flex items-center gap-2 text-[0.7857em]", grantActive ? "text-accent" : "text-warning")}>
          {grantActive ? <IconShieldCheck size={14} /> : <IconAlertTriangle size={14} />}
          {grantActive
            ? t("sceneDeploy.stage.approved", { expiresAt: grantExpiresText })
            : t("sceneDeploy.stage.approvedExpired")}
        </div>
      )}

      {/* ───────── 部署结果 ───────── */}
      {state.applyError !== null && (
        <ErrorNote tone="danger" icon={IconAlertTriangle} className="mb-3">
          {t("sceneDeploy.applyRefused", { reason: state.applyError })}
        </ErrorNote>
      )}
      {state.apply !== null && state.apply.ok && (
        <DeploymentResult deployment={state.apply.deployment} observed={state.apply.observed} />
      )}
    </div>
  );
}

/* ───────────────────────── 步骤「不会跑」的原因 ───────────────────────── */

/** 渲染一步**不会跑**的结构化原因 —— 按 `code` 分支取词条,不合并成一句含糊文案。 */
function HoldReason({ reason }: { reason: SceneStepHoldReason }) {
  const { t } = useI18n();
  if (reason.code === "needsResolution") {
    return (
      <div className="mt-1 text-warning">
        {reason.hint !== null
          ? t("sceneDeploy.hold.needsResolution", { hint: reason.hint })
          : t("sceneDeploy.hold.needsResolutionNoHint")}
      </div>
    );
  }
  if (reason.code === "dependency") {
    return <div className="mt-1 text-warning">{t("sceneDeploy.hold.dependency", { id: reason.dependencyId })}</div>;
  }
  return (
    <div className="mt-1 text-warning">
      <div>{t("sceneDeploy.hold.payloadProjectionHeader")}</div>
      {reason.problems.map((p) => (
        <div key={`${p.path}:${p.message}`} className="font-mono">
          {t("sceneDeploy.problemLine", { path: p.path, message: p.message })}
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────── 能力预检报告 ───────────────────────── */

function PreflightReport({ preflight }: { preflight: ScenePreflightWire }) {
  const { t } = useI18n();
  const optionalGaps = preflight.gaps.filter((g) => !g.required);
  return (
    <div>
      {preflight.ok ? (
        <div className="flex items-center gap-1.5 text-accent">
          <IconCircleCheck size={13} />
          {t("sceneDeploy.preflightOk", { n: preflight.checkedCapabilities })}
        </div>
      ) : (
        <div className="text-danger">
          <div className="font-medium">{t("sceneDeploy.preflightMissing")}</div>
          {preflight.requiredGaps.map((g) => (
            <div key={`req:${g.kind}:${g.id}`} className="font-mono">
              {g.reason === "incompatible"
                ? t("sceneDeploy.gapIncompatible", { kind: g.kind, id: g.id, detail: g.detail })
                : t("sceneDeploy.gapMissing", { kind: g.kind, id: g.id, detail: g.detail })}
            </div>
          ))}
        </div>
      )}
      {optionalGaps.length > 0 && (
        <div className="mt-1 text-warning">
          <div className="font-medium">{t("sceneDeploy.preflightOptional")}</div>
          {optionalGaps.map((g) => (
            <div key={`opt:${g.kind}:${g.id}`} className="font-mono">
              {g.reason === "incompatible"
                ? t("sceneDeploy.gapIncompatible", { kind: g.kind, id: g.id, detail: g.detail })
                : t("sceneDeploy.gapMissing", { kind: g.kind, id: g.id, detail: g.detail })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── 部署结果 ───────────────────────── */

function DeploymentResult({ deployment, observed }: { deployment: SceneDeploymentWire; observed: string[] }) {
  const { t } = useI18n();
  const statusKey = `sceneDeploy.deployStatus.${deployment.status}` as MessageId;
  const acc = deployment.acceptance;
  return (
    <div className="mb-3 rounded border border-edge bg-surface/50 p-2.5">
      <div className="mb-1.5 flex items-center gap-2 text-[0.8571em] font-medium text-content">
        {t("sceneDeploy.resultTitle")}
        <Badge variant={DEPLOY_STATUS_VARIANT[deployment.status]}>{t(statusKey)}</Badge>
      </div>

      {/* 验收:通过 / 未通过,以及期望 / 回读到 / 缺失三行 —— 不靠"看每步状态"猜。 */}
      {acc !== null && (
        <div className="mb-2 text-[0.7857em]">
          <div className={cn("flex items-center gap-1.5", acc.passed ? "text-accent" : "text-danger")}>
            {acc.passed ? <IconCircleCheck size={13} /> : <IconCircleXFilled size={13} />}
            {acc.passed ? t("sceneDeploy.acceptancePassed") : t("sceneDeploy.acceptanceFailed")}
          </div>
          <div className="mt-0.5 font-mono text-content-subtle">{t("sceneDeploy.acceptanceExpected", { ids: acc.expected.join(", ") })}</div>
          <div className="font-mono text-content-subtle">{t("sceneDeploy.acceptanceObserved", { ids: acc.observed.join(", ") || "—" })}</div>
          {acc.missing.length > 0 && (
            <div className="font-mono text-danger">{t("sceneDeploy.acceptanceMissing", { ids: acc.missing.join(", ") })}</div>
          )}
        </div>
      )}

      {/* 每步状态。 */}
      {deployment.steps.map((s) => {
        const stepKey = `sceneDeploy.stepStatus.${s.status}` as MessageId;
        return (
          <div key={s.actionId} className="mb-1 rounded border border-edge bg-surface px-2 py-1.5 text-[0.7857em]">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-content">{s.actionId}</span>
              <Badge variant={STEP_STATUS_VARIANT[s.status]} className="shrink-0">{t(stepKey)}</Badge>
            </div>
            {s.error && <div className="mt-0.5 text-danger">{t("sceneDeploy.stepError", { error: s.error })}</div>}
            {s.compensation && (
              <div className={cn("mt-0.5", s.compensation.applied ? "text-content-subtle" : "text-warning")}>
                {t("sceneDeploy.stepCompensation", { reason: s.compensation.reason })}
              </div>
            )}
          </div>
        );
      })}

      {/* 独立回读里"查不到"的资源—— 明确列出,不当成成功。 */}
      {observed.length === 0 && (
        <div className="mt-1 text-[0.7143em] text-content-subtle">
          {t("sceneDeploy.readbackUnverifiable", { ids: deployment.steps.map((s) => s.actionId).join(", ") })}
        </div>
      )}
    </div>
  );
}
