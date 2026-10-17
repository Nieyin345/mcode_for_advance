import { lazy, memo, Suspense, useEffect, useMemo, useRef, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { ClassicShell } from "./components/shell/ClassicShell.js";
import { Divider } from "./components/layout/Divider.js";
import { Titlebar } from "./components/layout/Titlebar.js";
import { LeftBar } from "./components/layout/LeftBar.js";
import { StreamSidebar } from "./components/layout/StreamSidebar.js";
import { ChatPane } from "./components/chat/ChatPane.js";
import { SessionTabs } from "./components/layout/SessionTabs.js";
import { UnifiedTabsBar } from "./components/layout/UnifiedTabsBar.js";
import { RightPanel } from "./components/layout/RightPanel.js";
import { BottomTerminalBar } from "./components/layout/BottomTerminalBar.js";
import { CommandPalette } from "./components/layout/CommandPalette.js";
import { SearchDialog } from "./components/ide/SearchDialog.js";
import { ModelConfigPrompt } from "./components/chat/ModelConfigPrompt.js";
import { AskChoiceDialog } from "./components/chat/AskChoiceDialog.js";
import { BrowserPanel } from "./components/browser/BrowserPanel.js";
import { Toaster } from "./components/layout/Toaster.js";
import { CustomUiHost } from "./components/customUi/CustomUiHost.js";
import { CustomUiToolbar } from "./components/customUi/CustomUiToolbar.js";
import { UpdateNotification } from "./components/layout/UpdateNotification.js";
import { VoiceListeningOverlay } from "./components/layout/VoiceListeningOverlay.js";
import { useClaudeEvents } from "./hooks/useClaudeEvents.js";
import { useFocusTrap } from "./hooks/useFocusTrap.js";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts.js";
import { useMouseGestures } from "./hooks/useMouseGestures.js";
import { useSuppressBrowserView } from "./hooks/useSuppressBrowserView.js";
import { useSessionStore } from "./stores/sessionStore.js";
import type { BrowserDevicePreset } from "@contracts/ipc";
import { api } from "./lib/api.js";
import { useTheme } from "./lib/theme.js";
import { useChatAppearance, useRightPanelAppearance, useThemeStyle } from "./lib/appearance.js";
import { useUiPrefsAppearance } from "./lib/uiPrefs.js";
import { useI18n } from "./lib/i18n/index.js";
import { OpenTabsBar } from "./components/ide/OpenTabsBar.js";
import { useFileViewStore } from "./stores/fileViewStore.js";
import { startWorkflowLive } from "./lib/workflowLive.js";
import { installAppControlHost } from "./lib/appControlHost.js";

// Lazy-load the Monaco-backed editor, diff dialog and plan viewer so the large
// monaco-editor library (and its web workers) stay out of the initial renderer
// chunk. PlanViewer statically imports monacoSetup.ts (the worker bootstrap),
// so an eager import here would pull all of Monaco into the first-paint
// critical path — exactly the slowness lazy-loading FileEditor was meant to
// avoid. All three are only needed once the user opens a file, a diff dialog
// or the plan tab — well after first paint. Vite splits them into separate
// chunks automatically.
const FileEditor = lazy(() =>
  import("./components/ide/FileEditor.js").then((m) => ({ default: m.FileEditor })),
);
const GitDiffDialog = lazy(() =>
  import("./components/ide/GitDiffDialog.js").then((m) => ({ default: m.GitDiffDialog })),
);
const PlanViewer = lazy(() =>
  import("./components/chat/PlanViewer.js").then((m) => ({ default: m.PlanViewer })),
);
// Same reasoning for the settings overlay and the read-only file preview:
// SettingsPage reaches Monaco + the Milkdown editor through the memory panel,
// and FileViewer pulls the PDF engine and Office previewers. Neither is on
// screen at first paint, so keep them out of the App chunk.
// The SettingsPage module itself is only the shell + nav (every panel is its
// own lazy chunk), so it is cheap to warm at idle after first paint: the first
// click on the gear then opens instantly instead of waiting on a chunk load.
const loadSettingsPage = () => import("./components/settings/SettingsPage.js");
const SettingsPage = lazy(() => loadSettingsPage().then((m) => ({ default: m.SettingsPage })));
const FileViewer = lazy(() =>
  import("./components/library/FileViewer.js").then((m) => ({ default: m.FileViewer })),
);

/**
 * Subscribe to settings visibility outside the App root. The workspace shell
 * stays mounted underneath this overlay (terminals own live PTYs); subscribing
 * in App itself made opening settings reconcile the entire chat/editor tree.
 * The memo boundary also keeps unrelated App renders from re-rendering the
 * overlay while it is open.
 *
 * **The overlay is a full-window surface with its own titlebar.** It used to
 * be `absolute inset-0` inside the main column, which only spanned the width
 * once the left workspace rail had been `display:none`d — and un-hiding a flex
 * sibling from 0 back to 20% reflows the whole workspace (chat virtual list
 * re-measures every row, the unvirtualized Files tree relayouts, every mounted
 * TerminalView refits and fires a pty.resize) on *every* settings open, all of
 * it invisible. Now the rail keeps its width, the workspace tree is never
 * touched, and the overlay simply covers the window — same shape as the
 * browser overlay, and the settings chrome (back button + heading) rides in
 * the overlay's own titlebar instead of switching the workspace one.
 */
const SettingsOverlay = memo(function SettingsOverlay() {
  const open = useSessionStore((s) => s.settingsOpen);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  // 【MC-046】焦点接管:打开时记录原焦点 → 移入层内首个控件,层内 Tab/Shift+Tab
  // 闭环,关闭/卸载时归还。键盘所有权和鼠标遮盖一样,是这层的契约 —— 完整的
  // 模态语义另一半(被盖住的后台 inert)在 WorkspaceInertShell。Escape 仍归
  // SettingsPage 自己的监听(见 useFocusTrap 文件头)。
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusTrap(rootRef, open);
  if (!open) return null;
  return (
    <div
      ref={rootRef}
      className="settings-root fixed inset-0 z-30 flex flex-col bg-surface-muted"
    >
      {/* Empty leftOpen/rightOpen: in settings mode the titlebar renders only
          the back button + heading (the workspace toggles are gone), so the
          panel flags below are inert. */}
      <Titlebar
        mode="settings"
        leftOpen={false}
        rightOpen={false}
        bottomTerminalOpen={false}
        onBack={() => setSettingsOpen(false)}
      />
      <div className="flex min-h-0 flex-1">
        <Suspense fallback={null}>
          <SettingsPage />
        </Suspense>
      </div>
    </div>
  );
});

interface WorkspaceSidebarProps {
  leftOpen: boolean;
  leftBarMode: string;
  leftWidthPct: number;
  onResizeLeft: (deltaPx: number) => void;
  onResetLeft: () => void;
}

const WorkspaceSidebarContents = memo(function WorkspaceSidebarContents({ mode }: { mode: string }) {
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
}: WorkspaceSidebarProps) {
  return (
    <>
      <aside
        data-testid="workspace-sidebar"
        className={cn(
          "flex h-full min-w-0 shrink-0 flex-col rounded-tl-3xl bg-surface-muted",
          !leftOpen && "hidden",
        )}
        style={{ flexGrow: 0, flexBasis: `${leftWidthPct}%` }}
      >
        <WorkspaceSidebarContents mode={leftBarMode} />
      </aside>
      {leftOpen && (
        <Divider
          orientation="vertical"
          hideLine
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
const WorkspaceInertShell = memo(function WorkspaceInertShell({
  children,
}: {
  children: ReactNode;
}) {
  const settingsOpen = useSessionStore((s) => s.settingsOpen);
  return (
    <div className="flex min-w-0 flex-1" inert={settingsOpen}>
      {children}
    </div>
  );
});

export function App() {
  // Subscribe to the claude event stream for the app's whole lifetime.
  useClaudeEvents();
  // Idle-prefetch the settings shell and its default "常规" panel (see
  // loadSettingsPage). Failures are ignored: the lazy import retries on open.
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      loadSettingsPage()
        .then((m) => { if (!cancelled) m.prefetchSettingsPanels(["GeneralPanel"]); })
        .catch(() => undefined);
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(run, { timeout: 5000 });
      return () => { cancelled = true; window.cancelIdleCallback(id); };
    }
    const id = setTimeout(run, 2000);
    return () => { cancelled = true; clearTimeout(id); };
  }, []);
  // 右栏「运行看板」的现场也常驻订阅 —— 看板没开着、停在别的页时照样记。否则图起跑时
  // 右栏关着,那段进度就永远丢了(打开看板一片灰)。见 `lib/workflowLive.ts` 文件头。
  useEffect(() => {
    startWorkflowLive();
  }, []);
  // mcode-app 的界面那半:主进程经 executeJavaScript 调进来切对话/开文件/发消息(见该文件头)。
  useEffect(() => {
    installAppControlHost();
  }, []);
  // When an agent browser tool opens/reuses a view, surface the browser panel
  // so the user sees the agent browsing and BrowserPanel can sync bounds.
  // Subscribed globally (not in BrowserPanel, which only mounts when the
  // browser tab is already active) so the panel switch happens even if the
  // right panel is currently on files/git. The view is adopted into the
  // renderer's tab list so BrowserPanel's show/hide/bounds logic manages it.
  //
  // The agent opens in the right sidebar (scrollable column) by default — a
  // desktop page renders at full width inside the sidebar; a phone page narrows
  // to the emulated viewport. The fullscreen overlay is never triggered
  // automatically: it's reserved for the user to open manually via the
  // "展开为 PC 全屏" button when they want more room.
  //
  // Respect the user's manual view-mode choice: if they've switched to the
  // fullscreen overlay, the agent must NOT yank them back to the sidebar. We
  // still adopt the tab so the overlay surfaces the agent's view, but leave
  // browserPanelOpen untouched. Only when the user is NOT in fullscreen do we
  // force the sidebar to own the view (isActive = !browserPanelOpen) and open
  // the right panel on the browser tab.
  // The device toolbar is auto-opened so the requested emulation takes effect
  // (collapsed = full-width desktop, ignoring the agent's device).
  useEffect(() => {
    const off = api.on.browserEvent((msg) => {
      if (msg.type !== "agentOpened") return;
      const p = (msg.payload as { url?: string; title?: string; device?: BrowserDevicePreset }) ?? {};
      const st = useSessionStore.getState();
      const createdNew = st.adoptAgentBrowserTab(msg.browserId, p);
      if (!st.browserPanelOpen) {
        // Not in fullscreen — bring up the sidebar to show the agent browsing.
        st.setRightPanelTab("browser");
        st.setRightOpen(true);
      }
      // Only auto-open the device toolbar for a brand-new agent tab, so the
      // requested emulation is visible. For an existing tab, preserve the
      // user's toolbar state — reopening it over their collapsed choice would
      // be surprising, and the user's device/size selection is preserved by
      // adoptAgentBrowserTab regardless.
      if (createdNew) {
        st.setBrowserDeviceToolbarOpen(true);
      }
    });
    return off;
  }, []);
  // Global keyboard shortcuts (Cmd+K palette, Cmd+B sidebar, etc.). Mounts a
  // single capture-phase window listener; rebinding in settings re-subscribes.
  useGlobalShortcuts();
  // Global mouse gestures (hold right button + drag). Same listener pattern;
  // detached entirely while disabled in settings.
  useMouseGestures();
  // Apply + keep in sync the color scheme (.dark on <html>).
  useTheme();
  // Apply + keep in sync the chat appearance CSS vars (--chat-font-size,
  // --user-bubble) from the user-configurable settings.
  useChatAppearance();
  // Apply + keep in sync the global side-panel + settings font-size CSS var
  // (--right-panel-font-size) for the left bar, right files/git/terminal
  // panels, and the settings page.
  useRightPanelAppearance();
  // Apply + keep in sync the theme STYLE (.sketch on <html>, orthogonal to
  // the light/dark scheme above) from the ui.themeStyle setting.
  useThemeStyle();
  // 界面 / 代码字体、聊天内容宽度、自定义 CSS(lib/uiPrefs.ts)。
  useUiPrefsAppearance();

  const init = useSessionStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);

  /** Left / right sidebar + bottom terminal visibility. Lifted from local
   *  useState into the store so the command palette (and any other consumer)
   *  can toggle them. Workspace-only — the settings overlay pins its own
   *  workspace-side flags (see SettingsOverlay). NOT persisted (matches
   *  original behavior). */
  const leftOpen = useSessionStore((s) => s.leftOpen);
  const leftBarMode = useSessionStore((s) => s.leftBarMode);
  const setLeftOpen = useSessionStore((s) => s.setLeftOpen);
  const rightOpen = useSessionStore((s) => s.rightOpen);
  const setRightOpen = useSessionStore((s) => s.setRightOpen);
  const bottomTerminalOpen = useSessionStore((s) => s.bottomTerminalOpen);
  const setBottomTerminalOpen = useSessionStore((s) => s.setBottomTerminalOpen);
  const widePanelOpen = useSessionStore((s) => s.widePanelOpen);
  // Wide-panel (3:7) split share + its resize/reset actions. The wide mode
  // reuses the layout's right aside (percentage width) instead of mounting a
  // second RightPanel inside the center column, so toggling wide never
  // unmounts the right panel (file tree, git scan, browser view ownership).
  const widePanelPct = useSessionStore((s) => s.widePanelPct);
  const adjustWidePanelPct = useSessionStore((s) => s.adjustWidePanelPct);
  const resetWidePanelPct = useSessionStore((s) => s.resetWidePanelPct);

  /** Draggable pane sizes + resize actions (from the store; persisted). */
  const leftWidthPct = useSessionStore((s) => s.leftWidthPct);
  const rightWidth = useSessionStore((s) => s.rightWidth);
  const bottomTerminalHeight = useSessionStore((s) => s.bottomTerminalHeight);
  const adjustLeftWidthPct = useSessionStore((s) => s.adjustLeftWidthPct);
  const adjustRightWidth = useSessionStore((s) => s.adjustRightWidth);
  const adjustBottomTerminalHeight = useSessionStore((s) => s.adjustBottomTerminalHeight);
  const resetLeftWidthPct = useSessionStore((s) => s.resetLeftWidthPct);
  const resetRightWidth = useSessionStore((s) => s.resetRightWidth);
  const resetBottomTerminalHeight = useSessionStore((s) => s.resetBottomTerminalHeight);

  /** Command palette + file search dialog visibility is driven by the
   *  global shortcut listener (useGlobalShortcuts) via store actions, so we
   *  no longer wire those keys here. */

  /**
   * `ideFocusNonce` —— **只在"去文件树里定位一个文件"时 bump**（`revealInFileTree`）。
   *
   * 它要做的事是"把目的地露出来"：右栏可能关着，而用户刚在别处点了"在文件树里显示"，
   * 那就得把面板展开，否则切了 tab 也看不见。
   *
   * ⚠️ **打开文件不走这条**（2026-09-22 改）。`openFileInIde` 从前也 bump 它，
   * 于是双击一个文件时右栏被拉到 **files** 页 —— 而用户要的是「双击打开文件的同时
   * 侧边栏弹出来主对话」。现在那条意图写在 `openFileInIde` 自己身上
   * （展开右栏 + 切 `flow` + 展开主对话），两者不再互相盖掉。
   */
  const ideFocusNonce = useSessionStore((s) => s.ideFocusNonce);
  useEffect(() => {
    if (ideFocusNonce > 0) setRightOpen(true);
  }, [ideFocusNonce, setRightOpen]);

  // Root row ref — measures the full window width so the left divider's px
  // drag delta can be converted into percentage points of that width (the
  // sidebar share is percentage-based so the 3:7 split scales on resize).
  const rootRef = useRef<HTMLDivElement>(null);
  // Convert a px drag delta into a percentage-point delta of the window
  // width. The divider sits to the RIGHT of the sidebar, so the sign flip
  // (none needed here — dragging right widens) lives in adjustLeftWidthPct.
  // No rounding: the store keeps fractional percentages so the pane tracks
  // the cursor pixel-for-pixel (integer pcts ate sub-percent deltas).
  const handleLeftResize = (deltaPx: number) => {
    const el = rootRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    if (w <= 0) return;
    adjustLeftWidthPct((deltaPx / w) * 100);
  };
  // Wide mode: the layout's center|right divider drives the wide split. Same
  // px→percentage-points conversion as handleLeftResize — wide mode forces
  // the left sidebar closed (store guard), so the window width IS the layout
  // row width that widePanelPct is a share of. The sign flip (dragging right
  // shrinks the right panel) lives in adjustWidePanelPct.
  const handleWidePanelResize = (deltaPx: number) => {
    const el = rootRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    if (w <= 0) return;
    adjustWidePanelPct((deltaPx / w) * 100);
  };

  return (
    // bg-surface-muted (matching the sidebar/toolbar/track) so the left
    // divider's transparent 1px layout slot blends in — a bg-surface root
    // showed through it as a stray light/dark hairline cutting the frame.
    <div ref={rootRef} className="flex h-full w-full bg-surface-muted text-content">
      {/* Command palette + file search dialog overlay both workspace and
          settings views. The browser panel overlay mounts here too - it
          covers the workspace with a fixed inset overlay (z-40, below the
          z-50 dialogs so ConfirmDialog etc. still sit on top). */}
      <CommandPalette />
      <SearchDialog />
      {/* Send-time "尚未配置模型" guard (sendPrompt opens it when the active
          provider has no model configured). Root-mounted so it overlays both
          workspace and settings views. */}
      <ModelConfigPrompt />
      {/* 「运行前先问我」那个四选一(见 `AskChoiceDialog`)。**根级挂一个** —— 它盯的是
          "当前会话有没有一问还在等",和具体是哪个面板在看没关系;挂在聊天面板里的话,
          切到设置页就看不见了,而那次运行还在那儿等着。 */}
      <AskChoiceDialog />
      {/* 自定义 UI 的视图浮窗 + 批量运行确认(菜单点完就关了,弹出来的东西得挂在根上)。
          顺带在应用起来时读一次自定义 UI 配置。 */}
      <CustomUiHost />
      <BrowserPanel mode="overlay" />
      {/* Wide-mode plan dialog - mounts over the wide 3:7 workspace (fixed
          overlay below the titlebar) when a plan tab is open. Mounted here
          beside the browser overlay so it covers both the chat and right
          columns. Renders null when not applicable. */}
      <WidePlanDialog />
      {/* 【ARC-005 V1】经典工作区外壳已抽成 ClassicShell(逐字搬运,零行为变化)。
          下一步的 WorkspaceShell 与它共用同一批已挂载组件实例。 */}
      <ClassicShell
        leftOpen={leftOpen}
        leftBarMode={leftBarMode}
        leftWidthPct={leftWidthPct}
        handleLeftResize={handleLeftResize}
        resetLeftWidthPct={resetLeftWidthPct}
        setLeftOpen={setLeftOpen}
        rightOpen={rightOpen}
        setRightOpen={setRightOpen}
        bottomTerminalOpen={bottomTerminalOpen}
        setBottomTerminalOpen={setBottomTerminalOpen}
        widePanelOpen={widePanelOpen}
        widePanelPct={widePanelPct}
        rightWidth={rightWidth}
        bottomTerminalHeight={bottomTerminalHeight}
        handleWidePanelResize={handleWidePanelResize}
        adjustRightWidth={adjustRightWidth}
        adjustBottomTerminalHeight={adjustBottomTerminalHeight}
        resetWidePanelPct={resetWidePanelPct}
        resetRightWidth={resetRightWidth}
        resetBottomTerminalHeight={resetBottomTerminalHeight}
      />
      {/* Settings is a full-window surface, mounted at the ROOT (not inside
          the workspace column) so no workspace ancestor's overflow or
          stacking context can clip it. It renders null when closed. */}
      <SettingsOverlay/>
      {/* Global bottom-right corner: update notification card + toast stack
          share one fixed column so they stack vertically and never overlap.
          Both render null when they have nothing to show. */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[9999] flex flex-col items-end gap-2">
        <UpdateNotification />
        <Toaster />
      </div>
      {/* Global voice-dictation indicator - floats top-center while any
          composer is listening. Renders null when idle. */}
      <VoiceListeningOverlay />
    </div>
  );
}

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
function WidePlanDialog() {
  const { t } = useI18n();
  const widePanelOpen = useSessionStore((s) => s.widePanelOpen);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const planTabActive = useSessionStore((s) =>
    activeSessionId ? (s.planTabActiveBySession[activeSessionId] ?? false) : false,
  );
  const planText = useSessionStore((s) =>
    activeSessionId ? (s.planDrawerPlanBySession[activeSessionId] ?? null) : null,
  );
  const planApprovalPending = useSessionStore((s) =>
    activeSessionId ? !!s.pendingPlanApprovalBySession[activeSessionId] : false,
  );
  const closePlanDrawer = useSessionStore((s) => s.closePlanDrawer);

  const open = widePanelOpen && planTabActive && !!planText;
  // Full-window DOM overlay: the browser view must hide while it's up (no
  // popup ref — the overlay always "overlaps").
  useSuppressBrowserView(open);

  if (!open) return null;
  return (
    <div className="fixed inset-x-0 top-10 bottom-0 z-50 flex flex-col bg-surface">
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-[11px] text-content-subtle">
            {t("layout.loadingPlan")}
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
    </div>
  );
}

/** The editor half: OpenTabsBar (only in tabs editor-mode, and not when
 *  `hideTabsBar` — the unified center bar passes that since it already
 *  renders the file tabs) + the active tab's content. Resolves the project
 *  path from the active project so FileEditor can show relative paths in
 *  its toolbar. When the plan tab is active, renders PlanViewer instead of
 *  FileEditor. */
