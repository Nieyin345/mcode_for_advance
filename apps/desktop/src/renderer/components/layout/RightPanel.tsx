import { useBrowserStore } from "@renderer/stores/browserStore.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { GenofficeViewHostPane } from "@renderer/components/ide/GenofficeViewHostPane.js";
import { useOfficeMemoryReclaim } from "@renderer/components/ide/useOfficeMemoryReclaim.js";
import { stableDocId } from "@renderer/components/ide/GenofficeViewHostPane.js";
import { canDockOfficeFile } from "@renderer/components/ide/officeChatHandoff.js";
import { FileTypeIcon } from "@renderer/lib/fileIcon.js";
import { hostedPaneContent } from "./paneLayout.js";
import { EngineRuntimePanel } from "@renderer/components/settings/workflows/EngineRuntimePanel.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { customUiLabel, type CustomUiItem } from "@contracts/customUi";
import type { RightPanelTab } from "@contracts/ipc";
import { IconArrowsMaximize, IconArrowsMinimize, IconGripVertical, IconPuzzle } from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useWorkflowLive } from "@renderer/lib/workflowLive.js";
import { resolveShortcut, acceleratorToDisplayString } from "@renderer/lib/shortcuts.js";
import { FilesPanel } from "@renderer/components/ide/FilesPanel.js";
import { GitPanel } from "@renderer/components/ide/GitPanel.js";
import { TurnFlowPanel } from "@renderer/components/ide/TurnFlowPanel.js";
import { TaskListPanel } from "@renderer/components/ide/TaskListPanel.js";
import { TaskCenterPanel } from "@renderer/components/ide/TaskCenterPanel.js";
import { WorkflowBoardPanel } from "@renderer/components/chat/WorkflowBoardPanel.js";
import { BrowserPanel } from "@renderer/components/browser/BrowserPanel.js";
import { PreviewPanel } from "@renderer/components/library/PreviewPanel.js";
import { RenderErrorBoundary } from "@renderer/components/chat/RenderErrorBoundary.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { openCustomUiSettings, useCustomUiStore } from "@renderer/stores/customUiStore.js";
import { resolveSlotEntries, type BuiltinRuntime } from "@renderer/components/customUi/CustomUiMenuItems.js";
import {
  BUILTIN_TAB_IDS,
  CUSTOM_ICONS,
  DEFAULT_ACTION_ICON,
  isBuiltinTabId,
  type BuiltinTabId,
} from "@renderer/components/customUi/registry.js";
import { CustomTabView } from "@renderer/components/customUi/CustomTabView.js";
import { useWorkspaceTarget } from "@renderer/components/customUi/useWorkspaceTarget.js";
import { nextRailFocusIndex } from "./panelRailNavigation.js";
import { revealRailItemWithin } from "./panelRailScroll.js";
import { CACHED_BUILTIN_RIGHT_TABS, prunePanelIds, rememberPanelId, rememberRightTab, shouldMountCachedBuiltin } from "./rightPanelKeepAlive.js";
import { PANE_DOCK_MIME, RIGHT_PANE_DRAG_ID, paneDockFromKeyboard } from "./paneDock.js";

const NO_MODULES: never[] = [];

/** Right panel: a horizontal icon rail docked at the top + a main panel
 *  area (IDE-style). The rail is always visible and holds three icons:
 *    - Files   → shows FilesPanel in the main area
 *    - Git     → shows GitPanel in the main area
 *    - Browser → toggles an embedded browser panel in the main area
 *      (sidebar mode, desktop-sized pages by default). Clicking again closes
 *      it. The PC-fullscreen overlay is a separate container rendered at the
 *      App root; while that overlay is open the right panel isn't visible at
 *      all.
 *
 *  The active panel (files / git) is read from / written to the session store
 *  (persisted in the settings table), so it survives restarts. The browser tab
 *  is session-only (hydrate ignores a persisted "browser" value so the browser
 *  never auto-opens at boot). The browser icon shows a badge with the open-tab
 *  count.
 *
 *  页签这一排可以在「设置 → 自定义 UI → 右栏页签」里排序、隐藏,也可以加自定义页签
 *  (显示一段 Markdown 视图,或项目里的一个文件)。自定义页签是否正在显示记在
 *  `customUiStore.activeTab`(session-only),不进 `rightPanelTab` 的持久化白名单;别处代码
 *  调 `setRightPanelTab` 时它会让位(见 sessionStore 的 `rightPanelTabSeq`)。右键这一排
 *  直接跳到那一页设置。 */
