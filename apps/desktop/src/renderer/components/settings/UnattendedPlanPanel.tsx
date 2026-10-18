/**
 * **无人值守任务计划**的设置面板(MC-001 —— 后端全通、这个面板是它的用户入口)。
 *
 * ## 它是什么
 *
 * 用户在这里把一份**有界的会话创建清单**(几条操作:标题 + 首条消息)写成计划,
 * 本人点「批准」签一枚计划级授权,再点「执行」把清单逐条交给唯一业务命令
 * `createSessionAndSend`。授权只给 `grantId`,正文由宿主从 `GrantStore` 取回 ——
 * 与 `SceneDeployPanel` 的「预览 → 批准 → 执行」同一条纪律(台账要求复用这套形态)。
 *
 * ## 为什么在**场景部署同一个分区**里
 *
 * 台账的系统性修复写明「并入同一个治理视图,而不是另起一个新面板、新的名字空间」。
 * 这一屏与场景部署共用「计划 → 批准(绑 digest/正文)→ 执行(只递 grantId)」的
 * 心算模型,挂在一起用户学一次就够;导航项不增(见 `SettingsPage` 的 `scene-deploy`)。
 *
 * ## 两半各自来源
 *
 *  - **上半:新建一份计划** —— 表单(项目下拉 + 操作行 + 有效期 + 次数上限)→ 批准 → 执行。
 *  - **下半:跨重启的等待列表** —— `unattendedPlans.list` 现读现算(等批准 / 可续跑 /
 *    已完成),给「续跑」「放弃」两个动作。零条时如实显示空状态(**不假装有事可做**)。
 */
import { useCallback, useMemo, useReducer, useState } from "react";
import {
  IconAlertTriangle,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconUserCheck,
} from "@tabler/icons-react";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { MessageId } from "@renderer/lib/i18n/index.js";
import type {
  PendingUnattendedPlanWire,
  UnattendedApproveResult,
  UnattendedRunIpcResult,
} from "@contracts/ipc/unattended";
import { cn } from "@renderer/lib/cn.js";
import { Badge, Button, EmptyState, ErrorNote, Field, Input, Select } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { PlanApprovalBar } from "./PlanApprovalBar.js";
import { PANEL_MAX_W } from "./panelWidth.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import {
  buildUnattendedApproveInput,
  buildUnattendedRunInput,
  canApproveUnattended,
  canRunUnattended,
  initialUnattendedPlanState,
  sortPendingPlans,
  unattendedPlanReducer,
  validateUnattendedDraft,
  UNATTENDED_MAX_TTL_MS,
  type UnattendedPlanProblem,
  type UnattendedPlanState,
} from "./unattendedPlanView.js";

/** 预判问题 → i18n(判据在纯函数里,文案在这里 —— 两边分开才喂得进无头 smoke)。 */
function problemMessage(t: (k: MessageId, p?: Record<string, string | number>) => string, p: UnattendedPlanProblem): string {
  switch (p.code) {
    case "no_operations":
      return t("unattended.problem.noOperations");
    case "empty_operation":
      return t("unattended.problem.emptyOperation", { id: p.operationId });
    case "max_count_below_operations":
      return t("unattended.problem.maxCountBelow", { count: p.operationCount, max: p.maxCount });
    case "ttl_out_of_range":
      return t("unattended.problem.ttlOutOfRange");
  }
}

/** 跨重启视图的三态 → 徽标。 */
const PLAN_KIND_VARIANT: Record<PendingUnattendedPlanWire["kind"], "accent" | "warning" | "success"> = {
  resumable: "accent",
  waiting_approval: "warning",
  completed: "success",
};

