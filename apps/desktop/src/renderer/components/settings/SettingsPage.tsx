import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import type { ProviderCapabilities } from "@contracts/provider";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { ThreePaneLayout } from "@renderer/components/layout/ThreePaneLayout.js";
import {
  IconSettings,
  IconPalette,
  IconKeyboard,
  IconRobot,
  IconSparkles,
  IconBell,
  IconBrandGit,
  IconTerminal2,
  IconWorld,
  IconCode,
  IconInfoCircle,
  IconChartBar,
  IconMicrophone,
  IconHandMove,
  IconPackage,
  IconPuzzle,
  IconActivity,
  IconArrowsSplit,
  IconBook,
  McpIcon,
  IconNotebook,
  IconAdjustmentsHorizontal,
  IconShieldLock,
  IconRocket,
  type TablerIconProps,
} from "@renderer/lib/icons.js";
import { Button, LoadingNote } from "@renderer/components/ui/index.js";
import { escapeClosesSettings } from "@renderer/components/ui/confirm-dialog.js";

/**
 * Every panel is its own lazy chunk (perf, 2026-09-28).
 *
 * Only the active panel is ever rendered, but these used to be static imports,
 * so opening settings for the first time had to fetch + evaluate ~6MB of JS
 * — mostly Monaco, dragged in through MemoryExplorerPanel → FileEditor /
 * monacoSetup — before even the "常规" tab could paint. Now the settings shell
 * is small, each panel loads when first shown, and after the shell mounts the
 * light panels are prefetched at idle so switching tabs stays instant. Heavy
 * panels (Monaco) are left to load on first use. `perf-startup-smoke` /
 * `settings-lazy-smoke` guard this.
 */
const PANEL_LOADERS = {
  CustomModelsPanel: () => import("./CustomModelsPanel.js"),
  DataRootPanel: () => import("./DataRootPanel.js"),
  LibraryTypesPanel: () => import("./LibraryTypesPanel.js"),
  CustomUiPanel: () => import("./CustomUiPanel.js"),
  RuntimesPanel: () => import("./RuntimesPanel.js"),
  SkillsPanel: () => import("./SkillsPanel.js"),
  WorkflowsPanel: () => import("./workflows/WorkflowsPanel.js"),
  HooksPanel: () => import("./HooksPanel.js"),
  GovernancePanel: () => import("./GovernancePanel.js"),
  McpPanel: () => import("./McpPanel.js"),
  AgentSshTrustPanel: () => import("./AgentSshTrustPanel.js"),
  EngineToolsPanel: () => import("./EngineToolsPanel.js"),
  PluginsPanel: () => import("./PluginsPanel.js"),
  ModuleSettingsPanel: () => import("../modules/ModuleContributions.js"),
  AppearancePanel: () => import("./AppearancePanel.js"),
  ShortcutsPanel: () => import("./ShortcutsPanel.js"),
  GesturesPanel: () => import("./GesturesPanel.js"),
  GeneralPanel: () => import("./GeneralPanel.js"),
  SettingsGitPanel: () => import("./SettingsGitPanel.js"),
  SettingsTerminalPanel: () => import("./SettingsTerminalPanel.js"),
  SettingsBrowserPanel: () => import("./SettingsBrowserPanel.js"),
  LspLanguagesPanel: () => import("./LspLanguagesPanel.js"),
  NotificationsPanel: () => import("./NotificationsPanel.js"),
  VoicePanel: () => import("./VoicePanel.js"),
  UsagePanel: () => import("./UsagePanel.js"),
  AboutPanel: () => import("./AboutPanel.js"),
  MonitoringPanel: () => import("../monitoring/MonitoringPanel.js"),
  MemoryExplorerPanel: () => import("../memory/MemoryExplorerPanel.js"),
};
type PanelName = keyof typeof PANEL_LOADERS;
/** Panels whose chunk pulls an editor engine: never prefetched in the background. */
const HEAVY_PANELS: ReadonlySet<PanelName> = new Set<PanelName>(["MemoryExplorerPanel"]);

/**
 * Warm panel chunks without rendering them. `names` defaults to every light
 * panel. Safe to call repeatedly (the module loader dedupes) and never throws —
 * a failed prefetch just means the panel loads (and reports) on first show.
 */
export function prefetchSettingsPanels(names?: readonly PanelName[]): void {
  const list = names ?? (Object.keys(PANEL_LOADERS) as PanelName[]).filter((n) => !HEAVY_PANELS.has(n));
  for (const n of list) void PANEL_LOADERS[n]().catch(() => undefined);
}

