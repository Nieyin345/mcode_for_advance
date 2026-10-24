/**
 * `LeftBar` 的**会话树单元**（从 `LeftBar.tsx` 拆出）。
 *
 * 项目节点 / 会话行 / 工作树节点 / 分组节点 / 各上下文菜单 / 分组弹窗是各自独立的渲染
 * 单元（AST 实测零闭包捕获，只有 React / dnd-kit / i18n 这类 import 是自由的）——
 * 纯搬迁，函数体逐字节一致。
 */
import { cloneElement, useCallback, useEffect, useMemo, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { useSortable } from "@dnd-kit/sortable";
import type { DraggableAttributes } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@renderer/lib/cn.js";
import { Button, Dialog, Input } from "@renderer/components/ui/index.js";
import { api } from "@renderer/lib/api.js";
import { ProjectMenuCustomEntries } from "@renderer/components/customUi/CustomSlotHosts.js";
import { HoverIconButton } from "./SidebarShared.js";
import { normWorktreeKey, worktreeDisplayName } from "@renderer/lib/worktree.js";
import { hexToTriplet, tripletToHex } from "@renderer/lib/colorUtils.js";
import { formatRelativeTime, formatFullTime } from "@renderer/lib/time.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import type { Project, Session } from "@contracts/session";
import {
  IconChevronRight,
  IconGitFork,
  IconGitMerge,
  IconArchive,
  IconTrash,
  IconPencil,
  IconCopy,
  IconX,
  IconFolder,
  IconPlus,
  IconLoader2,
  IconCheck,
  IconPin,
  IconPinnedFilled,
  IconCategoryFilled,
  IconPalette,
  IconArrowRight,
} from "@renderer/lib/icons.js";



/* ── Project node (expandable, with its sessions nested) ── */

interface ProjectNodeProps {
  project: Project;
  sessions: Session[];
  hasMore: boolean;
  total: number;
  expanded: boolean;
  isActiveProject: boolean;
  activeSessionId: string | null;
  runningBySession: Record<string, boolean>;
  unreadBySession: Record<string, number>;
  onToggleExpand: () => void;
  onNewSession: () => void;
  onLoadMore: () => void;
  onSelectSession: (sessionId: string) => void;
  onDelete: () => void;
  onArchiveSession: (sessionId: string) => void;
  onDeleteSession: (session: Session) => void;
  /** Toggle a session's pinned state (project-scoped top-of-list pin). */
  onTogglePinSession: (session: Session) => void;
  /** "New session bound to this worktree session's checkout" — passed down
   *  to materialized worktree rows. */
  onNewWorktreeHere: (session: Session) => void;
  /** Left-bar display names for worktree directories (normalized path →
   *  name). Resolved by WorktreeGroupNode headers. */
  worktreeNames: Record<string, string>;
  /** Which worktree group nodes are expanded (normalized path → bool).
   *  Absent key = COLLAPSED — a worktree's threads stay folded until the user
   *  opens the group (only an explicit `true` renders the rows). */
  expandedWorktrees: Record<string, boolean>;
  onToggleWorktree: (worktreePath: string) => void;
  /** New thread bound to this worktree directory (group header "+"). */
  onNewSessionInWorktree: (worktreePath: string) => void;
  /** Remove the worktree directory (guarded confirm dialog at bar level). */
  onRemoveWorktree: (worktreePath: string) => void;
  /** Merge the worktree directory's work back into the local branch
   *  (preview dialog at bar level — one shared checkout, one merge). */
  onMergeWorktree: (worktreePath: string) => void;
  onContextWorktree: (worktreePath: string, x: number, y: number) => void;
  /** Register a session row's DOM node for scroll-into-view. */
  registerNode: (id: string, el: HTMLLIElement | null) => void;
  /** Open the right-click context menu for a session at the given coords. */
  onContextSession: (session: Session, x: number, y: number) => void;
  /** Open the right-click context menu for this project row. */
  onContextProject: (x: number, y: number) => void;
  /** dnd-kit sortable injection: ref for the root <li>, applied by the
   *  SortableProjectNode wrapper so this row participates in drag-to-reorder.
   *  Undefined when rendered outside a SortableContext. */
  sortableRef?: (el: HTMLLIElement | null) => void;
  /** dnd-kit transform/opacity style for the root <li>. */
  sortableStyle?: React.CSSProperties;
  /** dnd-kit pointer listeners spread onto the row <div> (the drag handle).
   *  Buttons inside stopPropagation on pointerDown so they never start a drag. */
  sortableListeners?: Record<string, unknown>;
  sortableAttributes?: DraggableAttributes;
  /** When true the row is the active drag source — dims it for feedback. */
  isDragging?: boolean;
}

export function ProjectNode(props: ProjectNodeProps) {
  const { t } = useI18n();
  const {
    project, sessions, hasMore, total, expanded, isActiveProject, activeSessionId,
    runningBySession, unreadBySession,
    onToggleExpand, onNewSession, onLoadMore, onSelectSession,
    onDelete, onArchiveSession, onDeleteSession, onTogglePinSession,
    onNewWorktreeHere, worktreeNames, expandedWorktrees,
    onToggleWorktree, onNewSessionInWorktree, onRemoveWorktree, onMergeWorktree, onContextWorktree,
    registerNode, onContextSession, onContextProject,
    sortableRef, sortableStyle, sortableListeners, sortableAttributes, isDragging,
  } = props;
  const loaded = sessions.length;

  // ── Worktree bucketing. Sessions bound to a materialized (or freshly
  // bound) isolated checkout group under ONE collapsible directory node per
  // worktree, so a directory reads like a folder of threads; the groups
  // render ABOVE the local threads, which stay in the flat list below.
  // Insertion order of the Map gives group order — `sessions` is newest-first,
  // so the group containing the most recently active worktree thread sorts
  // first. Pagination is untouched: loadMore appends local rows and rows
  // re-bucket naturally.
  const { localSessions, worktreeGroups } = useMemo(() => {
    const local: Session[] = [];
    const buckets = new Map<string, { path: string; sessions: Session[] }>();
    for (const s of sessions) {
      if (!s.worktreePath) {
        local.push(s);
        continue;
      }
      const key = normWorktreeKey(s.worktreePath);
      const bucket = buckets.get(key);
      if (bucket) bucket.sessions.push(s);
      else buckets.set(key, { path: s.worktreePath, sessions: [s] });
    }
    return { localSessions: local, worktreeGroups: Array.from(buckets.values()) };
  }, [sessions]);

  // Shared row renderer so local sessions and rows inside a worktree group
  // are identical (same hover actions, context menu). `inWorktreeGroup`
  // trims the worktree furniture for group members: the group node itself
  // already carries the fork identity and its "+" spawns siblings, so the
  // per-row fork badge and "new session in this worktree" hover button are
  // pure noise there. (Pinned rows keep both — they sit OUTSIDE the group.)
  const renderSessionRow = (s: Session, inWorktreeGroup = false) => (
    <SessionRow
      key={s.id}
      session={s}
      active={s.id === activeSessionId}
      isRunning={!!runningBySession[s.id]}
      unreadCount={unreadBySession[s.id] ?? 0}
      onSelect={() => onSelectSession(s.id)}
      onTogglePin={() => onTogglePinSession(s)}
      onArchive={() => onArchiveSession(s.id)}
      onDelete={() => onDeleteSession(s)}
      onNewWorktreeSession={
        !inWorktreeGroup && s.worktreePath ? () => onNewWorktreeHere(s) : undefined
      }
      hideWorktreeBadge={inWorktreeGroup}
      registerNode={registerNode}
      onContext={(x, y) => onContextSession(s, x, y)}
    />
  );

  return (
    <li
      ref={sortableRef}
      style={sortableStyle}
    >
      <div
        {...sortableAttributes}
        {...sortableListeners}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextProject(e.clientX, e.clientY);
        }}
        className={cn(
          "group flex items-center gap-1 rounded px-1 py-1 [font-size:var(--right-panel-font-size)]",
          isActiveProject
            ? "bg-selected text-selectedContent font-medium"
            : "text-content-muted hover:bg-surface-hover",
          isDragging && "opacity-50",
        )}
      >
        {/* Pinned marker — always-visible badge at the very LEFT edge (before
            the chevron), mirroring SessionRow's pinned badge so a pinned
            project reads as pinned at a glance. */}
        {project.pinnedAt != null && (
          <IconPinnedFilled
            size={12}
            className="shrink-0 text-accent/80"
            aria-label={t("layout.pinned")}
          />
        )}

        {/* Expand / collapse toggle */}
        <button
          onClick={onToggleExpand}
          className="flex w-3 shrink-0 items-center justify-center text-content-subtle"
          title={expanded ? t("layout.collapse") : t("layout.expand")}
          aria-label={expanded ? t("layout.collapse") : t("layout.expand")}
        >
          <IconChevronRight
            size={10}
            className={cn(
              "transition-transform",
              expanded && "rotate-90",
            )}
          />
        </button>

        {/* Project name → click toggles expand/collapse (matches chevron) */}
        <button
          onClick={onToggleExpand}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          title={project.path}
        >
          <IconFolder size={14} className="shrink-0" />
          <span className="truncate">{project.name}</span>
        </button>

        {/* New session in this project */}
        <button
          onClick={onNewSession}
          className={cn(
            "flex shrink-0 items-center rounded px-1 text-content-subtle opacity-0 transition-colors",
            "hover:text-content group-hover:opacity-100 group-focus-within:opacity-100",
          )}
          title={t("layout.newSessionHere")}
          aria-label={t("layout.newSessionHere")}
        >
          <IconPlus size={12} />
        </button>

        {/* Delete — inline on hover (projects cannot be archived, only removed). */}
        <HoverIconButton onClick={onDelete} title={t("common.delete")} danger>
          <IconTrash size={13} />
        </HoverIconButton>
      </div>

      {expanded && (
        <ul className="ml-3 mt-0.5 space-y-0.5 border-l border-edge/50 pl-2">
          {loaded === 0 ? (
            <li className="px-2 py-1 text-content-subtle [font-size:var(--rp-fs-md)]">{t("layout.noThreads")}</li>
          ) : (
            <>
              {/* Mixed list — ONE collapsible directory node per worktree
                  FIRST, then the local threads. Groups start COLLAPSED (absent
                  key = folded): a project with many checkouts otherwise dumps
                  every worktree thread into the tree, burying the local ones.
                  The header's count badge and its session rows sit one click
                  away. */}
              {worktreeGroups.map((group) => {
                const key = normWorktreeKey(group.path);
                return (
                  <WorktreeGroupNode
                    key={key}
                    worktreePath={group.path}
                    repoPath={project.path}
                    displayName={worktreeDisplayName(group.path, worktreeNames)}
                    sessions={group.sessions}
                    expanded={!!expandedWorktrees[key]}
                    onToggle={() => onToggleWorktree(group.path)}
                    onNewSession={() => onNewSessionInWorktree(group.path)}
                    onMergeBack={() => onMergeWorktree(group.path)}
                    onRemove={() => onRemoveWorktree(group.path)}
                    onContext={(x, y) => onContextWorktree(group.path, x, y)}
                    renderSession={renderSessionRow}
                  />
                );
              })}
              {localSessions.map((s) => renderSessionRow(s))}
            </>
          )}
          {/* Load-more pages the project's LOCAL list; the remaining count is
              local-only too — the worktree section shares the cache array but
              not this pagination. */}
          {hasMore && (
            <li>
              <button
                onClick={onLoadMore}
                className={cn(
                  "w-full rounded px-2 py-1 text-left text-content-subtle transition-colors [font-size:var(--rp-fs-md)]",
                  "cds-hover-ghost  hover:text-content",
                )}
              >
                {t("layout.loadMore")}
                {total > 0
                  ? t("layout.loadMoreRemaining", { n: Math.max(total - localSessions.length, 0) })
                  : ""}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/* ── Session row (leaf) ── */

/** Provider-branded leading icon for a session row. Kept in a tiny component
 *  so the two usages (active row + archived row) stay in sync. */
function SessionRowIcon({ providerId, className }: { providerId: string; className?: string }) {
  const { Icon, color } = getProviderIcon(providerId);
  return <Icon size={14} className={cn(className, color)} />;
}

export function SessionRow({
  session, active, isRunning, unreadCount, onSelect, onTogglePin, onArchive, onDelete, onNewWorktreeSession, hideWorktreeBadge, registerNode, onContext,
}: {
  session: Session;
  active: boolean;
  isRunning: boolean;
  /** Unread event count for this session (0 = no badge). Only rendered when
   *  the row is idle (not running) and the count is > 0. */
  unreadCount: number;
  onSelect: () => void;
  /** Toggle this session's pinned state (moves it into / out of the global
   *  pinned section above the project tree). */
  onTogglePin: () => void;
  onArchive: () => void;
  onDelete: () => void;
  /** "New session in this worktree" — present only for materialized worktree
   *  rows OUTSIDE a worktree group (pinned section); creates a fresh thread
   *  BOUND to the same isolated checkout. Group members don't get it — the
   *  group header's "+" is that entry point. */
  onNewWorktreeSession?: () => void;
  /** True when the row renders INSIDE a worktree group node: the group
   *  already carries the fork identity, so the per-row fork badge is noise. */
  hideWorktreeBadge?: boolean;
  registerNode: (id: string, el: HTMLLIElement | null) => void;
  onContext: (x: number, y: number) => void;
}) {
  const { t } = useI18n();
  const [pendingConfirm, setPendingConfirm] = useState<null | "archive" | "delete">(null);
  const isPinned = session.pinnedAt != null;
  // Whether the pointer is over this row. We swap the right-aligned payload
  // between the relative-time label (default) and the archive/delete action
  // buttons (on hover), so the time can hug the right edge without the
  // always-reserved action buttons leaving a gap.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const idle = pendingConfirm === null && !isRunning;
  const hasUnread = unreadCount > 0;
  // When there are unread events, suppress the time label so the badge can
  // hug the right edge - the badge is more actionable information than the
  // timestamp. On hover the action buttons take precedence (so the user can
  // archive/delete without the badge getting in the way).
  const revealActions = hovered || focused;
  const showTime = idle && !revealActions && !hasUnread;
  const showActions = idle && revealActions;
  const showUnreadBadge = idle && !revealActions && hasUnread;

  const handleRowClick = () => {
    setPendingConfirm(null);
    onSelect();
  };

  return (
    <li
      ref={(el) => registerNode(session.id, el)}
      data-tree-session-row=""
      tabIndex={0}
      aria-current={active ? "page" : undefined}
      onClick={handleRowClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleRowClick();
        }
      }}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      onMouseEnter={() => {
        setHovered(true);
        // Warm the message bucket on hover — by the time the click lands
        // the history fetch is usually done (or in flight), so the center
        // pane swaps in with content instead of a skeleton frame.
        void useSessionStore.getState().prefetchSessionMessages(session.id);
      }}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={(e) => {
        // Suppress the menu while an inline confirm is mid-flight, otherwise
        // right-clicking the confirm buttons would lose the pending state.
        if (pendingConfirm) return;
        e.preventDefault();
        onContext(e.clientX, e.clientY);
      }}
      className={cn(
        "group flex cursor-pointer items-center gap-1 rounded-md px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-strong [font-size:var(--right-panel-font-size)]",
        active
          ? "bg-selected text-selectedContent font-medium shadow-sm ring-1 ring-inset ring-accent/35"
          : "text-content-muted hover:bg-surface-hover",
      )}
      title={`${session.title}\n${formatFullTime(session.updatedAt)}`}
    >
      {/* Pinned marker — always-visible badge at the very LEFT edge (before
          the provider icon) so a pinned thread reads as pinned at a glance,
          independent of the hover actions / unread badge on the right edge. */}
      {isPinned && (
        <IconPinnedFilled
          size={12}
          className="shrink-0 text-accent/80"
          aria-label={t("layout.pinned")}
        />
      )}

      <SessionRowIcon providerId={session.providerId} className="shrink-0" />

      <span className="min-w-0 flex-1 truncate">{session.title}</span>

      {/* Worktree marker — this thread runs in an isolated detached checkout
          (parallel task). Small accent fork next to the title; full path via
          the row tooltip is unnecessary noise. */}
      {session.worktreePath && !hideWorktreeBadge && (
        <span className="flex shrink-0 text-accent/80" title={t("chat.worktree.active")}>
          <IconGitFork size={11} />
        </span>
      )}

      {/* Relative time of the last activity (updatedAt), docked to the right
          edge. The row swaps between two right-aligned payloads: the time
          label by default, and the archive/delete action buttons on hover.
          While an inline confirm is pending or a turn is running, neither the
          time nor the normal actions show (the confirm buttons / spinner take
          their place). The full timestamp stays available via the hover
          tooltip on the <li>. */}
      {showTime && (
        <span className="shrink-0 text-content-subtle/70 [font-size:var(--rp-fs-sm)]">
          {formatRelativeTime(session.updatedAt)}
        </span>
      )}

      {/* Unread badge - shown when this session has events the user hasn't
          seen (turn done, error, blocking approval, background task finished)
          and the row is idle (not running, not hovered, no pending confirm).
          A count > 9 renders "9+" to keep the badge compact. Uses the accent
          color so it pops without clashing with the running spinner. */}
      {showUnreadBadge && (
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 leading-none text-white [font-size:var(--rp-fs-sm)]",
            "min-w-[16px] text-center",
            active ? "bg-accent" : "bg-accent/80",
          )}
        >
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      )}

      {/* Inline confirm — shown after the first click on archive or delete.
          Two icons replace the normal single-action button: a confirm check
          and a cancel X. The actual action only fires on the second click
          (confirm). Clicking anywhere else dismisses the pending state. */}
      {pendingConfirm === "archive" && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); setPendingConfirm(null); onArchive(); }}
            className="cds-hover-ghost flex shrink-0 items-center rounded px-1 text-accent"
            aria-label={t("layout.confirmArchive")}
            title={t("layout.confirmArchive")}
          >
            <IconCheck size={13} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setPendingConfirm(null); }}
            className="cds-hover-ghost flex shrink-0 items-center rounded px-1 text-content-subtle hover:text-content"
            aria-label={t("common.cancel")}
            title={t("common.cancel")}
          >
            <IconX size={13} />
          </button>
        </>
      )}
      {pendingConfirm === "delete" && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); setPendingConfirm(null); onDelete(); }}
            className="cds-hover-ghost flex shrink-0 items-center rounded px-1 text-danger"
            aria-label={t("layout.confirmDelete")}
            title={t("layout.confirmDelete")}
          >
            <IconCheck size={13} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setPendingConfirm(null); }}
            className="cds-hover-ghost flex shrink-0 items-center rounded px-1 text-content-subtle hover:text-content"
            aria-label={t("common.cancel")}
            title={t("common.cancel")}
          >
            <IconX size={13} />
          </button>
        </>
      )}

      {/* Normal action buttons - only mounted on hover (and only when the row
          is idle), so the relative-time label can sit flush against the right
          edge instead of sharing space with hidden-but-reserved buttons. */}
      {showActions && (
        <>
          {onNewWorktreeSession && (
            <HoverIconButton
              onClick={onNewWorktreeSession}
              title={t("layout.newSessionInWorktree")}
              className="opacity-100"
            >
              <IconGitFork size={13} />
            </HoverIconButton>
          )}
          <HoverIconButton
            onClick={onTogglePin}
            title={isPinned ? t("layout.unpin") : t("layout.pin")}
            className="opacity-100"
          >
            {isPinned ? (
              <IconPinnedFilled size={13} className="text-accent" />
            ) : (
              <IconPin size={13} />
            )}
          </HoverIconButton>
          <HoverIconButton
            onClick={() => { setPendingConfirm("archive"); }}
            title={t("layout.archive")}
            className="opacity-100"
          >
            <IconArchive size={13} />
          </HoverIconButton>
          <HoverIconButton
            onClick={() => { setPendingConfirm("delete"); }}
            title={t("common.delete")}
            danger
            className="opacity-100"
          >
            <IconTrash size={13} />
          </HoverIconButton>
        </>
      )}

      {/* Running spinner — always visible at the far right when a turn is live. */}
      {isRunning && (
        <IconLoader2
          size={12}
          className="shrink-0 animate-spin text-accent"
        />
      )}
    </li>
  );
}

