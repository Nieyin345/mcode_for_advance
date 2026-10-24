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
import { useCallback, useMemo, useState, type ComponentType } from "react";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { Badge, Button, EmptyState, ErrorNote, Skeleton } from "@renderer/components/ui/index.js";
import { cn } from "@renderer/lib/cn.js";
import {
  IconBolt,
  IconCheck,
  IconClock,
  IconGitBranch,
  IconListCheck,
  IconLoader2,
  IconMessage,
  IconRobot,
  IconUser,
  IconX,
} from "@renderer/lib/icons.js";
import type { TablerIconProps } from "@renderer/lib/icons.js";
import type { Task, TaskOrigin, TaskStatus } from "@contracts/ipc/task";
import type { Approval, ApprovalOutcome } from "@contracts/ipc/approval";

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

/**
 * 来源类型 → 图标 + 无障碍文案。
 *
 * 契约里 `origin.kind` 有五个值（`task.ts:105`）。**这里必须是全集** ——
 * 少一个会让那种来源的任务不显示图标，而「没图标」在界面上读起来像「没有来源」，
 * 不是「这个来源我不认识」。用 `Record<TaskOrigin["kind"], …>` 而不是
 * `Partial<…>`，少写一个 key 会当场 typecheck 失败。
 */
const ORIGIN_META: Record<TaskOrigin["kind"], { Icon: ComponentType<TablerIconProps>; key: MessageId }> = {
  session: { Icon: IconMessage, key: "taskCenter.origin.session" },
  user: { Icon: IconUser, key: "taskCenter.origin.user" },
  agent: { Icon: IconRobot, key: "taskCenter.origin.agent" },
  workflow: { Icon: IconGitBranch, key: "taskCenter.origin.workflow" },
  automation: { Icon: IconBolt, key: "taskCenter.origin.automation" },
};

/**
 * 【T109-C】七种审批结论 → 界面文案。
 *
 * **七种不是两种**：`answered`/`dismissed` 是「问答」的两种结果，
 * `approved`/`rejected` 是「计划」的，`cancelled` 是「会话取消」（**不是用户拒绝**）。
 * 把它们都写成「允许/拒绝」会让用户看不懂「我明明没拒绝过，为什么这里写拒绝」。
 *
 * 和 `STATUS_META` / `ORIGIN_META` 一样用完整 `Record<>`（不是 Partial）：
 * 新增一种结论会当场 typecheck 失败，而不是静默显示成空白。
 */