/** Run `fn` when the renderer is idle (falls back to a short timeout). */
function whenIdle(fn: () => void, timeout = 3000): () => void {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(fn, { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 200);
  return () => clearTimeout(id);
}

const CustomModelsPanel = lazy(() => PANEL_LOADERS.CustomModelsPanel().then((m) => ({ default: m.CustomModelsPanel })));
const DataRootPanel = lazy(() => PANEL_LOADERS.DataRootPanel().then((m) => ({ default: m.DataRootPanel })));
const LibraryTypesPanel = lazy(() => PANEL_LOADERS.LibraryTypesPanel().then((m) => ({ default: m.LibraryTypesPanel })));
const CustomUiPanel = lazy(() => PANEL_LOADERS.CustomUiPanel().then((m) => ({ default: m.CustomUiPanel })));
const RuntimesPanel = lazy(() => PANEL_LOADERS.RuntimesPanel().then((m) => ({ default: m.RuntimesPanel })));
const SkillsPanel = lazy(() => PANEL_LOADERS.SkillsPanel().then((m) => ({ default: m.SkillsPanel })));
const WorkflowsPanel = lazy(() => PANEL_LOADERS.WorkflowsPanel().then((m) => ({ default: m.WorkflowsPanel })));
const HooksPanel = lazy(() => PANEL_LOADERS.HooksPanel().then((m) => ({ default: m.HooksPanel })));
const GovernancePanel = lazy(() => PANEL_LOADERS.GovernancePanel().then((m) => ({ default: m.GovernancePanel })));
const McpPanel = lazy(() => PANEL_LOADERS.McpPanel().then((m) => ({ default: m.McpPanel })));
const AgentSshTrustPanel = lazy(() => PANEL_LOADERS.AgentSshTrustPanel().then((m) => ({ default: m.AgentSshTrustPanel })));
const EngineToolsPanel = lazy(() => PANEL_LOADERS.EngineToolsPanel().then((m) => ({ default: m.EngineToolsPanel })));
const PluginsPanel = lazy(() => PANEL_LOADERS.PluginsPanel().then((m) => ({ default: m.PluginsPanel })));
const ModuleSettingsPanel = lazy(() => PANEL_LOADERS.ModuleSettingsPanel().then((m) => ({ default: m.ModuleSettingsPanel })));
const AppearancePanel = lazy(() => PANEL_LOADERS.AppearancePanel().then((m) => ({ default: m.AppearancePanel })));
const ShortcutsPanel = lazy(() => PANEL_LOADERS.ShortcutsPanel().then((m) => ({ default: m.ShortcutsPanel })));
const GesturesPanel = lazy(() => PANEL_LOADERS.GesturesPanel().then((m) => ({ default: m.GesturesPanel })));
const GeneralPanel = lazy(() => PANEL_LOADERS.GeneralPanel().then((m) => ({ default: m.GeneralPanel })));
const SettingsGitPanel = lazy(() => PANEL_LOADERS.SettingsGitPanel().then((m) => ({ default: m.SettingsGitPanel })));
const SettingsTerminalPanel = lazy(() => PANEL_LOADERS.SettingsTerminalPanel().then((m) => ({ default: m.SettingsTerminalPanel })));
const SettingsBrowserPanel = lazy(() => PANEL_LOADERS.SettingsBrowserPanel().then((m) => ({ default: m.SettingsBrowserPanel })));
const LspLanguagesPanel = lazy(() => PANEL_LOADERS.LspLanguagesPanel().then((m) => ({ default: m.LspLanguagesPanel })));
const NotificationsPanel = lazy(() => PANEL_LOADERS.NotificationsPanel().then((m) => ({ default: m.NotificationsPanel })));
const VoicePanel = lazy(() => PANEL_LOADERS.VoicePanel().then((m) => ({ default: m.VoicePanel })));
const UsagePanel = lazy(() => PANEL_LOADERS.UsagePanel().then((m) => ({ default: m.UsagePanel })));
const AboutPanel = lazy(() => PANEL_LOADERS.AboutPanel().then((m) => ({ default: m.AboutPanel })));
const MonitoringPanel = lazy(() => PANEL_LOADERS.MonitoringPanel().then((m) => ({ default: m.MonitoringPanel })));
const MemoryExplorerPanel = lazy(() => PANEL_LOADERS.MemoryExplorerPanel().then((m) => ({ default: m.MemoryExplorerPanel })));

/** Suspense fallback: stays blank for fast (prefetched) loads, spins only if it drags. */
function PanelLoading() {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShow(true), 150);
    return () => clearTimeout(id);
  }, []);
  if (!show) return null;
  return <LoadingNote label={t("common.loading")} className="py-10" />;
}

