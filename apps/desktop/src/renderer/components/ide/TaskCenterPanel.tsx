/**
 * 【T100】**任务中心** —— 让用户能看见任务、接受或退回它。
 *
 * ## 它和 `TaskListPanel` 不是一件事（**名字最容易骗人的地方**）
 *
 * 右栏原本就有一个 `ide/TaskListPanel.tsx`，页签名「任务列表」。A 在 T97 核出来：
 * 它读的是 `terminal.list` + `subagentsBySession` + 工作流的 `activeNodes` ——
 * **它回答的是「这台机器此刻在跑什么」**（活动监控，2 秒轮询），不是「有哪些任务、
 * 哪个做完了等我验收」。
 *
 * 两个东西的数据模型都不一样：
 *
 * | | `TaskListPanel`（旧） | 本面板（任务中心） |
 * |---|---|---|
 * | 数据源 | 内存里的活物（终端/子代理/节点） | `tasks` 表（持久记录） |
 * | 生命周期 | 关了终端就消失 | 跨会话、跨重启 |
 * | 刷新 | 2 秒轮询 | 用户动作后重取 |
 * | 状态 | 跑/没跑 | 7 态，含 **done ≠ accepted** |
 * | 用户能做什么 | 看、关终端 | **验收 / 退回** |
 *
 * **所以是两条独立的路，没有合并**：把验收塞进一个轮询终端的面板，会让「这个任务
 * 做完了没有」和「那个终端还开着没有」混在同一个视觉密度里，而且旧面板的每一处
 * 刷新都会重建任务列表的滚动位置。
 *
 * ## 为什么「接受 / 退回」必须先填理由
 *
 * `TaskAcceptInputSchema.evidence` 与 `TaskRejectInputSchema.reason` 都是
 * `min(1)` —— **契约层就不许空着说「通过」**。这是路线图 §3「执行完成 ≠ 验收通过」
 * 的落点：一句没有理由的通过，事后看不出它是「真的验过」还是「随手一点」。
 *
 * 所以本面板不用 `ConfirmDialog`（那个组件没有输入框），而是自己带一个受控的输入区：
 * 点「接受」先把这一条展开成「写理由 → 确认」，理由为空时确认按钮禁用。
 *
 * ## 它**不**做什么
 *
 *  - 不建任务（`task.create` 不面向渲染端）—— 任务由执行方发起，用户在这里验收；
 *  - 不改执行态（`running`/`done` 是执行方写的）；
 *  - **不挂手机端**：`webApi.ts` 里 `task.*` 全是 `webUnsupported`，
 *    见那里 `task` 常量的注释。
 */
