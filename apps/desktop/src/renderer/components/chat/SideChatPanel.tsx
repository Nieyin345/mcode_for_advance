/**
 * Side chat panel — the right panel's "quick ask" tab.
 *
 * A side chat is a full hidden session (kind="side") parented to the ACTIVE
 * main session: it streams, approves tools and runs turns fully concurrent
 * with its parent (RuntimeManager keys everything by sessionId), never
 * appears in the left-bar lists, and its history survives restarts. One main
 * session can own many side chats — this panel lists them per parent and
 * hosts one at a time in a reused ChatPane.
 *
 * The list ALSO surfaces the main session's live SUBAGENTS (Task-tool
 * children) above the side-chat list: running first, finished ones kept for
 * review until the next turn. Clicking one opens a read-only transcript view
 * (no composer — the subagent is driven by the model, not the user) fed by
 * the `subagent.transcript` event channel.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@contracts/session";
import type { SubagentSnapshot } from "@contracts/runtime";
import { cn } from "@renderer/lib/cn.js";
import { formatRelativeTime } from "@renderer/lib/time.js";
import {
  IconArrowLeft,
  IconMessages,
  IconPlus,
  IconTrash,
} from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { useSessionStore, type Block } from "@renderer/stores/sessionStore.js";
import { ConfirmDialog } from "@renderer/components/ui/index.js";
import { ChatPane } from "@renderer/components/chat/ChatPane.js";
import { NewSubChatPicker } from "./NewSubChatPicker.js";
import { useFileViewStore } from "@renderer/stores/fileViewStore.js";
import { MessageBlocks } from "./MessageBlocks.js";
import { mapTranscriptBlock } from "./transcriptBlocks.js";
import { SUBAGENT_STATUS_META, fmtUsage } from "./activityShared.js";

export function SideChatPanel() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sideChats = useSessionStore((s) =>
    s.activeSessionId ? s.sideChatsByParent[s.activeSessionId] : undefined,
  );
  const activeSideChatId = useSessionStore((s) => s.activeSideChatId);
  const subagents = useSessionStore((s) =>
    s.activeSessionId ? s.subagentsBySession[s.activeSessionId] : undefined,
  );
  const hydrateSideChats = useSessionStore((s) => s.hydrateSideChats);
  const createSideChat = useSessionStore((s) => s.createSideChat);
  const selectSideChat = useSessionStore((s) => s.selectSideChat);
  const closeSideChatView = useSessionStore((s) => s.closeSideChatView);
  const openTab = useSessionStore((s) => s.openTab);
  const createSubChat = useSessionStore((s) => s.createSubChat);
  /** 「选档案」选择器开着没有 —— 非 null 时的那个矩形是它的锚（那个「+」的位置）。 */
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);
  // The subagent whose read-only transcript is open (by taskId). Local state:
  // leaving the tab or switching the parent session falls back to the list —
  // derived, so a roster rebuild that drops the id also resets the view.
  const [viewSubagentTaskId, setViewSubagentTaskId] = useState<string | null>(null);
  useEffect(() => {
    setViewSubagentTaskId(null);
  }, [activeSessionId]);
  // One-shot open request from OUTSIDE the panel (the activity console's
  // subagent row): enter the requested view when it belongs to the current
  // parent, then drain the request either way (chatFileQueue hand-off
  // pattern). The panel mounts on tab switch — its first effect run consumes
  // whatever request opened it.
  const pendingSubagentView = useSessionStore((s) => s.pendingSubagentView);
  const clearPendingSubagentView = useSessionStore((s) => s.clearPendingSubagentView);
  useEffect(() => {
    if (!pendingSubagentView) return;
    if (pendingSubagentView.sessionId === activeSessionId) {
      setViewSubagentTaskId(pendingSubagentView.taskId);
    }
    clearPendingSubagentView();
  }, [pendingSubagentView, activeSessionId, clearPendingSubagentView]);
  const viewedSubagent = viewSubagentTaskId
    ? subagents?.find((a) => a.taskId === viewSubagentTaskId)
    : undefined;

  // Parent row lookup (title + liveness) spans the active window + pinned
  // bucket — a pinned main session still owns its side chats.
  const mainSessions = useSessionStore((s) => s.sessionsByProject[s.activeProjectId ?? ""]);
  const pinnedSessions = useSessionStore((s) => s.pinnedSessions);
  const parentRow = useMemo(
    () =>
      activeSessionId
        ? mainSessions?.find((x) => x.id === activeSessionId) ??
          pinnedSessions.find((x) => x.id === activeSessionId)
        : undefined,
    [activeSessionId, mainSessions, pinnedSessions],
  );

  // Hydrate the active parent's list (covers first open + main-session
  // switches; the fetch itself is cheap and idempotent).
  useEffect(() => {
    if (activeSessionId) void hydrateSideChats(activeSessionId);
  }, [activeSessionId, hydrateSideChats]);

  const fromSideList = activeSideChatId
    ? sideChats?.find((x) => x.id === activeSideChatId)
    : undefined;
  /**
   * **`activeSideChatId` 可能指的不是子对话，而是图上某一格的节点会话**
   * （2026-09-21）——
   *
   * 用户在图上点一格，`WorkflowBoardPanel.pickNode` 会 `selectSideChat(nodeSessionId)`，
   * 意思是"打开这一格的对话"。而**节点会话是 `kind: "node"`，`sideChatsByParent`
   * 里只有 `kind: "side"`**（见 `SessionRepo.listSideByParent` 的 WHERE）—— 所以光查
   * 那个列表是找不到的，`activeSide` 会是 undefined、面板**压根不切**，用户点下去
   * 什么都没发生。
   *
   * 这里补一次节点会话的查询（`session.listNodes` —— 契约上它是**唯一**会返回节点
   * 会话的查询，见 `SelectionQuoteMenu` 的头注）。只在 side 列表查不到时才发，
   * 所以常态（点子对话）没有额外开销。
   */
  const [nodeSession, setNodeSession] = useState<Session | null>(null);
  useEffect(() => {
    if (!activeSideChatId || fromSideList) {
      setNodeSession(null);
      return;
    }
    let cancelled = false;
    void api.session
      .listNodes({ sessionId: activeSessionId ?? "" })
      .then((res) => {
        if (cancelled) return;
        setNodeSession(res.sessions.find((x) => x.id === activeSideChatId) ?? null);
      })
      .catch(() => {
        if (!cancelled) setNodeSession(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSideChatId, fromSideList, activeSessionId]);

  if (viewedSubagent && activeSessionId) {
    return (
      <SubagentView
        agent={viewedSubagent}
        sessionId={activeSessionId}
        onBack={() => setViewSubagentTaskId(null)}
      />
    );
  }

  // The chat view only applies when the active side chat belongs to the
  // CURRENT parent — after a main-session switch the stale id falls back to
  // the list view (derived, so no reset effect is needed).
  /**
   * **`activeSideChatId` 也可能是主对话自己**（2026-09-21）—— 列表最上面那一行
   * （`MainSessionRow`）点开时就把主对话的 id 放进这个字段，好让展开/收起复用同一套。
   *
   * ⚠️ 它**两个列表都查不到**：主对话既不是 `kind: "side"`（`sideChatsByParent`），
   * 也不是 `kind: "node"`（`session.listNodes`）。所以这里必须显式认一次，
   * 否则点那一行会**什么都不发生**（`activeSide` 落空 → 回列表视图）。
   */
  const mainRow = useMemo(
    () =>
      activeSideChatId && activeSideChatId === activeSessionId ? parentRow : undefined,
    [activeSideChatId, activeSessionId, parentRow],
  );

  const activeSide = fromSideList ?? nodeSession ?? mainRow ?? undefined;
  const view: "list" | "chat" = activeSide ? "chat" : "list";

  if (view === "chat" && activeSide) {
    return <SideChatView session={activeSide} parentRow={parentRow} />;
  }
  return (
    <>
      <SideChatListView
        hasMainSession={!!activeSessionId}
        parentTitle={parentRow?.title}
        sideChats={sideChats}
        subagents={subagents}
        onOpenSubagent={setViewSubagentTaskId}
        onCreate={() => void createSideChat()}
        onOpen={(id) => void selectSideChat(id)}
        onChooseProfile={setPickerAnchor}
      />
      {/* ⚠️ **挂在 `<>` 里而不是 `SideChatListView` 内部** —— 那个面板自己有若干
          early return（子代理视图 / chat 视图），挂在它里面的话，**展开一条对话时
          选择器会跟着消失**，而用户可能正是在那一刻想再建一条。 */}
      <NewSubChatPicker
        open={pickerAnchor !== null}
        anchorRect={pickerAnchor}
        onClose={() => setPickerAnchor(null)}
        onPick={(choice) => {
          void (async () => {
            const session = await createSubChat({
              profile: choice.profile ?? null,
              memory: choice.memory,
            });
            setPickerAnchor(null);
            // 建完就展开它 —— 点了「新建」，下一步一定是要跟它说话。
            if (session) void selectSideChat(session.id);
          })();
        }}
      />
    </>
  );
}

/* ── List view ── */

function SideChatListView({
  hasMainSession,
  parentTitle,
  sideChats,
  subagents,
  onOpenSubagent,
  onCreate,
  onOpen,
  onChooseProfile,
}: {
  hasMainSession: boolean;
  parentTitle?: string;
  sideChats: ReadonlyArray<Session> | undefined;
  subagents: ReadonlyArray<SubagentSnapshot> | undefined;
  onOpenSubagent: (taskId: string) => void;
  /** 建一条**空白**子对话（不弹选择器的那条路，见 `onChooseProfile`）。 */
  onCreate: () => void;
  onOpen: (id: string) => void;
  /**
   * 弹「选档案」那个选择器（2026-09-21）。
   *
   * ★ 用户的要求：「新建子对话就是子节点，**要能够选择当前的子代理模版**，添加的
   * 单独的子代理对话是**没有流程图的上下文**的，现在这个创建子对话可以选择**默认、
   * 或者是档案、或者是带有记忆的档案**」。
   *
   * 那个选择器**本来就有**（`NewSubChatPicker`），只是一直挂在输入框的「+」菜单上；
   * 右栏这个「+」走的是光秃秃的 `createSideChat()`。接上之后两处入口一致。
   */
  onChooseProfile: (anchor: DOMRect) => void;
}) {
  const { t } = useI18n();
  const deleteSession = useSessionStore((s) => s.deleteSession);
  // Row awaiting delete confirmation — held so the dialog can show the
  // row's display title (placeholder resolved) while it's open.
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);
  // Running first (stable sort keeps arrival order within each group) — the
  // live ones are what the user wants to check; finished ones stay reviewable
  // below until the next turn clears the roster.
  const orderedSubagents = useMemo(
    () =>
      subagents
        ? [...subagents].sort(
            (a, b) =>
              (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1),
          )
        : undefined,
    [subagents],
  );
  return (
    <div className="flex h-full flex-col">
      {/**
        * **只有一个加号，没有那一行框**（2026-09-21）。
        *
        * ★ 用户（截图）：「这里的新建新的子代理弹出的框也页面外面看不到，还有这个新建
        * **只要一个加号就行了，这一个框就不要了**，而且还**和主对话的置顶冲突，我老是
        * 以为有两个对话**」。
        *
        * 根因就是原来那一行：它左边写着**主对话的标题**，而新会话还没命名、默认就叫
        * "New session" —— 于是那一行**看起来像一条叫这个名字的对话**，紧挨着下面那条
        * 「主对话」，两条框叠在一起。
        *
        * 现在只留一个**没有边框、没有底色**的加号，靠右放。它不再像一条对话。
        *
        * （`hasMainSession` 那个判断也去掉了：没有主会话时按下去不会有反应这件事，
        *   由 `NewSubChatPicker` 那一侧自己说清楚 —— 而空列表本来就会告诉用户
        *   "先开一个会话"。多一层灰态只是让那个加号看起来像坏了。） */}
      <div className="flex shrink-0 justify-end px-1.5 pb-0.5 pt-1">
        <button
          type="button"
          // 弹「选档案」选择器（默认 / 档案 / 档案+记忆）—— 见 `onChooseProfile`。
          onClick={(e) => onChooseProfile(e.currentTarget.getBoundingClientRect())}
          title={t("sideChat.newChat")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-surface-hover hover:text-accent"
        >
          <IconPlus size={14} />
        </button>
      </div>

      {/* List body. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {/* **主对话那一行**（2026-09-21）。用户的要求：「主对话不是一直都在这个列表里面…
            只有主页面被占据了他才会过去」，以及「在列表最上面，稍微和其他的子代理有点
            不一样就行，边框加粗之类的」。
            ——
            所以它**只在中间被文件占住时**才出现：那时主对话被挤出了中央，得有个地方能
            点回它、也能对它说话。平常中央就是它，列表里再摆一行是多余的。
            边框加粗 + 主题色描边是"这一条和下面那几条不是一类"，不是"它更重"。 */}
        <MainSessionRow />

        {/* Live subagents (model-initiated Task children) — read-only
            transcripts behind each row. */}
        {orderedSubagents && orderedSubagents.length > 0 && (
          <div className="mb-2">
            <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
              {t("sideChat.subagentsSection")}
            </div>
            <ul className="space-y-0.5">
              {orderedSubagents.map((a) => (
                <SubagentRow key={a.taskId} agent={a} onOpen={() => onOpenSubagent(a.taskId)} />
              ))}
            </ul>
          </div>
        )}
        {sideChats === undefined ? (
          <p className="px-2 py-4 text-xs text-content-subtle">{t("sideChat.loading")}</p>
        ) : sideChats.length === 0 && !(orderedSubagents && orderedSubagents.length > 0) ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <IconMessages size={22} className="text-content-subtle" />
            <p className="text-xs font-medium text-content-muted">{t("sideChat.emptyTitle")}</p>
            <p className="text-[11px] leading-relaxed text-content-subtle">{t("sideChat.emptyHint")}</p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {sideChats.map((s) => (
              <SideChatRow key={s.id} session={s} onOpen={onOpen} onDelete={setPendingDelete} />
            ))}
          </ul>
        )}
      </div>

      {/* Delete confirmation — hard-deletes the side chat (messages cascade
          in the DB); the row leaves the list via applySessionDeletedState. */}
      <ConfirmDialog
        open={pendingDelete != null}
        danger
        title={t("sideChat.deleteChat")}
        description={t("sideChat.deleteChatDesc", {
          title: pendingDelete ? displayTitle(pendingDelete, t("sideChat.titlePlaceholder")) : "",
        })}
        confirmText={t("common.delete")}
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
        onConfirm={() => {
          if (pendingDelete) void deleteSession(pendingDelete.id);
        }}
      />
    </div>
  );
}

function SubagentRow({
  agent,
  onOpen,
}: {
  agent: SubagentSnapshot;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const running = agent.status === "running";
  const usage = fmtUsage(agent);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={agent.description}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
      >
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            running
              ? "animate-pulse bg-accent"
              : agent.status === "completed"
                ? "bg-accent/50"
                : agent.status === "failed" || agent.status === "killed"
                  ? "bg-danger/70"
                  : "bg-content-subtle/40",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            {agent.subagentType && (
              <span className="shrink-0 rounded bg-info/20 px-1 text-[9px] font-medium uppercase tracking-wide text-info">
                {agent.subagentType}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-xs text-content">
              {agent.description || t("sideChat.titlePlaceholder")}
            </span>
          </span>
          {(agent.lastToolName || usage) && (
            <span className="mt-0.5 block truncate text-[10px] text-content-subtle">
              {[agent.lastToolName, usage].filter(Boolean).join(" · ")}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/** Row/view title with the "Quick ask" placeholder resolved to the locale
 *  label — the raw placeholder (the DB-side sentinel for "never used") must
 *  never reach the UI. */
function displayTitle(session: Session, placeholder: string): string {
  return session.title === "Quick ask" ? placeholder : session.title;
}

/**
 * **主对话那一行** —— 列表最上面那条，只在"主对话被挤出中央"时出现。
 *
 * ## 什么时候出现
 *
 * 用户的要求：「主对话不是一直都在这个列表里面……**只有主页面被占据了他才会过去**」。
 * 所谓"被占据"就是**中间在看一个文件**（`fileViewStore.target !== null`）—— 那时主
 * 对话没地方站了，得有个入口能点回去、也能对它说话。平常中央就是它，列表里再摆一行
 * 是多余的。
 *
 * ## 它"不一样"在哪
 *
 * 用户原话：「在列表最上面，稍微和其他的子代理**有点不一样**就行，**边框加粗**之类的」。
 * 所以这里是主题色描边 + 加粗 —— 表达的是"**这一条和下面那几条不是一类**"（那是主子，
 * 它们是分身），不是"它更重"。
 *
 * 点击 = 关掉中间那个文件（`onBack`），主对话就回到中央。
 */
function MainSessionRow() {
  const { t } = useI18n();
  // 只在**中间被文件占住**时才出现 —— 见上面那段。
  const previewing = useFileViewStore((s) => s.target !== null);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const title = useSessionStore((s) =>
    s.activeSessionId
      ? (s.streamSessions.find((x) => x.id === s.activeSessionId)?.title ?? null)
      : null,
  );
  // **主对话也用 `activeSideChatId` 表示"现在展开的是它"** —— 于是展开/收起那一套
  // 逻辑（`SideChatView` + 那个返回箭头）一行都不用新写，而且和子对话完全一致。
  const open = useSessionStore((s) => s.activeSideChatId === activeSessionId);
  const select = useSessionStore((s) => s.selectSideChat);
  const close = useSessionStore((s) => s.closeSideChatView);
  if (!previewing || !activeSessionId) return null;
  return (
    <ul className="mb-2 space-y-0.5 border-b border-edge pb-2">
      <li>
        <button
          type="button"
          // **点一下展开、再点一下收起**（用户：「应该还能收起来」）。展开的是这条
          // 会话本身（`SideChatView` 用 `ChatPane`，主对话和子对话在那里是同一个东西）。
          onClick={() => (open ? close() : void select(activeSessionId))}
          title={open ? t("sideChat.collapseMain") : t("sideChat.expandMain")}
          className={cn(
            "flex w-full items-center gap-2 rounded-md border-2 px-2 py-1.5 text-left transition-colors",
            open
              ? "border-accent bg-accent/10"
              : "border-accent/60 bg-accent/5 hover:bg-accent/10",
          )}
        >
          <IconMessages size={13} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-content">
            {title || t("sideChat.mainChat")}
          </span>
          <span className="shrink-0 rounded bg-accent/15 px-1 text-[9px] font-medium text-accent">
            {t("sideChat.mainBadge")}
          </span>
        </button>
      </li>
    </ul>
  );
}

function SideChatRow({
  session,
  onOpen,
  onDelete,
}: {
  session: Session;
  onOpen: (id: string) => void;
  onDelete: (session: Session) => void;
}) {
  const { t } = useI18n();
  const running = useSessionStore((s) => !!s.runningBySession[session.id]);
  return (
    // The li is the hover surface; the open action and the delete action are
    // sibling buttons (a button inside a button is invalid HTML). The delete
    // affordance appears on hover, LeftBar row style, and is gated while the
    // chat's turn is running — deleting mid-stream would orphan the runtime.
    <li className="group flex items-center rounded-md pr-0.5 transition-colors hover:bg-surface-hover">
      <button
        type="button"
        onClick={() => onOpen(session.id)}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
      >
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            running ? "animate-pulse bg-accent" : "bg-content-subtle/40",
          )}
          title={session.title}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-content">
          {displayTitle(session, t("sideChat.titlePlaceholder"))}
        </span>
        <span className="shrink-0 text-[10px] text-content-subtle">
          {formatRelativeTime(session.createdAt)}
        </span>
      </button>
      <button
        type="button"
        disabled={running}
        onClick={() => onDelete(session)}
        title={running ? undefined : t("sideChat.deleteChat")}
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-content-subtle transition-all",
          "hover:bg-surface-hover hover:text-danger focus-visible:opacity-100",
          "opacity-0 group-hover:opacity-100",
          running && "pointer-events-none opacity-0",
        )}
      >
        <IconTrash size={13} />
      </button>
    </li>
  );
}

/* ── Subagent read-only transcript view ── */

function SubagentView({
  agent,
  sessionId,
  onBack,
}: {
  agent: SubagentSnapshot;
  sessionId: string;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rawBlocks = useSessionStore(
    (s) => s.subagentTranscriptsBySession[sessionId]?.[agent.toolUseId ?? ""],
  );
  const blocks = useMemo(
    () => (rawBlocks ?? []).map(mapTranscriptBlock),
    [rawBlocks],
  );
  const running = agent.status === "running";
  const usage = fmtUsage(agent);
  const meta = SUBAGENT_STATUS_META[agent.status];

  // Follow the tail while the subagent is live — new blocks scroll the view
  // to the bottom (same auto-follow intent as the main stream).
  useEffect(() => {
    if (running) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [blocks, running]);

  return (
    <div className="flex h-full flex-col">
      {/* Header: back + subagent description + status/usage. */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-edge bg-surface px-2">
        <button
          type="button"
          onClick={onBack}
          title={t("sideChat.backToList")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
        >
          <IconArrowLeft size={15} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {agent.subagentType && (
              <span className="shrink-0 rounded bg-info/20 px-1 text-[9px] font-medium uppercase tracking-wide text-info">
                {agent.subagentType}
              </span>
            )}
            <span className="truncate text-xs font-medium text-content">
              {agent.description || t("sideChat.titlePlaceholder")}
            </span>
          </div>
          <div className="flex items-center gap-1 text-[10px] text-content-subtle">
            <span className={cn("flex items-center gap-1", meta.cls)}>
              {running && (
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
              )}
              {t(meta.labelKey)}
            </span>
            {usage && <span className="truncate">· {usage}</span>}
          </div>
        </div>
      </div>

      {/* Read-only transcript — MessageBlocks is a pure presentational
          component (no composer, no send path, no per-session store buckets);
          the subagent is model-driven, the user only watches. */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        {blocks.length === 0 ? (
          <p className="px-2 py-4 text-xs text-content-subtle">
            {t("sideChat.subagentWaiting")}
          </p>
        ) : (
          <MessageBlocks blocks={blocks} />
        )}
      </div>
    </div>
  );
}

/* ── Chat view ── */

function SideChatView({ session, parentRow }: { session: Session; parentRow?: Session }) {
  const { t } = useI18n();
  /**
   * **这条是不是主对话自己**（2026-09-21）。
   *
   * ⚠️ 这个判断非有不可：`MainSessionRow` 让主对话也走这个视图（为了复用展开/收起），
   * 而它**自带一个垃圾桶按钮** —— 那是 `deleteSession`，**硬删**。主对话从这儿被删掉
   * 是灾难（它名下的子对话、节点会话会跟着没）。所以主对话那一档要把删除藏掉。
   */
  const isMain = useSessionStore((s) => s.activeSessionId === session.id);
  const closeSideChatView = useSessionStore((s) => s.closeSideChatView);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const openTab = useSessionStore((s) => s.openTab);
  const running = useSessionStore((s) => !!s.runningBySession[session.id]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const parentGone = !!session.parentSessionId && !parentRow;

  return (
    <div className="flex h-full flex-col">
      {/* Header: back + side chat title + parent jump + delete. */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-edge bg-surface px-2">
        <button
          type="button"
          onClick={closeSideChatView}
          title={t("sideChat.backToList")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
        >
          <IconArrowLeft size={15} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-content">
            {displayTitle(session, t("sideChat.titlePlaceholder"))}
          </div>
          {session.parentSessionId ? (
            <button
              type="button"
              disabled={parentGone}
              onClick={() => void openTab(session.parentSessionId as string)}
              title={parentGone ? t("sideChat.parentDeleted") : t("sideChat.goToParent")}
              className={cn(
                "block max-w-full truncate text-left text-[10px]",
                parentGone
                  ? "cursor-default text-content-subtle"
                  : "text-accent hover:underline",
              )}
            >
              <span className="text-content-subtle">{t("sideChat.parentPrefix")} · </span>
              {parentGone ? t("sideChat.parentDeleted") : (parentRow?.title ?? "")}
            </button>
          ) : (
            <span className="block truncate text-[10px] text-content-subtle">
              {t("sideChat.parentDeleted")}
            </span>
          )}
        </div>
        {/* **主对话不给删除入口** —— 见 `isMain` 那段。 */}
        {!isMain && (
        <button
          type="button"
          disabled={running}
          onClick={() => setConfirmDelete(true)}
          title={running ? undefined : t("sideChat.deleteChat")}
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-content-muted transition-colors",
            "hover:bg-surface-hover hover:text-danger",
            running && "pointer-events-none opacity-40",
          )}
        >
          <IconTrash size={14} />
        </button>
        )}
      </div>

      {/* Delete confirmation — same hard-delete path as the list rows; the
          cleared activeSideChatId drops the view back to the list. */}
      <ConfirmDialog
        open={confirmDelete}
        danger
        title={t("sideChat.deleteChat")}
        description={t("sideChat.deleteChatDesc", {
          title: displayTitle(session, t("sideChat.titlePlaceholder")),
        })}
        confirmText={t("common.delete")}
        onOpenChange={(open) => { if (!open) setConfirmDelete(false); }}
        onConfirm={() => { void deleteSession(session.id); }}
      />

      {/* The chat itself — ChatPane is fully sessionId-parameterized on the
          read side; sends carry the explicit sessionId (see handleSend).
          chipsMode="collapsed": the narrow panel always shows the single-icon
          chip toggle (model / effort / permission behind one icon) instead of
          measuring whether the full chip row fits. */}
      <div className="min-h-0 flex-1">
        <ChatPane sessionId={session.id} isActive chipsMode="collapsed" />
      </div>
    </div>
  );
}
