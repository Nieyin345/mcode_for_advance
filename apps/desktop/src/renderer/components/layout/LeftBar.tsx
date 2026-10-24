import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { cn } from "@renderer/lib/cn.js";
import { ScrollFade } from "@renderer/components/ui/cds/ScrollFade.js";
import { LibrarySections, LibraryTrashRow } from "@renderer/components/library/LibrarySectionParts.js";
import {
  IconFolder,
  IconGitFork,
  IconGitMerge,
  IconChevronRight,
  IconPlus,
  IconArchive,
  IconTrash,
  IconLoader2,
  IconSettings,
  IconCheck,
  IconX,
  IconPencil,
  IconCopy,
  IconList,
  IconCategoryFilled,
  IconArrowRight,
  IconPalette,
  IconSearch,
  IconPin,
  IconPinnedFilled,
  IconSun,
  IconMoon,
  IconFocus,
  IconLayoutSidebarLeftExpand,
} from "@renderer/lib/icons.js";
import { useTheme, applyThemeClass } from "@renderer/lib/theme.js";
import { isMac } from "@renderer/lib/platform.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { ConfirmDialog } from "@renderer/components/ui/index.js";
import { BrandLogo } from "./BrandLogo.js";
import { SidebarQuickActions } from "./SidebarQuickActions.js";
import { RenameDialog, SessionContextMenu, ArchivedRow } from "./SidebarShared.js";
import { LeftBarModeSwitch } from "./StreamSidebar.js";
import {
  ProjectNode,
  SessionRow,
  WorktreeContextMenu,
  GroupNode,
  SortableProjectNode,
  ProjectContextMenu,
  GroupDialog,
} from "./LeftBarParts.js";
import { api } from "@renderer/lib/api.js";
import { normWorktreeKey, worktreeDisplayName } from "@renderer/lib/worktree.js";
import { WorktreeMergeBackDialog, WorktreeRemoveDialog } from "@renderer/components/chat/WorktreeMergeBack.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { makeQuoteTag } from "@renderer/lib/contentTag.js";
import type { Project, Session } from "@contracts/session";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useToastStore } from "@renderer/stores/toastStore.js";

/**
 * Left bar — a tree of projects → sessions, with archive (soft) / delete (hard)
 * icon buttons revealed on hover for every row, plus a collapsible "archived"
 * section at the bottom grouped by project.
 *
 * Sessions are paginated: only the first SESSION_PAGE_SIZE (5) LOCAL threads
 * load per project, and a "加载更多" button under the list appends the next
 * page. Worktree-bound threads load separately (in full) and render as group
 * nodes ABOVE the local list, so a worktree-heavy project never eats into
 * the local list's first page.
 *
 * Replaces the old two flat lists (Projects / Sessions) which had no project
 * switching and no lifecycle actions. Sessions are cached per-project in the
 * store (sessionsByProject = active page slice, archivedSessionsByProject =
 * unpaginated archived rows), so expanding a project is instant.
 *
 * Layout sketch:
 *   EXPLORER                       [+ 添加项目]
 *   ▾ 📁 mcode                 + 🗑
 *       💬 P2会话持久化         📦 🗑
 *       💬 自定义模型     ✓    📦 🗑
 *       加载更多（还有 3 条）
 *   ▸ 📁 blog-site             + 🗑
 *   ─────────────────────────────
 *   ▾ 已归档 (4)
 *       📁 old-project     [恢复] [删]
 *       📁 side-project
 *         💬 old-thread       [恢复] [删]
 *   ─────────────────────────────
 *   ⚙ 设置
 */