import { useCallback, useMemo, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { Badge, Button, EmptyState, ErrorNote, Skeleton } from "@renderer/components/ui/index.js";
import { cn } from "@renderer/lib/cn.js";
import {
  IconCheck,
  IconClock,
  IconListCheck,
  IconLoader2,
  IconX,
} from "@renderer/lib/icons.js";
import type { Task, TaskStatus } from "@contracts/ipc/task";

/**
 * 状态 → 界面。**七态一个不少**（契约里就是这么多个）。
 *
 * `done` 与 `accepted` 的文案**必须能一眼分开** —— 这是 T99 在数据模型上刻意保留
 * 的区别，界面如果都写成「完成」，那层区分在医院里就白做了。
 */
const STATUS_META: Record<TaskStatus, { key: `taskCenter.status.${TaskStatus}`; variant: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  pending: { key: "taskCenter.status.pending", variant: "neutral" },
  running: { key: "taskCenter.status.running", variant: "accent" },
  blocked: { key: "taskCenter.status.blocked", variant: "warning" },
  done: { key: "taskCenter.status.done", variant: "accent" },
  failed: { key: "taskCenter.status.failed", variant: "danger" },
  accepted: { key: "taskCenter.status.accepted", variant: "success" },
  rejected: { key: "taskCenter.status.rejected", variant: "danger" },
};

/**
 * 能验收的状态 —— **只有 `done`**。
 *
 * 不是「done 和 failed 都能验收」：`failed` 的执行方已经说了「我没做成」，
 * 用户能做的只有退回（让它返修）。允许验收一个失败的任务，等于给执行方
 * 一条「失败也能被盖章通过」的路。
 */
const ACCEPTABLE: readonly TaskStatus[] = ["done"] as const;
/** 能退回的状态：做完了但不满意，或者根本没做成。 */
const REJECTABLE: readonly TaskStatus[] = ["done", "failed"] as const;

type Decision = { taskId: string; kind: "accept" | "reject" } | null;

/**
 * 提交一次验收 / 退回 —— **导出是为了让套件直接执行这段真代码**。
 *
 * 为什么不把它留在 `submit` 里：那个 callback 只能由面板里的按钮触发，而仓库的
 * 极小 React 运行时**不执行子组件**（`TaskRow` 不会被调用），所以「整面板挂载 →
 * 点按钮 → 真的发 RPC」这条路在无头环境里走不通。
 *
 * 抽出来之后，套件拿真函数、真 `api.task.*`、真 toast store 跑一遍 —— 验的仍是
 * **生产代码**，不是副本（CLAUDE.md：套件要跑真身）。
 *
 * 返回值让调用方决定收尾：`ok:false` 时**不**关闭输入区，用户可以改完再试。
 */
export async function submitDecision(
  decision: { taskId: string; kind: "accept" | "reject" },
  text: string,
  failureTitle: string,
): Promise<{ ok: boolean }> {
  if (text.trim() === "") return { ok: false };
  try {
    if (decision.kind === "accept") {
      await api.task.accept({ id: decision.taskId, evidence: text });
    } else {
      await api.task.reject({ id: decision.taskId, reason: text });
    }
    return { ok: true };
  } catch (err) {
    // 主进程的结果是权威（ARC-009）：失败要把原话给用户看，不能吞掉。
    useToastStore.getState().push({
      kind: "error",
      title: failureTitle,
      body: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}

export function TaskCenterPanel() {
  const { t } = useI18n();
  const [filter, setFilter] = useState<TaskStatus | "all">("all");
  const [decision, setDecision] = useState<Decision>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // 跨会话全量：不传 `sessionId`（T99 的核心能力）。
  const { data, loading, error, refetch } = useRpc(
    () => api.task.list(filter === "all" ? {} : { status: filter }),
    [filter],
    { toastOnError: false },
  );

  const tasks = data?.tasks ?? [];

  /**
   * 按「等你动手的」排前面。
   *
   * 用户打开这个面板，最想知道的是「有什么需要我」。`done`（跑完了等验收）和
   * `rejected`（我退回过、等着返修）比 `accepted` 紧急；同组内按更新时间倒序，
   * 新的在上面。
   */
  const ordered = useMemo(() => {
    const rank = (s: TaskStatus): number => {
      if (s === "done") return 0;      // 等我验收
      if (s === "failed") return 1;    // 等我决定退不退
      if (s === "running" || s === "blocked") return 2;
      if (s === "pending") return 3;
      if (s === "rejected") return 4;  // 等执行方返修，我暂时没事
      return 5;                         // accepted
    };
    return [...tasks].sort((a, b) => rank(a.status) - rank(b.status) || b.updatedAt - a.updatedAt);
  }, [tasks]);

  const openDecision = useCallback((taskId: string, kind: "accept" | "reject") => {
    setDecision({ taskId, kind });
    setDraft("");
  }, []);

  const closeDecision = useCallback(() => {
    setDecision(null);
    setDraft("");
  }, []);

  /**
   * 提交验收 / 退回。
   *
   * **理由为空直接不提交** —— 契约层会拒（`min(1)`），但在这里挡住能给用户
   * 一句「为什么按钮是灰的」，而不是等他按下再吃一个 zod 报错。
   */
  const submit = useCallback(async () => {
    if (decision === null) return;
    const text = draft.trim();
    if (text === "") return;
    setBusy(true);
    const r = await submitDecision(decision, text, t("taskCenter.actionFailed"));
    setBusy(false);
    if (r.ok) {
      closeDecision();
      await refetch();
    }
  }, [decision, draft, closeDecision, refetch, t]);

  const pendingCount = tasks.filter((x) => x.status === "done" || x.status === "failed").length;

  return (
    <div className="flex h-full min-h-0 flex-col" data-task-center="">
      {/* ── 头部：标题 + 等你的数量 + 状态筛选 ── */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-edge px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-content">
            <IconListCheck size={14} />
            {t("taskCenter.title")}
          </div>
          <div className="flex items-center gap-2">
            {pendingCount > 0 && (
              <Badge variant="accent">{t("taskCenter.awaitingYou", { count: pendingCount })}</Badge>
            )}
            <Button size="sm" variant="ghost" onClick={() => void refetch()} disabled={loading}>
              {loading ? <IconLoader2 size={13} className="animate-spin" /> : t("taskCenter.refresh")}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")} label={t("taskCenter.filter.all")} />
          {ACCEPTABLE.concat(REJECTABLE.filter((s) => !ACCEPTABLE.includes(s)))
            .concat(["running", "blocked", "pending", "rejected", "accepted"])
            .filter((s, i, arr) => arr.indexOf(s) === i) // 去重（done 在两个数组里都出现）
            .map((s) => (
              <FilterChip
                key={s}
                active={filter === s}
                onClick={() => setFilter(s)}
                label={t(STATUS_META[s].key)}
              />
            ))}
        </div>
      </div>

      {/* ── 列表 ── */}
      <div className="min-h-0 flex-1 overflow-auto">
        {error !== null && (
          <div className="p-3">
            <ErrorNote title={t("taskCenter.loadFailed")} action={<Button size="sm" onClick={() => void refetch()}>{t("taskCenter.retry")}</Button>}>
              {error.message}
            </ErrorNote>
          </div>
        )}

        {loading && data === undefined && (
          <div className="flex flex-col gap-2 p-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {!loading && error === null && ordered.length === 0 && (
          <div className="p-6">
            <EmptyState
              icon={IconListCheck}
              title={filter === "all" ? t("taskCenter.empty") : t("taskCenter.emptyFiltered")}
              desc={t("taskCenter.emptyDesc")}
            />
          </div>
        )}

        <ul className="flex flex-col">
          {ordered.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              expanded={decision?.taskId === task.id}
              decision={decision?.taskId === task.id ? decision.kind : null}
              draft={draft}
              busy={busy}
              onDraft={setDraft}
              onAccept={() => openDecision(task.id, "accept")}
              onReject={() => openDecision(task.id, "reject")}
              onCancel={closeDecision}
              onSubmit={() => void submit()}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded px-1.5 py-0.5 text-[11px] transition-colors",
        active ? "bg-accent/15 text-accent" : "text-content-muted hover:bg-surface-hover hover:text-content",
      )}
    >
      {label}
    </button>
  );
}

/**
 * 单行任务 —— **导出是为了让套件把它当根组件挂载**。
 *
 * 为什么：仓库的极小 React 运行时（各 smoke 目录下的 `fakeReact.ts`）不执行子组件，
 * 只把 `{type, props}` 留在树里。而「点接受 → 出输入框 → 空理由不能提交」
 * 这条链全在这一行里。把它导出、单独挂载，套件测的就是**真代码的 handler**
 * 而不是一份副本（见 CLAUDE.md：套件要跑真身）。
 */
export function TaskRow({
  task,
  expanded,
  decision,
  draft,
  busy,
  onDraft,
  onAccept,
  onReject,
  onCancel,
  onSubmit,
}: {
  task: Task;
  expanded: boolean;
  decision: "accept" | "reject" | null;
  draft: string;
  busy: boolean;
  onDraft: (v: string) => void;
  onAccept: () => void;
  onReject: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  const meta = STATUS_META[task.status];
  const canAccept = ACCEPTABLE.includes(task.status);
  const canReject = REJECTABLE.includes(task.status);
  const evidenceRequired = draft.trim() === "";

  return (
    <li className="border-b border-edge/60 last:border-b-0" data-task-id={task.id}>
      <div className="flex flex-col gap-1.5 px-3 py-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <Badge variant={meta.variant}>{t(meta.key)}</Badge>
              {/* 轮次只在退回过之后才显示 —— 首次验收的「第 1 轮」是噪音。 */}
              {task.acceptance !== null && task.acceptance.round > 1 && (
                <span className="text-[11px] text-content-muted">
                  {t("taskCenter.round", { n: task.acceptance.round })}
                </span>
              )}
            </div>
            <div className="mt-1 break-words text-[12px] leading-snug text-content">{task.goal}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {canAccept && !expanded && (
              <Button size="sm" variant="primary" onClick={onAccept}>
                <IconCheck size={13} />
                {t("taskCenter.accept")}
              </Button>
            )}
            {canReject && !expanded && (
              <Button size="sm" variant="ghost" onClick={onReject}>
                <IconX size={13} />
                {t("taskCenter.reject")}
              </Button>
            )}
          </div>
        </div>

        {/* 失败原因 / 退回理由：**执行方和用户各自的原话**，别混成一句。 */}
        {task.failureReason !== null && (
          <div className="rounded bg-danger/5 px-2 py-1 text-[11px] text-danger">
            {t("taskCenter.failureReason")}{task.failureReason}
          </div>
        )}
        {task.rejectionReason !== null && (
          <div className="rounded bg-warning/5 px-2 py-1 text-[11px] text-warning">
            {t("taskCenter.rejectionReason")}{task.rejectionReason}
          </div>
        )}

        {/* 产物 —— 只列路径与人话说明，不在这里打开（打开是另一条路）。 */}
        {task.artifacts.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {task.artifacts.map((a) => (
              <li key={a.path} className="truncate text-[11px] text-content-muted" title={a.path}>
                {a.description}
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2 text-[10px] text-content-subtle">
          <IconClock size={10} />
          <span>{new Date(task.updatedAt).toLocaleString()}</span>
          <span className="text-content-subtle/60">{task.id}</span>
        </div>

        {/* ── 验收 / 退回的输入区（受控，理由必填） ── */}
        {expanded && decision !== null && (
          <div className="mt-1 flex flex-col gap-1.5 rounded border border-edge bg-surface/60 p-2">
            <div className="text-[11px] text-content">
              {decision === "accept" ? t("taskCenter.evidencePrompt") : t("taskCenter.reasonPrompt")}
            </div>
            <textarea
              value={draft}
              onChange={(e) => onDraft(e.target.value)}
              rows={3}
              autoFocus
              placeholder={decision === "accept" ? t("taskCenter.evidencePlaceholder") : t("taskCenter.reasonPlaceholder")}
              className="w-full resize-y rounded border border-edge bg-surface px-2 py-1 text-[12px] text-content outline-none focus:border-accent"
              disabled={busy}
            />
            <div className="flex items-center justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
                {t("taskCenter.cancel")}
              </Button>
              <Button
                size="sm"
                variant={decision === "accept" ? "primary" : "danger"}
                data-confirm=""
                onClick={onSubmit}
                disabled={evidenceRequired || busy}
                // 灰按钮要能解释为什么灰 —— 别让用户猜。
                title={evidenceRequired ? t("taskCenter.reasonRequired") : undefined}
              >
                {busy && <IconLoader2 size={13} className="animate-spin" />}
                {decision === "accept" ? t("taskCenter.confirmAccept") : t("taskCenter.confirmReject")}
              </Button>
            </div>
            {evidenceRequired && (
              <div className="text-[10px] text-content-subtle">{t("taskCenter.reasonRequired")}</div>
            )}
          </div>
        )}

        {/* 已验收：把当初的理由显示出来（「凭什么说它通过了」）。 */}
        {task.acceptance !== null && task.status === "accepted" && (
          <div className="rounded bg-success/5 px-2 py-1 text-[11px] text-success">
            {t("taskCenter.acceptanceEvidence")}{task.acceptance.evidence}
          </div>
        )}
      </div>
    </li>
  );
}
