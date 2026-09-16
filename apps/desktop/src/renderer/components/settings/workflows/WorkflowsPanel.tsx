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
 * ## 两个页签,一个 section
 *
 * - **工作流库**:六个内置 + 用户自建的。选中一个,中间是**画布**(加节点、拖动、
 *   连依赖),右边是检查器(选中节点就配那个节点,没选就配工作流本体)。
 * - **节点类型**:节点引用什么类型、每种类型要什么参数、哪些清单读不进来。
 *
 * 它们合成一个页签而不是两个设置项:节点类型是**工作流的底座**(没有类型就没有
 * 节点),而一个只读的底座列表不值得在设置导航里占一格。装插件那条路走的是
 * 「设置 → 插件」,这里只负责把"当前有什么"说清楚。
 *
 * ## 节点类型清单由**这一层**持有
 *
 * 两个页签都要它:画布的「添加节点」菜单要按类型列,检查器要按类型生成参数表单,
 * 节点类型那页要列来源。各读各的会让"点刷新"只刷新其中一处。所以在这里读一次、
 * 往下传 —— 顺带 `NodeTypesView` 变成一个纯展示组件(喂数据就能画,见冒烟脚本)。
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
 * 自动化那边**没有「节点类型」页签**:节点类型是节点的底座,两者用的是同一批类型,
 * 说明书放一份就够了(在工作流那一边)。
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { PANEL_MAX_W } from "../panelWidth.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { IconArrowsSplit, IconBolt } from "@renderer/lib/icons.js";
import type { AgentProfile, AgentProfileCatalog } from "@contracts/agentProfile";
import type { NodeTypeCatalog } from "@contracts/nodeType";
import { PanelHeader } from "../PanelHeader.js";
import { WorkflowLibraryView } from "./WorkflowLibraryView.js";
import { NodeTypesView } from "./NodeTypesView.js";
import type { WorkflowPurpose } from "./workflowView.js";

type WorkflowsView = "library" | "nodeTypes";

const VIEWS: ReadonlyArray<{ id: WorkflowsView; labelKey: MessageId }> = [
  { id: "library", labelKey: "settings.workflows.tabLibrary" },
  { id: "nodeTypes", labelKey: "settings.workflows.tabNodeTypes" },
];

export function WorkflowsPanel({ purpose }: { purpose: WorkflowPurpose }) {
  const { t } = useI18n();
  const [view, setView] = useState<WorkflowsView>("library");
  const isAutomation = purpose === "automation";
  // 自动化只有"库"这一个页签,而节点类型那一页的文案(「工作流库」)也不适用 ——
  // 所以页签集合是按用途筛出来的,不是写死两份。
  const views = isAutomation ? VIEWS.filter((v) => v.id === "library") : VIEWS;
  const prefix = isAutomation ? "automation" : "workflows";

  const [catalog, setCatalog] = useState<NodeTypeCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      setCatalog(await api.workflow.nodeTypes());
    } catch (err) {
      setCatalogError((err as Error).message);
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  /**
   * 代理档案。**在这一层读一次往下传**,和 `catalog` 同一个理由:画布(添加节点菜单)
   * 和节点类型那一页(档案列表)是同一份数据的两个消费者,而两个页签**同时挂载**
   * (靠 `hidden` 切换)—— 各自拉一次的话,在这一页存一份档案,另一页的列表就是旧的。
   */
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [profileProblems, setProfileProblems] = useState<AgentProfileCatalog["problems"]>([]);
  const [profileError, setProfileError] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
    try {
      const res = await api.workflow.agentProfiles();
      setProfiles(res.profiles);
      setProfileProblems(res.problems);
    } catch {
      // 档案是**附加**能力:拉不到不该让画布和类型清单一起打不开。
      setProfiles([]);
      setProfileProblems([]);
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const saveProfile = useCallback(
    async (profile: AgentProfile) => {
      setProfileError(null);
      let res: { ok: boolean; error?: string };
      try {
        res = await api.workflow.saveAgentProfile({ profile });
      } catch (err) {
        setProfileError((err as Error).message);
        return;
      }
      if (!res.ok) {
        setProfileError(res.error ?? t("settings.workflows.profileSaveFailed"));
        return;
      }
      await loadProfiles();
    },
    [loadProfiles, t],
  );

  const removeProfile = useCallback(
    async (id: string) => {
      setProfileError(null);
      try {
        await api.workflow.removeAgentProfile({ id });
      } catch (err) {
        setProfileError((err as Error).message);
        return;
      }
      await loadProfiles();
    },
    [loadProfiles],
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
                  onClick={() => setView(item.id)}
                  className={cn(
                    "rounded border px-2 py-1 text-[0.7857em] transition-colors",
                    active
                      ? "border-accent bg-accent/10 font-medium text-accent"
                      : "border-edge bg-surface text-content-muted hover:bg-surface-hover/60 hover:text-content",
                  )}
                >
                  {t(item.labelKey)}
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
      {/* 节点类型那一页只有工作流那边有(`views` 里已经筛掉了),所以这整块对自动化
          不渲染 —— 挂一棵永远 `hidden` 的子树没有意义。 */}
      {!isAutomation && (
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
            profiles={profiles}
            profileProblems={profileProblems}
            profileError={profileError}
            onSaveProfile={saveProfile}
            onRemoveProfile={removeProfile}
          />
        </div>
      )}
    </div>
  );
}

/** 页签与面板的 id —— 只在 `aria-controls` / `aria-labelledby` 里用,不参与样式。
 *  **带上前缀**:两个用途的面板各自挂在自己的设置页上,id 撞了就是同一份 DOM id
 *  出现两次(`PanelHeader` 之外还有别的地方按 id 找元素时会被第一个截胡)。 */
const tabId = (prefix: string, view: WorkflowsView): string => `${prefix}-tab-${view}`;
const panelId = (prefix: string, view: WorkflowsView): string => `${prefix}-panel-${view}`;
