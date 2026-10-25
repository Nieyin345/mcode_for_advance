/**
 * Mcode's ONE workflow workbench.
 *
 * Node-RED is the native canvas and execution runtime, not a separate product.
 * Ordinary workflows and event-driven automations share the same canvas,
 * node catalog and Host permission/ownership model. The library's category
 * selector changes which documents are listed; it does not create an editor
 * or a second execution engine.
 *
 * Fast first paint: on the default canvas we mount ONLY EngineRuntimePanel.
 * Library, catalog, profile editing and their IPC reads are deferred until
 * first visit. After visiting, their trees are retained to preserve unsaved
 * drafts and avoid reconstructing them during frequent tab switching.
 *
 * The legacy `purpose="automation"` input remains for existing caller/tests,
 * but SettingsPage routes both deep links through one workflow entry.
 *
 * Do not nest another ThreePaneLayout; SettingsPage owns the window shell.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { Button, ErrorNote } from "@renderer/components/ui/index.js";
import { localizeWorkflowCatalog } from "./workflowPresentation.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { PANEL_MAX_W } from "../panelWidth.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { IconArrowsSplit, IconBolt } from "@renderer/lib/icons.js";
import type { AgentProfile } from "@contracts/agentProfile";
import { PanelHeader } from "../PanelHeader.js";
// Heavy library/inspector modules are downloaded only when their tab is first
// visited. Keeping their mounted tree after that avoids draft/state loss.
const WorkflowLibraryView = lazy(() => import("./WorkflowLibraryView.js")
  .then(module => ({ default: module.WorkflowLibraryView })));
const NodeTypesView = lazy(() => import("./NodeTypesView.js")
  .then(module => ({ default: module.NodeTypesView })));
const AgentProfilesView = lazy(() => import("./AgentProfilesView.js")
  .then(module => ({ default: module.AgentProfilesView })));
import { EngineRuntimePanel } from "./EngineRuntimePanel.js";
import type { WorkflowPurpose } from "./workflowView.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

type WorkflowsView = "library" | "nodeTypes" | "profiles" | "engines";

/**
 * 默认页签（用户原话，2026-10-24）：「默认就是 node-red 的编辑页面，不要之前自己写的
 * 编辑页面了」。手写画布已删除（见 `WorkflowLibraryView` 文件头），工作流库那一页现在
 * 只剩列表与检查器 —— 打开「工作流」时用户想看到的是 Node-RED 原厂画布。
 *
 * **导出**：默认值是一个判据而不是一行字面量 —— 冒烟脚本要能断言"初值来自这里"，
 * 而不是在组件源码里 grep 一个字符串（见 `scripts/workflow-engine-view-owner-smoke`）。
 */
export const DEFAULT_WORKFLOWS_VIEW: WorkflowsView = "engines";

/**
 * 打开面板时先落在哪一页。三个输入：
 *
 * - `focusWorkflowId`（技能/插件页的「节点」反查带来的目标）**优先** —— 用户是点着
 *   一份工作流进来的，必须落在库那页去把它选中；否则反查会落在一个看不见的页上。
 * - `purpose === "workflow"` → 默认 `DEFAULT_WORKFLOWS_VIEW`（原厂画布）。
 * - `purpose === "automation"` → 保持 `library`。自动化那一页回答的是「我有哪些
 *   自动化、它们什么时候跑」，它的库是有内容的；引擎页是"引擎进程 + 同一块画布"，
 *   对一个来看触发器的人来说不是下一步。读代码没有找到相反的证据。
 */
export function initialWorkflowsView(
  purpose: WorkflowPurpose,
  focusWorkflowId: string | null | undefined,
  libraryPurpose: WorkflowPurpose = purpose,
): WorkflowsView {
  if (focusWorkflowId || libraryPurpose === "automation") return "library";
  return purpose === "workflow" ? DEFAULT_WORKFLOWS_VIEW : "library";
}

const VIEWS: ReadonlyArray<{ id: WorkflowsView; labelKey: MessageId }> = [
  { id: "library", labelKey: "settings.workflows.tabLibrary" },
  { id: "nodeTypes", labelKey: "settings.workflows.tabNodeTypes" },
  { id: "profiles", labelKey: "settings.workflows.tabProfiles" },
  // Native Node-RED canvas is Mcode’s ONLY workflow editor. Its runtime is
  // an internal implementation detail, not a second third-party workspace.
  { id: "engines", labelKey: "settings.workflows.tabEngines" },
];