/* ── Worktree group node (directory of threads sharing one checkout) ──
 * Collapsible header bucketing every session bound to the same isolated
 * worktree directory, so a worktree reads like a folder of threads under its
 * project. Mirrors ProjectNode's row layout (chevron + icon + name) but is
 * NOT sortable — group order follows the sessions' recency. "+" creates a
 * new thread bound to the SAME checkout (shared directory + node_modules);
 * right-click opens the worktree context menu (new session / rename). */

interface WorktreeGroupNodeProps {
  worktreePath: string;
  /** Owning project root — the repo the worktree was created from; anchors
   *  both the merge-eligibility probe and the merge-back dialog. */
  repoPath: string;
  displayName: string;
  sessions: Session[];
  expanded: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onMergeBack: () => void;
  onRemove: () => void;
  onContext: (x: number, y: number) => void;
  renderSession: (s: Session, inWorktreeGroup?: boolean) => React.ReactNode;
}

function WorktreeGroupNode({
  worktreePath, repoPath, displayName, sessions, expanded,
  onToggle, onNewSession, onMergeBack, onRemove, onContext, renderSession,
}: WorktreeGroupNodeProps) {
  const { t } = useI18n();

  // ── Merge-back eligibility — probed ON HOVER, not polled: the button only
  // exists while the row is being pointed at, so an idle group costs nothing.
  // "Has work" uses the same probe as the Titlebar merge button: dirty files
  // OR commits not contained in the main checkout's HEAD (worktreeList's
  // `merged` flag is the ancestor probe). A clean, fully-merged worktree
  // renders no button; re-probing happens on every mouseenter, so a merge
  // or removal that clears the work is reflected the next time the user
  // hovers (leaving and returning is the natural gesture after a dialog).
  const [mergeable, setMergeable] = useState(false);
  const probeMerge = useCallback(async () => {
    try {
      const { worktrees } = await api.git.worktreeList({ repoPath });
      const target = normWorktreeKey(worktreePath);
      const mine = worktrees.find((w) => normWorktreeKey(w.path) === target);
      setMergeable(!!mine && (mine.dirty || !mine.merged));
    } catch {
      setMergeable(false);
    }
  }, [repoPath, worktreePath]);

  return (
    <li>
      <div
        onMouseEnter={() => void probeMerge()}
        onContextMenu={(e) => {
          e.preventDefault();
          onContext(e.clientX, e.clientY);
        }}
        className="group flex items-center gap-1 rounded px-1 py-1 [font-size:var(--right-panel-font-size)] text-content-muted hover:bg-surface-hover"
      >
        {/* Expand / collapse toggle */}
        <button
          onClick={onToggle}
          className="flex w-3 shrink-0 items-center justify-center text-content-subtle"
          title={expanded ? t("layout.collapse") : t("layout.expand")}
          aria-label={expanded ? t("layout.collapse") : t("layout.expand")}
        >
          <IconChevronRight
            size={10}
            className={cn("transition-transform", expanded && "rotate-90")}
          />
        </button>

        {/* Directory name (+ thread count) → click toggles expand/collapse */}
        <button
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          title={worktreePath}
        >
          <IconGitFork size={13} className="shrink-0 text-accent/80" />
          <span className="truncate">{displayName}</span>
          <span className="shrink-0 rounded bg-surface-muted px-1 text-content-subtle [font-size:var(--rp-fs-sm)]">
            {sessions.length}
          </span>
        </button>

        {/* Merge back into the local branch — hover-only AND gated on the
            hover probe: shown just while the directory actually has unmerged
            work (dirty files or new commits), so a clean/fully-merged tree
            stays quiet. Accent tint marks "work waiting to land"; opens the
            same preview dialog as the context-menu entry. */}
        {mergeable && (
          <button
            onClick={onMergeBack}
            className={cn(
              "flex shrink-0 items-center rounded px-1 text-accent opacity-0 transition-colors",
              "group-hover:opacity-100 group-focus-within:opacity-100",
            )}
            title={t("layout.mergeWorktreeBack")}
            aria-label={t("layout.mergeWorktreeBack")}
          >
            <IconGitMerge size={12} />
          </button>
        )}

        {/* New session bound to this worktree — hover only, mirrors the
            project row's "+" button. */}
        <button
          onClick={onNewSession}
          className={cn(
            "flex shrink-0 items-center rounded px-1 text-content-subtle opacity-0 transition-colors",
            "hover:text-content group-hover:opacity-100 group-focus-within:opacity-100",
          )}
          title={t("layout.newSessionInWorktree")}
          aria-label={t("layout.newSessionInWorktree")}
        >
          <IconPlus size={12} />
        </button>

        {/* Remove the worktree — hover, danger-tinted on hover. Opens the
            same guarded confirm dialog as the context-menu entry (running
            turns refuse; dirty trees get patch-export / force options). */}
        <button
          onClick={onRemove}
          className={cn(
            "flex shrink-0 items-center rounded px-1 text-content-subtle opacity-0 transition-colors",
            "hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100",
          )}
          title={t("chat.worktree.removeWt")}
          aria-label={t("chat.worktree.removeWt")}
        >
          <IconTrash size={12} />
        </button>
      </div>

      {expanded && (
        <ul className="ml-3 mt-0.5 space-y-0.5 border-l border-edge/50 pl-2">
          {sessions.map((s) => renderSession(s, true))}
        </ul>
      )}
    </li>
  );
}

