/**
 * 【已退役 2026-10-27】**ClassicShell 不再由 `App.tsx` 渲染。**
 *
 * 生产外壳已换成 `ClaudeShell`（Claude Code 页的列覆盖 + pane tile 模型，
 * 见 `shell/ClaudeShell.tsx`）。本文件保留在仓库里，原因有两条：
 *
 * 1. **8 套回归网在读它的源码**（`arc005-editor-keepalive` / `pane-docking` /
 *    `pane-free-grid` / `workspace-visual` / `ipc-wiring` / `surface-layers` /
 *    `t129-terminal` / `workspace-shell`）。删文件会同时删掉这些断言。
 * 2. 新壳的回归网（`claude-shell-smoke`，29 条）刚建，覆盖度还远不如旧的 ——
 *    **先补齐再删，不能反过来**（硬规矩 1：先补测试再动刀）。
 *
 * ## 删除条件（三条都满足才动手）
 *
 * - `claude-shell-smoke` 或等效套件覆盖了这 8 套原本守的不变量：
 *   pane 停靠、编辑器保活、终端默认折叠、表面分层、IPC 三层接线；
 * - `surface-layers-smoke:186` 的 `readFileSync(ClassicShell.tsx)` 改成读新壳；
 * - 真 Electron 截图（`arc005-visual-baseline`）在新壳上稳定全绿。
 *
 * 在那之前，本文件保持只读 —— **不要在它上面继续加功能**。
 *
 * ---
 *
 * 【ARC-005 V1】ClassicShell —— 经典工作区外壳,从 App.tsx **整段逐字**抽出。
 *
 * 渲染内容就是原来 App 里的那段 `<WorkspaceInertShell>…</WorkspaceInertShell>`
 * (左栏 WorkspaceSidebar + 右列 Titlebar/ThreePaneLayout/底部终端),连同它
 * 直接依赖的 CenterPane / UnifiedTabbedPane / SplitCenterPane / ChatColumn /
 * EditorColumn 一起搬进来 —— 每个 class、每个 data-testid、每个 flex 参数都与
 * 抽出前逐字节一致。settings-layout-smoke 的几何断言钉着「打开设置前后左栏/
 * 主列逐像素不变」。
 *
 * **零行为变化**:状态值全部来自 props(见 ClassicShellProps,就是工作区 JSX
 * 分支今天在 App 闭包里读的那批);App 仍持有订阅与两个分隔线处理函数
 * (rootRef 量的是整窗宽度,不能挪进这个只占剩余宽度的子树里)。
 *
 * 为什么抽出来:ARC-005 的下一步是会话优先的 `WorkspaceShell`,两个壳必须复用
 * **同一批已挂载的组件实例** —— 壳切换只许重新摆放,不许卸载工作区子树
 * (终端 PTY 保活、Monaco/草稿状态,见 App 主注释里那条不变量)。
 */