export function WorkflowsPanel({ purpose, initialLibraryPurpose = purpose }: {
  purpose: WorkflowPurpose;
  /** Legacy automation deep links enter the same workflow surface with its library filter selected. */
  initialLibraryPurpose?: WorkflowPurpose;
}) {
  const { t } = useI18n();
  // 一次性焦点:技能/插件页的「节点」反查点一行时带的"要打开哪一份"(见 store 的
  // `settingsFocusWorkflowId`)。这里只负责**切到库那一页**;真正打开那份图、用完清掉
  // 由 `WorkflowLibraryView` 做(它才拿得到 `openWorkflow`)。
  // 先于 `useState` 读 store:初值要经过 `initialWorkflowsView`(反查优先)。
  const focusWorkflowId = useSessionStore((s) => s.settingsFocusWorkflowId);
  const [view, setView] = useState<WorkflowsView>(() =>
    initialWorkflowsView(purpose, focusWorkflowId, initialLibraryPurpose),
  );
  // A native flows.json swap restarts Node-RED; remount its status/view so an
  // old editor WebContentsView cannot keep showing the previous canvas.
  const [nativeCanvasEpoch, setNativeCanvasEpoch] = useState(0);
  const [libraryPurpose, setLibraryPurpose] = useState<WorkflowPurpose>(initialLibraryPurpose);
  // Focus is a one-shot navigation intent consumed by WorkflowLibraryView.
  // Its later clearing must NOT throw the user back to the canvas.
  const focusRef = useRef(focusWorkflowId);
  focusRef.current = focusWorkflowId;
  // A workflow editor is a heavyweight WebContentsView. The library, catalog
  // and profiles are not prerequisites for opening the native canvas. Mount
  // those trees on first visit, then retain drafts across tab switches.
  const [visitedLibrary, setVisitedLibrary] = useState(() =>
    initialWorkflowsView(purpose, focusWorkflowId, initialLibraryPurpose) === "library");
  const [visitedNodeTypes, setVisitedNodeTypes] = useState(false);
  const [visitedProfiles, setVisitedProfiles] = useState(false);
  const chooseView = useCallback((next: WorkflowsView) => {
    setView(next);
    if (next === "library") setVisitedLibrary(true);
    if (next === "nodeTypes") setVisitedNodeTypes(true);
    if (next === "profiles") setVisitedProfiles(true);
  }, []);
  useEffect(() => {
    setLibraryPurpose(initialLibraryPurpose);
    if (initialLibraryPurpose === "automation") chooseView("library");
    else if (purpose === "workflow" && !focusRef.current) chooseView(DEFAULT_WORKFLOWS_VIEW);
  }, [initialLibraryPurpose, purpose, chooseView]);
  const flowDocked = useSessionStore((s) => s.paneLayout?.placements?.some(p => p.content?.kind === "flow") ?? false);
  useEffect(() => {
    if (focusWorkflowId) chooseView("library");
  }, [focusWorkflowId, chooseView]);
  const isAutomation = purpose === "automation";
  // 自动化和工作流共用原厂引擎；节点类型与档案说明仍只在工作流页展示。
  // Both workflow and automation libraries use the same native Node-RED editor.
  const views = isAutomation ? VIEWS.filter((v) => v.id === "library" || v.id === "engines") : VIEWS;
  const prefix = isAutomation ? "automation" : "workflows";

  // Skip both IPC reads on the common "open workflows -> native canvas"
  // path. The same result is shared by all library/inspector/profile consumers.
  // Once a panel has requested shared metadata, keep its read cache live.
  // Toggling library -> canvas -> library should not send the same two IPC
  // requests again (useRpc re-fetches every time enabled flips false->true).
  const needsCatalog = visitedLibrary || visitedNodeTypes || visitedProfiles;
  const needsProfiles = visitedLibrary || visitedProfiles;
  const catalogRead = useRpc(() => api.workflow.nodeTypes(), [], {
    toastOnError: false, enabled: needsCatalog,
  });
  const profilesRead = useRpc(() => api.workflow.agentProfiles(), [], {
    toastOnError: false, enabled: needsProfiles,
  });
  const catalog = useMemo(() => catalogRead.data ? localizeWorkflowCatalog(catalogRead.data, t) : null, [catalogRead.data, t]);
  const catalogError = catalogRead.error?.message ?? null;
  const catalogLoading = catalogRead.loading;
  const loadCatalog = catalogRead.refetch;
  const loadProfiles = profilesRead.refetch;
  const profiles = profilesRead.data?.profiles ?? [];
  const profileProblems = profilesRead.data?.problems ?? [];
  const profilesLoading = profilesRead.loading;
  const [profileMutationError, setProfileError] = useState<string | null>(null);
  const profileError = profileMutationError ?? profilesRead.error?.message ?? null;

  const saveProfile = useCallback(
    async (profile: AgentProfile): Promise<boolean> => {
      setProfileError(null);
      let res: { ok: boolean; error?: string };
      try {
        res = await api.workflow.saveAgentProfile({ profile });
      } catch (err) {
        setProfileError((err as Error).message);
        return false;
      }
      if (!res.ok) {
        setProfileError(res.error ?? t("settings.workflows.profileSaveFailed"));
        return false;
      }
      await loadProfiles();
      return true;
    },
    [loadProfiles, t],
  );

  const removeProfile = useCallback(
    async (id: string) => {
      setProfileError(null);
      try {
        const res = await api.workflow.removeAgentProfile({ id });
        if (!res.ok) {
          setProfileError(t("settings.workflows.profileRemoveFailed"));
          return;
        }
      } catch (err) {
        setProfileError((err as Error).message);
        return;
      }
      await loadProfiles();
    },
    [loadProfiles, t],
  );

  return (
    <div className={cn("mx-auto flex h-full w-full min-h-0 flex-col", PANEL_MAX_W.canvas)}>
      <PanelHeader
        className="mb-3"
        icon={isAutomation ? IconBolt : IconArrowsSplit}
        title={t(isAutomation ? "settings.nav.automation" : "settings.nav.workflows")}
        action={
          // 段控而不是 Tab 组件:页签很少,不需要键盘方向键那套,而 SkillsPanel 的
          // 作用域选择器用的就是这个形状。ARIA 仍按真正的页签写 —— 下面那块是
          // `role="tabpanel"`。
          <div className="flex gap-1" role="tablist">
            {views.map((item) => {
              const active = item.id === view;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  id={tabId(prefix, item.id)}
                  aria-selected={active}
                  aria-controls={panelId(prefix, item.id)}
                  tabIndex={active ? 0 : -1}
                  onKeyDown={moveTabFocus}
                  onClick={() => chooseView(item.id)}
                  className={cn(
                    "rounded border px-2 py-1 text-[0.7857em] transition-colors",
                    active
                      ? "border-edge/80 bg-surface-hover font-medium text-content ring-1 ring-inset ring-edge/70"
                      : "border-edge bg-surface text-content-muted hover:bg-surface-hover/60 hover:text-content",
                  )}
                >
                  {t(isAutomation && item.id === "library" ? "settings.automation.tabLibrary" : item.labelKey)}
                </button>
              );
            })}
          </div>
        }
      />

      {/* ⚠️ 藏起来用 `hidden` **类**,不是 `hidden` **属性**。这个 div 同时带 `flex`,
          而 preflight 的 `[hidden]{display:none}` 与 `.flex` 同特异性、又排在 utilities
          之前 —— 属性会输,两块面板会一起显示。仓库里既有的做法就是类
          (见 `PluginsPanel` 的页签)。 */}
      <div
        id={panelId(prefix, "library")}
        role="tabpanel"
        aria-labelledby={tabId(prefix, "library")}
        className={cn("min-h-0 flex-1 flex-col", view === "library" ? "flex" : "hidden")}
      >
        {visitedLibrary && <>
        {/* Workflow and automation are categories of ONE library, not two
            copies of the editor or two navigation destinations. */}
        <div className="flex shrink-0 items-center gap-1 pb-2" role="group" aria-label={t("settings.nav.workflows")}>
          <Button size="sm" variant={libraryPurpose === "workflow" ? "secondary" : "ghost"}
            aria-pressed={libraryPurpose === "workflow"}
            onClick={() => setLibraryPurpose("workflow")}>
            {t("settings.nav.workflows")}
          </Button>
          <Button size="sm" variant={libraryPurpose === "automation" ? "secondary" : "ghost"}
            aria-pressed={libraryPurpose === "automation"}
            onClick={() => setLibraryPurpose("automation")}>
            {t("settings.nav.automation")}
          </Button>
        </div>
        <Suspense fallback={<div className="px-3 py-4 text-content-muted">{t("common.loading")}</div>}>
        <WorkflowLibraryView
          key={libraryPurpose}
          purpose={libraryPurpose}
          catalog={catalog}
          catalogError={catalogError}
          onRetryCatalog={() => void loadCatalog()}
          profiles={profiles}
          profileError={profileError}
          onSaveProfile={saveProfile}
          onRemoveProfile={removeProfile}
          focusWorkflowId={focusWorkflowId}
          onOpenNativeEditor={() => { setNativeCanvasEpoch(n => n + 1); chooseView("engines"); }}
        />
        </Suspense>
        </>}
      </div>
      {/* 节点类型与代理档案这两页只有工作流那边有(`views` 里已经筛掉了),所以这整块
          对自动化不渲染 —— 挂一棵永远 `hidden` 的子树没有意义。 */}
      {!isAutomation && (
        <>
          <div
            id={panelId(prefix, "nodeTypes")}
            role="tabpanel"
            aria-labelledby={tabId(prefix, "nodeTypes")}
            className={cn(
              "min-h-0 flex-1 overflow-y-auto pr-1",
              view === "nodeTypes" ? "block" : "hidden",
            )}
          >
            {visitedNodeTypes && <Suspense fallback={<div className="px-3 py-4 text-content-muted">{t("common.loading")}</div>}><NodeTypesView
              catalog={catalog}
              loading={catalogLoading}
              error={catalogError}
              onRefresh={() => void loadCatalog()}
            /></Suspense>}
          </div>
          {/* 代理档案是**自己的一页**(2026-09-20):它长得和节点类型那一页不一样 ——
              左边是分类、右边是这一类里的档案,而且右栏就地编辑。挤在节点类型下半部分
              时,档案一多就把说明书整个顶下去了。 */}
          <div
            id={panelId(prefix, "profiles")}
            role="tabpanel"
            aria-labelledby={tabId(prefix, "profiles")}
            className={cn("min-h-0 flex-1 flex-col", view === "profiles" ? "flex" : "hidden")}
          >
            {visitedProfiles && profilesRead.error && <ErrorNote className="mb-2" action={<Button size="sm" variant="secondary" onClick={() => void loadProfiles()}>{t("common.retry")}</Button>}>{profilesRead.error.message}</ErrorNote>}
            {visitedProfiles && (!profilesRead.error || profilesRead.data) && <Suspense fallback={<div className="px-3 py-4 text-content-muted">{t("common.loading")}</div>}><AgentProfilesView
              catalog={catalog}
              profiles={profiles}
              loading={profilesLoading}
              problems={profileProblems}
              error={profileMutationError}
              onSave={saveProfile}
              onRemove={removeProfile}
            /></Suspense>}
          </div>
        </>
      )}
      {/* One authenticated WebContentsView, shared by the two libraries. */}
      <div
        id={panelId(prefix, "engines")}
        role="tabpanel"
        aria-labelledby={tabId(prefix, "engines")}
        className={cn("min-h-0 flex-1 flex-col", view === "engines" ? "flex" : "hidden")}
      >
        {/* 【W15】有流停靠在右侧时，编辑器由右侧面板显示，本页的实例 active=false
            —— 从前这里是一块什么都画不出来的空白（`EngineRow` 的 stage div 占了
            整块，而 effects 早退、没人往里画）。现在把原因和动作摆出来：要么去
            右侧看，要么把它收回来（收回 = 清掉停靠位，本页立刻接管同一个视图）。 */}
        {flowDocked && (
          <div
            className="flex min-h-24 flex-1 flex-col items-center justify-center gap-2 rounded border border-dashed border-edge px-4 py-6 text-center text-[0.7857em] text-content-muted"
            data-engine-docked=""
          >
            <p>{t("settings.workflows.engine.dockedHint")}</p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                // 与右侧面板那个「×」（`layout.paneRestore`）走同一个 store action：
                // 清掉右栏的停靠内容 → `flowDocked` 变 false → 本页实例 active=true
                // 并 open/复用同一个 docId（视图从未关闭，只是换了宿主显示）。
                useSessionStore.getState().setLayoutPaneContent("right", undefined);
              }}
            >
              {t("settings.workflows.engine.dockedBringBack")}
            </Button>
          </div>
        )}
        <div className={cn("min-h-0 flex-1 flex-col", flowDocked ? "hidden" : "flex")}>
          <EngineRuntimePanel key={nativeCanvasEpoch} active={view === "engines" && !flowDocked} />
        </div>
      </div>
    </div>
  );
}

/** 页签与面板的 id —— 只在 `aria-controls` / `aria-labelledby` 里用,不参与样式。
 *  **带上前缀**:两个用途的面板各自挂在自己的设置页上,id 撞了就是同一份 DOM id
 *  出现两次(`PanelHeader` 之外还有别的地方按 id 找元素时会被第一个截胡)。 */
const tabId = (prefix: string, view: WorkflowsView): string => `${prefix}-tab-${view}`;
const panelId = (prefix: string, view: WorkflowsView): string => `${prefix}-panel-${view}`;

function moveTabFocus(event: React.KeyboardEvent<HTMLButtonElement>): void {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = Array.from(
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
  );
  if (tabs.length === 0) return;
  event.preventDefault();
  const current = Math.max(0, tabs.indexOf(event.currentTarget));
  const next = event.key === "Home" ? 0
    : event.key === "End" ? tabs.length - 1
    : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next]?.focus();
  tabs[next]?.click();
}