/**
 * Settings page with a left functional menu + right content panel layout.
 *
 * Rendered as a sibling view to the workspace (toggled by `settingsOpen` in
 * the session store). Reuses the same ThreePaneLayout shell as the main
 * workspace - the only difference is the right sidebar is collapsed and the
 * left sidebar hosts the settings navigation instead of the project tree.
 *
 * The nav is grouped into 5 labeled clusters (通用 → AI 能力 → 输入与提醒 →
 * 工作台 → 系统) so the flat list of panels doesn't read as one undifferentiated
 * wall; the group eyebrow is inert (not selectable). Deep links via
 * `setSettingsOpen(true, sectionId)` still address individual items.
 *
 * Note: the legacy “Claude CLI 路径” panel was removed - the Agent SDK bundles
 * its own claude binary, so an externally-configured path is no longer used.
 */
type SectionId = "general" | "library-types" | "custom-ui" | "runtimes" | "custom-models" | "skills" | "workflows" | "automation" | "hooks" | "scene-deploy" | "mcp" | "agent-ssh" | "engine-tools" | "memory" | "plugins" | "extension-settings" | "appearance" | "shortcuts" | "gestures" | "voice" | "notifications" | "git" | "terminal" | "browser" | "lsp-languages" | "monitoring" | "usage" | "about";

interface NavItem {
  id: SectionId;
  labelKey: MessageId;
  icon: ComponentType<TablerIconProps>;
  /** Capability gate: the item renders only when some provider declares it
   *  (undefined = always shown). Keeps an engine-specific page from reading as
   *  a broken entry when no engine can serve it.
   *
   *  ⚠️ **眼下没有一个条目用它** —— 唯一那个(子代理页)2026-09-20 删了。留着是因为
   *  它是这个导航的通用机制(下面的滤逻辑还在),而不是哪一页的私货。 */
  requiresCapability?: (caps: ProviderCapabilities) => boolean;
}

interface NavGroup {
  labelKey: MessageId;
  items: NavItem[];
}

/** Settings nav sidebar width (px). Fixed — the workspace sidebar is now a
 *  percentage of the window (leftWidthPct) and no longer shares a width with
 *  the titlebar's retired left strip, so there's nothing to stay aligned
 *  with. 240px keeps labels comfortable while giving the content column (the
 *  main stage) as much room as possible. */
const SETTINGS_NAV_WIDTH = 240;

