import { useEffect, useState, type ComponentType } from "react";
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
  IconDatabase,
  IconBook,
  IconShieldCheck,
  McpIcon,
  IconNotebook,
  type TablerIconProps,
} from "@renderer/lib/icons.js";
import { CustomModelsPanel } from "./CustomModelsPanel.js";
import { InstitutionAuthPanel } from "./InstitutionAuthPanel.js";
import { DataRootPanel } from "./DataRootPanel.js";
import { RuntimesPanel } from "./RuntimesPanel.js";
import { SkillsPanel } from "./SkillsPanel.js";
import { WorkflowsPanel } from "./workflows/WorkflowsPanel.js";
import { HooksPanel } from "./HooksPanel.js";
import { McpPanel } from "./McpPanel.js";
import { PluginsPanel } from "./PluginsPanel.js";
import { AppearancePanel } from "./AppearancePanel.js";
import { ShortcutsPanel } from "./ShortcutsPanel.js";
import { GesturesPanel } from "./GesturesPanel.js";
import { GeneralPanel } from "./GeneralPanel.js";
import { SettingsGitPanel } from "./SettingsGitPanel.js";
import { SettingsTerminalPanel } from "./SettingsTerminalPanel.js";
import { SettingsBrowserPanel } from "./SettingsBrowserPanel.js";
import { LspLanguagesPanel } from "./LspLanguagesPanel.js";
import { NotificationsPanel } from "./NotificationsPanel.js";
import { VoicePanel } from "./VoicePanel.js";
import { UsagePanel } from "./UsagePanel.js";
import { AboutPanel } from "./AboutPanel.js";
import { MonitoringPanel } from "../monitoring/MonitoringPanel.js";
import { MemoryExplorerPanel } from "../memory/MemoryExplorerPanel.js";

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
type SectionId = "general" | "data-root" | "runtimes" | "custom-models" | "institution" | "skills" | "workflows" | "automation" | "hooks" | "mcp" | "memory" | "plugins" | "appearance" | "shortcuts" | "gestures" | "voice" | "notifications" | "git" | "terminal" | "browser" | "lsp-languages" | "monitoring" | "usage" | "about";

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
      // 上下文那一页**删掉了**(2026-09-20,用户定的),里面的两节搬进了「记忆库」——
      // 它们本来就是一类东西(喂给引擎的长期信息),而记忆库已经是那个页面。
      // 第三那节「工具占用」是静态估算,没搬(它没有实际用处)。
      //
      // 记忆库跟在 MCP 后面:两者都是"喂给引擎的长期信息"(MCP 是工具,记忆是内容)。
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
      // 数据位置排在最前面 —— 它是"我的东西在哪"这个问题的唯一答案,其余设置都
      // 建立在它之上(数据库、文献库、模版库都在它下面)。
      { id: "data-root", labelKey: "settings.nav.dataRoot", icon: IconDatabase },
      // 资料库类型紧跟数据位置:注册表决定「库里有哪几类」,而库本身就住在数据根下 ——
      // 两个入口放在一起,「数据在哪」和「数据怎么分」一眼就看全。
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
  const [active, setActive] = useState<SectionId>(
    () =>
      (settingsSection && NAV_ITEMS.some((n) => n.id === settingsSection)
        ? settingsSection
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
          {active === "general" && <GeneralPanel />}
          {active === "appearance" && <AppearancePanel />}
          {active === "custom-models" && <CustomModelsPanel />}
          {active === "data-root" && <DataRootPanel />}
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
          {/* 记忆库 —— 2026-09-20 起它**多担了两节**:全局指令(常驻指令的编辑器)
              与项目记忆(CLI 自动记忆文件的编辑器)。两者原先在「上下文」那一页上,
              而那一页整页删了(用户定的):三节里只有「工具占用」是只读估算,没有
              实际用处,没有被搬过来。 */}
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
        </div>
      }
      right={null}
      leftOpen
      rightOpen={false}
      leftWidth={SETTINGS_NAV_WIDTH}
    />
  );
}