/* ── Worktree right-click context menu ──
 * Opened from a worktree group node's header. Entries: spawn a sibling
 * thread bound to the same checkout, merge the directory's work back into
 * the local branch (all sessions of the group share one checkout, so one
 * merge covers everything), rename the directory's left-bar display name,
 * and REMOVE the worktree (guarded confirm dialog; referencing sessions
 * degrade back to local). */

interface WorktreeContextMenuProps {
  ctxMenu: { worktreePath: string; x: number; y: number } | null;
  onClose: () => void;
  onNewSession: (worktreePath: string) => void;
  onMergeBack: (worktreePath: string) => void;
  onRename: (worktreePath: string) => void;
  onRemove: (worktreePath: string) => void;
}

export function WorktreeContextMenu({
  ctxMenu, onClose, onNewSession, onMergeBack, onRename, onRemove,
}: WorktreeContextMenuProps) {
  const { t } = useI18n();
  // Virtual anchor pinned to the cursor coords (same as SessionContextMenu).
  const anchor = useCursorAnchor(ctxMenu);

  const worktreePath = ctxMenu?.worktreePath;

  return (
    <Menu.Root open={!!ctxMenu} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start">
          <Menu.Popup
            className={cn(
              "z-50 min-w-[180px] origin-top-left rounded-[var(--radius-btn-xs)] border border-edge bg-surface py-1 shadow-[var(--shadow-popover)]",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <Menu.Item
              onClick={() => worktreePath && onNewSession(worktreePath)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted",
              )}
            >
              <IconGitFork size={14} className="shrink-0" />
              {t("layout.newSessionInWorktree")}
            </Menu.Item>
            <Menu.Item
              onClick={() => worktreePath && onMergeBack(worktreePath)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted",
              )}
            >
              <IconGitMerge size={14} className="shrink-0" />
              {t("layout.mergeWorktreeBack")}
            </Menu.Item>
            <Menu.Item
              onClick={() => worktreePath && onRename(worktreePath)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted",
              )}
            >
              <IconPencil size={14} className="shrink-0" />
              {t("layout.renameWorktree")}
            </Menu.Item>
            <Menu.Item
              onClick={() => worktreePath && onRemove(worktreePath)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
                "text-danger data-[highlighted]:bg-surface-muted",
              )}
            >
              <IconTrash size={14} className="shrink-0" />
              {t("chat.worktree.removeWt")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/* ── Group node (grouped view) ──
 * A collapsible header that clusters its member projects. Mirrors the
 * archived bin's group-header layout but is interactive: click toggles
 * collapse, hover reveals rename/delete actions. Member projects render via
 * the shared `renderProject` callback so rows are identical to the flat view. */

interface GroupNodeProps {
  groupName: string;
  projects: Project[];
  /** Per-group color as "R G B" triplet, or null for the default. */
  groupColor: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onRenameGroup: () => void;
  onDeleteGroup: () => void;
  onSetColor: (rgb: string | null) => void;
  renderProject: (p: Project) => React.ReactNode;
}

/** Preset swatches for the group color picker (mirrors ACCENT_PRESETS).
 *  Names are dictionary keys — resolved at render for the swatch tooltip. */
const GROUP_COLOR_PRESETS: { nameKey: MessageId; triplet: string; hex: string }[] = [
  { nameKey: "layout.color.emerald", triplet: "5 150 105", hex: "#059669" },
  { nameKey: "layout.color.sky", triplet: "2 132 199", hex: "#0284c7" },
  { nameKey: "layout.color.indigo", triplet: "67 56 202", hex: "#4338ca" },
  { nameKey: "layout.color.violet", triplet: "124 58 237", hex: "#7c3aed" },
  { nameKey: "layout.color.rose", triplet: "225 29 72", hex: "#e11d48" },
  { nameKey: "layout.color.amber", triplet: "217 119 6", hex: "#d97706" },
];

export function GroupNode({
  groupName, projects, groupColor, collapsed,
  onToggle, onRenameGroup, onDeleteGroup, onSetColor, renderProject,
}: GroupNodeProps) {
  const { t } = useI18n();
  // The header is both a drop target (dropping a project here reassigns its
  // group) AND a sortable item (groups can be dragged to reorder among
  // themselves). useSortable provides both behaviors.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: `group:${groupName}` });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? { zIndex: 10 } : undefined),
  };
  const colorHex = groupColor ? tripletToHex(groupColor) : null;
  return (
    <li ref={setNodeRef} style={style} {...attributes}>
      <div
        {...listeners}
        className={cn(
          "group flex items-center gap-1 rounded px-1 py-0.5 [font-size:var(--rp-fs-md)]",
          "text-content-subtle hover:bg-surface-hover",
          isOver && "bg-surface-hover ring-1 ring-accent/40",
          isDragging && "opacity-50",
        )}
      >
        <button
          onClick={onToggle}
          className="flex w-3 shrink-0 items-center justify-center"
          title={collapsed ? t("layout.expand") : t("layout.collapse")}
          aria-label={collapsed ? t("layout.expand") : t("layout.collapse")}
        >
          <IconChevronRight
            size={10}
            className={cn("transition-transform", !collapsed && "rotate-90")}
          />
        </button>
        <button
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 text-left font-medium"
        >
          <IconCategoryFilled
            size={13}
            className="shrink-0"
            style={colorHex ? { color: colorHex } : undefined}
          />
          <span className="truncate">{groupName}</span>
          <span className="text-content-subtle/70">({projects.length})</span>
        </button>
        {/* Color picker — hover-revealed palette button. The button's tint
            reflects the current group color so it doubles as an indicator. */}
        <Menu.Root>
          <Menu.Trigger
            title={t("layout.setColor")}
            aria-label={t("layout.setColor")}
            className="cds-hover-ghost flex shrink-0 items-center rounded px-1 text-content-subtle opacity-0 transition-colors group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <IconPalette size={12} style={colorHex ? { color: colorHex } : undefined} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner align="end">
              <Menu.Popup
                className={cn(
                  "z-50 min-w-[180px] origin-top-left rounded-[var(--radius-btn-xs)] border border-edge bg-surface py-1 shadow-[var(--shadow-popover)]",
                  "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                  "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                  "transition-[transform,opacity] duration-100",
                )}
              >
                <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-content-subtle">
                  {t("layout.groupColor")}
                </div>
                <div className="flex flex-wrap gap-1.5 px-3 py-1">
                  {GROUP_COLOR_PRESETS.map((p) => (
                    <Menu.Item
                      key={p.triplet}
                      onClick={() => onSetColor(p.triplet)}
                      className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border-2 transition-transform hover:scale-110 data-[highlighted]:scale-110"
                      style={{
                        backgroundColor: p.hex,
                        borderColor: groupColor === p.triplet ? "var(--color-content)" : "var(--color-edge)",
                      }}
                      title={`${t(p.nameKey)} · ${p.hex.toUpperCase()}`}
                      aria-label={`${t(p.nameKey)} · ${p.hex.toUpperCase()}`}
                    >
                      {groupColor === p.triplet && (
                        <IconCheck size={12} className="text-white drop-shadow" />
                      )}
                    </Menu.Item>
                  ))}
                </div>
                <div className="my-1 h-px bg-edge" />
                <div className="flex items-center gap-2 px-3 py-1">
                  <span className="text-xs text-content-muted">{t("layout.customColor")}</span>
                  <input
                    type="color"
                    value={colorHex ?? "#808080"}
                    onChange={(e) => {
                      const triplet = hexToTriplet(e.target.value);
                      if (triplet) onSetColor(triplet);
                    }}
                    className="h-6 w-8 cursor-pointer rounded border border-edge bg-transparent p-0.5"
                  />
                </div>
                <Menu.Item
                  onClick={() => onSetColor(null)}
                  disabled={!groupColor}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-content-muted data-[highlighted]:bg-surface-muted disabled:opacity-40"
                >
                  {t("layout.resetColor")}
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        <button
          onClick={onRenameGroup}
          className="flex shrink-0 items-center rounded px-1 text-content-subtle opacity-0 transition-colors hover:text-content group-hover:opacity-100 group-focus-within:opacity-100"
          title={t("layout.renameGroup")}
          aria-label={t("layout.renameGroup")}
        >
          <IconPencil size={12} />
        </button>
        <HoverIconButton onClick={onDeleteGroup} title={t("layout.dissolveGroup")} danger>
          <IconX size={12} />
        </HoverIconButton>
      </div>
      {!collapsed && (
        <ul className="ml-3 mt-0.5 space-y-0.5 border-l border-edge/50 pl-2">
          {projects.map((p) => renderProject(p))}
        </ul>
      )}
    </li>
  );
}

