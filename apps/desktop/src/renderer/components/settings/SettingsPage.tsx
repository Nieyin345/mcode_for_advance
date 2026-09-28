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
  IconBolt,
  IconBook,
  IconShieldCheck,
  McpIcon,
  IconNotebook,
  IconAdjustmentsHorizontal,
  type TablerIconProps,
} from "@renderer/lib/icons.js";
import { IconLoader2 } from "@renderer/lib/icons.js";

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
  InstitutionAuthPanel: () => import("./InstitutionAuthPanel.js"),
  DataRootPanel: () => import("./DataRootPanel.js"),
  LibraryTypesPanel: () => import("./LibraryTypesPanel.js"),
  CustomUiPanel: () => import("./CustomUiPanel.js"),
  RuntimesPanel: () => import("./RuntimesPanel.js"),
  SkillsPanel: () => import("./SkillsPanel.js"),
  WorkflowsPanel: () => import("./workflows/WorkflowsPanel.js"),
  HooksPanel: () => import("./HooksPanel.js"),
  McpPanel: () => import("./McpPanel.js"),
  PluginsPanel: () => import("./PluginsPanel.js"),
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
const InstitutionAuthPanel = lazy(() => PANEL_LOADERS.InstitutionAuthPanel().then((m) => ({ default: m.InstitutionAuthPanel })));
const DataRootPanel = lazy(() => PANEL_LOADERS.DataRootPanel().then((m) => ({ default: m.DataRootPanel })));
const LibraryTypesPanel = lazy(() => PANEL_LOADERS.LibraryTypesPanel().then((m) => ({ default: m.LibraryTypesPanel })));
const CustomUiPanel = lazy(() => PANEL_LOADERS.CustomUiPanel().then((m) => ({ default: m.CustomUiPanel })));
const RuntimesPanel = lazy(() => PANEL_LOADERS.RuntimesPanel().then((m) => ({ default: m.RuntimesPanel })));
const SkillsPanel = lazy(() => PANEL_LOADERS.SkillsPanel().then((m) => ({ default: m.SkillsPanel })));
const WorkflowsPanel = lazy(() => PANEL_LOADERS.WorkflowsPanel().then((m) => ({ default: m.WorkflowsPanel })));
const HooksPanel = lazy(() => PANEL_LOADERS.HooksPanel().then((m) => ({ default: m.HooksPanel })));
const McpPanel = lazy(() => PANEL_LOADERS.McpPanel().then((m) => ({ default: m.McpPanel })));
const PluginsPanel = lazy(() => PANEL_LOADERS.PluginsPanel().then((m) => ({ default: m.PluginsPanel })));
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
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShow(true), 150);
    return () => clearTimeout(id);
  }, []);
  if (!show) return null;
  return (
    <div className="flex justify-center py-10 text-content-subtle">
      <IconLoader2 size={18} className="animate-spin" />
    </div>
  );
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
type SectionId = "general" | "library-types" | "custom-ui" | "runtimes" | "custom-models" | "institution" | "skills" | "workflows" | "automation" | "hooks" | "mcp" | "memory" | "plugins" | "appearance" | "shortcuts" | "gestures" | "voice" | "notifications" | "git" | "terminal" | "browser" | "lsp-languages" | "monitoring" | "usage" | "about";

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
  {
    labelKey: "settings.navGroup.general",
    items: [
      { id: "general", labelKey: "settings.nav.general", icon: IconSettings },
      { id: "appearance", labelKey: "settings.nav.appearance", icon: IconPalette },
    ],
  },
  {
    labelKey: "settings.navGroup.ai",
    items: [
      { id: "custom-models", labelKey: "settings.nav.customModels", icon: IconRobot },
      { id: "runtimes", labelKey: "settings.nav.runtimes", icon: IconPackage },
      { id: "plugins", labelKey: "settings.nav.plugins", icon: IconPuzzle },
      { id: "skills", labelKey: "settings.nav.skills", icon: IconSparkles },
      // 自定义子代理那一页**删掉了**(2026-09-20,用户定的):它和「工作流 →
      // 代理档案」是同一件事的两个入口 —— 那边现在能按节点类型分类地新建/编辑档案,
      // 覆盖面比这一页宽。同一个东西两个地方改,迟早出现"这边改了那边没变"。
      //
      // ⚠️ **能力还在,只是没了界面入口。** Claude provider 的 `Options.agents`
      // 照样被主进程读(那一条在 provider 里,与这一页无关);用户自己写在
      // `~/.claude/agents/` 下的子代理也不受影响 —— 那些从来就不经过这一页。
      // 被删掉的只有"在这个框里手写一份、存进数据根"那条路。
      //
      // 工作流紧挨着技能:两者都在回答"AI 按什么做事"(技能是动词,工作流是流程),
      // 而节点类型由插件带来 —— 再往下一格就是插件。
      { id: "workflows", labelKey: "settings.nav.workflows", icon: IconArrowsSplit },
      // 自动化紧跟工作流:同一张图、同一个编辑器,差别只在**谁把它跑起来**
      // (工作流跟着对话跑,自动化等一个事件)。排在一起,这个关系才看得出来 ——
      // 隔着几格的话,"这两个页有什么关系"就得靠读文档回答了。
      { id: "automation", labelKey: "settings.nav.automation", icon: IconBolt },
      // 钩子跟在自动化后面:它们回答的都是"**什么时候**跑",而不是"跑什么"。
      // 钩子比自动化更靠外一层 —— 它不属于任何一张图,对每一次对话、每一个工作流
      // 节点都生效(见 `@contracts/hook`)。
      { id: "hooks", labelKey: "settings.nav.hooks", icon: IconActivity },
      { id: "mcp", labelKey: "settings.nav.mcp", icon: McpIcon },
      { id: "memory", labelKey: "settings.nav.memory", icon: IconNotebook },
    ],
  },
  {
    labelKey: "settings.navGroup.input",
    items: [
      { id: "voice", labelKey: "settings.nav.voice", icon: IconMicrophone },
      { id: "shortcuts", labelKey: "settings.nav.shortcuts", icon: IconKeyboard },
      { id: "gestures", labelKey: "settings.nav.gestures", icon: IconHandMove },
      { id: "notifications", labelKey: "settings.nav.notifications", icon: IconBell },
    ],
  },
  {
    labelKey: "settings.navGroup.workbench",
    items: [
      // 数据根与资料库设置合并在同一个入口;入口名保留「文档管理」,内容先显示
      // 数据位置,再配置文档如何供 AI 使用。旧 data-root 深链在初始化时映射到这里。
      { id: "library-types", labelKey: "settings.nav.libraryTypes", icon: IconBook },
      // 自定义 UI 紧跟文档管理:资料库右键菜单的功能项、Files 文件右键都在这里配置
      // (主界面只放入口,点了做什么、显示什么在这一页定义)。
      { id: "custom-ui", labelKey: "customUi.nav", icon: IconAdjustmentsHorizontal },
      // 机构认证归在「工作台」组:它是使用场景(下载文献要先登录),
      // 不是 AI 配置,放 ai 组会让人以为是模型相关设置。
      { id: "institution", labelKey: "settings.nav.institution", icon: IconShieldCheck },
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
  const requestedSection = settingsSection === "data-root" ? "library-types" : settingsSection;
  const [active, setActive] = useState<SectionId>(
    () =>
      (requestedSection && NAV_ITEMS.some((n) => n.id === requestedSection)
        ? requestedSection
        : NAV_ITEMS[0].id) as SectionId,
  );

  // Esc returns to the workspace (preserves the modal's keyboard shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
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
          className="px-2 py-3"
          style={{ fontSize: "var(--right-panel-font-size)" }}
        >
          {NAV_GROUPS.map((group, gi) => (
            <div key={group.labelKey} className={gi === 0 ? "pb-1" : "pb-1 pt-4"}>
              <div className="px-3 pb-1 text-[0.7143em] font-medium uppercase tracking-wider text-content-subtle">
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
                    <button
                      key={item.id}
                      onClick={() => setActive(item.id)}
                      className={cn(
                        "relative flex w-full items-center gap-2 rounded px-3 py-2 text-left transition-colors",
                        isActive
                          ? "bg-surface-hover font-medium text-content"
                          : "text-content-muted hover:bg-surface-hover hover:text-content",
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
                    </button>
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
          className="min-h-0 h-full overflow-y-auto px-6 pb-5"
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
            {active === "institution" && <InstitutionAuthPanel />}
            {active === "shortcuts" && <ShortcutsPanel />}
            {active === "gestures" && <GesturesPanel />}
            {active === "voice" && <VoicePanel />}
            {active === "skills" && <SkillsPanel />}
            {active === "workflows" && <WorkflowsPanel purpose="workflow" />}
            {active === "automation" && <WorkflowsPanel purpose="automation" />}
            {active === "hooks" && <HooksPanel />}
            {active === "runtimes" && <RuntimesPanel />}
            {active === "mcp" && <McpPanel />}
            {active === "memory" && <MemoryExplorerPanel />}
            {active === "plugins" && <PluginsPanel />}
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
