import { useMemo } from "react";
import { cn } from "@renderer/lib/cn.js";
import {
  IconFolder,
  IconGitBranch,
  IconWorld,
  IconListDetails,
  IconMessages,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconBook,
  IconTemplate,
  IconListTree,
  IconTerminal2,
} from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useWorkflowLive } from "@renderer/lib/workflowLive.js";
import { resolveShortcut, acceleratorToDisplayString } from "@renderer/lib/shortcuts.js";
import { FilesPanel } from "@renderer/components/ide/FilesPanel.js";
import { GitPanel } from "@renderer/components/ide/GitPanel.js";
import { TurnFlowPanel } from "@renderer/components/ide/TurnFlowPanel.js";
import { TaskListPanel } from "@renderer/components/ide/TaskListPanel.js";
import { WorkflowBoardPanel } from "@renderer/components/chat/WorkflowBoardPanel.js";
import { BrowserPanel } from "@renderer/components/browser/BrowserPanel.js";
import { SideChatPanel } from "@renderer/components/chat/SideChatPanel.js";
import { LibraryPanel } from "@renderer/components/library/LibraryPanel.js";
import { TemplatePanel } from "@renderer/components/templates/TemplatePanel.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

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
 *  count. */
export function RightPanel() {
  const { t } = useI18n();
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

  /** Toggle the embedded sidebar browser: open it if another tab is active,
   *  or close it (fall back to files) if it's already showing. */
  const toggleBrowser = () => {
    setTab(tab === "browser" ? "files" : "browser");
  };

  return (
    <div className="flex h-full flex-col">
      {/* Horizontal icon rail — always visible, docked at the panel's top
          edge. Each icon is a square button; the active one is marked with
          the accent token. */}
      <div className="flex h-9 shrink-0 flex-row items-center gap-1 border-b border-edge bg-surface px-1.5">
        <RailButton
          active={tab === "files"}
          onClick={() => setTab("files")}
          title={t("layout.tabFiles")}
        >
          <IconFolder size={16} className="shrink-0" />
        </RailButton>
        <RailButton
          active={tab === "git"}
          onClick={() => setTab("git")}
          title="Git" /* brand name */
        >
          <IconGitBranch size={16} className="shrink-0" />
        </RailButton>
        {/* Browser — toggles the embedded sidebar (mobile-first). */}
        <div className="relative">
          <RailButton
            active={tab === "browser"}
            onClick={toggleBrowser}
            title={tab === "browser" ? t("layout.closeSidebarBrowser") : t("layout.openBrowser")}
          >
            <IconWorld size={16} className="shrink-0" />
          </RailButton>
          {browserTabCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold leading-none text-white">
              {browserTabCount}
            </span>
          )}
        </div>
        {/* Turn flow — per-turn visualization of the model's work process
            (prompt → actions → reply → token cost) from the message stream. */}
        <RailButton
          active={tab === "turns"}
          onClick={() => setTab("turns")}
          title={t("layout.tabTurns")}
        >
          <IconListDetails size={16} className="shrink-0" />
        </RailButton>
        {/* 运行看板 —— 这张图现在跑到哪一格、哪几个分身还在干活。**带角标**:
            有几个在跑就在图标上写几,用户不点开也知道。 */}
        <div className="relative">
          <RailButton
            active={tab === "flow"}
            onClick={() => setTab("flow")}
            title={t("layout.tabFlow")}
          >
            <IconListTree size={16} className="shrink-0" />
          </RailButton>
          {runningNodeCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold leading-none text-white">
              {runningNodeCount}
            </span>
          )}
        </div>
        {/* 任务列表 —— 所有终端 + 代理派出去的任务 + 工作流正在跑的那一步,点开看输出。
            与「工作流运行」是两个问题:那个讲**这张图**跑到哪一格,这个讲**这台机器
            此刻在跑什么**(谁开的、跑完了没)。 */}
        <RailButton
          active={tab === "tasks"}
          onClick={() => setTab("tasks")}
          title={t("layout.tabTasks")}
        >
          <IconTerminal2 size={16} className="shrink-0" />
        </RailButton>
        {/* Side chat — quick Q&A beside the running main session. */}
        <RailButton
          active={tab === "sidechat"}
          onClick={() => setTab("sidechat")}
          title={t("layout.tabSideChat") + hintFor("sidechat.open")}
        >
          <IconMessages size={16} className="shrink-0" />
        </RailButton>
        {/* 文献库 —— 与左栏的「文献库」分组联动:在左栏点某个库,这里切到本标签
            并显示该库的文献。仿照上面的 RailButton 写法,不改动其余标签的行为。 */}
        <RailButton
          active={tab === "library"}
          onClick={() => setTab("library")}
          title={t("library.title")}
        >
          <IconBook size={16} className="shrink-0" />
        </RailButton>
        {/* 模版 —— 与左栏的「模版」分组联动:在左栏点开一条模版、点里面的一个文件,
            这里显示它的内容(应用内预览)。与文献库那个标签同一套做法。 */}
        <RailButton
          active={tab === "templates"}
          onClick={() => setTab("templates")}
          title={t("layout.tabTemplates")}
        >
          <IconTemplate size={16} className="shrink-0" />
        </RailButton>
        {/* Wide-panel (3:7) mode - hide the left sidebar + center editor and
            split the workspace into this right panel (7/10) + the chat column
            (3/10). Toggled here, via the command palette / shortcut, or the
            titlebar back button. Pushed to the rail's far right with ml-auto. */}
        <div className="ml-auto flex items-center gap-1">
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
        {tab === "files" && <FilesPanel />}
        {tab === "git" && <GitPanel />}
        {tab === "turns" && <TurnFlowPanel />}
        {tab === "flow" && <WorkflowBoardPanel />}
        {tab === "tasks" && <TaskListPanel />}
        {tab === "sidechat" && <SideChatPanel />}
        {tab === "library" && <LibraryPanel />}
        {tab === "templates" && <TemplatePanel />}
        {tab === "browser" && <BrowserPanel mode="sidebar" />}
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
      onClick={onClick}
      title={title}
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
