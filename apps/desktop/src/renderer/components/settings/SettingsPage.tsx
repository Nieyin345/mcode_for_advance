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
  IconPlugConnected,
  IconShieldCheck,
  McpIcon,
  IconBrain,
  type TablerIconProps,
} from "@renderer/lib/icons.js";
import { CustomModelsPanel } from "./CustomModelsPanel.js";
import { ContextPanel } from "./ContextPanel.js";
import { InstitutionAuthPanel } from "./InstitutionAuthPanel.js";
import { IntegrationsPanel } from "./IntegrationsPanel.js";
import { DataRootPanel } from "./DataRootPanel.js";
import { LibraryTypesPanel } from "./LibraryTypesPanel.js";
import { RuntimesPanel } from "./RuntimesPanel.js";
import { SkillsPanel } from "./SkillsPanel.js";
import { WorkflowsPanel } from "./workflows/WorkflowsPanel.js";
import { HooksPanel } from "./HooksPanel.js";
import { McpPanel } from "./McpPanel.js";
import { SubagentsPanel } from "./SubagentsPanel.js";
import { PluginsPanel } from "./PluginsPanel.js";
import { AppearancePanel } from "./AppearancePanel.js";
import { ShortcutsPanel } from "./ShortcutsPanel.js";
import { GesturesPanel } from "./GesturesPanel.js";
import { GeneralPanel } from "./GeneralPanel.js";
import { GitPanel } from "./GitPanel.js";
import { TerminalPanel } from "./TerminalPanel.js";
import { BrowserPanel } from "./BrowserPanel.js";
import { LspLanguagesPanel } from "./LspLanguagesPanel.js";
import { NotificationsPanel } from "./NotificationsPanel.js";
import { VoicePanel } from "./VoicePanel.js";
import { UsagePanel } from "./UsagePanel.js";
import { AboutPanel } from "./AboutPanel.js";

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
type SectionId = "general" | "data-root" | "library-types" | "runtimes" | "custom-models" | "institution" | "integrations" | "library" | "templates" | "skills" | "claude-subagents" | "workflows" | "automation" | "hooks" | "mcp" | "context" | "plugins" | "appearance" | "shortcuts" | "gestures" | "voice" | "notifications" | "git" | "terminal" | "browser" | "lsp-languages" | "usage" | "about";

interface NavItem {
  id: SectionId;
  labelKey: MessageId;
  icon: ComponentType<TablerIconProps>;
  /** Capability gate: the item renders only when some provider declares it
   *  (undefined = always shown). Keeps provider-specific pages (子代理) from
   *  reading as broken entries when the engine can't serve them. */
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
      // 自定义子代理：Claude provider 专属能力（Options.agents），按能力位显隐 ——
      // 没有引擎支持时整个入口消失，而不是给一页"用不了"的编辑器。
      {
        id: "claude-subagents",
        labelKey: "settings.nav.subagents",
        icon: IconRobot,
        requiresCapability: (caps) => caps.supportsCustomSubagents === true,
      },
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
      // 上下文紧跟 MCP:两者都是"喂给引擎的全局上下文"(MCP 是工具,
      // 上下文是常驻指令与记忆) —— 共用一条事实源,挨在一起才看得出来。
      { id: "context", labelKey: "settings.nav.context", icon: IconBrain },
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
      { id: "library-types", labelKey: "settings.nav.libraryTypes", icon: IconBook },
      // 机构认证归在「工作台」组:它是使用场景(下载文献要先登录),
      // 不是 AI 配置,放 ai 组会让人以为是模型相关设置。
      { id: "institution", labelKey: "settings.nav.institution", icon: IconShieldCheck },
      { id: "integrations", labelKey: "settings.nav.integrations", icon: IconPlugConnected },
      { id: "git", labelKey: "settings.nav.git", icon: IconBrandGit },
      { id: "terminal", labelKey: "settings.nav.terminal", icon: IconTerminal2 },
      { id: "browser", labelKey: "settings.nav.browser", icon: IconWorld },
      { id: "lsp-languages", labelKey: "settings.nav.lsp", icon: IconCode },
    ],
  },
  {
    labelKey: "settings.navGroup.system",
    items: [
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
          {/* 文献库 / 模版库 / 数据位置 是同一件事(数据根下的三样东西),合并成一页。
              保留三个 id 是为了老的深链不落空。 */}
          {(active === "data-root" || active === "library" || active === "templates") && (
            <DataRootPanel />
          )}
          {active === "library-types" && <LibraryTypesPanel />}
          {active === "institution" && <InstitutionAuthPanel />}
          {active === "integrations" && <IntegrationsPanel />}
          {active === "shortcuts" && <ShortcutsPanel />}
          {active === "gestures" && <GesturesPanel />}
          {active === "voice" && <VoicePanel />}
          {active === "skills" && <SkillsPanel />}
          {/* 面板本身不随导航隐藏:深链(setSettingsOpen(true, "claude-subagents"))即便
              在入口被能力位滤掉的瞬间也应落在真实内容上,而不是一页空白。 */}
          {active === "claude-subagents" && <SubagentsPanel />}
          {active === "workflows" && <WorkflowsPanel purpose="workflow" />}
          {active === "automation" && <WorkflowsPanel purpose="automation" />}
          {active === "hooks" && <HooksPanel />}
          {active === "runtimes" && <RuntimesPanel />}
          {active === "mcp" && <McpPanel />}
          {active === "context" && <ContextPanel />}
          {active === "plugins" && <PluginsPanel />}
          {active === "notifications" && <NotificationsPanel />}
          {active === "git" && <GitPanel />}
          {active === "terminal" && <TerminalPanel />}
          {active === "browser" && <BrowserPanel />}
          {active === "lsp-languages" && <LspLanguagesPanel />}
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
