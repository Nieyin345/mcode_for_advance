/**
 * 设置 → 工作流。
 *
 * ## 这一页面朝谁
 *
 * 面朝**流程的作者**,也就是用户自己。原来的「对话模式」在
 * `main/lib/systemPrompt.ts` 里写死,只有改代码才能动;这一页把同一批流程变成用户
 * 能读、能改、能画的东西 —— 这正是整个功能存在的理由(见方案:模型拿到技能之后仍然
 * 在"一步步试",根因是流程没有固化)。
 *
 * ## 三个页签,一个 section
 *
 * - **工作流库**:六个内置 + 用户自建的。选中一个,中间是**画布**(加节点、拖动、
 *   连依赖),右边是检查器(选中节点就配那个节点,没选就配工作流本体)。
 * - **节点类型**:节点引用什么类型、每种类型要什么参数、哪些清单读不进来。
 * - **代理档案**:存下来的那几份配置**,按节点类型分成组** —— 每个类型一组、每组下面
 *   是那个类型的档案,点开就能改(见 `AgentProfilesView` 的新文件头)。
 *
 * 它们合成一个页签而不是三个设置项:节点类型是**工作流的底座**(没有类型就没有
 * 节点),档案是"某个类型的一组参数"(没有类型就没有档案)—— 三者是同一条线上的
 * 三段,拆成三个设置项之后每换一页都要重新找自己在哪。装插件那条路走的是
 * 「设置 → 插件」,这里只负责把"当前有什么"说清楚。
 *
 * ## 节点类型清单与档案列表由**这一层**持有
 *
 * 三个页签都要它们:画布的「添加节点」菜单要按类型列、按档案建节点,检查器要按类型
 * 生成参数表单、按档案套用,节点类型那页要列来源,档案那页要按类型分组。各读各的会让
 * "点刷新"只刷新其中一处。所以在这里读一次、往下传 —— 顺带 `NodeTypesView` 与
 * `AgentProfilesView` 都变成纯展示组件(喂数据就能画,见冒烟脚本)。
 *
 * ## 档案在**打开这一页时**就取一次,不必先点进那个页签
 *
 * 三个页签同时挂载(靠 `hidden` 切换),所以这句话不是为了省一次渲染 —— 是为了让
 * "这一页里存了一份档案"这件事在页签之间**立刻**一致。把取数挪进页签里就等于说
 * "你先点它一下才有数据",而用户点它的那一刻看到的会是空列表再闪一下。
 *
 * ⚠️ 这里**不嵌 `ThreePaneLayout`** —— 它已经是设置页的窗口级外壳,面板内部要自己
 * 写 flex/grid(与 SkillsPanel / 模型配置同一形状:`h-full` + 内部各自滚动)。
 *
 * ## 同一个面板,两种用途(工作流 / 自动化)
 *
 * `purpose` 这一个参数决定了标题、图标、页签数量,以及库视图列哪些东西。两者**共用
 * 同一份数据、同一个编辑器**,差别只在"谁把它跑起来"(见 `@contracts/workflow`)——
 * 所以不是一个新面板,而是这个面板的另一种用法。
 *
 * 自动化那边**没有「节点类型」和「代理档案」页签**:节点类型是节点的底座,两者用的是
 * 同一批类型,说明书放一份就够了(在工作流那一边);而自动化那一页根本画不出档案能套
 * 的节点(它的起点是触发器)。
 */
import { useCallback, useMemo, useState } from "react";
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
import { WorkflowLibraryView } from "./WorkflowLibraryView.js";
import { NodeTypesView } from "./NodeTypesView.js";
import { AgentProfilesView } from "./AgentProfilesView.js";
import type { WorkflowPurpose } from "./workflowView.js";

type WorkflowsView = "library" | "nodeTypes" | "profiles";

const VIEWS: ReadonlyArray<{ id: WorkflowsView; labelKey: MessageId }> = [
  { id: "library", labelKey: "settings.workflows.tabLibrary" },
  { id: "nodeTypes", labelKey: "settings.workflows.tabNodeTypes" },
  { id: "profiles", labelKey: "settings.workflows.tabProfiles" },
];

export function WorkflowsPanel({ purpose }: { purpose: WorkflowPurpose }) {
  const { t } = useI18n();
  const [view, setView] = useState<WorkflowsView>("library");
  const isAutomation = purpose === "automation";
  // 自动化只有"库"这一个页签,而另外两页的文案(「工作流库」)也不适用 ——
  // 所以页签集合是按用途筛出来的,不是写死两份。
  const views = isAutomation ? VIEWS.filter((v) => v.id === "library") : VIEWS;
  const prefix = isAutomation ? "automation" : "workflows";

  const catalogRead = useRpc(() => api.workflow.nodeTypes(), [], { toastOnError: false });
  const profilesRead = useRpc(() => api.workflow.agentProfiles(), [], { toastOnError: false });
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
                  onClick={() => setView(item.id)}
                  className={cn(
                    "rounded border px-2 py-1 text-[0.7857em] transition-colors",
                    active
                      ? "border-accent bg-accent/10 font-medium text-accent"
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
        <WorkflowLibraryView
          purpose={purpose}
          catalog={catalog}
          catalogError={catalogError}
          onRetryCatalog={() => void loadCatalog()}
          profiles={profiles}
          profileError={profileError}
          onSaveProfile={saveProfile}
          onRemoveProfile={removeProfile}
        />
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
            <NodeTypesView
              catalog={catalog}
              loading={catalogLoading}
              error={catalogError}
              onRefresh={() => void loadCatalog()}
            />
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
            {profilesRead.error && <ErrorNote className="mb-2" action={<Button size="sm" variant="secondary" onClick={() => void loadProfiles()}>{t("common.retry")}</Button>}>{profilesRead.error.message}</ErrorNote>}
            {(!profilesRead.error || profilesRead.data) && <AgentProfilesView
              catalog={catalog}
              profiles={profiles}
              loading={profilesLoading}
              problems={profileProblems}
              error={profileMutationError}
              onSave={saveProfile}
              onRemove={removeProfile}
            />}
          </div>
        </>
      )}
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