export function UnattendedPlanPanel(): React.JSX.Element {
  const { t } = useI18n();
  const [state, dispatch] = useReducer(unattendedPlanReducer, undefined, () => initialUnattendedPlanState());
  const [busy, setBusy] = useState<"approve" | "run" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 下半区动作的忙碌标记(续跑 / 放弃按 planId 记,免得两行互相锁)。 */
  const [listBusy, setListBusy] = useState<string | null>(null);
  /** list 的重取序号(动作成功后 bump,触发 useRpc 重取)。 */
  const [listNonce, setListNonce] = useState(0);

  // ── 读:项目清单(下拉框) ──
  const { data: projectsData } = useRpc(() => api.project.list(), []);
  const projects = useMemo(
    () => (projectsData?.projects ?? []).filter((p) => !p.archived),
    [projectsData],
  );

  // ── 读:等待中的计划(跨重启视图)──
  const { data: listData, loading: listLoading, error: listError } = useRpc(
    () => api.unattendedPlans.list(),
    [listNonce],
    { toastOnError: false },
  );
  const pending = useMemo(() => sortPendingPlans(listData?.plans ?? []), [listData]);
  // 【MC-029 剩余项】**结构化健康度**(只读、独立于 list):即便 list 抛错(坏档时它拒绝),
  // 面板也要说得出是「内容坏了」还是「读不了」以及怎么修 —— 而不是只画一个错误条 +
  // 一张「没有等待中的计划」的空态(两者并列时用户会以为列表真的空)。
  const { data: healthData } = useRpc(
    () => api.unattendedPlans.health(),
    [listNonce],
    { toastOnError: false },
  );
  const archiveHealth = healthData?.archiveHealth;
  const archiveProblem = archiveHealth !== undefined && archiveHealth.state !== "ok" ? archiveHealth : null;

  const draft = useMemo(
    () => ({ planId: state.planId, projectId: state.projectId, operations: state.operations, ttlMs: state.ttlMs, maxCount: state.maxCount }),
    [state.planId, state.projectId, state.operations, state.ttlMs, state.maxCount],
  );
  const problems = useMemo(
    // 项目没选也报一条(空状态下的表单本来就该提示先去选)。
    () => validateUnattendedDraft(draft, UNATTENDED_MAX_TTL_MS),
    [draft],
  );

  /** 批准(写):显式 await。入参不含 actor —— 签发主体由主进程写死为 user。 */
  const approve = useCallback(async (): Promise<void> => {
    const input = buildUnattendedApproveInput(draft, UNATTENDED_MAX_TTL_MS);
    if (input === null) return;
    setBusy("approve");
    setActionError(null);
    try {
      const res: UnattendedApproveResult = await api.unattended.approve(input);
      if (res.ok) {
        dispatch({ type: "granted", grantId: res.grantId, expiresAt: res.expiresAt });
        setListNonce((n) => n + 1); // 刚批准的可能就是列表里那条 waiting_approval
      } else {
        dispatch({ type: "approvalRefused", reason: res.reason });
      }
    } catch (err) {
      dispatch({ type: "approvalRefused", reason: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }, [draft]);

  /** 执行(写):显式 await。**只给 grantId** —— 授权内容由宿主从 GrantStore 取回。 */
  const run = useCallback(async (): Promise<void> => {
    if (state.grant === null) return;
    const input = buildUnattendedRunInput(draft, state.grant.grantId, UNATTENDED_MAX_TTL_MS);
    if (input === null) return;
    setBusy("run");
    setActionError(null);
    try {
      const res: UnattendedRunIpcResult = await api.unattended.run(input);
      if (res.ok) {
        dispatch({ type: "ran", report: res.report });
      } else {
        dispatch({ type: "runRefused", reason: res.reason });
      }
      setListNonce((n) => n + 1); // 执行会改变跨重启视图(completedCount 等)
    } catch (err) {
      dispatch({ type: "runRefused", reason: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }, [draft, state.grant]);

  /** 续跑(写):只给 planId;正文与授权由宿主从存档 + GrantStore 取回。 */
  const resume = useCallback(async (planId: string): Promise<void> => {
    setListBusy(planId);
    setActionError(null);
    try {
      const res: UnattendedRunIpcResult = await api.unattendedPlans.resume({ planId });
      if (!res.ok) setActionError(res.reason);
      setListNonce((n) => n + 1);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setListBusy(null);
    }
  }, []);

  /** 放弃(写):幂等 —— 已放弃 / 不存在的返回 `abandoned:false`,不是错误。 */
  const abandon = useCallback(async (planId: string): Promise<void> => {
    setListBusy(planId);
    setActionError(null);
    try {
      await api.unattendedPlans.abandon({ planId });
      setListNonce((n) => n + 1);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setListBusy(null);
    }
  }, []);

  const runReport = state.run !== null && state.run.ok ? state.run.report : null;

  return (
    <div className={cn("mx-auto flex h-full w-full min-h-0 flex-col overflow-y-auto", PANEL_MAX_W.form)}>
      <PanelHeader icon={IconUserCheck} title={t("unattended.title")} hint={t("unattended.intro")} />

      <p className="mb-3 border-l-2 border-warning/40 px-4 py-2 text-[0.7143em] leading-relaxed text-content-subtle">
        {t("unattended.hint")}
      </p>

      {/* ───────── 新建计划:项目 ───────── */}
      <Field className="mb-3" label={t("unattended.projectLabel")}>
        <Select.Root value={state.projectId} onValueChange={(v) => dispatch({ type: "setProject", projectId: v as string })}>
          <Select.Trigger className="w-full">
            <Select.Value>
              {(val: string) => projects.find((p) => p.id === val)?.name ?? t("unattended.projectNone")}
            </Select.Value>
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner className="z-50">
              <Select.Popup>
                <Select.List>
                  <Select.Item value="">
                    <Select.ItemText>{t("unattended.projectNone")}</Select.ItemText>
                  </Select.Item>
                  {projects.map((p) => (
                    <Select.Item key={p.id} value={p.id}>
                      <Select.ItemText>{p.name}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
      </Field>

      {/* ───────── 操作行 ───────── */}
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[0.7857em] font-medium text-content-muted">{t("unattended.operationsLabel")}</span>
        <Button variant="ghost" size="sm" className="gap-1" onClick={() => dispatch({ type: "addRow" })}>
          <IconPlus size={12} />
          {t("unattended.addOperation")}
        </Button>
      </div>
      {state.operations.map((op, idx) => (
        <div key={op.operationId} className="mb-2 rounded border border-edge bg-surface p-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="font-mono text-[0.7143em] text-content-subtle">{op.operationId}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={state.operations.length <= 1}
              onClick={() => dispatch({ type: "removeRow", operationId: op.operationId })}
              aria-label={t("unattended.removeOperation")}
            >
              <IconTrash size={12} />
            </Button>
          </div>
          <Input
            value={op.title}
            placeholder={t("unattended.operationTitlePlaceholder")}
            aria-label={`${t("unattended.operationTitleLabel")} ${idx + 1}`}
            onChange={(e) => dispatch({ type: "editRow", operationId: op.operationId, field: "title", value: e.target.value })}
            className="mb-1.5"
          />
          <textarea
            value={op.prompt}
            placeholder={t("unattended.operationPromptPlaceholder")}
            aria-label={`${t("unattended.operationPromptLabel")} ${idx + 1}`}
            onChange={(e) => dispatch({ type: "editRow", operationId: op.operationId, field: "prompt", value: e.target.value })}
            className="min-h-[64px] w-full resize-y rounded border border-edge bg-surface px-2 py-1.5 text-[0.7857em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
          />
        </div>
      ))}

      <div className="mb-3 flex gap-3">
        <Field label={t("unattended.ttlLabel")} className="flex-1">
          <Input
            type="number"
            value={String(Math.round(state.ttlMs / 60_000))}
            min={1}
            max={UNATTENDED_MAX_TTL_MS / 60_000}
            onChange={(e) => dispatch({ type: "setTtl", ttlMs: Number(e.target.value) * 60_000 })}
          />
        </Field>
        <Field label={t("unattended.maxCountLabel")} className="flex-1">
          <Input
            type="number"
            value={String(state.maxCount)}
            min={1}
            onChange={(e) => dispatch({ type: "setMaxCount", maxCount: Number(e.target.value) })}
          />
        </Field>
      </div>

      {/* 本地预判:一条条报出来,不是"点下去看拒绝"。 */}
      {problems.length > 0 ? (
        <ul className="mb-3 list-disc pl-5 text-[0.7143em] leading-relaxed text-content-subtle">
          {problems.map((p, i) => (
            <li key={`${p.code}-${i}`}>{problemMessage(t, p)}</li>
          ))}
        </ul>
      ) : null}

      <PlanApprovalBar
        testId="unattended-plan-approval-bar"
        canApprove={canApproveUnattended(state)}
        canRun={canRunUnattended(state)}
        grant={state.grant}
        busyApprove={busy === "approve"}
        busyRun={busy === "run"}
        approveLabel={t("unattended.approve")}
        approvingLabel={t("unattended.approving")}
        runLabel={t("unattended.run")}
        runningLabel={t("unattended.running")}
        grantActiveLabel={t("unattended.grantActive")}
        grantExpiredLabel={t("unattended.grantExpired")}
        resetLabel={t("unattended.reset")}
        onApprove={() => void approve()}
        onRun={() => void run()}
        onReset={() => {
          setActionError(null);
          dispatch({ type: "reset" });
        }}
      />

      {state.approvalError !== null ? (
        <ErrorNote tone="warning" icon={IconAlertTriangle} className="mb-3">
          {state.approvalError}
        </ErrorNote>
      ) : null}
      {state.run !== null && !state.run.ok ? (
        <ErrorNote tone="warning" icon={IconAlertTriangle} className="mb-3">
          {state.run.reason}
        </ErrorNote>
      ) : null}
      {runReport !== null ? (
        <p className="mb-3 rounded border border-edge bg-surface px-2 py-1.5 text-[0.7143em] leading-relaxed text-content-subtle">
          {t("unattended.runReport", { done: runReport.results.filter((r) => r.ok).length, total: runReport.results.length })}
          {runReport.stoppedAt !== null ? ` ${t("unattended.runStopped", { at: runReport.stoppedAt, code: runReport.stopCode ?? "" })}` : ""}
        </p>
      ) : null}

      {/* ───────── 跨重启的等待列表 ───────── */}
      <div className="mb-2 flex items-center justify-between border-t border-edge pt-3">
        <span className="text-[0.7857em] font-medium text-content-muted">{t("unattended.pendingLabel")}</span>
        <Button variant="ghost" size="sm" className="gap-1" onClick={() => setListNonce((n) => n + 1)}>
          <IconRefresh size={12} />
          {t("unattended.refresh")}
        </Button>
      </div>
      {actionError !== null ? (
        <ErrorNote tone="warning" icon={IconAlertTriangle} className="mb-2">
          {actionError}
        </ErrorNote>
      ) : null}
      {listError !== null ? (
        <ErrorNote tone="warning" icon={IconAlertTriangle} className="mb-2">
          {listError.message}
        </ErrorNote>
      ) : null}
      {/* 【MC-029 剩余项】坏档的结构化诊断 —— 带状态标签、原因、恢复动作,并把「空列表」
          替换掉(诊断在时不再画 EmptyState:那会被读成"真的没有计划")。 */}
      {archiveProblem !== null ? (
        <ErrorNote tone="danger" icon={IconAlertTriangle} className="mb-2">
          <p>
            {t(
              archiveProblem.state === "unreadable"
                ? "unattended.archiveHealth.unreadable"
                : "unattended.archiveHealth.corrupt",
            )}
          </p>
          {archiveProblem.reason ? <p className="text-[0.7143em]">{archiveProblem.reason}</p> : null}
          <p className="text-[0.7143em]">{t("unattended.archiveHealth.recovery")}</p>
        </ErrorNote>
      ) : null}
      {archiveProblem !== null && pending.length === 0 ? null
        : listLoading && pending.length === 0 ? null : pending.length === 0 ? (
        <EmptyState icon={IconUserCheck} title={t("unattended.pendingEmpty")} desc={t("unattended.pendingEmptyDesc")} />
      ) : (
        pending.map((plan) => (
          <div key={plan.planId} className="mb-2 flex items-center gap-2 rounded border border-edge bg-surface px-2 py-1.5 text-[0.7857em]">
            <Badge variant={PLAN_KIND_VARIANT[plan.kind]}>{t(`unattended.planKind.${plan.kind}` as MessageId)}</Badge>
            <span className="font-mono text-[0.7857em] text-content-subtle">{plan.planId}</span>
            <span className="text-content-muted">
              {t("unattended.pendingProgress", { done: plan.completedCount, total: plan.operationCount })}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button variant="secondary" size="sm" disabled={plan.kind !== "resumable" || listBusy !== null} onClick={() => void resume(plan.planId)}>
                {listBusy === plan.planId ? t("unattended.resuming") : t("unattended.resume")}
              </Button>
              <Button variant="ghost" size="sm" disabled={listBusy !== null} onClick={() => void abandon(plan.planId)}>
                {t("unattended.abandon")}
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