const APPROVAL_OUTCOME_META: Record<ApprovalOutcome, { key: MessageId }> = {
  allow: { key: "taskCenter.approval.allow" },
  deny: { key: "taskCenter.approval.deny" },
  answered: { key: "taskCenter.approval.answered" },
  dismissed: { key: "taskCenter.approval.dismissed" },
  approved: { key: "taskCenter.approval.approved" },
  rejected: { key: "taskCenter.approval.rejected" },
  cancelled: { key: "taskCenter.approval.cancelled" },
};

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
  /**
   * 【T111】**同时只能展开一条** —— 这不是审美选择，是 280px 的后果。
   *
   * 右栏可以被拖窄到这个面板已经没有任何横向余量。详情区一展开就会很高
   * （失败原因 + 产物列表 + 验收证据），**两条同时展开会把列表推出屏幕**，
   * 用户就失去了「我在哪条任务上」的位置感。
   *
   * 存 id 而不是布尔：布尔只能表达「展开了没有」，表达不了「展开的是哪一条」，
   * 那样点第二行时就没法知道该收起谁。
   */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // 跨会话全量：不传 `sessionId`（T99 的核心能力）。
  const { data, loading, error, refetch } = useRpc(
    () => api.task.list(filter === "all" ? {} : { status: filter }),
    [filter],
    { toastOnError: false },
  );

  const tasks = data?.tasks ?? [];

  /**
   * 【T111】会话标题表 —— **面板挂载时取一次**，不是每行一次。
   *
   * 详情区的第 4 项要显示「来自对话『帮我整理那份 2024 年的销售数据』」。
   * 只写「来自一个对话」等于把列表里那个图标又重复了一遍，没有增加任何信息。
   *
   * `session.listAll` 一次返回全部会话（含 `title`，`max(80)`），所以这是
   * **一次额外读取**，与任务条数无关。
   *
   * 失败/加载中一律空表 —— 详情区会退化成「来自一个已删除的对话」吗？**不会**，
   * 见 `originTextOf()`：它区分「查不到这个会话」（删了）和「标题表还没到」
   * （仍显示会话 id，不谎称已删除）。
   */
  const { data: sessionPage } = useRpc(
    () => api.session.listAll({}),
    [],
    { toastOnError: false },
  );

  const sessionTitleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sessionPage?.sessions ?? []) {
      const title = (s.title ?? "").trim();
      if (title !== "") m.set(s.id, title);
    }
    return m;
  }, [sessionPage]);

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

  /**
   * 【T109-C】当前展开那条任务所属会话的审批记录。
   *
   * ## ⚠️ 这是「这个会话的审批」，**不是「这条任务的审批」** —— 界面文案必须说清
   *
   * `approvals` 表只有 `session_id`，**没有 `task_id`**（T109 的决定：
   * 审批发生在 `turn.done` 之前，而任务在 `turn.done` 才建 —— 存一个当时还不存在的
   * id 只能存 null）。而 `autoCreate.ts:216-221` 是**每个 turn.done 建一个任务**：
   *
   * ```
   * 一个会话里做了三件事 → 三个任务，而三条审批记录都只带同一个 session_id
   * ```
   *
   * **所以按会话拉，每条任务都会显示整个会话的全部审批。** 这是当前数据模型的
   * 必然结果，不是 bug。
   *
   * 两种处理：① 假装精确（写成「本任务的审批」）—— **那是界面在说谎**；
   * ② 拉会话的、**在文案里说清是会话范围**（本实现）。
   *
   * 精确归属需要给 `approvals` 加 `turn_id`，等有真实多任务会话样本再决定
   * （现在审批表刚建，一次真实使用都还没跑过 —— 零样本时加字段是在猜）。
   *
   * ## 只在展开时拉
   *
   * `enabled` 挂 `expandedId`：没展开就不请求。任务列表可能有几十条，
   * 每条都预先拉一遍审批没有意义。
   */
  const expandedTask = useMemo(
    () => ordered.find((x) => x.id === expandedId),
    [ordered, expandedId],
  );
  const expandedSessionId =
    expandedTask !== undefined && expandedTask.origin.kind === "session"
      ? expandedTask.origin.ref
      : null;
  const { data: approvalPage, loading: approvalsLoading } = useRpc(
    () => expandedSessionId === null
      ? Promise.resolve({ approvals: [] })
      : api.approval.list({ sessionId: expandedSessionId, limit: 50 }),
    [expandedSessionId],
    { enabled: expandedSessionId !== null, toastOnError: false },
  );
  const approvals = approvalPage?.approvals ?? [];


  /**
   * 【T111】点一行：展开它，**并收起之前那条**（同时只展开一条）。
   * 再点同一行 = 收起。
   *
   * 展开时若这一行还处在「拒绝理由输入」状态，那个状态要保留 ——
   * 用户可能先点开看看再回来写理由。
   */
  const toggleExpand = useCallback((taskId: string) => {
    setExpandedId((prev) => (prev === taskId ? null : taskId));
  }, []);

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
              expanded={expandedId === task.id}
              decision={decision?.taskId === task.id ? decision.kind : null}
              draft={draft}
              busy={busy}
              sessionTitle={sessionTitleById.get(task.origin.ref)}
              sessionMapReady={sessionPage !== undefined}
              // 【T109-C】审批记录**只给展开的那一行**（`approvals` 本来就是按
              // 展开的会话拉的）；收起时给空数组，避免别的行误显示。
              approvals={expandedId === task.id ? approvals : []}
              approvalsLoading={expandedId === task.id && approvalsLoading}
              approvalsScope={expandedId === task.id && expandedSessionId !== null ? "session" : "none"}
              onToggle={() => toggleExpand(task.id)}
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