function LeftBarBase({
  showSearch = true,
  showConnectPhone = true,
}: {
  /** Forwarded to SidebarQuickActions — the mobile drawer hides the 搜索 /
      连接手机 entries (no Ctrl+K on a phone, and its visitor is already it). */
  showSearch?: boolean;
  showConnectPhone?: boolean;
} = {}) {
  const { t } = useI18n();
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const sessionsByProject = useSessionStore((s) => s.sessionsByProject);
  const sessionsHasMoreByProject = useSessionStore((s) => s.sessionsHasMoreByProject);
  const sessionsTotalByProject = useSessionStore((s) => s.sessionsTotalByProject);
  const archivedSessionsByProject = useSessionStore((s) => s.archivedSessionsByProject);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const expandedProjects = useSessionStore((s) => s.expandedProjects);
  const expandedWorktrees = useSessionStore((s) => s.expandedWorktrees);
  const worktreeNames = useSessionStore((s) => s.worktreeNames);
  const archivedViewOpen = useSessionStore((s) => s.archivedViewOpen);
  /**
   * 「项目」这一段折起来了没有（2026-09-21）。
   *
   * 用户报的问题：「现在的左边栏**项目和下面的文档大类一个不能折叠，一个能折叠**，
   * 这个要统一起來」。项目段原来是个光秃秃的 `<h3>`，而文档大类有折叠箭头 ——
   * 同一层的东西长了两样。这里给项目段补上，与大类**同一个交互**。
   *
   * 局部 state 不进 store：它和「看哪个大类」一样是"这一段自己现在什么样"。
   */
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const pinnedSessions = useSessionStore((s) => s.pinnedSessions);

  const addProject = useSessionStore((s) => s.addProjectFromFolder);
  const toggleProjectExpanded = useSessionStore((s) => s.toggleProjectExpanded);
  const toggleWorktreeExpanded = useSessionStore((s) => s.toggleWorktreeExpanded);
  const renameWorktree = useSessionStore((s) => s.renameWorktree);
  const setArchivedViewOpen = useSessionStore((s) => s.setArchivedViewOpen);
  const loadMoreSessions = useSessionStore((s) => s.loadMoreSessions);
  const startSession = useSessionStore((s) => s.startSession);
  // Use `openTab` rather than `selectSession` so the clicked thread is
  // added to the tab strip (in `tabs` mode) or simply activated (in
  // `single` mode). Both display modes share the same entry point; the
  // difference is whether SessionTabs is mounted above the center pane.
  const openTab = useSessionStore((s) => s.openTab);
  const deleteProject = useSessionStore((s) => s.deleteProject);
  const archiveProject = useSessionStore((s) => s.archiveProject);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const archiveSession = useSessionStore((s) => s.archiveSession);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const setLeftOpen = useSessionStore((s) => s.setLeftOpen);
  const runningBySession = useSessionStore((s) => s.runningBySession);
  const unreadBySession = useSessionStore((s) => s.unreadBySession);
  const renameSession = useSessionStore((s) => s.renameSession);
  const setSessionPinned = useSessionStore((s) => s.setSessionPinned);
  const forkSession = useSessionStore((s) => s.forkSession);
  const renameProject = useSessionStore((s) => s.renameProject);
  const setProjectPinned = useSessionStore((s) => s.setProjectPinned);
  const projectView = useSessionStore((s) => s.projectView);
  const setProjectView = useSessionStore((s) => s.setProjectView);
  const setProjectGroup = useSessionStore((s) => s.setProjectGroup);
  const reorderProjects = useSessionStore((s) => s.reorderProjects);
  const groupMeta = useSessionStore((s) => s.groupMeta);
  const setGroupColor = useSessionStore((s) => s.setGroupColor);
  const setGroupOrder = useSessionStore((s) => s.setGroupOrder);
  const renameGroupMeta = useSessionStore((s) => s.renameGroupMeta);

  // Resolve a session's owning project (for the "open project folder" menu
  // action). Falls back to undefined if the session's project isn't loaded.
  const findProject = useCallback(
    (projectId: string) => projects.find((p) => p.id === projectId),
    [projects],
  );

  // The active session's owning project, resolved from the loaded per-project
  // slices (the owning project auto-expands on activation, so its slice is
  // loaded). Used to SUPPRESS the project row's selected look while one of its
  // threads is selected: the thread row already carries the selection, and a
  // highlighted parent + child reads as two selections. Null when no session
  // is active (or it isn't loaded yet) — then a directly-selected project
  // (e.g. a freshly added empty project) keeps its highlight.
  const activeSessionProjectId = useMemo(() => {
    if (!activeSessionId) return null;
    for (const [pid, list] of Object.entries(sessionsByProject)) {
      if (list.some((s) => s.id === activeSessionId)) return pid;
    }
    // Pinned rows render in the global pinned section, not their project's
    // list — resolve the owner from the pinned bucket so the project row
    // still suppresses its own selection while the pinned row is active.
    const pinned = pinnedSessions.find((s) => s.id === activeSessionId);
    return pinned ? pinned.projectId : null;
  }, [activeSessionId, sessionsByProject, pinnedSessions]);

  // Theme quick-toggle (bottom rail). useTheme subscribes to theme.changed,
  // so the icon stays in sync when the theme changes elsewhere (settings
  // panel, or the OS flipping while in "system" mode). The toggle flips
  // between the two EXPLICIT themes based on what's currently rendering —
  // a "system" preference resolves via `effective` and lands on the opposite
  // explicit theme.
  const { effective: effectiveTheme } = useTheme();
  const toggleTheme = () => {
    const next = effectiveTheme === "dark" ? "light" : "dark";
    void api.theme.set({ theme: next }).then((s) => {
      applyThemeClass(s.effective);
    });
  };

  // ── Scroll-to-active-thread (clicking a tab should locate the thread in
  // the left bar, even across collapsed groups/projects and un-paginated
  // pages). Each SessionRow registers its <li> node here;
  // locateActiveSession() scrolls it into view and, when the row isn't in
  // the DOM yet, expands the owning group + project (whichever is
  // collapsed), then loads more pages until it mounts. Called by the effect
  // below (auto-locate on activeSessionId change, "nearest" so the list
  // barely moves) and by the bottom-rail locate button ("center" for an
  // explicit jump). Mirrors SessionTabs' tabNodes pattern + FileTree's
  // "mount-may-be-delayed" handling.
  const rowNodes = useRef<Map<string, HTMLLIElement>>(new Map());
  const registerNode = useCallback((id: string, el: HTMLLIElement | null) => {
    if (el) rowNodes.current.set(id, el);
    else rowNodes.current.delete(id);
  }, []);

  const locateActiveSession = useCallback((center = false) => {
    const id = useSessionStore.getState().activeSessionId;
    if (!id) return;

    const tryScroll = () => {
      const el = rowNodes.current.get(id);
      if (el) {
        el.scrollIntoView({ block: center ? "center" : "nearest", behavior: "smooth" });
        return true;
      }
      return false;
    };

    if (tryScroll()) return;

    // The active row isn't mounted yet. Reasons: its GROUP is collapsed
    // (grouped view — group collapse is LeftBar-local state the store can't
    // touch), its project row is collapsed (syncConfigFromSession expands it
    // on activation, but the user can collapse it again afterwards), or it's
    // beyond the loaded page slice. Find its project, reveal the ancestors,
    // then keep loading pages until the row appears or there's no more.
    void (async () => {
      // Re-check after a paint in case the expand just rendered the row.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (tryScroll()) return;

      const st = useSessionStore.getState();
      let projectId: string | undefined;
      for (const pid of Object.keys(st.sessionsByProject)) {
        if (st.sessionsByProject[pid]?.some((s) => s.id === id)) {
          projectId = pid;
          break;
        }
      }
      if (!projectId) {
        // Pinned rows live in the global pinned section, not the per-project
        // slices — if it's there, expand the section (rows register nodes on
        // mount) and scroll to it; no project/page expansion needed.
        if (st.pinnedSessions.some((s) => s.id === id)) {
          setPinnedOpen(true);
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          tryScroll();
          return;
        }
        return; // archived / unknown - nothing to scroll to.
      }

      // Reveal ancestors so the row can mount at all. Grouped view: expand
      // the owning group when collapsed (identity return when already open —
      // React bails out, no extra render). A PINNED parent renders inside the
      // pinned-projects section instead — expand that section too when it's
      // collapsed (mirrors the pinned-session branch above). Then expand the
      // project row when collapsed — the toggle's expand path is a pure local
      // set, so it never clobbers the loaded slice (the pagination loop below
      // refills whatever a prior collapse trimmed away).
      const proj = st.projects.find((p) => p.id === projectId);
      if (st.projectView === "grouped" && proj?.group) {
        const groupName = proj.group;
        setCollapsedGroups((g) => (g[groupName] ? { ...g, [groupName]: false } : g));
      }
      if (proj?.pinnedAt != null) {
        setPinnedProjectsOpen(true);
      }
      if (!st.expandedProjects[projectId]) {
        st.toggleProjectExpanded(projectId);
      }
      // Same reveal for the worktree group node the target thread buckets
      // under — a collapsed group keeps the row unmounted, so tryScroll would
      // silently miss it even with the project expanded. Groups render
      // COLLAPSED by default (absent key = folded), so every group that is not
      // already explicitly open needs expanding here.
      const target = st.sessionsByProject[projectId]?.find((s) => s.id === id);
      if (target?.worktreePath && !st.expandedWorktrees[normWorktreeKey(target.worktreePath)]) {
        st.toggleWorktreeExpanded(target.worktreePath);
      }
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (tryScroll()) return;

      // Load successive pages until the target row mounts or pages run out.
      for (;;) {
        const s = useSessionStore.getState();
        if (!s.sessionsHasMoreByProject[projectId]) break;
        await s.loadMoreSessions(projectId);
        if (tryScroll()) break;
      }
    })();
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
    locateActiveSession();
  }, [activeSessionId, locateActiveSession]);

  // ── Right-click context menu for session rows. Controlled Menu + a virtual
  // anchor positioned at the cursor, so the popup opens exactly where the user
  // right-clicked (base-ui's ContextMenu.Trigger anchors to the element edge,
  // not the cursor, which doesn't match the expected behavior).
  const [ctxMenu, setCtxMenu] = useState<{ session: Session; x: number; y: number } | null>(null);

  // ── Rename dialog state. Shared by sessions, projects, and worktree
  // groups; `kind` picks the dialog copy and the dispatch target on submit.
  // For kind "worktree" `id` carries the RAW worktree path.
  const [renaming, setRenaming] = useState<{
    id: string;
    title: string;
    kind: "session" | "project" | "worktree";
  } | null>(null);

  // ── Right-click context menu for worktree group nodes (new session in
  // this worktree / rename). Same controlled-Menu + virtual-anchor pattern
  // as the session and project menus below. `projectId` rides along so the
  // menu can spawn the new thread in the right project.
  const [wtCtxMenu, setWtCtxMenu] = useState<
    | { projectId: string; worktreePath: string; x: number; y: number }
    | null
  >(null);

  // ── Group-level merge-back dialog (left panel's "全量合并"): every
  // session under a worktree shares ONE checkout, so a single merge-back of
  // the directory covers all their unmerged work.
  const [wtMerge, setWtMerge] = useState<{ repoPath: string; worktreePath: string } | null>(null);

  // ── Group-level removal (guarded by the shared confirm dialog — dirty
  // trees get the patch-export / force options). On success the backend
  // degrades every referencing session back to local and broadcasts, which
  // also flips this project's view back to the local list.
  const [wtRemove, setWtRemove] = useState<{ repoPath: string; worktreePath: string } | null>(null);

  // ── Delete confirmation dialog state. A single controlled ConfirmDialog
  // replaces the three native confirm() calls (active project, archived
  // project, archived session). The `kind` discriminator carries enough
  // context to render the right title/description and dispatch the right
  // destructive action on confirm.
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: "project"; id: string; name: string }
    | { kind: "session"; id: string; title: string }
    | null
  >(null);

  // ── Project grouping state (left-bar "grouped" view).
  // `projectCtxMenu` is the right-click menu on a project row; the submenu of
  // existing groups + "新建分组" + "移出分组" lives inside it. `groupDialog`
  // drives the small dialog for creating a new group (or renaming one — both
  // flows share the same input UI, distinguished by `mode`). `collapsedGroups`
  // is in-memory expand state for the group headers, mirroring
  // `expandedProjects` for project rows.
  const [projectCtxMenu, setProjectCtxMenu] = useState<
    | { project: Project; x: number; y: number }
    | null
  >(null);
  const [groupDialog, setGroupDialog] = useState<
    | { mode: "create"; projectId: string }
    | { mode: "rename"; groupName: string }
    | null
  >(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  // Expand state for the global pinned section (in-memory, defaults open so
  // the feature is discoverable; mirrors the archived bin's local toggle).
  const [pinnedOpen, setPinnedOpen] = useState(true);
  // Same pattern for the pinned-PROJECTS section above the project tree.
  const [pinnedProjectsOpen, setPinnedProjectsOpen] = useState(true);

  // Split into active vs archived. Active projects show in the tree;
  // archived projects (whole-project archive) show as their own rows in
  // the archived bin, while archived SESSIONS under still-active projects
  // are grouped by their parent project in the bin.
  const activeProjects = projects.filter((p) => !p.archived);
  const archivedProjects = projects.filter((p) => p.archived);

  // Pinned projects leave the flat list / their group and render in a
  // dedicated pinned section ABOVE the tree (most recent pin first — the
  // store refetches the DB-ordered list after every pin toggle, so this
  // array's order already carries it). Everything below (grouped buckets,
  // drag order) operates on the remaining tree projects only.
  const pinnedProjects = activeProjects.filter((p) => p.pinnedAt != null);
  const treeProjects = activeProjects.filter((p) => p.pinnedAt == null);

  // Archived sessions grouped by their (still-active) parent project, in
  // the same project order as the tree above. Empty groups are skipped.
  const archivedGroups = activeProjects
    .map((p) => ({ project: p, sessions: archivedSessionsByProject[p.id] ?? [] }))
    .filter((g) => g.sessions.length > 0);
  const archivedCount = archivedProjects.length + archivedGroups.reduce((n, g) => n + g.sessions.length, 0);

  // ── Grouped view buckets. In "grouped" mode the active tree clusters
  // projects under collapsible headers keyed by `Project.group`. Groups are
  // ordered by first appearance (treeProjects is already created_at-ASC);
  // ungrouped projects (group == null) render in a trailing flat section.
  // Pinned projects never enter a bucket — they render in the pinned section
  // above the tree, outside (and independent of) their group.
  // Memoized so the bucketing only re-runs when the project list changes.
  const { groupedProjects, ungroupedProjects, knownGroups } = useMemo(() => {
    const grouped = new Map<string, Project[]>();
    const ungrouped: Project[] = [];
    for (const p of treeProjects) {
      const g = p.group && p.group.length > 0 ? p.group : null;
      if (g == null) {
        ungrouped.push(p);
      } else {
        const arr = grouped.get(g);
        if (arr) arr.push(p);
        else grouped.set(g, [p]);
      }
    }
    // Reorder groups by stored `order` (from groupMeta); groups absent from
    // meta keep their first-appearance order (stable fallback). Entries are
    // rebuilt into a new Map so iteration reflects the sorted order.
    const ordered = [...grouped.entries()].sort((a, b) => {
      const oa = groupMeta[a[0]]?.order ?? Number.MAX_SAFE_INTEGER;
      const ob = groupMeta[b[0]]?.order ?? Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return 0; // equal order (incl. both absent) → preserve insertion order
    });
    const sorted = new Map(ordered);
    return {
      groupedProjects: sorted,
      ungroupedProjects: ungrouped,
      knownGroups: Array.from(sorted.keys()),
    };
  }, [treeProjects, groupMeta]);

  // ── Drag-to-reorder. A single SortableContext covers every visible
  // project (flat list OR all groups flattened in display order). sortable
  // ids are namespaced ("proj:<id>" / "group:<name>") so project ids never
  // collide with group-header droppables. `displayOrder` is the flattened
  // visible order used by onDragEnd to compute from/to indices. Pinned
  // projects are NOT part of it — they render outside the SortableContext,
  // and their sort_order stays frozen while pinned (unpinning returns them
  // to their drag-order spot).
  const displayOrder = useMemo(() => {
    if (projectView === "flat") return treeProjects;
    const out: Project[] = [];
    for (const projs of groupedProjects.values()) out.push(...projs);
    out.push(...ungroupedProjects);
    return out;
  }, [projectView, treeProjects, groupedProjects, ungroupedProjects]);

  // Sortable ids: projects always; group headers too in grouped view (so
  // groups can be dragged to reorder among themselves). Both are namespaced
  // ("proj:<id>" / "group:<name>") so they never collide.
  const sortableItems = useMemo(() => {
    const ids = displayOrder.map((p) => `proj:${p.id}`);
    if (projectView === "grouped") {
      for (const g of groupedProjects.keys()) ids.push(`group:${g}`);
    }
    return ids;
  }, [displayOrder, projectView, groupedProjects]);

  // Sensors: a 6px movement activates a drag (less is a click, so taps on the
  // project row still expand/collapse). Touch gets a short delay so a scroll
  // isn't hijacked. Mirrors SessionTabs.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
  );

  const findProjectById = useCallback(
    (id: string) => treeProjects.find((p) => p.id === id),
    [treeProjects],
  );

  // Live cross-group reassignment while dragging. Fires as the pointer moves
  // over a different group's project or header; setProjectGroup is a no-op if
  // the group hasn't changed (guarded here) so we don't thrash the IPC.
  const onDragOver = useCallback(
    (e: DragOverEvent) => {
      const { active, over } = e;
      if (!over) return;
      const activeId = String(active.id);
      const overId = String(over.id);
      if (!activeId.startsWith("proj:")) return;
      const pid = activeId.slice(5);
      const proj = findProjectById(pid);
      if (!proj) return;

      if (overId.startsWith("group:")) {
        const groupName = overId.slice(6);
        if (proj.group !== groupName) void setProjectGroup(pid, groupName);
      } else if (overId.startsWith("proj:")) {
        const overProj = findProjectById(overId.slice(5));
        const targetGroup = overProj?.group ?? null;
        if ((proj.group ?? null) !== targetGroup) {
          void setProjectGroup(pid, targetGroup);
        }
      }
    },
    [findProjectById, setProjectGroup],
  );

  // Final position commit on drop. Two branches: group-on-group reorders the
  // group list (persists group order); project-on-project reorders projects.
  // Project-dropped-on-group reassignment is handled live in onDragOver.
  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const activeId = String(active.id);
      const overId = String(over.id);
      // Group reorder
      if (activeId.startsWith("group:") && overId.startsWith("group:")) {
        const names = Array.from(groupedProjects.keys());
        const from = names.indexOf(activeId.slice(6));
        const to = names.indexOf(overId.slice(6));
        if (from === -1 || to === -1 || from === to) return;
        setGroupOrder(arrayMove(names, from, to));
        return;
      }
      // Project reorder
      if (!activeId.startsWith("proj:") || !overId.startsWith("proj:")) return;
      const ids = displayOrder.map((p) => p.id);
      const from = ids.indexOf(activeId.slice(5));
      const to = ids.indexOf(overId.slice(5));
      if (from === -1 || to === -1 || from === to) return;
      const next = arrayMove(ids, from, to);
      void reorderProjects(next);
    },
    [displayOrder, reorderProjects, groupedProjects, setGroupOrder],
  );

  // Shared <ProjectNode> renderer. Hoisted as a callback so the flat view,
  // the grouped view, AND the pinned-projects section render identical rows
  // (and the group node can embed it). Bound to onContextMenu to open the
  // project-grouping context menu. `sortable` wraps the row in
  // SortableProjectNode — false for pinned rows, which render outside the
  // DndContext (pinning, not dragging, is how they got there).
  const renderProjectNode = useCallback(
    (p: Project, sortable = true) => {
      const node = (
        <ProjectNode
          // 列表里每个元素都要有 key:这个函数是给三处 `.map()` 用的
          //(置顶 / 树 / 未分组),而 React 把缺 key 的数组报成"Check the render
          // method of LeftBarBase" —— 元素是在这里造的,它只知道最外层那个组件。
          // 键的写法与 DnD 那套 id 一致(`proj:<id>`),免得同一个项目在两处有
          // 两种身份。dnd-kit 自己那份 id 在 SortableProjectNode 的 projectId 上,
          // 与这里的 React key 是两件事,互不影响。
          key={`proj:${p.id}`}
          project={p}
          sessions={sessionsByProject[p.id] ?? []}
          hasMore={!!sessionsHasMoreByProject[p.id]}
          total={sessionsTotalByProject[p.id] ?? 0}
          expanded={!!expandedProjects[p.id]}
          // Selected look only when the project is active WITHOUT one of its
          // threads being the active session (see activeSessionProjectId).
          isActiveProject={p.id === activeProjectId && activeSessionProjectId !== p.id}
          activeSessionId={activeSessionId}
          runningBySession={runningBySession}
          unreadBySession={unreadBySession}
          onToggleExpand={() => toggleProjectExpanded(p.id)}
          onNewSession={() => void startSession(p.id)}
          onLoadMore={() => void loadMoreSessions(p.id)}
          onSelectSession={(sid) => void openTab(sid)}
          onDelete={() => {
            setConfirmDelete({ kind: "project", id: p.id, name: p.name });
          }}
          onArchiveSession={(sid) => void archiveSession(sid, true)}
          onDeleteSession={(s) => void deleteSession(s.id)}
          onTogglePinSession={(s) => void setSessionPinned(s.id, !s.pinnedAt)}
          onNewWorktreeHere={(s) => void startSession(s.projectId, { worktreePath: s.worktreePath ?? undefined })}
          worktreeNames={worktreeNames}
          expandedWorktrees={expandedWorktrees}
          onToggleWorktree={(path) => toggleWorktreeExpanded(path)}
          onNewSessionInWorktree={(path) => void startSession(p.id, { worktreePath: path })}
          onRemoveWorktree={(path) => setWtRemove({ repoPath: p.path, worktreePath: path })}
          onMergeWorktree={(path) => setWtMerge({ repoPath: p.path, worktreePath: path })}
          onContextWorktree={(path, x, y) => setWtCtxMenu({ projectId: p.id, worktreePath: path, x, y })}
          registerNode={registerNode}
          onContextSession={(session, x, y) => setCtxMenu({ session, x, y })}
          onContextProject={(x, y) => setProjectCtxMenu({ project: p, x, y })}
        />
      );
      return sortable ? (
        <SortableProjectNode key={`proj-sortable:${p.id}`} projectId={p.id}>
          {node}
        </SortableProjectNode>
      ) : (
        node
      );
    },
    [
      sessionsByProject, sessionsHasMoreByProject, sessionsTotalByProject,
      expandedProjects, expandedWorktrees, worktreeNames,
      activeProjectId, activeSessionId, activeSessionProjectId,
      // unreadBySession 也是行里要画的数据 —— 漏了它，未读角标只能搭别的依赖的便车刷新。
      runningBySession, unreadBySession,
      toggleProjectExpanded, toggleWorktreeExpanded, startSession, loadMoreSessions, openTab,
      archiveSession, deleteSession, setSessionPinned, registerNode,
    ],
  );

  return (
    <div className="flex h-full flex-col px-2 py-2 [font-size:var(--right-panel-font-size)]">
      {/* Top strip. mac: the brand header (logo + name) was removed — the
          strip now hosts the sidebar-collapse toggle, moved up from the
          footer, sitting right of the traffic lights (trafficLightPosition
          {x:20,y:13}: three 12px circles ending ~x=72): -mt-2 cancels the
          root's pt-2 so the box spans the Titlebar's 40px band (y 0..40) and
          the button centers on the traffic lights' centerline; pl-[70px]
          clears the buttons (toggle starts at x≈78). The strip doubles as a
          window drag handle; the button opts out. win: keeps the original
          brand header (logo + name + tagline), clicking it collapses the
          sidebar (setLeftOpen(false)) — settings remain in the footer. */}
      {isMac ? (
        <div
          className="-mt-2 mb-2 flex h-10 items-center gap-1 pl-[70px]"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        >
          <button
            type="button"
            onClick={() => setLeftOpen(false)}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded text-content-muted transition-colors",
              "cds-hover-ghost hover:text-content",
            )}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            title={t("layout.hideLeftPanel")}
          >
            <IconLayoutSidebarLeftExpand size={18} className="shrink-0" />
          </button>
          {/* Tree ↔ stream view switch (same spot in both sidebars). */}
          <LeftBarModeSwitch />
        </div>
      ) : (
        <div className="mb-2" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setLeftOpen(false)}
              className={cn(
                "group flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors",
                "cds-hover-ghost ",
              )}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            title={t("layout.hideLeftPanel")}
          >
            <BrandLogo size={30} />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-[1.07em] font-semibold tracking-tight text-content">
                Mcode
              </span>
              <span className="truncate text-content-subtle [font-size:var(--rp-fs-sm)]">
                {t("layout.tagline")}
              </span>
            </span>
            </button>
            {/* Tree ↔ stream view switch (same spot in both sidebars). */}
            <LeftBarModeSwitch />
          </div>
        </div>
      )}

      {/* Quick actions — 新建会话 / 搜索 / 连接手机. Full-width buttons
          docked directly under the brand logo so the most-used workspace
          entry points are always visible without scrolling. */}
      <SidebarQuickActions
        showSearch={showSearch}
        showConnectPhone={showConnectPhone}
      />

      {/* Header */}
      <div className="group mb-1 flex items-center justify-between px-1">
        <div className="flex min-w-0 items-center">
          {/* 折叠箭头 —— 与文档大类那一个**逐字同一套**（w-3 槽 + 10px chevron +
              rotate-90）。两段是同级的，箭头错开半格就很明显。 */}
          <button
            onClick={() => setProjectsCollapsed((v) => !v)}
            title={projectsCollapsed ? t("layout.expand") : t("layout.collapse")}
            aria-label={projectsCollapsed ? t("layout.expand") : t("layout.collapse")}
            className="flex w-3 shrink-0 items-center justify-center text-content-subtle hover:text-content"
          >
            <IconChevronRight
              size={10}
              className={cn("transition-transform", !projectsCollapsed && "rotate-90")}
            />
          </button>
          <h3 className="truncate font-semibold uppercase tracking-wide text-content-subtle [font-size:var(--left-section-title-fs)]">
            {t("layout.projects")}
          </h3>
        </div>
        <div className="flex items-center gap-1">
          {/* View-mode toggle: flat list vs grouped under headers. Hover-
              revealed (mirrors the add-project button below) to keep the
              header clean; the active segment still highlights on hover so
              the current mode is discoverable. */}
          <div
            className={cn(
              "flex items-center rounded border border-edge transition-all",
              "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
            )}
            role="group"
            aria-label={t("layout.projectViewMode")}
          >
            <button
              onClick={() => void setProjectView("flat")}
              className={cn(
                "flex items-center rounded-l px-1 py-0.5 transition-colors",
                projectView === "flat"
                  ? "bg-surface-hover text-content"
                  : "cds-hover-ghost text-content-subtle hover:text-content",
              )}
              title={t("layout.viewFlat")}
              aria-label={t("layout.viewFlat")}
              aria-pressed={projectView === "flat"}
            >
              <IconList size={13} />
            </button>
            <button
              onClick={() => void setProjectView("grouped")}
              className={cn(
                "flex items-center rounded-r border-l border-edge px-1 py-0.5 transition-colors",
                projectView === "grouped"
                  ? "bg-surface-hover text-content"
                  : "cds-hover-ghost text-content-subtle hover:text-content",
              )}
              title={t("layout.viewGrouped")}
              aria-label={t("layout.viewGrouped")}
              aria-pressed={projectView === "grouped"}
            >
              <IconCategoryFilled size={13} />
            </button>
          </div>
          <button
            onClick={() => void addProject()}
            className={cn(
              "flex items-center rounded px-1 py-0.5 text-content-muted transition-all",
              // Always visible when there are no projects so the user has a
              // clear entry point to add one (no empty placeholder row anymore).
              projects.length === 0
                ? "opacity-100 hover:text-content"
                : "opacity-0 hover:text-content group-hover:opacity-100 group-focus-within:opacity-100",
            )}
            title={t("layout.addProject")}
            aria-label={t("layout.addProject")}
          >
            <IconPlus size={12} />
          </button>
        </div>
      </div>

      {/* Project → session tree. A single DndContext wraps both view modes:
          flat list reorders in place; grouped view reorders within the
          flattened display order AND supports cross-group drag-to-reassign
          (handled live in onDragOver). Group headers are droppable targets
          (not draggable) so dropping a project on a header moves it there. */}
      <ScrollFade className="min-h-0 flex-1">
        {/* ── 折起来之后**项目树整块收掉**（2026-09-21）──
            ⚠️ 上一版的箭头**只转向、不折内容**：`projectsCollapsed` 只用在那个
            `IconChevronRight` 上，从来没拿去藏过东西。用户报「项目的折叠不能用」
            就是这个 —— 点了箭头，列表纹丝不动。

            这一段（置顶项目 + 项目树）就是"项目"那一段的内容，与大类那边
            `collapsed ? null : (...)` 是同一个做法。 */}
        {projectsCollapsed ? null : (
        <>
        {/* Pinned projects — the project-level counterpart of the pinned
            sessions section below: pinned projects leave the flat list /
            their group and live here until unpinned. Rows are full
            ProjectNodes (expandable, context menu, delete) rendered OUTSIDE
            the DndContext — dragging is the unpinned list's ordering tool,
            pinning is this section's. Rendered ABOVE the pinned-sessions
            section (project-before-thread mirrors the tree's hierarchy).
            Hidden entirely when nothing is pinned. */}
        {pinnedProjects.length > 0 && (
          <div className="mb-2">
            <button
              onClick={() => setPinnedProjectsOpen(!pinnedProjectsOpen)}
              className={cn(
                "flex w-full items-center gap-1 rounded px-1 py-0.5 font-medium uppercase tracking-wide [font-size:var(--rp-fs-md)]",
                "cds-hover-ghost text-content-subtle transition-colors",
              )}
            >
              <IconChevronRight
                size={12}
                className={cn(
                  "shrink-0 transition-transform",
                  pinnedProjectsOpen && "rotate-90",
                )}
              />
              <IconPin size={12} className="shrink-0 text-accent/70" />
              {t("layout.pinnedProjectsSection", { n: pinnedProjects.length })}
            </button>
            {pinnedProjectsOpen && (
              <ul className="mt-1 space-y-0.5">
                {pinnedProjects.map((p) => renderProjectNode(p, false))}
              </ul>
            )}
          </div>
        )}
        {/* Pinned sessions — a global section collecting the pinned threads
            of every project (pinned rows leave their project's list and live
            here until unpinned). Rendered INSIDE the scroll region, above the
            project tree, so it scrolls together with the grouped projects
            instead of staying fixed while the tree scrolls under it. Mirrors
            the archived bin's collapsible-header pattern, but defaults open.
            Hidden entirely when nothing is pinned. */}
        {pinnedSessions.length > 0 && (
          <div className="mb-2">
            <button
              onClick={() => setPinnedOpen(!pinnedOpen)}
              className={cn(
                "flex w-full items-center gap-1 rounded px-1 py-0.5 font-medium uppercase tracking-wide [font-size:var(--rp-fs-md)]",
                "cds-hover-ghost text-content-subtle transition-colors",
              )}
            >
              <IconChevronRight
                size={12}
                className={cn(
                  "shrink-0 transition-transform",
                  pinnedOpen && "rotate-90",
                )}
              />
              <IconPin size={12} className="shrink-0 text-accent/70" />
              {t("layout.pinnedSection", { n: pinnedSessions.length })}
            </button>
            {pinnedOpen && (
              <ul className="mt-1 space-y-0.5">
                {pinnedSessions.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    active={s.id === activeSessionId}
                    isRunning={!!runningBySession[s.id]}
                    unreadCount={unreadBySession[s.id] ?? 0}
                    onSelect={() => void openTab(s.id)}
                    onTogglePin={() => void setSessionPinned(s.id, !s.pinnedAt)}
                    onArchive={() => void archiveSession(s.id, true)}
                    onDelete={() => void deleteSession(s.id)}
                    onNewWorktreeSession={
                      s.worktreePath
                        ? () => void startSession(s.projectId, { worktreePath: s.worktreePath ?? undefined })
                        : undefined
                    }
                    registerNode={registerNode}
                    onContext={(x, y) => setCtxMenu({ session: s, x, y })}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
        {projects.length === 0 ? null : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
              {projectView === "flat" ? (
                <ul className="space-y-0.5">
                  {treeProjects.map((p) => renderProjectNode(p))}
                </ul>
              ) : (
                <ul className="space-y-0.5">
                  {Array.from(groupedProjects.entries()).map(([groupName, projs]) => (
                    <GroupNode
                      key={groupName}
                      groupName={groupName}
                      projects={projs}
                      groupColor={groupMeta[groupName]?.color ?? null}
                      collapsed={!!collapsedGroups[groupName]}
                      onToggle={() =>
                        setCollapsedGroups((s) => ({ ...s, [groupName]: !s[groupName] }))
                      }
                      onRenameGroup={() =>
                        setGroupDialog({ mode: "rename", groupName })
                      }
                      onDeleteGroup={() => {
                        // Removing a group nulls every member's group field.
                        // Look members up across ALL active projects, not just
                        // the bucket — pinned members sit outside the tree but
                        // keep their `group` for when they return, and leaving
                        // it set would resurrect a ghost group on unpin.
                        activeProjects
                          .filter((p) => p.group === groupName)
                          .forEach((p) => void setProjectGroup(p.id, null));
                      }}
                      onSetColor={(rgb) => setGroupColor(groupName, rgb)}
                      renderProject={renderProjectNode}
                    />
                  ))}
                  {ungroupedProjects.length > 0 && (
                    <>
                      {/* Separator label only when there are also groups above;
                          a lone ungrouped section looks like the flat list. */}
                      {groupedProjects.size > 0 && (
                        <li className="px-1 py-0.5 text-content-subtle [font-size:var(--rp-fs-md)]">
                          {t("layout.ungrouped")}
                        </li>
                      )}
                      {ungroupedProjects.map((p) => renderProjectNode(p))}
                    </>
                  )}
                </ul>
              )}
            </SortableContext>
          </DndContext>
        )}
        </>
        )}

        {/* 资料库 —— 与「项目」并列的顶层分组,按要求排在项目段**下面**。
            放在这个滚动容器**内部**(而不是容器外):库多、或者展开着几十篇
            文献时,它跟着一起滚,不会把上面的项目列表挤扁。表头样式与项目段
            逐字对齐,两段读起来是一个体系。
            段落按**大类**走(一段一个组,组表来自主进程、设置页可编辑):
            旧的独立模版段不再单独挂 —— 它那五类已由主进程启动时自动迁移进
            统一库,现在就是「模版」这个组。 */}
        <div className="mt-3">
          <LibrarySections />
        </div>
      </ScrollFade>

      {/* ── 回收站：**钉在左栏最底部**，不跟上面的列表一起滚（2026-09-21）──
          用户的原话：「回收站是固定到页面最下面的…不是随着我的文件的折叠而上下移动」，
          「相当于你开一个和侧边栏同宽度的在顶层固定的小滚动窗口」。

          所以它**在滚动容器之外**：上面那段（项目 + 资料库）怎么滚、怎么折叠，
          这一条都不动。它自己是一个独立的滚动区（上限 40vh），条目多时自己滚。 */}
      <LibraryTrashRow />

      {/* Archived bin — archived projects first, then archived sessions
          grouped by their parent project. */}
      {archivedCount > 0 && (
        <div className="mt-2 border-t border-edge pt-2">
          <button
            onClick={() => setArchivedViewOpen(!archivedViewOpen)}
            className={cn(
              "flex w-full items-center gap-1 rounded px-1 py-0.5 font-medium uppercase tracking-wide [font-size:var(--rp-fs-md)]",
              "cds-hover-ghost text-content-subtle transition-colors",
            )}
          >
            <IconChevronRight
              size={12}
              className={cn(
                "shrink-0 transition-transform",
                archivedViewOpen && "rotate-90",
              )}
            />
            {t("layout.archivedCount", { n: archivedCount })}
          </button>
          {archivedViewOpen && (
            <ul className="mt-1 space-y-0.5">
              {archivedProjects.map((p) => (
                <ArchivedRow
                  key={p.id}
                  icon={<IconFolder size={14} className="opacity-60" />}
                  title={p.name}
                  onRestore={() => void archiveProject(p.id, false)}
                  onDelete={() => {
                    setConfirmDelete({ kind: "project", id: p.id, name: p.name });
                  }}
                />
              ))}
              {archivedGroups.map(({ project, sessions }) => (
                <li key={project.id} className="mt-0.5">
                  {/* Group header: parent project name (non-interactive). */}
                  <div className="flex items-center gap-1 px-1 py-0.5 text-content-subtle [font-size:var(--rp-fs-md)]">
                    <IconFolder size={12} className="opacity-50" />
                    <span className="truncate">{project.name}</span>
                  </div>
                  <ul className="ml-3 space-y-0.5 border-l border-edge/50 pl-2">
                    {sessions.map((s) => (
                      <ArchivedRow
                        key={s.id}
                        icon={(() => {
                          const { Icon, color } = getProviderIcon(s.providerId);
                          return <Icon size={14} className={cn("opacity-60", color)} />;
                        })()}
                        title={s.title}
                        onRestore={() => void archiveSession(s.id, false)}
                        onDelete={() => {
                          setConfirmDelete({ kind: "session", id: s.id, title: s.title });
                        }}
                      />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Settings + locate + theme quick-toggle — entry moved here from the
          (removed) TopBar header. Docked to the bottom of the left rail so
          it's always reachable regardless of how far the project list
          scrolls. The two compact square buttons right of 设置: locate
          (scroll the project tree to the active session, centering it) and
          theme (sun while dark → light, moon while light → dark). */}
      <div className="mt-2 flex shrink-0 items-center gap-1 border-t border-edge pt-1.5">
        <button
          onClick={() => setSettingsOpen(true)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-content-muted transition-colors [font-size:var(--right-panel-font-size)]",
            "cds-hover-ghost hover:text-content",
          )}
          title={t("layout.settings")}
        >
          <IconSettings size={14} className="shrink-0" />
          {t("layout.settings")}
        </button>
        <button
          onClick={() => locateActiveSession(true)}
          disabled={!activeSessionId}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded text-content-muted transition-colors [font-size:var(--right-panel-font-size)]",
            "cds-hover-ghost  hover:text-content disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
          )}
          title={t("layout.locateSession")}
        >
          <IconFocus size={14} />
        </button>
        <button
          onClick={toggleTheme}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded text-content-muted transition-colors [font-size:var(--right-panel-font-size)]",
            "cds-hover-ghost hover:text-content",
          )}
          title={effectiveTheme === "dark" ? t("layout.themeToLight") : t("layout.themeToDark")}
        >
          {effectiveTheme === "dark" ? <IconSun size={14} /> : <IconMoon size={14} />}
        </button>
        {/* Collapse-sidebar toggle — win only. On mac it moved to the
            sidebar's top strip (right of the traffic lights). The toolbar
            re-shows its own toggle while the sidebar is CLOSED, since this
            footer button is inside the hidden sidebar then. */}
        {!isMac && (
          <button
            onClick={() => setLeftOpen(false)}
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded text-content-muted transition-colors [font-size:var(--right-panel-font-size)]",
              "cds-hover-ghost hover:text-content",
            )}
            title={t("layout.hideLeftPanel")}
          >
            <IconLayoutSidebarLeftExpand size={14} />
          </button>
        )}
      </div>

      {/* Right-click context menu for session rows. Rendered once at the bar
          level and positioned at the cursor via a virtual anchor. */}
      <SessionContextMenu
        ctxMenu={ctxMenu}
        onClose={() => setCtxMenu(null)}
        onRename={(s) => { setCtxMenu(null); setRenaming({ id: s.id, title: s.title, kind: "session" }); }}
        onCopyTitle={(s) => { void navigator.clipboard.writeText(s.title); setCtxMenu(null); }}
        // 复制 id：用户把它粘进**别的**对话，那一边的模型就能按 id 读这条的记录。
        // 给一句 toast 是因为 id 是一串无意义的字符 —— 拷没拷成，光看剪贴板看不出来。
        onCopyId={(s) => {
          void navigator.clipboard.writeText(s.id);
          setCtxMenu(null);
          useToastStore.getState().push({ kind: "info", title: t("layout.copiedSessionId") });
        }}
        // 引用到当前对话（2026-09-24）：**不读这条对话的正文**，只落一个引用标签，
        // 提示词里给标题 + id，目标那边的模型自己用 `session_read_log` 按模式读。
        // 用户明确要求「不要直接把其他对话的全部内容直接插入进去，让模型自己查」。
        onQuoteSession={(s) => {
          setCtxMenu(null);
          const store = useSessionStore.getState();
          const targetId = store.activeSessionId;
          if (!targetId) {
            useToastStore.getState().push({ kind: "warning", title: t("layout.quoteSessionNoTarget") });
            return;
          }
          // 引用自己没意义（它就是当前对话）。**要说话**：裸 return 的话用户看到的
          // 就是"点了没反应" —— 一个按下去什么都不发生的按钮比没有更坏。
          if (targetId === s.id) {
            useToastStore.getState().push({ kind: "info", title: t("layout.quoteSessionSelf") });
            return;
          }
          const tag = makeQuoteTag({
            text: "",
            origin: { kind: "otherSession", sessionTitle: s.title, sessionId: s.id },
          });
          store.quoteIntoComposer(targetId, tag);
        }}
        onOpenFolder={(s) => {
          setCtxMenu(null);
          const proj = findProject(s.projectId);
          if (proj) void api.shell.openPath({ path: proj.path });
        }}
        onTogglePin={(s) => {
          setCtxMenu(null);
          void setSessionPinned(s.id, !s.pinnedAt);
        }}
        onFork={(s) => {
          // 菜单的关闭由 `SessionContextMenu` 自己先做了(它要把浮层收掉再等主进程)。
          void forkSession(s.id, t("layout.forkSessionTitle", { title: s.title }));
        }}
        onNewWorktreeSession={(s) => {
          setCtxMenu(null);
          void startSession(s.projectId, { worktreePath: s.worktreePath ?? undefined });
        }}
        onMergeWorktree={(s) => {
          setCtxMenu(null);
          const proj = findProject(s.projectId);
          if (proj && s.worktreePath) setWtMerge({ repoPath: proj.path, worktreePath: s.worktreePath });
        }}
        onRenameWorktree={(s) => {
          setCtxMenu(null);
          if (s.worktreePath) {
            setRenaming({
              id: s.worktreePath,
              title: worktreeDisplayName(s.worktreePath, worktreeNames),
              kind: "worktree",
            });
          }
        }}
        onRemoveWorktree={(s) => {
          setCtxMenu(null);
          const proj = findProject(s.projectId);
          if (proj && s.worktreePath) setWtRemove({ repoPath: proj.path, worktreePath: s.worktreePath });
        }}
      />

      {/* Right-click context menu for worktree group nodes. */}
      <WorktreeContextMenu
        ctxMenu={wtCtxMenu}
        onClose={() => setWtCtxMenu(null)}
        onNewSession={(path) => {
          setWtCtxMenu(null);
          const projectId = wtCtxMenu?.projectId;
          if (projectId) void startSession(projectId, { worktreePath: path });
        }}
        onMergeBack={(path) => {
          setWtCtxMenu(null);
          // The merge anchors on the owning project's root (the repo the
          // worktree was created from — materialization requires `.git`
          // there).
          const proj = wtCtxMenu ? projects.find((p) => p.id === wtCtxMenu.projectId) : undefined;
          if (proj) setWtMerge({ repoPath: proj.path, worktreePath: path });
        }}
        onRename={(path) => {
          setWtCtxMenu(null);
          setRenaming({ id: path, title: worktreeDisplayName(path, worktreeNames), kind: "worktree" });
        }}
        onRemove={(path) => {
          setWtCtxMenu(null);
          const proj = wtCtxMenu ? projects.find((p) => p.id === wtCtxMenu.projectId) : undefined;
          if (proj) setWtRemove({ repoPath: proj.path, worktreePath: path });
        }}
      />

      {/* Group-level removal — the guarded confirm dialog (dirty trees get
          the patch-export / force options). On success the backend clears
          every referencing session's worktreePath and broadcasts; the
          existing degenerate-event fallback flips the project's view back
          to the local list. */}
      <WorktreeRemoveDialog
        open={!!wtRemove}
        onOpenChange={(o) => {
          if (!o) setWtRemove(null);
        }}
        repoPath={wtRemove?.repoPath ?? null}
        worktreePath={wtRemove?.worktreePath ?? ""}
      />

      {/* Group-level merge-back — one shared checkout, one merge covers all
          the group's sessions. */}
      <WorktreeMergeBackDialog
        open={!!wtMerge}
        onOpenChange={(o) => {
          if (!o) setWtMerge(null);
        }}
        sessionId={null}
        worktreePath={wtMerge?.worktreePath ?? ""}
        repoPath={wtMerge?.repoPath ?? null}
      />

      {/* Right-click context menu for project rows. Hosts the "移动到分组"
          actions (existing groups + 新建分组 + 移出分组), plus pin / rename. */}
      <ProjectContextMenu
        ctxMenu={projectCtxMenu}
        knownGroups={knownGroups}
        onClose={() => setProjectCtxMenu(null)}
        onTogglePin={(p) => {
          void setProjectPinned(p.id, p.pinnedAt == null);
          setProjectCtxMenu(null);
        }}
        onRename={(p) => {
          setProjectCtxMenu(null);
          setRenaming({ id: p.id, title: p.name, kind: "project" });
        }}
        onMoveToGroup={(pid, group) => {
          void setProjectGroup(pid, group);
          setProjectCtxMenu(null);
        }}
        onCreateGroup={(pid) => {
          setGroupDialog({ mode: "create", projectId: pid });
          setProjectCtxMenu(null);
        }}
        onRemoveFromGroup={(pid) => {
          void setProjectGroup(pid, null);
          setProjectCtxMenu(null);
        }}
        onOpenFolder={(p) => {
          void api.shell.openPath({ path: p.path });
          setProjectCtxMenu(null);
        }}
      />

      {/* Rename dialog (shared by the session / project / worktree menus). */}
      <RenameDialog
        renaming={renaming}
        onClose={() => setRenaming(null)}
        onSubmit={async (id, title, kind) => {
          if (kind === "project") {
            await renameProject(id, title);
          } else if (kind === "worktree") {
            await renameWorktree(id, title);
          } else {
            await renameSession(id, title);
          }
          setRenaming(null);
        }}
      />

      {/* Group dialog — shared by "新建分组" (create, targets a project) and
          "重命名分组" (rename, targets every project in the group). Both
          flows collect a trimmed non-empty name then dispatch setProjectGroup.
          On rename we walk every member so the whole group moves at once. */}
      <GroupDialog
        state={groupDialog}
        onClose={() => setGroupDialog(null)}
        onSubmit={async (name) => {
          const st = groupDialog;
          if (!st) return;
          if (st.mode === "create") {
            await setProjectGroup(st.projectId, name);
          } else {
            // Rename: move every member of the old group to the new name, and
            // migrate the group's metadata (color + order) to the new name.
            const members = activeProjects.filter((p) => p.group === st.groupName);
            await Promise.all(members.map((p) => setProjectGroup(p.id, name)));
            renameGroupMeta(st.groupName, name);
          }
          setGroupDialog(null);
        }}
      />

      {/* Delete confirmation dialog (shared by project / archived project /
          archived session destructive actions). Replaces the native
          confirm() prompts that previously blocked the renderer. */}
      <ConfirmDialog
        open={confirmDelete != null}
        danger
        title={confirmDelete?.kind === "project" ? t("layout.deleteProject") : t("layout.deleteThread")}
        description={
          confirmDelete?.kind === "project"
            ? t("layout.deleteProjectDesc", { name: confirmDelete.name })
            : t("layout.deleteThreadDesc", { title: confirmDelete?.title ?? "" })
        }
        confirmText={t("common.delete")}
        onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}
        onConfirm={() => {
          if (!confirmDelete) return;
          if (confirmDelete.kind === "project") {
            void deleteProject(confirmDelete.id);
          } else {
            void deleteSession(confirmDelete.id);
          }
        }}
      />
    </div>
  );
}

/** Memoized so a left-sidebar width drag (App re-renders on every mousemove
 *  via its leftWidthPct subscription) doesn't reconcile the whole project
 *  tree each frame. LeftBarBase reads its own data via zustand selectors,
 *  which still update it independently of parent re-renders. Renders with no
 *  props everywhere (workspace aside), so the shallow compare always skips. */
export const LeftBar = memo(LeftBarBase);
