import { useEffect, useMemo, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { customUiLabel, type CustomUiItem } from "@contracts/customUi";
import type { RightPanelTab } from "@contracts/ipc";
import { IconArrowsMaximize, IconArrowsMinimize } from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useWorkflowLive } from "@renderer/lib/workflowLive.js";
import { resolveShortcut, acceleratorToDisplayString } from "@renderer/lib/shortcuts.js";
import { FilesPanel } from "@renderer/components/ide/FilesPanel.js";
import { GitPanel } from "@renderer/components/ide/GitPanel.js";
import { TurnFlowPanel } from "@renderer/components/ide/TurnFlowPanel.js";
import { TaskListPanel } from "@renderer/components/ide/TaskListPanel.js";
import { WorkflowBoardPanel } from "@renderer/components/chat/WorkflowBoardPanel.js";
import { BrowserPanel } from "@renderer/components/browser/BrowserPanel.js";
import { PreviewPanel } from "@renderer/components/library/PreviewPanel.js";
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
import { CACHED_BUILTIN_RIGHT_TABS, prunePanelIds, rememberPanelId, rememberRightTab, shouldMountCachedBuiltin } from "./rightPanelKeepAlive.js";

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
  const browserTabCount = useSessionStore((s) => s.browserTabCount);
  const widePanelOpen = useSessionStore((s) => s.widePanelOpen);
  const setWidePanelOpen = useSessionStore((s) => s.setWidePanelOpen);
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

  const showBuiltin = (id: RightPanelTab) => {
    setActiveCustom(null);
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

  const titleOf = (id: BuiltinTabId, fallback: string): string => {
    if (id === "browser") return tab === "browser" && !activeCustom ? t("layout.closeSidebarBrowser") : t("layout.openBrowser");
    if (id === "git") return "Git"; /* brand name */
    return fallback;
  };

  return (
    <div className="flex h-full flex-col">
      {/* Horizontal icon rail — always visible, docked at the panel's top
          edge. Each icon is a square button; the active one is marked with
          the accent token. 顺序 / 显隐 / 自定义页签都来自「设置 → 自定义 UI →
          右栏页签」;宽屏按钮是布局开关,不参与排,固定在最右。 */}
      <div
        className="flex h-9 shrink-0 flex-row items-center gap-1 border-b border-edge bg-surface px-1.5"
        onContextMenu={(e) => {
          e.preventDefault();
          openCustomUiSettings("rightPanel.tab");
        }}
      >
        <div
          className="flex min-w-0 flex-row items-center gap-1 overflow-x-auto [scrollbar-width:none]"
          aria-label={t("customUi.slot.rightPanel.tab")}
          onKeyDown={(e) => {
            // Do not steal SDK shortcuts, Alt menus or IME composition.
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
            if (!(e.target instanceof Element)) return;
            const currentButton = e.target.closest<HTMLButtonElement>("button[data-pane-rail-button]");
            if (!currentButton) return;
            const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-pane-rail-button]"));
            const index = buttons.indexOf(currentButton);
            const nextIndex = nextRailFocusIndex(e.key, index, buttons.length);
            if (nextIndex === null) return;
            e.preventDefault();
            e.stopPropagation();
            const nextButton = buttons[nextIndex];
            if (!nextButton) return;
            nextButton.focus();
            nextButton.scrollIntoView({ block: "nearest", inline: "nearest" });
          }}
        >
          {entries.map((e) => {
            if (e.kind === "builtin") {
              if (!isBuiltinTabId(e.meta.id)) return null;
              const id = e.meta.id;
              const Icon = e.meta.icon;
              const badge = badgeOf(id);
              return (
                <div key={e.key} className="relative shrink-0">
                  <RailButton active={!activeCustom && tab === id} onClick={e.runtime.run} title={titleOf(id, t(e.meta.labelKey))}>
                    <Icon size={16} className="shrink-0" />
                  </RailButton>
                  {badge > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold leading-none text-white">
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
                  active={activeCustom?.id === e.item.id}
                  onClick={() => setActiveCustom(e.item.id)}
                  title={customUiLabel(e.item.label, locale)}
                >
                  <Icon size={16} className="shrink-0" />
                </RailButton>
              </div>
            );
          })}
        </div>
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
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {CACHED_BUILTIN_RIGHT_TABS.map((id) => {
          if (!shouldMountCachedBuiltin(id, tab, visitedBuiltinTabs)) return null;
          const selected = !activeCustom && tab === id;
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
          const selected = activeCustom?.id === e.item.id;
          return (
            <div key={e.item.id} className="h-full min-h-0"
              style={{ display: selected ? "block" : "none" }}
              inert={!selected} aria-hidden={!selected}>
              <CustomTabView item={e.item} target={target} />
            </div>
          );
        })}
        {activeCustom && activeCustom.action.type !== "panel" && (
          <CustomTabView key={activeCustom.id} item={activeCustom} target={target} />
        )}
        {!activeCustom && tab === "turns" && <TurnFlowPanel />}
        {!activeCustom && tab === "flow" && <WorkflowBoardPanel />}
        {!activeCustom && tab === "tasks" && <TaskListPanel />}
        {!activeCustom && tab === "preview" && <PreviewPanel />}
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
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-pane-rail-button=""
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-accent/15 text-accent"
          : "text-content-muted hover:bg-surface-hover hover:text-content",
      )}
    >
      {children}
    </button>
  );
}