import { lazy, memo, Suspense, useEffect, useMemo, useRef, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { ThreePaneLayout } from "../layout/ThreePaneLayout.js";
import { Divider } from "../layout/Divider.js";
import { Titlebar } from "../layout/Titlebar.js";
import { LeftBar } from "../layout/LeftBar.js";
import { StreamSidebar } from "../layout/StreamSidebar.js";
import { ChatPane } from "../chat/ChatPane.js";
import { SessionTabs } from "../layout/SessionTabs.js";
import { UnifiedTabsBar } from "../layout/UnifiedTabsBar.js";
import { RightPanel } from "../layout/RightPanel.js";
import { BottomTerminalBar } from "../layout/BottomTerminalBar.js";
import { OpenTabsBar } from "../ide/OpenTabsBar.js";
import { CustomUiToolbar } from "../customUi/CustomUiToolbar.js";
import { useSessionStore } from "../../stores/sessionStore.js";
import { useFileViewStore } from "../../stores/fileViewStore.js";
import { useI18n } from "../../lib/i18n/index.js";
import type { ShellVariant } from "./shellPrefs.js";
import { shouldMountUnifiedEditorHost } from "./editorMountPolicy.js";
import { dockResizeDelta, type PaneDock } from "../layout/paneDock.js";

// Lazy-load the Monaco-backed editor / diff dialog / plan viewer and the
// read-only file preview (moved here verbatim from App.tsx) so the large
// monaco-editor library stays out of the initial workspace chunk.
const FileEditor = lazy(() =>
  import("../ide/FileEditor.js").then((m) => ({ default: m.FileEditor })),
);
const GitDiffDialog = lazy(() =>
  import("../ide/GitDiffDialog.js").then((m) => ({ default: m.GitDiffDialog })),
);
const PlanViewer = lazy(() =>
  import("../chat/PlanViewer.js").then((m) => ({ default: m.PlanViewer })),
);
const FileViewer = lazy(() =>
  import("../library/FileViewer.js").then((m) => ({ default: m.FileViewer })),
);

interface WorkspaceSidebarProps {
  leftOpen: boolean;
  leftBarMode: string;
  leftWidthPct: number;
  onResizeLeft: (deltaPx: number) => void;
  onResetLeft: () => void;
  /** 【ARC-005 V2】布局变体。只改 class(宽度下限/圆角/分隔线),不改子树。 */
  variant?: ShellVariant;
}

export const WorkspaceSidebarContents = memo(function WorkspaceSidebarContents({ mode }: { mode: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {mode === "stream" ? <StreamSidebar /> : <LeftBar />}
    </div>
  );
});

/**
 * 左侧工作区栏。**设置打开时不做布局变化** —— 见 `App` 里 `SettingsOverlay`
 * 上面的那段注释:设置覆盖层是整窗的,这一栏本来就被盖住,再把它
 * `display:none` 只会让它右边的主列从 80% 宽被撑到 100%,连带对话虚拟列表
 * 重新测量折行、Files 树重排、每个挂着的 TerminalView 重 fit 并发一条
 * `pty.resize`。那些重排全发生在**看不见**的树上,是"点设置很卡"的主因。
 *
 * 所以设置打开时这里一个字节都不变(宽度、Divider 都保持原样);视觉上照样
 * 看不到它 —— 覆盖层不透明,且 z-30 在它上面。
 */
const WorkspaceSidebar = memo(function WorkspaceSidebar({
  leftOpen,
  leftBarMode,
  leftWidthPct,
  onResizeLeft,
  onResetLeft,
  variant = "classic",
}: WorkspaceSidebarProps) {
  // 【ARC-005 V2】workspace 变体:侧栏给个最小宽度(会话标题不至于被压成一条),
  // 起始圆角收成 CDS 的 10px,并且不再画分隔线 —— Claude 桌面端的会话列表与
  // 主列靠色阶差 + 主列圆角缺口分隔,不靠一根线。拖动热区两种变体都在
  // (Divider 的 hideLine 只影响画不画线)。
  const isWorkspace = variant === "workspace";
  return (
    <>
      <aside
        data-testid="workspace-sidebar"
        className={cn(
          "flex h-full shrink-0 flex-col bg-surface-muted",
          isWorkspace ? "min-w-[240px] rounded-tl-[10px]" : "min-w-0 rounded-tl-3xl",
          !leftOpen && "hidden",
        )}
        style={{ flexGrow: 0, flexBasis: `${leftWidthPct}%` }}
      >
        <WorkspaceSidebarContents mode={leftBarMode} />
        <div className="max-h-[38vh] shrink-0 overflow-y-auto empty:hidden"></div>
      </aside>
      {leftOpen && (
        <Divider
          orientation="vertical"
          hideLine={isWorkspace}
          className="z-20"
          onResize={onResizeLeft}
          onDoubleClick={onResetLeft}
        />
      )}
    </>
  );
});

/**
 * 【MC-046】被设置覆盖层盖住时,把整棵工作区**标 inert**(React 19 原生支持
 * `inert` 布尔 prop):子树退出 Tab 序、退出辅助技术读序、不接受指针与焦点。
 * 这是模态语义的另一半 —— 焦点管理的 hook(useFocusTrap)只保证焦点在
 * 设置层内循环/归位;如果不 inert,原生 Tab 走到设置层最后一个元素后照样会
 * 走进后台(以及根上其它可聚焦层),屏幕阅读器也照样念到被盖住的控件。
 *
 * 为什么是**包壳**而不是卸载:工作区子树必须全程挂载(终端 PTY 保活、Monaco/
 * 草稿状态,见 App 主注释里那条不变量);inert 只改可达性,不动布局、不卸载任何
 * 东西 —— 几何断言(settings-layout-smoke)钉着"打开设置前后左栏/主列逐像素不变",
 * 这个包壳按原 flex 参数逐字复刻(工作区仍是 root 里唯一的在流 flex 子项),
 * 不引入任何盒子变化。
 *
 * 为什么做成**自订阅的 memo 组件**、而不是在 App 里读 `settingsOpen` 再传 prop:
 * 与 SettingsOverlay 同理 —— App 一旦订阅这个字段,每次开关设置都会调和整棵
 * 应用树(正是"点设置很卡"的老账)。这里只有这个包壳重渲染,`children` 元素
 * 身份不变,React 直接跳过子树。
 */
export const WorkspaceInertShell = memo(function WorkspaceInertShell({
  children,
  variant,
}: {
  children: ReactNode;
  variant: ShellVariant;
}) {
  const settingsOpen = useSessionStore((s) => s.settingsOpen);
  return (
    <div className="flex min-w-0 flex-1" data-ui-shell-variant={variant} inert={settingsOpen}>
      {children}
    </div>
  );
});

/** Center pane router. `tabs` displayMode renders the UNIFIED tab bar —
 *  session tabs and editor file tabs share ONE strip, and whichever tab is
 *  active (chat or editor) takes the full center width (no split). `single`
 *  mode keeps the legacy layout: a horizontal split between the chat column
 *  (left) and the file-editor column (right), where the editor column only
 *  appears when a file or plan tab is open (see the design notes in
 *  docs/tech-stack.md).
 *
 *  `wide` (wide-panel 3:7 mode) is a RENDER VARIATION, not a different tree:
 *  the same components stay mounted and only the editor surface is hidden
 *  (the plan opens as the WidePlanDialog overlay instead). Toggling wide is
 *  a relayout, never a remount — the chat panes (Tiptap composers, scroll,
 *  drafts) and everything else below this point survive the toggle. */
export function CenterPane({ wide }: { wide: boolean }) {
  const displayMode = useSessionStore((s) => s.displayMode);
  if (displayMode === "tabs") {
    return <UnifiedTabbedPane wide={wide} />;
  }
  return <SplitCenterPane wide={wide} />;
}

/** `tabs` displayMode: ONE tab bar (UnifiedTabsBar) mixing session tabs and
 *  file tabs, with the active tab's content filling the whole center width.
 *  The chat|editor split is gone — that's the point (maximum reading space
 *  for whichever view is active). All open tabs' ChatPanes stay mounted and
 *  are backgrounded via CSS (`hidden`) so drafts / scroll / undo survive
 *  focus flips (same keep-alive trick the old tabs-mode chat column used);
 *  an open file editor stays mounted even while a chat/preview tab is focused.
 *
 *  In wide mode the editor has no surface (the plan opens as the
 *  WidePlanDialog overlay instead), so the strip swaps to the session-only
 *  SessionTabs (file tabs would be dead controls) and an editor tab holding
 *  the focus keeps its host mounted but `hidden` — the editor host is a
 *  SIBLING of the pane host, so the strip swap and the hide never remount
 *  the ChatPanes below. Monaco therefore survives the wide toggle and
 *  re-shows instantly on exit. */
function UnifiedTabbedPane({ wide }: { wide: boolean }) {
  // The active file is scoped to the active project - switching projects
  // swaps to that project's open files (or hides the editor if none).
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const activeFile = useSessionStore((s) =>
    activeProjectId ? s.ideActiveFileByProject[activeProjectId] ?? null : null,
  );
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const openTabs = useSessionStore((s) => s.openTabs);
  const planTabActive = useSessionStore(
    (s) => (activeSessionId ? s.planTabActiveBySession[activeSessionId] ?? false : false),
  );
  const centerTabFocus = useSessionStore((s) => s.centerTabFocus);
  // 只读预览(资料库条目 / 模版库文件 / 项目文件)。**与可编辑文件是两回事** ——
  // 见 `fileViewStore` 开头那段:可编辑的走 `openFiles` + `ideActiveFile`,预览走这里。
  const fileView = useFileViewStore((s) => s.target);
  // The editor owns the content area only while focused AND it has content.
  // The content check makes a stale "editor" focus (e.g. the last file was
  // closed by a path that didn't recompute the flag) fall back to the chat
  // instead of showing an empty editor. 预览也算"有内容"。
  const showEditor = centerTabFocus === "editor" && (!!activeFile || planTabActive);
  const showFileView = centerTabFocus === "editor" && fileView !== null && !showEditor;
  // Wide mode: only a FILE editor stays mounted (hidden keep-alive). A plan
  // tab's surface is owned by the WidePlanDialog overlay — keeping a second
  // hidden PlanViewer here would double the markdown/Monaco work on every
  // streamed plan update. Visible only when not wide; the chat pane is the
  // wide-mode surface, matching isSessionChatOnScreen's wide semantics.
  // A tab change must not destroy the active Monaco instance. Keep it mounted
  // while the project still has an active file, merely CSS-hide it behind chat.
  const editorMounted = shouldMountUnifiedEditorHost(activeFile, showEditor, wide);
  const editorVisible = showEditor && !wide;
  // 预览:**宽模式里也留着**(它不是 Monaco,没有"重建一次要几百毫秒"的成本);
  // 而且预览恰恰是宽模式最该看的东西 —— 宽模式就是给"边看边聊"用的。
  const fileViewVisible = showFileView;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {wide ? <SessionTabs /> : <UnifiedTabsBar />}
      <div className="relative min-h-0 flex-1">
        {openTabs.map((sid) => (
          <div
            key={sid}
            className={cn(
              "absolute inset-0",
              sid === activeSessionId && !editorVisible && !fileViewVisible ? "" : "hidden",
            )}
          >
            <ChatPane sessionId={sid} isActive={sid === activeSessionId && !editorVisible && !fileViewVisible} />
          </div>
        ))}
        {editorMounted && (
          <div
            className={cn(
              "absolute inset-0 flex min-h-0 flex-col",
              !editorVisible && "hidden",
            )}
          >
            {/* hideTabsBar: the unified bar above already shows the file
                tabs — a second OpenTabsBar would duplicate them. In wide
                mode the strip is SessionTabs, and the hidden host renders
                no bar at all. */}
            <EditorColumn filePath={activeFile} hideTabsBar />
          </div>
        )}
        {/* 只读预览的宿主。与编辑器**并列**、不共用那一格 —— 两者由
            `centerTabFocus` 互斥(`showFileView` 只在没有可编辑文件时才真),
            所以同时最多只有一个可见。分开写是因为它们各自要管的生命周期差很远:
            编辑器要保 Monaco 的挂载态,预览每换一个文件就该重读一次。 */}
        {showFileView && (
          <div className="absolute inset-0 flex min-h-0 flex-col">
            <Suspense fallback={null}>
              <FileViewer target={fileView} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}

/** `single` displayMode: a horizontal split between the chat column (left)
 *  and the file-editor column (right). When no file is open the editor
 *  column is omitted and the chat column takes the full width — the layout
 *  the user sees when they haven't clicked any files yet. The editor column
 *  hosts the Monaco FileEditor + its own tab bar (OpenTabsBar), and is only
 *  rendered when `ideActiveFile` is non-null.
 *
 *  Wide mode CSS-hides the editor column (keep-alive) and lets the chat fill
 *  the center — the right panel lives in the layout's aside beside it. Both
 *  columns are siblings of the same flex row, so the hide is a class flip,
 *  never a remount. */
function SplitCenterPane({ wide }: { wide: boolean }) {
  // The active file is scoped to the active project - switching projects
  // swaps to that project's open files (or hides the editor if none).
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const activeFile = useSessionStore((s) =>
    activeProjectId ? s.ideActiveFileByProject[activeProjectId] ?? null : null,
  );
  // Plan tab: the editor column is visible when a file tab is active OR the
  // plan tab is active. EditorColumn decides whether to render PlanViewer
  // (plan tab active) or FileEditor (file tab active) based on planTabActive.
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const planTabActive = useSessionStore(
    (s) => (activeSessionId ? s.planTabActiveBySession[activeSessionId] ?? false : false),
  );

  // The editor column is visible when EITHER a file is active OR the plan tab
  // is active. (The plan tab's mere existence in the bar doesn't force the
  // editor visible - only when it's the active tab.) Wide mode keeps a FILE
  // editor mounted but `hidden` (keep-alive, same trick as the chat panes) so
  // exiting wide restores it without a Monaco rebuild; a plan tab's surface
  // is owned by the WidePlanDialog overlay, so no second hidden PlanViewer.
  const editorMounted = (!!activeFile || planTabActive) && !(wide && !activeFile);
  const editorVisible = editorMounted && !wide;

  // Draggable chat|editor split. The editor column's share is a persisted
  // percentage; the chat column gets the remainder. The Divider reports a px
  // delta which we convert to a percentage delta using the container's
  // measured width (captured via ref on the split row).
  const editorWidthPct = useSessionStore((s) => s.editorWidthPct);
  const adjustEditorWidthPct = useSessionStore((s) => s.adjustEditorWidthPct);
  const resetEditorWidthPct = useSessionStore((s) => s.resetEditorWidthPct);
  const splitRef = useRef<HTMLDivElement>(null);

  // Convert a px drag delta into a percentage-point delta relative to the
  // container width. The divider sits to the LEFT of the editor column, so the
  // sign flip (growing the editor shrinks as the handle moves right) lives in
  // adjustEditorWidthPct — here we just translate px to percentage points.
  const handleEditorResize = (deltaPx: number) => {
    const el = splitRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    if (w <= 0) return;
    adjustEditorWidthPct((deltaPx / w) * 100);
  };

  return (
    <div ref={splitRef} className="flex h-full min-h-0">
      {/* Chat column - flex-basis is the remainder of the editor share so the
          two columns split the center pane proportionally. When no file is
          open and no plan is viewed it takes the full width (flex-1). */}
      <div
        className="flex min-w-0 flex-col"
        style={editorVisible ? { flexGrow: 0, flexBasis: `${100 - editorWidthPct}%` } : { flexGrow: 1, flexBasis: "0%" }}
      >
        <ChatColumn />
      </div>
      {/* Divider between chat and editor - only while the editor column is
          actually visible (a hidden keep-alive column gets no handle). */}
      {editorVisible && (
        <Divider
          orientation="vertical"
          onResize={handleEditorResize}
          onDoubleClick={resetEditorWidthPct}
        />
      )}
      {/* Editor column - mounted while a file or plan tab is open; wide mode
          keeps it mounted but `hidden` (flexBasis is inert under display:none,
          the chat's flexGrow:1 above takes the full width). */}
      {editorMounted && (
        <div
          className={cn(
            "flex min-w-0 flex-col border-l border-edge-panel bg-surface",
            !editorVisible && "hidden",
          )}
          style={{ flexGrow: 0, flexBasis: `${editorWidthPct}%` }}
        >
          <EditorColumn filePath={activeFile} />
        </div>
      )}
    </div>
  );
}

/** The chat half: SessionTabs strip (in tabs mode) + the active ChatPane.
 *
 *  BOTH display modes keep every pane in the keep-alive bucket mounted and
 *  background the inactive ones via CSS (display:none). This keeps each
 *  pane's composer draft, scroll position, and Tiptap undo history alive
 *  across switches — switching is a visibility swap instead of re-mounting
 *  and re-measuring, so a left-bar click lands instantly. Events still
 *  stream into backgrounded panes (they read their own session bucket).
 *  Closing a tab removes its id from openTabs, letting React unmount it.
 *  Tabs mode shows the bucket in the SessionTabs strip; single mode has no
 *  strip, so the bucket self-prunes: only the active session plus the most
 *  recently TOUCHED ones stay mounted (see keepAliveOrder). */

/** LRU of recently-activated sessions for single mode's keep-alive window.
 *  Module-level so it survives ChatColumn re-mounts (mode switches). Tabs
 *  mode doesn't consult it — its bucket is the user's own tab strip. */
const keepAliveOrder: string[] = [];
const KEEP_ALIVE_MAX = 8;

function ChatColumn() {
  const displayMode = useSessionStore((s) => s.displayMode);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const openTabs = useSessionStore((s) => s.openTabs);

  // Touch the LRU whenever the foreground session changes (single-mode
  // window membership follows usage, not just open order).
  useEffect(() => {
    if (activeSessionId == null) return;
    const i = keepAliveOrder.indexOf(activeSessionId);
    if (i >= 0) keepAliveOrder.splice(i, 1);
    keepAliveOrder.push(activeSessionId);
    if (keepAliveOrder.length > KEEP_ALIVE_MAX * 2) {
      keepAliveOrder.splice(0, keepAliveOrder.length - KEEP_ALIVE_MAX * 2);
    }
  }, [activeSessionId]);

  if (displayMode === "tabs") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <SessionTabs />
        <div className="relative min-h-0 flex-1">
          {openTabs.map((sid) => (
            <div
              key={sid}
              className={`absolute inset-0 ${sid === activeSessionId ? "" : "hidden"}`}
            >
              <ChatPane sessionId={sid} isActive={sid === activeSessionId} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // single mode: same keep-alive structure, no tab strip. Without it the
  // keyed remount (`key={activeSessionId}`) tore down and rebuilt the whole
  // ChatPane on every left-bar switch — composer Tiptap re-init, full
  // timeline re-parse — which read as a lag before the new session appeared.
  //
  // Mounted set = the active session (always — defends against a path that
  // activates a session without adding it to openTabs; the tabs branch makes
  // the same assumption the other way) + the most recently touched ones that
  // are still in openTabs (the filter hands pane lifetime to openTabs'
  // delete/archive cleanup, so panes of removed sessions unmount instead of
  // lingering here). Sessions pushed out of the window unmount and re-mount
  // cold on their next visit — same cost as the old keyed remount, so the
  // window can only ever improve on the baseline.
  if (activeSessionId == null) {
    return <ChatPane sessionId={null} />;
  }
  const keepAlive = keepAliveOrder
    .slice(-KEEP_ALIVE_MAX)
    .filter((sid) => sid !== activeSessionId && openTabs.includes(sid));
  const panes = [activeSessionId, ...keepAlive];
  return (
    <div className="relative min-h-0 flex-1">
      {panes.map((sid) => (
        <div
          key={sid}
          className={`absolute inset-0 ${sid === activeSessionId ? "" : "hidden"}`}
        >
          <ChatPane sessionId={sid} isActive={sid === activeSessionId} />
        </div>
      ))}
    </div>
  );
}

/** The editor half: OpenTabsBar (only in tabs editor-mode, and not when
 *  `hideTabsBar` — the unified center bar passes that since it already
 *  renders the file tabs) + the active tab's content. Resolves the project
 *  path from the active project so FileEditor can show relative paths in
 *  its toolbar. When the plan tab is active, renders PlanViewer instead of
 *  FileEditor. */
export function EditorColumn({
  filePath,
  hideTabsBar = false,
}: {
  filePath: string | null;
  hideTabsBar?: boolean;
}) {
  const { t } = useI18n();
  const editorMode = useSessionStore((s) => s.ideEditorMode);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);

  // Plan tab state: when planTabActive is true and there's plan text, render
  // PlanViewer instead of FileEditor.
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const planText = useSessionStore(
    (s) => (activeSessionId ? s.planDrawerPlanBySession[activeSessionId] ?? null : null),
  );
  const planTabActive = useSessionStore(
    (s) => (activeSessionId ? s.planTabActiveBySession[activeSessionId] ?? false : false),
  );
  // Whether an ExitPlanMode approval is pending for this session - passed to
  // PlanViewer so its save action knows to stage the draft for the approval
  // sheet (vs. just updating the local view for a historical plan).
  const planApprovalPending = useSessionStore(
    (s) => (activeSessionId ? !!s.pendingPlanApprovalBySession[activeSessionId] : false),
  );
  const closePlanDrawer = useSessionStore((s) => s.closePlanDrawer);

  const showPlan = planTabActive && !!planText;

  const projectPath = useMemo(() => {
    if (!activeProjectId) return null;
    return projects.find((p) => p.id === activeProjectId)?.path ?? null;
  }, [activeProjectId, projects]);

  return (
    <>
      {!hideTabsBar && editorMode === "tabs" && <OpenTabsBar />}
      <div className="min-h-0 flex-1">
        {showPlan ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
                {t("layout.loadingEditor")}
              </div>
            }
          >
            <PlanViewer
              plan={planText!}
              sessionId={activeSessionId!}
              isApprovalPending={planApprovalPending}
              onClose={() => activeSessionId && closePlanDrawer(activeSessionId)}
            />
          </Suspense>
        ) : filePath && projectPath ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
                {t("layout.loadingEditor")}
              </div>
            }
          >
            {/* NOT keyed by filePath: the editor is persistent and swaps
                models on file switches (see EditPane / editorModelCache) —
                a full remount per file would stutter. */}
            <FileEditor filePath={filePath} projectPath={projectPath} />
          </Suspense>
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-content-subtle">
            {t("layout.noProjectPath")}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * ClassicShell 的 props —— **就是工作区 JSX 分支今天在 App 闭包里读的那些值**,
 * 一个不多、一个不少。将来的 WorkspaceShell 复用这组契约时,App 只换传参来源。
 */
export interface ClassicShellProps {
  /** 【ARC-005 V2】布局变体(唯一允许随 `ui.shell` 变的东西)。
   *  ⚠️ 切壳必须在**这里**发生,不许在 App 里换组件类型 —— 换类型会卸载整棵
   *  工作区子树(PTY/Monaco/草稿保活立刻失效)。 */
  variant?: ShellVariant;
  leftOpen: boolean;
  leftBarMode: string;
  leftWidthPct: number;
  handleLeftResize: (deltaPx: number) => void;
  resetLeftWidthPct: () => void;
  setLeftOpen: (open: boolean) => void;
  rightOpen: boolean;
  setRightOpen: (open: boolean) => void;
  bottomTerminalOpen: boolean;
  setBottomTerminalOpen: (open: boolean) => void;
  widePanelOpen: boolean;
  widePanelPct: number;
  rightWidth: number;
  rightDock: PaneDock;
  bottomTerminalHeight: number;
  handleWidePanelResize: (deltaPx: number) => void;
  adjustRightWidth: (deltaPx: number) => void;
  /** 【T02】双击 50/50 吸附：直接设像素宽，绕开 delta 的双重取反。 */
  setRightWidthPx: (px: number) => void;
  adjustBottomTerminalHeight: (deltaPx: number) => void;
  resetWidePanelPct: () => void;
  resetRightWidth: () => void;
  resetBottomTerminalHeight: () => void;
}

/**
 * 经典工作区外壳。状态值全部来自 props(见 ClassicShellProps);只有
 * `WorkspaceInertShell` 自己就地订阅 `settingsOpen`(与抽出前相同 —— 它是
 * 自订阅的 memo 包壳,设置开关只重渲染这一层)。
 */
export function ClassicShell({ variant = "classic", leftOpen, leftBarMode, leftWidthPct, handleLeftResize, resetLeftWidthPct, setLeftOpen, rightOpen, setRightOpen, bottomTerminalOpen, setBottomTerminalOpen, widePanelOpen, widePanelPct, rightWidth, rightDock, bottomTerminalHeight, handleWidePanelResize, adjustRightWidth, setRightWidthPx, adjustBottomTerminalHeight, resetWidePanelPct, resetRightWidth, resetBottomTerminalHeight }: ClassicShellProps) {
  const setRightDock = useSessionStore((s) => s.setRightDock);
  const paneLayout = useSessionStore((s) => s.paneLayout);
  const moveLayoutPane = useSessionStore((s) => s.moveLayoutPane);
  const setPaneRightSizePct = useSessionStore((s) => s.setPaneRightSizePct);
  // Both rightWidth (px) and widePanelPct (%) currently subtract their drag
  // input. The handle moves to the other side when docked left, so invert.
  const handleDockedResize = (deltaPx: number) => {
    const normalized = dockResizeDelta(deltaPx, rightDock);
    if (widePanelOpen) handleWidePanelResize(normalized);
    else adjustRightWidth(normalized);
  };
  return (
    <WorkspaceInertShell variant={variant}>
      <WorkspaceSidebar
        variant={variant}
        leftOpen={leftOpen}
        leftBarMode={leftBarMode}
        leftWidthPct={leftWidthPct}
        onResizeLeft={handleLeftResize}
        onResetLeft={resetLeftWidthPct}
      />
      {/*
        Right column — the 7 of the 3:7 split: the toolbar (Titlebar) on top
        and the main panel below (center chat/editor pane + right IDE panel,
        plus the bottom terminal inside the center main).
      */}
      <div data-testid="workspace-main" className="flex min-w-0 flex-1 flex-col">
        {/*
          Workspace shell is ALWAYS mounted — the settings view renders as a
          full-window overlay on top of it, not as a mutually-exclusive
          sibling. This is critical: BottomTerminalBar (→ TerminalPanel →
          every TerminalView) lives inside ThreePaneLayout. A ternary swap
          `settingsOpen ? <Settings> : <Workspace>` would unmount the whole
          workspace subtree on every settings open, killing all live PTYs
          (TerminalView's cleanup calls api.terminal.kill) and destroying
          scrollback — and racing many concurrent pty.kill() calls on Windows
          occasionally crashes the main process. Keeping the workspace mounted
          preserves the carefully-built cross-project terminal keep-alive (see
          TerminalPanel.tsx) exactly as designed. Nothing below reads
          `settingsOpen`: the workspace keeps its exact layout (including the
          left rail's width) and the overlay just covers it — see
          SettingsOverlay for why that matters for open latency.
        */}
        <Titlebar
          mode="workspace"
          leftOpen={leftOpen}
          rightOpen={rightOpen}
          bottomTerminalOpen={bottomTerminalOpen}
          onToggleLeft={() => setLeftOpen(!leftOpen)}
          onToggleRight={() => setRightOpen(!rightOpen)}
          onToggleBottomTerminal={() => setBottomTerminalOpen(!bottomTerminalOpen)}
        />
        {/* Main panel row — bg-surface-muted as the contrasting track so the
            center pane's rounded left-edge corners (in ThreePaneLayout)
            reveal this muted color through the notches and read as clean
            arcs. The left sidebar (bg-surface-muted) blends into the track
            on its side; the center pane (bg-surface) separates from the
            track by the flat color step alone (no shadow). */}
        <div className="relative flex min-h-0 flex-1 bg-surface-muted">
          {/*
            Center is ONE stable tree across wide mode (CenterPane takes the
            wide flag as a render variation) — the old ternary swap
            `<WidePanelSplit/> : <CenterPane/>` remounted every ChatPane
            (Tiptap, timeline) + the whole right panel on each toggle, which
            read as a lag. Wide mode only re-shapes the layout: the right
            aside switches to the percentage share (rightWidthPct) and stays
            open (setWidePanelOpen forces rightOpen=true on enter and
            restores the snapshot on exit), so RightPanel — file tree, git
            scan, browser view ownership — is never torn down.
          */}
          <ThreePaneLayout
            variant={variant}
            /* ARC-005：普通聊天保持窄抽屉；宽屏模式恢复真正的可调整 pane。
               只修改同一 ThreePaneLayout 的呈现参数，不更换 RightPanel/PTY/Monaco 实例。 */
            rightSurface={widePanelOpen ? "pane" : "drawer"}
            left={null}
            center={<CenterPane wide={widePanelOpen} />}
            right={<RightPanel />}
            toolbar={<CustomUiToolbar />}
            leftOpen={false}
            rightOpen={rightOpen}
            bottomTerminal={<BottomTerminalBar active={bottomTerminalOpen} />}
            bottomTerminalOpen={bottomTerminalOpen}
            rightWidth={rightWidth}
            rightDock={rightDock}
            onChangeRightDock={setRightDock}
            paneLayout={paneLayout}
            onMovePane={moveLayoutPane}
            onChangeRightOpen={setRightOpen}
            rightWidthPct={widePanelOpen ? widePanelPct : (paneLayout.placements.find(p => p.id === "right")?.sizePct ?? 30)}
            bottomTerminalHeight={bottomTerminalHeight}
            onResizeRight={handleDockedResize}
            onSetRightWidth={setRightWidthPx}
            onSetPaneRightSizePct={widePanelOpen ? undefined : setPaneRightSizePct}
            onResizeBottomTerminal={adjustBottomTerminalHeight}
            onResetRight={widePanelOpen ? resetWidePanelPct : resetRightWidth}
            onResetBottomTerminal={resetBottomTerminalHeight}
          />
          {/* Git diff dialog (the "dialog" open-mode). Portaled to <body>;
              renders nothing when closed or empty. Mounted at the workspace
              level so it overlays the editor while staying app-scoped.
              Lazy-loaded with monaco since it reuses the Monaco DiffPane. */}
          <Suspense fallback={null}>
            <GitDiffDialog />
          </Suspense>
        </div>
      </div>
    </WorkspaceInertShell>
  );
}