const NAV_GROUPS: NavGroup[] = [
  // 【ARC-005 V2】导航分组按台账要求重组为「常用 / 引擎 / 文档 / 扩展 / 系统」。
  // 原来的五组（通用/AI 能力/输入与提醒/工作台/系统）保留全部条目与顺序，
  // 只把归属改成用户找东西时的心智模型：
  //   · 常用 —— 每次开局都会动的三页（常规、外观、输入与提醒）；
  //   · 引擎 —— 三家 SDK、模型、工具面与记忆；
  //   · 文档 —— 资料库、自定义 UI、Git/终端/浏览器/LSP、工作流与自动化；
  //   · 扩展 —— 插件、技能、MCP、钩子；
  //   · 系统 —— 场景部署、监控、用量、关于。
  {
    labelKey: "settings.navGroup.common",
    items: [
      { id: "general", labelKey: "settings.nav.general", icon: IconSettings },
      { id: "appearance", labelKey: "settings.nav.appearance", icon: IconPalette },
      { id: "voice", labelKey: "settings.nav.voice", icon: IconMicrophone },
      { id: "shortcuts", labelKey: "settings.nav.shortcuts", icon: IconKeyboard },
      { id: "gestures", labelKey: "settings.nav.gestures", icon: IconHandMove },
      { id: "notifications", labelKey: "settings.nav.notifications", icon: IconBell },
    ],
  },
  {
    labelKey: "settings.navGroup.engine",
    items: [
      { id: "custom-models", labelKey: "settings.nav.customModels", icon: IconRobot },
      { id: "runtimes", labelKey: "settings.nav.runtimes", icon: IconPackage },
      { id: "engine-tools", labelKey: "settings.nav.engineTools", icon: IconAdjustmentsHorizontal },
      { id: "memory", labelKey: "settings.nav.memory", icon: IconNotebook },
    ],
  },
  {
    labelKey: "settings.navGroup.extensions",
    items: [
      { id: "plugins", labelKey: "settings.nav.plugins", icon: IconPuzzle },
      { id: "extension-settings", labelKey: "settings.nav.extensionSettings", icon: IconAdjustmentsHorizontal },
      { id: "skills", labelKey: "settings.nav.skills", icon: IconSparkles },
      // 钩子与自动化同属"什么时候跑"，但钩子不属于任何一张图，对每次对话/节点
      // 都生效；它跟着扩展走（由插件/用户脚本提供），因此留在本组。
      { id: "hooks", labelKey: "settings.nav.hooks", icon: IconActivity },
      { id: "mcp", labelKey: "settings.nav.mcp", icon: McpIcon },
      // 远程主机信任紧跟 MCP:两者都在回答"这台机器愿意把凭据交给谁"。SSH 首连的
      // 主机指纹审批从前没有界面入口(MC-014/MC-052 的洞),这一页就是那扇门。
      { id: "agent-ssh", labelKey: "settings.nav.agentSsh", icon: IconShieldLock },
    ],
  },
  {
    labelKey: "settings.navGroup.docs",
    items: [
      // 工作流与自动化共用一套工作台：画布、数据与 Node-RED 执行器唯一；
      // 自动化只是工作流库中的类型，旧深链仍能进入这个入口。
      // One workflow surface. Automation is a library category (same native
      // Node-RED process/canvas), not a second settings destination.
      { id: "workflows", labelKey: "settings.nav.workflows", icon: IconArrowsSplit },
      // 数据根与资料库设置合并在同一个入口;入口名保留「文档管理」,内容先显示
      // 数据位置,再配置文档如何供 AI 使用。旧 data-root 深链在初始化时映射到这里。
      { id: "library-types", labelKey: "settings.nav.libraryTypes", icon: IconBook },
      // 自定义 UI 紧跟文档管理:资料库右键菜单的功能项、Files 文件右键都在这里配置
      // (主界面只放入口,点了做什么、显示什么在这一页定义)。
      { id: "custom-ui", labelKey: "customUi.nav", icon: IconAdjustmentsHorizontal },
      { id: "git", labelKey: "settings.nav.git", icon: IconBrandGit },
      { id: "terminal", labelKey: "settings.nav.terminal", icon: IconTerminal2 },
      { id: "browser", labelKey: "settings.nav.browser", icon: IconWorld },
      { id: "lsp-languages", labelKey: "settings.nav.lsp", icon: IconCode },
    ],
  },
  {
    labelKey: "settings.navGroup.system",
    items: [
      // 运行监控排在用量前面:两者都是"看系统发生了什么"(用量看花了多少 token,
      // 监控看自动化跑了成什么样),放一组,先看跑得怎么样、再看花销。
      // 场景部署排在最后:它把前面那些块(工作流/钩子/MCP/技能…)作为**一份声明**整体建出来,
      // 是这一整组能力的"合拢"入口 —— 排在能看见那些块的页面之后,顺序才对得上。
      { id: "scene-deploy", labelKey: "sceneDeploy.nav", icon: IconRocket },
      { id: "monitoring", labelKey: "settings.nav.monitoring", icon: IconActivity },
      { id: "usage", labelKey: "settings.nav.usage", icon: IconChartBar },
      { id: "about", labelKey: "settings.nav.about", icon: IconInfoCircle },
    ],
  },
];