/* ── Sortable wrapper for a project row ──
 * Hooks ProjectNode into the DndContext: useSortable provides the ref, the
 * transform (visual reorder during drag), and the pointer listeners that make
 * the row a drag handle. These are injected into ProjectNode via its optional
 * sortable* props so the row markup stays in one place. Mirrors SessionTabs'
 * SortableTab. The id is namespaced ("proj:<id>") to avoid colliding with
 * group-header droppables ("group:<name>"). */
export function SortableProjectNode({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactElement<ProjectNodeProps>;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: `proj:${projectId}` });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? { zIndex: 10 } : undefined),
  };
  return cloneElement(children, {
    sortableRef: setNodeRef,
    sortableStyle: style,
    sortableListeners: listeners,
    sortableAttributes: attributes,
    isDragging,
  });
}

/* ── Project right-click context menu ──
 * Hosts the "移动到分组" actions: a flat list of existing groups (click to
 * assign), "新建分组…" (opens the group dialog), and "移出分组" (only when
 * the project is currently grouped). Plus pin (top of the menu, mirroring
 * the session menu), rename, and an "open in file manager" entry for parity
 * with the session context menu. */

interface ProjectContextMenuProps {
  ctxMenu: { project: Project; x: number; y: number } | null;
  knownGroups: string[];
  onClose: () => void;
  onTogglePin: (project: Project) => void;
  onRename: (project: Project) => void;
  onMoveToGroup: (projectId: string, group: string) => void;
  onCreateGroup: (projectId: string) => void;
  onRemoveFromGroup: (projectId: string) => void;
  onOpenFolder: (project: Project) => void;
}