/**
 * 状态筛选条的一个 chip。
 *
 * ## ⚠️ 选中态**不能**用品牌淡底（`design-tokens-smoke` 守这条）
 *
 * 【ARC-005 V2】的规矩：**accent 只留给「运行中 / 需要注意」的信号**。
 * 筛选条的「选中」两样都不是 —— 它是选中态，所以走**中性底 + 边框**表达，
 * 与 `chat/ActivityConsole.tsx:118` 的 `FilterChip` 同一取向。
 *
 * ## 为什么保留现在的形状，不照抄那边
 *
 * 那边是 `rounded-full` + `px-2` + `font-semibold` + `text-[10.5px]`（药丸）。
 * 这里在**右栏（可拖到 280px 宽）**里要横排 7 个 chip（全部 + 六个状态），
 * 药丸形状比现在的紧凑方形多占约三成宽度，会挤成两行 —— 而两行筛选条会
 * 把列表往下推，用户扫任务时少看见一条。**所以只换颜色，保留形状。**
 *
 * ## `aria-pressed` 不是装饰
 *
 * 它是这个 chip **唯一的、和视觉无关的「选中」信号**：将来若有人给筛选条写
 * 键盘或状态断言，只有它能被程序读到（`bg-*` 类名不是语义）。
 */
function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded border px-1.5 py-0.5 text-[11px] transition-colors",
        active
          ? "border-edge bg-surface-muted text-content"
          : "cds-hover-ghost border-transparent text-content-muted hover:text-content",
      )}
    >
      {label}
    </button>
  );
}

/**
 * 【T111】来源那一行的文案。
 *
 * ## 判据：**`ref` 只在「用户可能要去某个地方找它」时才有用**
 *
 * | kind | 主文案 | ref |
 * |---|---|---|
 * | `session` | 来自对话「<标题>」 | 显示（能找那个会话） |
 * | `workflow` | 由工作流发起 | 显示（能找那个工作流） |
 * | `automation` | 由自动化发起 | 显示（能找那个自动化） |
 * | `user` | 你直接创建的 | **不显示** —— 没有可去的地方 |
 * | `agent` | 由 Agent 发起 | **不显示** —— 见下 |
 *
 * ## 为什么 `agent` 不显示 ref
 *
 * 契约注释（`task.ts:106`）写 `ref` 是「会话 id / 工作流 id / 自动化 id」，
 * **`agent` 没有明写**。而**当前没有任何生产路径建 `origin.kind === "agent"` 的任务**
 * （`grep 'kind: "agent"'` 命中的都是 `requester` / hook action，不是 `TaskOrigin`）。
 *
 * 所以这是一个**未来才会有**的分支。我按「最可能的语义」写：agent 的 ref 是它
 * 跑的那个会话 id —— 如果是，那它和 `session` 那条表达的是同一件事，显示两遍是噪音。
 * **等第一条 agent 任务真的出现时回来核这一点。**
 *
 * ## 三种情况不能混
 *
 * - 标表里有这个会话 → 显示标题；
 * - **标题表已加载但查不到** → 会话被删了，说「已删除的对话」。**不能静默降级成
 *   「来自一个对话」** —— 那会让用户以为他没删过；
 * - **标题表还没加载完** → 这是「还不知道」，不是「删了」。仍然显示会话 id，
 *   不谎称已删除。
 */