/** Flat nav items (group order preserved) — used to validate deep-link ids. */
const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export function SettingsPage() {
  const { t } = useI18n();
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  // Capability-gated nav items (子代理 etc.) read the provider list — present
  // after the initial PROVIDER_LIST round-trip, empty on first paint (items
  // then blink in; harmless).
  const providers = useSessionStore((s) => s.providers);
  // SettingsPage mounts fresh each time the modal opens (App.tsx conditionally
  // renders it on `settingsOpen`), so this useState reads the requested
  // section once per open. Callers pass a section via setSettingsOpen(true, id)
  // — e.g. the composer's "管理模型…" entry targets "custom-models".
  // A plain gear click (no section) lands on the first nav item ("常规") — the
  // default must NOT be "custom-models", or every plain open would jump to
  // the model-config tab.
  const settingsSection = useSessionStore((s) => s.settingsSection);
  // Existing callers or an already-open settings state may still request the
  // retired data-root id; keep that deep link landing on the merged tab.
  // ⚠️ **`"office"` 也是同一种遗留 id** —— 它曾是 `OnlyOfficeEditorPane` 三处
  // 「打开设置」的深链目标（OnlyOffice 已于 O5 批三删除，不再有发起方）。保留映射
  // 只为**已持久化的旧设置状态**：不映射的话那些旧值会回落到 `NAV_ITEMS[0]`（常规），
  // 与用户上一步看到的栏目对不上。
  const requestedSection =
    settingsSection === "automation" ? "workflows"
    : settingsSection === "data-root"
      ? "library-types"
      : settingsSection === "office"
        ? "runtimes"
        : settingsSection;
  // Preserve existing automations deep links without mounting a second copy
  // of WorkflowsPanel. Navigating to the single entry selects the canvas.
  const [workflowCategory, setWorkflowCategory] = useState<"workflow" | "automation">(
    settingsSection === "automation" ? "automation" : "workflow",
  );
  const [active, setActive] = useState<SectionId>(
    () =>
      (requestedSection && NAV_ITEMS.some((n) => n.id === requestedSection)
        ? requestedSection
        : NAV_ITEMS[0].id) as SectionId,
  );

  // 【MC-045】设置页**已打开**时来的深链(跨面板跳转 / Agent 指定栏目)必须当场
  // 切过去 —— 从前 `active` 只在首次挂载读一次 `settingsSection`,已打开时再调
  // `setSettingsOpen(true, "workflows")` 只改 Store,左侧高亮和内容都停在原栏目
  // (台账红例)。修订号变化 = 一次**新**导航请求:消费它、切 `active`。
  // 手动点导航**不**递增修订号,所以这条 effect 不会把用户的手动选择弹回去;
  // 用户手动切走后旧请求(同修订号)也不会重放 —— 它已经消费过了。
  const settingsNavRevision = useSessionStore((s) => s.settingsNavRevision);
  useEffect(() => {
    if (!settingsNavRevision) return;
    const section = useSessionStore.getState().settingsSection;
    const mapped =
      section === "automation" ? "workflows"
      : section === "data-root" ? "library-types" : section === "office" ? "runtimes" : section;
    if (section === "automation" || section === "workflows") {
      setWorkflowCategory(section === "automation" ? "automation" : "workflow");
    }
    if (mapped && NAV_ITEMS.some((n) => n.id === mapped)) {
      setActive(mapped as SectionId);
    } else if (mapped) {
      // 过期/非法 section(如已退役的 id):显式回退到首项并留下诊断 —— 不静默
      // 停在没有对应内容的旧栏目上。
      console.warn(`settings: 未知的深链栏目 "${mapped}",回退到「${NAV_ITEMS[0].id}」`);
      setActive(NAV_ITEMS[0].id);
    }
  }, [settingsNavRevision]);

  // Esc returns to the workspace (preserves the modal's keyboard shortcut) —
  // but only when no nested overlay owns Escape (UI-005, see escapeClosesSettings).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && escapeClosesSettings(e)) setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSettingsOpen]);

  // Warm the other light panels once the shell has painted, so tab switches
  // don't wait on a chunk load. Heavy (editor) panels still load on first use.
  useEffect(() => whenIdle(() => prefetchSettingsPanels()), []);

  return (
    <ThreePaneLayout
      left={
        <nav
          data-settings-nav=""
          className="h-full min-h-0 overflow-y-auto border-r border-edge bg-surface-muted px-3 py-4"
          style={{ fontSize: "var(--right-panel-font-size)" }}
        >
          {NAV_GROUPS.map((group, gi) => (
            <div key={group.labelKey} className={gi === 0 ? "pb-1" : "border-t border-edge/60 pb-1 pt-3 mt-3"}>
              <div className="px-3 pb-2 text-[length:var(--chat-fs-xxs)] font-semibold uppercase tracking-[0.08em] text-content-subtle">
                {t(group.labelKey)}
              </div>
              <div className="space-y-0.5">
                {group.items
                  .filter(
                    (item) =>
                      !item.requiresCapability ||
                      providers.some((p) => item.requiresCapability!(p.capabilities)),
                  )
                  .map((item) => {
                  const isActive = item.id === active;
                  const Icon = item.icon;
                  return (
                    <Button
                      key={item.id}
                      type="button"
                      variant="ghost"
                      size="md"
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => {
                        if (item.id === "workflows") setWorkflowCategory("workflow");
                        setActive(item.id);
                      }}
                      // 【ARC-005 V2】导航项改用 CDS 控件档圆角与 32px 行高，
                      // 与侧栏会话行、分段控件同一密度；激活态保留左侧 accent 竖条
                      // （颜色之外的第二个可辨信号）。
                      className={cn(
                        "relative flex h-9 w-full items-center justify-start gap-2 rounded-[var(--radius-btn-md)] px-3 text-left text-[length:var(--chat-fs-xs)] transition-colors",
                        isActive
                          ? "bg-surface-muted font-semibold text-content"
                          : "text-content-muted hover:text-content",
                      )}
                    >
                      {isActive && (
                        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                      )}
                      <Icon
                        size={16}
                        className={cn(
                          "shrink-0",
                          isActive ? "text-accent" : "text-content-subtle",
                        )}
                      />
                      {t(item.labelKey)}
                    </Button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      }
      center={
        <div
          // `h-full` (not flex-1) is required here: the parent in
          // ThreePaneLayout is a non-flex `overflow-hidden` box, so `flex-1`
          // was inert and this wrapper fell back to content height. That broke
          // the height chain — child panels using `h-full` couldn't resolve,
          // their internal `overflow-y-auto` regions never scrolled, and tall
          // content (e.g. a long skill list) pushed the bottom "新建" button
          // off-screen (clipped by the outer overflow-hidden). h-full makes this
          // wrapper a definite height so child panels fill it and scroll
          // internally; overflow-y-auto still lets non-internal-scroll panels
          // (Git/Terminal/About) scroll when their content is tall.
          //
          // NO top padding: Chromium anchors a `sticky top-0` child below the
          // scroll container's padding-top, so a `py-5` here left a 20px strip
          // above the stuck PanelHeader where scrolling content showed through.
          // The initial 20px gap comes from PanelHeader's own `mt-5` instead —
          // a sticky element's self-margin positions it at rest but does not
          // offset where it sticks.
          data-settings-content=""
          className="min-h-0 h-full overflow-y-auto bg-surface px-6 pb-5"
          style={{ fontSize: "var(--right-panel-font-size)" }}
        >
          <Suspense key={active} fallback={<PanelLoading />}>
            {active === "general" && <GeneralPanel />}
            {active === "appearance" && <AppearancePanel />}
            {active === "custom-models" && <CustomModelsPanel />}
            {active === "library-types" && (
              <>
                <DataRootPanel />
                <LibraryTypesPanel />
              </>
            )}
            {active === "custom-ui" && <CustomUiPanel />}
            {active === "shortcuts" && <ShortcutsPanel />}
            {active === "gestures" && <GesturesPanel />}
            {active === "voice" && <VoicePanel />}
            {active === "skills" && <SkillsPanel />}
            {active === "workflows" && <WorkflowsPanel purpose="workflow" initialLibraryPurpose={workflowCategory} />}
            {active === "hooks" && <HooksPanel />}
            {/* 【MC-001】同一个治理视图:场景部署 + 无人值守任务计划(后端全通却没入口的那条) ——
                两半共用「计划 → 批准(绑正文)→ 执行(只递 grantId)」的心算模型,挂在一起用户学一次就够。 */}
            {active === "scene-deploy" && <GovernancePanel />}
            {active === "runtimes" && <RuntimesPanel />}
            {active === "mcp" && <McpPanel />}
            {active === "agent-ssh" && <AgentSshTrustPanel />}
            {active === "engine-tools" && <EngineToolsPanel />}
            {active === "memory" && <MemoryExplorerPanel />}
            {active === "plugins" && <PluginsPanel />}
            {active === "extension-settings" && <ModuleSettingsPanel />}
            {active === "notifications" && <NotificationsPanel />}
            {active === "git" && <SettingsGitPanel />}
            {active === "terminal" && <SettingsTerminalPanel />}
            {active === "browser" && <SettingsBrowserPanel />}
            {active === "lsp-languages" && <LspLanguagesPanel />}
            {active === "monitoring" && <MonitoringPanel />}
            {active === "usage" && <UsagePanel />}
            {active === "about" && <AboutPanel />}
          </Suspense>
        </div>
      }
      right={null}
      leftOpen
      rightOpen={false}
      leftWidth={SETTINGS_NAV_WIDTH}
    />
  );
}