export function ProjectContextMenu({
  ctxMenu, knownGroups, onClose,
  onTogglePin, onRename, onMoveToGroup, onCreateGroup, onRemoveFromGroup, onOpenFolder,
}: ProjectContextMenuProps) {
  const { t } = useI18n();
  const anchor = useCursorAnchor(ctxMenu);

  const project = ctxMenu?.project;
  const currentGroup = project?.group && project.group.length > 0 ? project.group : null;
  const isPinned = project?.pinnedAt != null;

  const itemClass = cn(
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
    "text-content-muted data-[highlighted]:bg-surface-muted",
  );

  return (
    <Menu.Root open={!!ctxMenu} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start">
          <Menu.Popup
            className={cn(
              "z-50 min-w-[180px] origin-top-left rounded-[var(--radius-btn-xs)] border border-edge bg-surface py-1 shadow-[var(--shadow-popover)]",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <Menu.Item
              onClick={() => project && onTogglePin(project)}
              className={itemClass}
            >
              {isPinned ? (
                <IconPinnedFilled size={14} className="shrink-0 text-accent" />
              ) : (
                <IconPin size={14} className="shrink-0" />
              )}
              {isPinned ? t("layout.unpin") : t("layout.pin")}
            </Menu.Item>
            <Menu.Item
              onClick={() => project && onRename(project)}
              className={itemClass}
            >
              <IconPencil size={14} className="shrink-0" />
              {t("common.rename")}
            </Menu.Item>
            <Menu.Separator className="my-1 h-px bg-edge" />
            {/* Section: move to an existing group. Each row shows the group
                name with a check on the currently-assigned one. */}
            {knownGroups.length > 0 && (
              <>
                <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-content-subtle">
                  {t("layout.moveToGroup")}
                </div>
                {knownGroups.map((g) => (
                  <Menu.Item
                    key={g}
                    onClick={() => project && onMoveToGroup(project.id, g)}
                    className={itemClass}
                  >
                    <IconCategoryFilled size={14} className="shrink-0" />
                    <span className="flex-1 truncate">{g}</span>
                    {currentGroup === g && <IconCheck size={13} className="shrink-0 text-accent" />}
                  </Menu.Item>
                ))}
                <Menu.Separator className="my-1 h-px bg-edge" />
              </>
            )}
            <Menu.Item
              onClick={() => project && onCreateGroup(project.id)}
              className={itemClass}
            >
              <IconPlus size={14} className="shrink-0" />
              {t("layout.newGroupMenu")}
            </Menu.Item>
            {currentGroup && (
              <Menu.Item
                onClick={() => project && onRemoveFromGroup(project.id)}
                className={itemClass}
              >
                <IconArrowRight size={14} className="shrink-0 rotate-45" />
                {t("layout.removeFromGroup")}
              </Menu.Item>
            )}
            <Menu.Separator className="my-1 h-px bg-edge" />
            <Menu.Item
              onClick={() => project && onOpenFolder(project)}
              className={itemClass}
            >
              <IconFolder size={14} className="shrink-0" />
              {t("layout.openInFileManager")}
            </Menu.Item>
            {/* 自定义 UI「项目右键」挂载位(R39) */}
            <ProjectMenuCustomEntries project={project} itemClass={itemClass} onClose={onClose} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/* ── Group dialog (create / rename) ──
 * One input, one submit. In "create" mode the parent LeftBar dispatches
 * setProjectGroup(projectId, name); in "rename" mode it walks every member.
 * Empty/whitespace-only input is rejected by disabling submit (mirrors
 * RenameDialog). */

interface GroupDialogProps {
  state: { mode: "create"; projectId: string } | { mode: "rename"; groupName: string } | null;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}

export function GroupDialog({ state, onClose, onSubmit }: GroupDialogProps) {
  const { t } = useI18n();
  const [value, setValue] = useState("");

  useEffect(() => {
    if (state?.mode === "rename") setValue(state.groupName);
    else setValue("");
  }, [state]);

  const trimmed = value.trim();
  const submit = () => {
    if (!state || !trimmed) return;
    void onSubmit(trimmed);
  };

  return (
    <Dialog.Root open={!!state} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-[420px] max-w-[90vw] p-4">
          <Dialog.Title>{state?.mode === "rename" ? t("layout.renameGroup") : t("layout.newGroup")}</Dialog.Title>
          <Dialog.Description className="mt-1">
            {state?.mode === "rename"
              ? t("layout.renameGroupDesc")
              : t("layout.newGroupDesc")}
          </Dialog.Description>

          <div className="mt-4">
            <Input
              value={value}
              autoFocus
              placeholder={t("layout.groupNamePlaceholder")}
              onChange={(e) => setValue((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                // 中文输入法里敲拼音、按回车**确认候选词**时 keydown 带 isComposing ——
                // 那不是"提交",是输入法自己的按键。少了这道守卫,用户用拼音起个分组名、
                // 一确认候选词就把分组建了出来(名字还没打完)。与下面会话行那条同款。
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") { e.preventDefault(); submit(); }
                if (e.key === "Escape") { e.preventDefault(); onClose(); }
              }}
              onFocus={(e) => (e.target as HTMLInputElement).select()}
            />
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={submit} disabled={!trimmed}>
              {state?.mode === "rename" ? t("common.save") : t("common.create")}
            </Button>
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