export function originTextOf(input: {
  origin: TaskOrigin;
  sessionTitle: string | undefined;
  sessionMapReady: boolean;
  t: (key: MessageId, params?: Record<string, string | number>) => string;
}): { text: string; ref: string | null } {
  const { origin, sessionTitle, sessionMapReady, t } = input;
  switch (origin.kind) {
    case "session":
      if (sessionTitle !== undefined) {
        return { text: t("taskCenter.origin.fromSession", { title: sessionTitle }), ref: origin.ref };
      }
      return sessionMapReady
        ? { text: t("taskCenter.origin.fromDeletedSession"), ref: origin.ref }
        : { text: t("taskCenter.origin.fromSessionNoTitle"), ref: origin.ref };
    case "workflow":
      return { text: t("taskCenter.origin.workflow"), ref: origin.ref };
    case "automation":
      return { text: t("taskCenter.origin.automation"), ref: origin.ref };
    case "user":
      return { text: t("taskCenter.origin.user"), ref: null };
    case "agent":
      return { text: t("taskCenter.origin.agent"), ref: null };
  }
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
  sessionTitle,
  sessionMapReady,
  approvals,
  approvalsLoading,
  approvalsScope,
  onToggle,
  onDraft,
  onAccept,
  onReject,
  onCancel,
  onSubmit,
}: {
  task: Task;
  /** 展开详情（与「在填写理由」是两件事，见文件里 `expandedId` 的注释）。 */
  expanded: boolean;
  /** 非 null = 这一行正在填写接受/退回的理由。 */
  decision: "accept" | "reject" | null;
  draft: string;
  busy: boolean;
  /** `origin.kind === "session"` 时的会话标题（查不到 = undefined）。 */
  sessionTitle: string | undefined;
  /** 会话标题表是否已加载 —— 区分「会话被删了」和「标题还没到」。 */
  sessionMapReady: boolean;
  /**
   * 【T109-C】审批记录。**范围是本条任务所属会话，不是本条任务** ——
   * 数据模型里没有 task_id（见面板里那个 memo 的说明）。
   */
  approvals: Approval[];
  approvalsLoading: boolean;
  /** `"session"` = 显示的是整个会话的审批；`"none"` = 这条任务没有会话来源。 */
  approvalsScope: "session" | "none";
  onToggle: () => void;
  onDraft: (v: string) => void;
  onAccept: () => void;
  onReject: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  const meta = STATUS_META[task.status];
  const originMeta = ORIGIN_META[task.origin.kind];
  const canAccept = ACCEPTABLE.includes(task.status);
  const canReject = REJECTABLE.includes(task.status);
  const evidenceRequired = draft.trim() === "";

  const originLine = originTextOf({ origin: task.origin, sessionTitle, sessionMapReady, t });

  return (
    <li className="border-b border-edge/60 last:border-b-0" data-task-id={task.id}>
      <div className="flex flex-col gap-1.5 px-3 py-2">
        {/* ── 第一行：状态 + 来源图标 + 轮次 + goal + 动作 ──
             整行可点（展开详情）—— 用 button 包住文本区，动作按钮在外面。 */}
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            data-toggle-expand=""
            className="min-w-0 flex-1 text-left"
          >
            <div className="flex items-center gap-1.5">
              <Badge variant={meta.variant}>{t(meta.key)}</Badge>
              {/*
                【T109-B】来源**类型**图标。详情里才显示具体是哪个会话 ——
                列表这一行已经有状态徽标 + goal + 轮次，再塞对话标题会把行高撑开，
                而用户扫列表时看的是「哪条要我处理」。
              */}
              {originMeta !== undefined && (
                <span
                  className="flex items-center text-content-subtle"
                  title={t(originMeta.key)}
                  data-origin-kind={task.origin.kind}
                >
                  <originMeta.Icon size={11} />
                </span>
              )}
              {/* 轮次只在退回过之后才显示 —— 首次验收的「第 1 轮」是噪音。 */}
              {task.acceptance !== null && task.acceptance.round > 1 && (
                <span className="text-[11px] text-content-muted">
                  {t("taskCenter.round", { n: task.acceptance.round })}
                </span>
              )}
            </div>
            <div className="mt-1 break-words text-[12px] leading-snug text-content">{task.goal}</div>
          </button>
          <div className="flex shrink-0 items-center gap-1">
            {canAccept && decision === null && (
              <Button size="sm" variant="primary" onClick={onAccept}>
                <IconCheck size={13} />
                {t("taskCenter.accept")}
              </Button>
            )}
            {canReject && decision === null && (
              <Button size="sm" variant="ghost" onClick={onReject}>
                <IconX size={13} />
                {t("taskCenter.reject")}
              </Button>
            )}
          </div>
        </div>

        {/*
          ── 展开区（T111）──
          信息顺序按「用户在**这条任务上做决定**的顺序」，不是「用户最想知道什么」：
          这个面板的核心动作是接受/退回，用户点开一条是在为那个动作收集理由。

            1. 失败原因 / 退回理由 —— 如果这条是 failed/rejected，这就是他点开它的原因
            2. 产物               —— 「它到底做出来什么」，接受/退回的主要判据
            3. 验收证据           —— 「当初凭什么说它通过了」（只有 accepted 有）
            4. 来源               —— 列表里是图标，这里说清是哪个会话
            5. id / 时间          —— 诊断用

          **不重复 goal** —— 用户刚点开的那一行就是它。
          **没有「审批」段** —— 那条功能还不存在，占位「尚未记录」会让用户
          以为记录了但丢了（见文件头 TaskCenterPanel 的说明）。
        */}
        {expanded && (
          <div className="mt-1 flex flex-col gap-1.5 border-l-2 border-edge pl-2" data-task-detail="">
            {task.failureReason !== null && (
              <div className="rounded bg-danger/5 px-2 py-1 text-[11px] text-danger" data-detail="failure">
                {t("taskCenter.failureReason")}{task.failureReason}
              </div>
            )}
            {task.rejectionReason !== null && (
              <div className="rounded bg-warning/5 px-2 py-1 text-[11px] text-warning" data-detail="rejection">
                {t("taskCenter.rejectionReason")}{task.rejectionReason}
              </div>
            )}
            {task.artifacts.length > 0 && (
              <div data-detail="artifacts">
                <div className="text-[10px] text-content-subtle">{t("taskCenter.detailArtifacts")}</div>
                <ul className="flex flex-col gap-0.5">
                  {task.artifacts.map((a) => (
                    <li key={a.path} className="truncate text-[11px] text-content-muted" title={a.path}>
                      {a.description}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {task.acceptance !== null && task.status === "accepted" && (
              <div className="rounded bg-success/5 px-2 py-1 text-[11px] text-success" data-detail="acceptance">
                {t("taskCenter.acceptanceEvidence")}{task.acceptance.evidence}
              </div>
            )}
            <div className="text-[11px] text-content-muted" data-detail="origin">
              {originLine.text}
              {originLine.ref !== null && (
                <span className="ml-1 text-[10px] text-content-subtle">{originLine.ref}</span>
              )}
            </div>
            {/*
              【T109-C】审批记录。位置在「来源」之后、「meta」之前 —— 按 T111 定的
              「用户做决定的顺序」：这条任务要不要验收，信息已经在前四项里了；
              审批是**补充证据**（他当时批了哪些操作），不是决定本身。
              ⚠️ 标题写的是「这个对话里的审批」而不是「本任务的审批」—— 见 memo 说明。
            */}
            {approvalsScope === "session" && (
              <div data-detail="approvals">
                <div className="text-[10px] text-content-subtle">
                  {t("taskCenter.detailApprovals")}
                  <span className="ml-1 text-content-subtle/70">{t("taskCenter.detailApprovalsScope")}</span>
                </div>
                {approvalsLoading && approvals.length === 0 ? (
                  <div className="text-[11px] text-content-subtle">{t("taskCenter.approvalsLoading")}</div>
                ) : approvals.length === 0 ? (
                  // 空态要说清是「这一轮没有需要你批的操作」，不是「记录丢了」。
                  <div className="text-[11px] text-content-subtle">{t("taskCenter.approvalsEmpty")}</div>
                ) : (
                  <ul className="flex flex-col gap-0.5">
                    {approvals.map((a) => (
                      <li key={a.id} className="flex items-start gap-1.5 text-[11px]" data-approval-id={a.id}>
                        <span className="shrink-0 text-content-subtle">
                          {t(APPROVAL_OUTCOME_META[a.decision].key)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-content-muted" title={a.subject}>
                          {a.subject}
                        </span>
                        {a.always && (
                          <span className="shrink-0 text-[10px] text-content-subtle">
                            {t("taskCenter.approvalAlways")}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="flex items-center gap-2 text-[10px] text-content-subtle" data-detail="meta">
              <IconClock size={10} />
              <span>{new Date(task.updatedAt).toLocaleString()}</span>
              <span className="text-content-subtle/60">{task.id}</span>
            </div>
          </div>
        )}

        {/* ── 验收 / 退回的输入区（受控，理由必填） ──
            与「展开详情」是两件事：点动作按钮进入这一态，不要求先展开。 */}
        {decision !== null && (
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
      </div>
    </li>
  );
}