export function RightPanel() {
  const { t, locale } = useI18n();
  const tab = useSessionStore((s) => s.rightPanelTab);
  const setTab = useSessionStore((s) => s.setRightPanelTab);
  const content = useSessionStore((s) => s.paneLayout?.placements
    ? hostedPaneContent(s.paneLayout) : undefined);
  const setContent = useSessionStore((s) => s.setLayoutPaneContent);
  const setRightOpen = useSessionStore((s) => s.setRightOpen);
  const settingsOpen = useSessionStore((s) => s.settingsOpen);
  const activeFile = useSessionStore((s) => s.activeProjectId
    ? s.ideActiveFileByProject[s.activeProjectId] ?? null : null);
  // The native editor supports six GenOffice applications, not just DOCX.
  // Reuse its single routing contract; unknown formats remain disabled.
  const dockableDoc = canDockOfficeFile(activeFile) ? activeFile : null;
  const pinnedDoc = content?.kind === "document" ? content.documentId : null;
  const pinnedFlow = content?.kind === "flow" ? content.flowId : null;
  const [visitedDocs, setVisitedDocs] = useState<ReadonlySet<string>>(() => new Set());
  const [visitedFlows, setVisitedFlows] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (pinnedDoc) setVisitedDocs(previous => previous.has(pinnedDoc) ? previous : new Set([...previous, pinnedDoc]));
    if (pinnedFlow) setVisitedFlows(previous => previous.has(pinnedFlow) ? previous : new Set([...previous, pinnedFlow]));
  }, [pinnedDoc, pinnedFlow]);
  // 【Office 深度集成】后台编辑器视图的内存回收。六个 GenOffice 编辑器同时
  // 驻留约 1.70 GiB（O18 实测），而 hide() 只把视图挪到屏幕外、页面仍满编常驻。
  // 判据与安全线见 useOfficeMemoryReclaim.ts：当前激活的、脏的、太新的都不动。
  // 面板组件会在它的 list() 轮询里发现"视图被回收了"并用同一 docId 重建。
  useOfficeMemoryReclaim({
    activeFilePath: pinnedDoc,
    docIdForPath: stableDocId,
  });
  const browserTabCount = useBrowserStore((s) => s.browserTabCount);
  const widePanelOpen = useSessionStore((s) => s.widePanelOpen);
  const setWidePanelOpen = useSessionStore((s) => s.setWidePanelOpen);
  const rightDock = useSessionStore((s) => s.rightDock);
  const setRightDock = useSessionStore((s) => s.setRightDock);
  const dockTitle = locale.startsWith("zh")
    ? (rightDock === "left" ? "停靠到右侧（也可拖动）" : "停靠到左侧（也可拖动）")
    : (rightDock === "left" ? "Dock panel right (or drag)" : "Dock panel left (or drag)");
  // 角标上的数:**当前对话**有几个节点在跑。订阅点在这里(而不是面板里)——
  // 面板没打开时角标也得对。
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const live = useWorkflowLive();
  const runningNodeCount = useMemo(() => {
    if (!activeSessionId) return 0;
    let n = 0;
    for (const run of Object.values(live.runs)) {
      if (run.sessionId !== activeSessionId) continue;
      for (const id of run.order) {
        if (run.nodes[id]?.phase === "running") n++;
      }
    }
    return n;
  }, [live.runs, activeSessionId]);

  // Append the effective shortcut for a command's tooltip (same pattern as the
  // Titlebar's hintFor; cheap - a handful of lookups per render).
  const overrides = useSessionStore((s) => s.shortcutOverrides);
  const hintFor = (commandId: string): string => {
    const a = resolveShortcut(commandId, overrides);
    return a ? ` (${acceleratorToDisplayString(a)})` : "";
  };

  // 自定义页签(设置 → 自定义 UI → 右栏页签)。`activeTab` 非空 = 此刻显示的是那一个;
  // 为空 = 显示内置的 `tab`。
  const customItems = useCustomUiStore((s) => s.config.items);
  const tabLayout = useCustomUiStore((s) => s.config.layout["rightPanel.tab"]);
  const activeCustomId = useCustomUiStore((s) => s.activeTab);
  const setActiveCustom = useCustomUiStore((s) => s.setActiveTab);
  const target = useWorkspaceTarget();
  const moduleViews: Array<{ module: unknown; contribution: { location: string; icon?: string } }> = [];
  const [activeModuleView,setActiveModuleView] = useState(false);
  const moduleVisible = activeModuleView && moduleViews.length>0;
  const railTrackRef = useRef<HTMLDivElement>(null);

  const showBuiltin = (id: RightPanelTab) => {
    setContent("right", undefined);
    setActiveCustom(null);
    setActiveModuleView(false);
    setTab(id);
  };

  /** Toggle the embedded sidebar browser: open it if another tab is active,
   *  or close it (fall back to files) if it's already showing. */
  const toggleBrowser = () => {
    showBuiltin(!activeCustom && tab === "browser" ? "files" : "browser");
  };

  // 内置页签的「点了做什么」。全部给出 = 全部可显示;藏不藏、排第几由布局决定。
  // 十来个键,每次渲染现算,不值得 memo。
  const builtinRuntime: Record<string, BuiltinRuntime> = {};
  for (const id of BUILTIN_TAB_IDS) {
    builtinRuntime[id] = { run: id === "browser" ? toggleBrowser : () => showBuiltin(id) };
  }
  const entries = resolveSlotEntries("rightPanel.tab", target, customItems, tabLayout, builtinRuntime, NO_MODULES);

  // 正在显示的自定义页签被删了 / 藏了 → 退回内置的那个(不改存储里的值,下次还原得回来)
  const activeCustom: CustomUiItem | null =
    activeCustomId === null
      ? null
      : (entries.find(
          (e): e is Extract<(typeof entries)[number], { kind: "custom" }> =>
            e.kind === "custom" && e.item.id === activeCustomId,
        )?.item ?? null);

  // Stateful builtin panes (Files/Git/Browser) and sandboxed HTML panel iframes
  // mount only when first visited. Keep their same React identity when another
  // rail tab is selected, preserving Git subtabs, explorer scroll and iframe
  // runtime state. Hidden custom entries are excluded by the live entries list.
  const [visitedBuiltinTabs, setVisitedBuiltinTabs] = useState<ReadonlySet<RightPanelTab>>(() => new Set());
  const [visitedPanelIds, setVisitedPanelIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (activeCustom === null) setVisitedBuiltinTabs((prev) => rememberRightTab(prev, tab));
    else if (activeCustom.action.type === "panel")
      setVisitedPanelIds((prev) => rememberPanelId(prev, activeCustom.id));
  }, [activeCustom, tab]);
  const availablePanelIds = new Set(entries.flatMap(
    (e) => e.kind === "custom" && e.item.action.type === "panel" ? [e.item.id] : [],
  ));
  useEffect(() => {
    setVisitedPanelIds((prev) => prunePanelIds(prev, availablePanelIds));
  }, [entries]);
  const cachedPanelIds = entries.filter(
    (e) => e.kind === "custom" && e.item.action.type === "panel" &&
      (visitedPanelIds.has(e.item.id) || activeCustom?.id === e.item.id),
  );

  const badgeOf = (id: BuiltinTabId): number =>
    id === "browser" ? browserTabCount : id === "flow" ? runningNodeCount : 0;

  // Reveal the selected action INSIDE the rail, never via scrollIntoView:
  // scrolling an ancestor could shift the chat composer or editor. Selection
  // changes are not enough: docking, resizing, or opening another pane may
  // shrink the rail while its selected action remains off-screen.
  useEffect(() => {
    const track = railTrackRef.current;
    if (!track || pinnedDoc || pinnedFlow) return;
    let frame = 0;
    const reveal = () => {
      const selected = track.querySelector<HTMLElement>(
        '[data-pane-rail-button][aria-pressed="true"]',
      );
      if (selected) revealRailItemWithin(track, selected);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reveal);
    };
    schedule();
    // ResizeObserver watches only this small rail viewport. No window-wide
    // resize listener and no per-button observers; cleanup runs on unmount.
    const observer = typeof ResizeObserver === "undefined"
      ? null : new ResizeObserver(schedule);
    observer?.observe(track);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [tab, activeCustomId, moduleVisible, pinnedDoc, pinnedFlow, entries.length]);

  const titleOf = (id: BuiltinTabId, fallback: string): string => {
    if (id === "browser") return tab === "browser" && !activeCustom ? t("layout.closeSidebarBrowser") : t("layout.openBrowser");
    if (id === "git") return "Git"; /* brand name */
    return fallback;
  };

  return (
    <div data-cds="RightPanel" className="flex h-full flex-col">
      {/* Horizontal icon rail — always visible, docked at the panel's top
          edge. Each icon is a square button; the active one is marked with
          the accent token. 顺序 / 显隐 / 自定义页签都来自「设置 → 自定义 UI →
          右栏页签」;宽屏按钮是布局开关,不参与排,固定在最右。 */}
      <div
        data-cds="RightPanelRail"
        className="flex h-10 min-w-0 shrink-0 flex-row items-center gap-1 border-b border-edge/60 bg-surface px-2"
        role="toolbar"
        aria-label={t("customUi.slot.rightPanel.tab")}
        onKeyDown={(e) => {
          // The whole toolbar is one navigation surface: built-in, custom,
          // module and docked content icons plus wide-mode. The draggable
          // docking handle retains its own ArrowLeft/ArrowRight semantics.
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
          if (!(e.target instanceof Element)) return;
          const currentButton = e.target.closest<HTMLButtonElement>("button[data-pane-rail-button]");
          if (!currentButton) return;
          const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-pane-rail-button]:not(:disabled)"));
          const index = buttons.indexOf(currentButton);
          if (index < 0) return;
          const nextIndex = nextRailFocusIndex(e.key, index, buttons.length);
          if (nextIndex === null) return;
          e.preventDefault();
          e.stopPropagation();
          const nextButton = buttons[nextIndex];
          if (!nextButton) return;
          nextButton.focus({ preventScroll: true });
          const rail = railTrackRef.current;
          if (rail?.contains(nextButton)) revealRailItemWithin(rail, nextButton);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openCustomUiSettings("rightPanel.tab");
        }}
      >
        <div
          data-pane-rail-track=""
          ref={railTrackRef}
          className="flex min-w-0 flex-1 flex-row items-center gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:thin]"
        >
          {entries.map((e) => {
            if (e.kind === "builtin") {
              if (!isBuiltinTabId(e.meta.id)) return null;
              const id = e.meta.id;
              const Icon = e.meta.icon;
              const badge = badgeOf(id);
              const label = titleOf(id, t(e.meta.labelKey)) + (badge > 0 ? ` (${badge})` : "");
              return (
                <div key={e.key} className="relative shrink-0">
                  <RailButton active={!activeCustom && !moduleVisible && !pinnedDoc && !pinnedFlow && tab === id} onClick={e.runtime.run} title={label}>
                    <Icon size={16} className="shrink-0" />
                  </RailButton>
                  {badge > 0 && (
                    <span aria-hidden="true" className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold leading-none text-white">
                      {badge}
                    </span>
                  )}
                </div>
              );
            }
            if (e.kind !== "custom") return null;
            const Icon = e.item.icon ? CUSTOM_ICONS[e.item.icon] : DEFAULT_ACTION_ICON[e.item.action.type];
            return (
              <div key={e.key} className="shrink-0">
                <RailButton
                  active={!pinnedDoc && !pinnedFlow && activeCustom?.id === e.item.id}
                  onClick={() => {setActiveModuleView(false);setContent("right",undefined);setActiveCustom(e.item.id);}}
                  title={customUiLabel(e.item.label, locale)}
                >
                  <Icon size={16} className="shrink-0" />
                </RailButton>
              </div>
            );
          })}
        </div>
        {moduleViews.length>0 && <RailButton active={moduleVisible && !pinnedDoc && !pinnedFlow} onClick={()=>{setActiveModuleView(true);setContent("right",undefined);setActiveCustom(null);}} title={`${locale==="zh"?"扩展视图":"Extension views"} · ${moduleViews.length}`}><IconPuzzle /></RailButton>}
        {/* Native document and Node-RED share the same movable shell. Their
            component trees are cached instead of keyed by docking position:
            flex reorder must never navigate an unsaved editor. */}
        <div className="flex shrink-0 items-center gap-0.5 border-l border-edge/60 pl-1">
          <RailButton active={pinnedDoc !== null} disabled={!dockableDoc && !pinnedDoc} onClick={() => {
            const docTarget = dockableDoc ?? pinnedDoc;
            if (!docTarget) return;
            setActiveModuleView(false);
            setContent("right", { kind: "document", documentId: docTarget });
            setActiveCustom(null);
            setRightOpen(true);
          }} title={t("layout.paneDocument")}>
            <FileTypeIcon path={dockableDoc ?? pinnedDoc ?? "document"} size={16} className="shrink-0" />
          </RailButton>
          <RailButton active={pinnedFlow !== null} onClick={() => {
            setActiveModuleView(false);
            setContent("right", { kind: "flow", flowId: "node-red" });
            setActiveCustom(null);
            setRightOpen(true);
          }} title={t("layout.paneFlow")}>
            <span aria-hidden="true" className="font-mono text-[10px]">NR</span>
          </RailButton>
          {(pinnedDoc !== null || pinnedFlow !== null) && (
            <RailButton active={false} onClick={() => setContent("right", undefined)} title={t("layout.paneRestore")}>
              <span aria-hidden="true">×</span>
            </RailButton>
          )}
        </div>
        {/* Native HTML drag source + click/keyboard alternative. Drag this handle
            onto the left/right half of the chat/editor to change the dock;
            a click/Enter/Space toggles the same persistent side. */}
        <button type="button" draggable
          data-testid="right-pane-drag-handle"
          data-cds="RightPanelDockHandle"
          title={dockTitle} aria-label={dockTitle}
          aria-keyshortcuts="ArrowLeft ArrowRight"
          onClick={() => setRightDock(rightDock === "left" ? "right" : "left")}
          onKeyDown={(e) => {
            const dockSide = paneDockFromKeyboard({
              key: e.key, altKey: e.altKey, ctrlKey: e.ctrlKey,
              metaKey: e.metaKey, shiftKey: e.shiftKey,
              isComposing: e.nativeEvent.isComposing,
              keyCode: e.nativeEvent.keyCode,
            });
            if (dockSide) {
              e.preventDefault();
              e.stopPropagation();
              setRightDock(dockSide);
            }
          }}
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData(PANE_DOCK_MIME, RIGHT_PANE_DRAG_ID);
            e.dataTransfer.effectAllowed = "move";
          }}
          className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-btn-xs)] text-content-muted hover:bg-surface-hover active:bg-surface-active hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <span data-cds="RightPanelDockGlyph" aria-hidden="true" className="text-[15px] tracking-tighter">⋮⋮</span>
          <IconGripVertical data-cds="RightPanelDockIcon" size={14} className="shrink-0" aria-hidden="true" />
        </button>
        {/* Wide-panel (3:7) mode - hide the left sidebar + center editor and
            split the workspace into this right panel (7/10) + the chat column
            (3/10). Toggled here, via the command palette / shortcut, or the
            titlebar back button. Pushed to the rail's far right with ml-auto. */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <div className="h-5 w-px bg-edge" />
          <RailButton
            active={widePanelOpen}
            onClick={() => setWidePanelOpen(!widePanelOpen)}
            title={
              (widePanelOpen ? t("layout.exitWideMode") : t("layout.wideMode")) +
              hintFor("layout.toggle-wide-panel")
            }
          >
            {/* Maximize when entering, minimize (restore) when already wide —
                the standard expand/collapse affordance pair. */}
            {widePanelOpen ? (
              <IconArrowsMinimize size={16} className="shrink-0" />
            ) : (
              <IconArrowsMaximize size={16} className="shrink-0" />
            )}
          </RailButton>
        </div>
      </div>

      {/* Main panel area — must NOT scroll itself (children own height /
          overflow). Renders the panel matching the active tab. The browser
          sidebar (mobile-first) renders inline here; the PC-fullscreen overlay
          is rendered at the App root and covers the whole workspace. */}
      <div data-cds="RightPanelContent" className="relative min-h-0 flex-1 overflow-hidden">
        {Array.from(visitedDocs).map(path => {
          const selected = pinnedDoc === path && !settingsOpen;
          return <div key={path} className="h-full min-h-0 overflow-hidden rounded-[var(--radius-panel)] border border-edge-panel bg-surface"
            data-pane-document={path} style={{ display: selected ? "block" : "none" }}
            inert={!selected} aria-hidden={!selected}>
            <div className="h-full min-h-0" onMouseDown={() => {
              try { void api.documentView.focus({ docId: stableDocId(path) }).catch(() => {}); } catch { /* web fallback */ }
            }}>
              <GenofficeViewHostPane filePath={path} active={selected} />
            </div>
          </div>;
        })}
        {Array.from(visitedFlows).map(engineId => {
          const selected = pinnedFlow === engineId && !settingsOpen;
          return <div key={engineId} className="h-full min-h-0 overflow-hidden rounded-[var(--radius-panel)] border border-edge-panel bg-surface"
            data-pane-flow={engineId} style={{ display: selected ? "block" : "none" }}
            inert={!selected} aria-hidden={!selected}>
            <EngineRuntimePanel engineId={engineId} editorOnly active={selected} />
          </div>;
        })}
        <div className={pinnedDoc || pinnedFlow ? "hidden h-full" : "h-full"} inert={!!(pinnedDoc || pinnedFlow)} aria-hidden={!!(pinnedDoc || pinnedFlow)}>
        {CACHED_BUILTIN_RIGHT_TABS.map((id) => {
          if (!shouldMountCachedBuiltin(id, tab, visitedBuiltinTabs)) return null;
          const selected = !moduleVisible && !activeCustom && !pinnedDoc && !pinnedFlow && tab === id;
          return (
            <div
              key={id}
              data-keepalive-tab={id}
              className="h-full min-h-0"
              style={{ display: selected ? "block" : "none" }}
              inert={!selected}
              aria-hidden={!selected}
            >
              {id === "files" && <FilesPanel />}
              {id === "git" && <GitPanel />}
              {id === "browser" && <BrowserPanel mode="sidebar" selected={selected} />}
            </div>
          );
        })}
        {cachedPanelIds.map((e) => {
          if (e.kind !== "custom") return null;
          const selected = !moduleVisible && activeCustom?.id === e.item.id;
          return (
            <div key={e.item.id} className="h-full min-h-0"
              style={{ display: selected ? "block" : "none" }}
              inert={!selected} aria-hidden={!selected}>
              <CustomTabView item={e.item} target={target} />
            </div>
          );
        })}
        {!moduleVisible && activeCustom && activeCustom.action.type !== "panel" && (
          <CustomTabView key={activeCustom.id} item={activeCustom} target={target} />
        )}
        {/* 【T41】错误边界**只包扩展区块**,不包整个右栏 —— 包大了会把文件树/Git/
            回合流这些无关面板的异常也吞成一张卡,用户连切走的原因都看不到。
            `moduleViews` 是渲染期直接算出来的(没有 useMemo 托管),而扩展坞是它唯一的
            消费者;把边界收在这一块,坏目录最多让扩展坞显示错误卡,右栏其余部分照常。 */}
        {!moduleVisible && !activeCustom && tab === "turns" && <TurnFlowPanel />}
        {!moduleVisible && !activeCustom && tab === "flow" && <WorkflowBoardPanel />}
        {!moduleVisible && !activeCustom && tab === "tasks" && <TaskListPanel />}
        {/* 【T100】任务中心 —— 与上面那个「正在跑什么」是两件事（见 TaskCenterPanel 文件头）。 */}
        {!moduleVisible && !activeCustom && tab === "taskcenter" && <TaskCenterPanel />}
        {!moduleVisible && !activeCustom && tab === "preview" && <PreviewPanel />}
        </div>
      </div>
    </div>
  );
}

/** A square icon button in the panel's rail. Active state uses the accent
 *  token; idle state uses the muted content token with a hover surface. */
function RailButton({
  active,
  onClick,
  title,
  children,
  disabled = false,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      data-pane-rail-button=""
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        "flex size-8 items-center justify-center rounded-[var(--radius-btn-xs)] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "bg-surface-hover text-content ring-1 ring-inset ring-edge/70"
          : "cds-hover-ghost text-content-muted hover:text-content",
      )}
    >
      {children}
    </button>
  );
}
