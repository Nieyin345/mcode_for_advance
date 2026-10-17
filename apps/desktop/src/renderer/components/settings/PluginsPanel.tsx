/**
 * Plugins settings panel (docs/plugin-feasibility.md v1).
 *
 * Layout: the 「方案二 · 顶部页签」 variant of
 * prototypes/plugins-settings-redesign.html — the page is ONE surface with two
 * segmented tabs (已安装 / 插件市场) in the sticky header. The previous stacked
 * sections pushed the marketplace further down with every plugin installed; a
 * tab swap gives each list the full panel height and its own scroll, so neither
 * one displaces the other. Both panes stay mounted (`hidden`) so the search
 * text, filter and expanded row survive a tab switch.
 *
 * R66:与技能 / MCP 同一个管理模型 —— 总库(=已安装)/ 项目(每个项目单独开关、
 * 单独选引擎,见 ProjectPluginsView)/ 节点(哪些节点挂了哪个插件,只读反查)/ 插件市场。
 *
 * 已安装 pane:
 *  - Tool row: search (name / description / component names) + a 全部 / 已启用
 *    filter whose labels double as counts + ONE 「安装 ▾」 menu (git / local dir
 *    / zip). The three install sources used to sit in the panel permanently and
 *    read as noise; the git URL+ref form only materializes when that source is
 *    picked.
 *  - One row per plugin, two lines: chevron + monogram + name/version/component
 *    chips, then the description. Enabled state rides on the monogram tint and
 *    the switch — the old 「已启用」 badge bought a third line to restate what
 *    the switch already said.
 *  - Expanding a row shows the full inventory (skills / commands / agents / MCP
 *    / hooks), the per-provider support matrix, source / install time and the
 *    install path — the same ComponentDetails the install-review dialog renders
 *    (one source of truth for "what does this plugin contain").
 *  - Per-engine delivery, like the skill matrix (Settings → 技能): every row
 *    carries Claude / Codex / Pi keys (plugins.enginesSet). An engine the plugin
 *    has nothing for is struck through and disabled (Codex takes skills + MCP,
 *    Pi skills only, Claude everything but hooks); the expanded row spells out
 *    what each engine receives. A 全部引擎 / Claude / Codex / Pi filter lists
 *    what a given engine actually gets.
 *
 * 插件市场 pane additions: each catalog is badged with its ecosystem (Claude /
 * Codex / ZCode — openai/plugins is a built-in Codex catalog), and entries
 * whose tree is inside the cloned catalog show which engines could use them
 * before install; app-only Codex entries (ChatGPT connectors) are marked as
 * unusable in Mcode.
 *
 * 插件市场 pane: one group card per marketplace (kind badge, entry count,
 * refresh / remove), entries as name+version / description with an 安装 button
 * or an 已安装 tag; the add form is hidden behind a dashed 「＋ 添加插件市场」
 * button. The cross-marketplace search stays: the official catalog carries
 * hundreds of entries, and stacked group cards make a flat scan worse, not
 * better.
 *
 * Security posture (feasibility §3.4) is unchanged: installs land DISABLED, the
 * component-review dialog pops on success, enabling is an explicit click, and a
 * plugin declaring hooks gets a second confirmation that states OPENLY that
 * hooks are parsed but never executed in v1 — 静默 no-op 比明示不完整更糟.
 *
 * Panel-local state throughout (like McpPanel): the data has no consumers
 * outside this panel, so nothing goes into the session store. Every mutation
 * RPC resolves when done and ends with a full re-list — no push channel.
 */
import { useCallback, useEffect, useState } from "react";
import { PANEL_MAX_W } from "./panelWidth.js";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  Button,
  ConfirmDialog,
  ErrorNote,
  InfoHint,
  Switch,
} from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
// 子组件从 `PluginsPanelParts.tsx` 拆出（纯搬迁，见那边文件头）。
import { PanelTabs, InstalledPane, MarketplacePane, PluginReviewDialog } from "@renderer/components/settings/PluginsPanelParts.js";
import { NODE_PLUGINS_PARAM_KEY } from "@contracts/nodeType";
import { ScopeTabs, useManagedProject } from "./ScopeTabs.js";
import { ProjectPluginsView } from "./ProjectPluginsView.js";
import { SkillNodesView } from "./SkillNodesView.js";
import type {
  PluginEcosystem,
  PluginEngineId,
  PluginHookSummary,
  PluginMarketplaceState,
  PluginState,
} from "@contracts/ipc";
import type { HostHookGrant } from "@contracts/hostHookGrant";
import {
  activePluginGrants,
  canAuthorizeHook,
  hookGrantIssueInput,
  pluginGrants,
  shouldRefetchHookGrants,
} from "./pluginHookGrantsView.js";
import {
  IconPuzzle,
  IconLoader2,
  IconTrash,
  IconAlertTriangle,
  IconChevronRight,
  IconChevronDown,
  IconFolderOpen,
  IconFileZip,
  IconPlus,
  IconRefresh,
  IconGitBranch,
  IconSearch,
  IconShieldCheck,
  IconLock,
  IconX,
} from "@renderer/lib/icons.js";

const EMPTY_PLUGINS: PluginState[] = [];
const EMPTY_MARKETPLACES: PluginMarketplaceState[] = [];

/** The one content column the whole panel lives in — header, tabs, tool rows,
 *  marketplaces and lists all share it.
 *
 *  Deliberately the McpPanel shape (`mx-auto w-full max-w-*`, page scrolls in
 *  the settings pane, PanelHeader sticks) rather than SkillsPanel's full-height
 *  twin-scroller: with an inner `overflow-y-auto` list the panel had two
 *  different widths in one view — the header / tool row spanned the column,
 *  while the list inside the scroller was one scrollbar narrower (and the
 *  presence of that scrollbar flipped with the amount of content). One
 *  scroll container per page keeps the title bar and every content block at
 *  exactly the same width, and `max-w-*` caps it no matter how long the list
 *  gets. */
const PANEL_COLUMN = `mx-auto w-full ${PANEL_MAX_W.form}`;

/** Result shape shared by the three install RPCs. */
export interface InstallResult {
  ok: boolean;
  error?: string;
  plugin?: PluginState;
}

interface PluginCollections {
  plugins: PluginState[];
  marketplaces: PluginMarketplaceState[];
}

/** Mutation plumbing both panes need: the in-flight action key (disables just
 *  that control), the error sink and the install tail. */
export interface PanelOps {
  busyKey: string | null;
  setBusyKey: (key: string | null) => void;
  setError: (msg: string | null) => void;
  /** Shared tail of every install RPC: surface errors, pop the review dialog
   *  on success, re-list so the row appears. */
  afterInstall: (res: InstallResult) => Promise<void>;
  reload: () => Promise<PluginCollections | null>;
}

export type TabId = "installed" | "project" | "nodes" | "market";

/* ─────────────────── engines ─────────────────── */

/** The three local engines in matrix order, with the provider id the main
 *  process filters delivery on (mirrors PLUGIN_ENGINE_PROVIDER_IDS). */
export const ENGINES: ReadonlyArray<{ id: PluginEngineId; provider: string; label: string }> = [
  { id: "claude", provider: "claude-sdk", label: "Claude" },
  { id: "codex", provider: "codex-sdk", label: "Codex" },
  { id: "pi", provider: "pi-sdk", label: "Pi" },
];
const ALL_PROVIDERS = ENGINES.map((e) => e.provider);

/** Providers the plugin's components can feed (older hosts: assume all). */
function capableProviders(p: PluginState): Set<string> {
  return new Set(p.compatibleProviderIds ?? ALL_PROVIDERS);
}

/** The user's engine switches (older hosts: all on). */
function engineSwitchesOf(p: PluginState): Record<PluginEngineId, boolean> {
  return p.engines ?? { claude: true, codex: true, pi: true };
}

/** True when the plugin reaches `engine` (capable AND switched on) — what the
 *  engine filter and the delivery table go by. */
export function deliveredTo(p: PluginState, engine: (typeof ENGINES)[number]): boolean {
  const delivered = p.deliveredProviderIds;
  if (delivered) return delivered.includes(engine.provider);
  return capableProviders(p).has(engine.provider) && engineSwitchesOf(p)[engine.id];
}

/** Component labels one engine receives from this plugin ("Skills 3", …) —
 *  the delivery paths documented in @contracts/plugin. Empty for an engine
 *  that only gets the plugin through a manifest capability declaration. */
function engineReceives(
  p: PluginState,
  engine: PluginEngineId,
  t: ReturnType<typeof useI18n>["t"],
): string[] {
  const c = p.components;
  const parts: string[] = [];
  if (c.skills.length > 0) parts.push(`${t("settings.plugins.cmpSkills")} ${c.skills.length}`);
  if (engine === "claude") {
    if (c.commands.length > 0) parts.push(`${t("settings.plugins.cmpCommands")} ${c.commands.length}`);
    if (c.agents.length > 0) parts.push(`${t("settings.plugins.cmpAgents")} ${c.agents.length}`);
  }
  if (engine !== "pi" && c.mcpServers.length > 0) {
    parts.push(`${t("settings.plugins.cmpMcp")} ${c.mcpServers.length}`);
  }
  return parts;
}

/**
 * 【ARC-014】这个引擎**是不是收得到该插件的全部组件**(ALL 语义)。返回要显示的一句话,
 * 或缺省(老宿主没有这份事实 → `null`,不显示 —— 不猜)。
 *
 * 与上面那行 ANY(兼容列表里有没有该引擎)是**两件事**:一个含通用 Skill + Claude 专用
 * Command 的插件对 Pi「兼容」(ANY 为真),但 Pi 收不到那个 Command(ALL 为假)。这里把后
 * 者显式说出来,用户才知道「勾上了这个引擎,但它只拿到一部分」。
 */
function componentReadinessHint(
  p: PluginState,
  providerId: string,
  t: ReturnType<typeof useI18n>["t"],
): string | null {
  const r = p.componentReadiness?.[providerId];
  if (r === undefined) return null;
  if (r.ready) return t("settings.plugins.engineAllReady");
  const gaps = r.gaps.length;
  if (gaps === 0) return null;
  return t("settings.plugins.enginePartial", { gaps });
}

/** Why an engine cannot use the plugin at all (tooltip of a struck-out key). */
function engineNoneKey(engine: PluginEngineId): MessageId {
  if (engine === "codex") return "settings.plugins.engineNoneCodex";
  if (engine === "pi") return "settings.plugins.engineNonePi";
  return "settings.plugins.engineNoneClaude";
}

/** Row-level engine keys — the plugin twin of the skill page's group switches.
 *  On = accent; switched off = struck through (click to turn back on); an
 *  engine with nothing to receive = dimmed + disabled. */
export function PluginEngineKeys({
  plugin,
  busy,
  onToggle,
}: {
  plugin: PluginState;
  busy: boolean;
  onToggle: (engine: PluginEngineId, want: boolean) => void;
}) {
  const { t } = useI18n();
  const capable = capableProviders(plugin);
  const switches = engineSwitchesOf(plugin);
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-edge bg-surface/40 p-0.5">
      {ENGINES.map((e) => {
        const can = capable.has(e.provider);
        const on = can && switches[e.id];
        const what = engineReceives(plugin, e.id, t);
        const title = !can
          ? t(engineNoneKey(e.id))
          : on
            ? t("settings.plugins.engineOn", {
                engine: e.label,
                what: what.length > 0 ? what.join(" · ") : t("settings.plugins.engineDeclared"),
              })
            : t("settings.plugins.engineOff", { engine: e.label });
        return (
          <button
            key={e.id}
            type="button"
            disabled={busy || !can}
            aria-pressed={on}
            title={title}
            onClick={() => onToggle(e.id, !switches[e.id])}
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-semibold leading-tight transition-colors",
              on
                ? plugin.enabled
                  ? "bg-accent/15 text-accent"
                  : "bg-surface-hover text-content-muted"
                : can
                  ? "text-content-subtle line-through hover:text-content-muted"
                  : "cursor-not-allowed text-content-subtle/40 line-through",
              busy && can && "opacity-50",
            )}
          >
            {e.label}
          </button>
        );
      })}
    </span>
  );
}

/** Expanded-row delivery table: one line per engine with its switch and what
 *  it receives — the editable form of the old static support matrix. */
export function EngineDeliveryTable({
  plugin,
  busy,
  onToggle,
}: {
  plugin: PluginState;
  busy: boolean;
  onToggle: (engine: PluginEngineId, want: boolean) => void;
}) {
  const { t } = useI18n();
  const capable = capableProviders(plugin);
  const switches = engineSwitchesOf(plugin);
  const hasHooks = plugin.components.hooks.length > 0;
  // 【MC-061】分清"v1 不执行"与"事件根本映射不到 Mcode 的统一事件" —— 后者即使将来接上
  // 执行通道也该明确报不可用,不能和"暂时没接"混成一句话。
  const hasUnmappableHook = plugin.components.hooks.some((h) => h.execution === "unmappable");
  return (
    <div className="mb-2.5 border-b border-edge pb-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[0.7143em] font-semibold text-content-muted">
        {t("settings.plugins.engineSection")}
        <InfoHint>{t("settings.plugins.engineSectionDesc")}</InfoHint>
      </div>
      <div className="space-y-1">
        {ENGINES.map((e) => {
          const can = capable.has(e.provider);
          const on = can && switches[e.id];
          const what = engineReceives(plugin, e.id, t);
          return (
            <div key={e.id} className="flex items-center gap-2.5 text-[0.75em]">
              <span
                className={cn(
                  "w-12 shrink-0 font-semibold",
                  on ? "text-content" : "text-content-subtle",
                )}
              >
                {e.label}
              </span>
              <Switch
                checked={on}
                disabled={busy || !can}
                onCheckedChange={() => onToggle(e.id, !switches[e.id])}
                label={t("settings.plugins.engineToggle", { engine: e.label, name: plugin.name })}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  can ? "text-content-muted" : "text-content-subtle",
                  can && !on && "line-through",
                )}
              >
                {!can
                  ? t(engineNoneKey(e.id))
                  : what.length > 0
                    ? what.join(" · ")
                    : t("settings.plugins.engineDeclared")}
                {can && e.id === "claude" && hasHooks && (
                  <span className="ml-1.5 text-warning no-underline">
                    {hasUnmappableHook ? t("settings.plugins.engineHooksUnmappable") : t("settings.plugins.engineHooksNote")}
                  </span>
                )}
                {/* 【ARC-014】ALL 语义:这个引擎收不收得到该插件的**全部**组件。与上面那行
                    (ANY:兼容列表里有没有它)是两件事 —— 一个含通用 Skill + Claude 专用 Command 的
                    插件对 Pi「兼容」,但 Pi 收不到那个 Command。缺省(老宿主)就不显示这段。 */}
                {can && componentReadinessHint(plugin, e.provider, t) !== null && (
                  <span className="ml-1.5 text-content-subtle no-underline">
                    {componentReadinessHint(plugin, e.provider, t)}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Ecosystem chip for a marketplace (tab + catalog header). */
const ECOSYSTEM_LABEL: Record<PluginEcosystem, string> = {
  claude: "Claude",
  codex: "Codex",
  zcode: "ZCode",
};

export function EcosystemBadge({ ecosystem }: { ecosystem?: PluginEcosystem }) {
  const { t } = useI18n();
  if (!ecosystem) return null;
  const label = ECOSYSTEM_LABEL[ecosystem];
  return (
    <span
      title={t("settings.plugins.mpEcosystemTitle", { ecosystem: label })}
      className={cn(
        "shrink-0 rounded px-1 py-px text-[0.78em] font-semibold leading-tight",
        ecosystem === "codex"
          ? "bg-info/10 text-info"
          : ecosystem === "zcode"
            ? "bg-surface-hover text-content-muted"
            : "bg-accent/10 text-accent-strong",
      )}
    >
      {label}
    </span>
  );
}

/* ─────────────────── plugin monogram ─────────────────── */

/** Neither the plugin manifest nor the marketplace format carries a logo
 *  (verified against anthropics/claude-plugins-official: 292 entries, zero
 *  icon-ish fields), so visual identity is the name's initial. The tint doubles
 *  as the enabled indicator: accent when live, recessed grey when off — same
 *  name, same letter, every surface. */
export function PluginAvatar({
  name,
  size = 30,
  enabled = true,
}: {
  name: string;
  size?: number;
  enabled?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-lg font-semibold uppercase leading-none",
        enabled ? "bg-accent/10 text-accent-strong" : "bg-surface-muted text-content-subtle",
      )}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.44)) }}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/** Search haystack for the installed list: name, description and every
 *  component name, so "postgres" finds a plugin whose MCP server is named
 *  postgres even when the plugin name is unrelated. */
export function pluginHaystack(p: PluginState): string {
  const c = p.components;
  return [
    p.name,
    p.description,
    ...c.skills.map((s) => `${s.name} ${s.description}`),
    ...c.commands.map((s) => `${s.name} ${s.description}`),
    ...c.agents.map((s) => `${s.name} ${s.description}`),
    ...c.mcpServers.map((s) => `${s.name} ${s.kind} ${s.detail}`),
    ...c.hooks.map((h) => `${h.event} ${h.command}`),
  ]
    .join(" ")
    .toLowerCase();
}

export function PluginsPanel() {
  const { t } = useI18n();
  const [plugins, setPlugins] = useState<PluginState[]>(EMPTY_PLUGINS);
  const [marketplaces, setMarketplaces] = useState<PluginMarketplaceState[]>(EMPTY_MARKETPLACES);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Key of the in-flight action (disables just that control).
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("installed");
  const { project, projects, setManagedProjectId } = useManagedProject();

  // Post-install review dialog: shown for every successful install; enabling
  // is an explicit click inside it (installs land disabled).
  const [review, setReview] = useState<PluginState | null>(null);
  // Confirmation before enabling a plugin that declares hooks (the panel must
  // say the hooks won't run — never let the user assume they will).
  const [hookWarn, setHookWarn] = useState<PluginState | null>(null);
  const [pendingRemove, setPendingRemove] = useState<PluginState | null>(null);
  // 【MC-037】插件市场记录损坏的读侧诊断(列表只剩出厂市场时必须说清是"记录读不出来")。
  const [marketplacesCorrupt, setMarketplacesCorrupt] = useState<string | null>(null);

  /** Re-list both collections; returns the fresh data so callers (e.g. the
   *  marketplace add flow) can react to what actually landed. Null on error. */
  const reload = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([api.plugins.list(), api.plugins.marketplaceList()]);
      const plugins = p.plugins ?? EMPTY_PLUGINS;
      const marketplaces = m.marketplaces ?? EMPTY_MARKETPLACES;
      setPlugins(plugins);
      setMarketplaces(marketplaces);
      setMarketplacesCorrupt(m.corrupt?.reason ?? null);
      return { plugins, marketplaces };
    } catch (err) {
      console.error("PluginsPanel load failed:", err);
      setError((err as Error).message);
      return null;
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const afterInstall = async (res: InstallResult) => {
    setBusyKey(null);
    if (!res.ok) {
      setError(t("settings.plugins.installFailed", { error: res.error ?? "" }));
      return;
    }
    setError(null);
    if (res.plugin) setReview(res.plugin);
    await reload();
  };

  /* ── enable / remove ── */

  const applyEnable = async (name: string, enabled: boolean) => {
    setBusyKey(`toggle:${name}`);
    setError(null);
    try {
      const res = await api.plugins.setEnabled({ name, enabled });
      if (!res.ok) setError(t("settings.plugins.enableFailed", { error: res.error ?? "" }));
      await reload();
      // The plugin's skills feed the composer's `/` menu — refresh the
      // cached list so entries appear/disappear immediately.
      void useSessionStore.getState().reloadSkills();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  /** One engine switch of one plugin (plugins.enginesSet). */
  const applyEngine = async (name: string, engine: PluginEngineId, want: boolean) => {
    setBusyKey(`engines:${name}`);
    setError(null);
    try {
      const res = await api.plugins.enginesSet({ name, [engine]: want });
      if (!res.ok) setError(t("settings.plugins.enableFailed", { error: res.error ?? "" }));
      await reload();
      void useSessionStore.getState().reloadSkills();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  /** Enable flow with the hooks gate: plugins declaring hooks get an explicit
   *  "these won't run" confirmation first. */
  const requestEnable = (p: PluginState) => {
    if (p.components.hooks.length > 0) setHookWarn(p);
    else void applyEnable(p.name, true);
  };

  const toggleEnabled = (p: PluginState) => {
    if (p.enabled) void applyEnable(p.name, false);
    else requestEnable(p);
  };

  const confirmRemove = async () => {
    const target = pendingRemove;
    if (!target) return { ok: true };
    setBusyKey(`remove:${target.name}`);
    setError(null);
    try {
      const res = await api.plugins.remove({ name: target.name });
      if (!res.ok) setError(t("settings.plugins.removeFailed", { error: res.error ?? "" }));
      await reload();
      // Keep the composer's `/` menu in sync (the plugin's skills are gone).
      void useSessionStore.getState().reloadSkills();
      // 失败交给 ConfirmDialog 保留弹窗显示(UI-001);成功才让它关闭。
      return res;
    } catch (err) {
      setError((err as Error).message);
      throw err; // 让 ConfirmDialog 保留弹窗,不假装卸载成功
    } finally {
      setBusyKey(null);
    }
  };

  const ops: PanelOps = { busyKey, setBusyKey, setError, afterInstall, reload };
  const marketEntryCount = marketplaces.reduce((n, m) => n + m.plugins.length, 0);

  return (
    <section className={PANEL_COLUMN}>
      <PanelHeader
        className="mb-3"
        title={t("settings.plugins.title")}
        icon={IconPuzzle}
        action={
          <PanelTabs
            tab={tab}
            onChange={setTab}
            installedCount={plugins.length}
            marketCount={marketEntryCount}
          />
        }
      />

      {error && (
        <ErrorNote
          className="mt-2 flex-none"
          action={
            <button
              type="button"
              className="text-content-subtle hover:text-content"
              title={t("common.close")}
              onClick={() => setError(null)}
            >
              <IconX size={13} />
            </button>
          }
        >
          {error}
        </ErrorNote>
      )}

      {marketplacesCorrupt && !error && (
        <ErrorNote className="mt-2 flex-none" action={null}>
          {t("settings.market.recordsCorrupt", { reason: marketplacesCorrupt })}
        </ErrorNote>
      )}

      {/* Both panes stay mounted: switching tabs must not drop the search
          text, the filter or which row is expanded. */}
      <InstalledPane
        className={tab === "installed" ? "flex" : "hidden"}
        plugins={plugins}
        loaded={loaded}
        ops={ops}
        onToggle={toggleEnabled}
        onEngine={(p, engine, want) => void applyEngine(p.name, engine, want)}
        onRemove={setPendingRemove}
      />
      <MarketplacePane
        className={tab === "market" ? "flex" : "hidden"}
        visible={tab === "market"}
        marketplaces={marketplaces}
        loaded={loaded}
        ops={ops}
      />
      {tab === "project" && (
        <ProjectPluginsView
          project={project}
          projects={projects}
          onSelectProject={setManagedProjectId}
          refreshKey={plugins}
        />
      )}
      {tab === "nodes" && (
        <div className="min-h-0 flex-1 overflow-auto pr-1">
          <SkillNodesView
            skills={plugins.map((p) => ({ name: p.name, description: p.description }))}
            paramKey={NODE_PLUGINS_PARAM_KEY}
            hint={t("settings.plugins.nodesHint")}
            empty={t("settings.plugins.nodesEmpty")}
            icon={IconPuzzle}
            onJumpToWorkflow={(workflowId) => useSessionStore.getState().setSettingsOpen(true, "workflows", workflowId)}
            onJumpToProfile={() => useSessionStore.getState().setSettingsOpen(true, "workflows")}
          />
        </div>
      )}

      {/* ── Dialogs ── */}
      <PluginReviewDialog
        plugin={review}
        onOpenChange={(open) => {
          if (!open) setReview(null);
        }}
        onEnable={(p) => {
          setReview(null);
          requestEnable(p);
        }}
      />

      <ConfirmDialog
        open={hookWarn != null}
        title={t("settings.plugins.hooksWarnTitle")}
        description={
          hookWarn &&
          t("settings.plugins.hooksWarnDesc", {
            name: hookWarn.name,
            n: hookWarn.components.hooks.length,
          })
        }
        confirmText={t("common.confirm")}
        onOpenChange={(open) => {
          if (!open) setHookWarn(null);
        }}
        onConfirm={() => {
          const p = hookWarn;
          setHookWarn(null);
          if (p) void applyEnable(p.name, true);
        }}
      />

      <ConfirmDialog
        open={pendingRemove != null}
        title={t("settings.plugins.removeConfirmTitle")}
        danger
        description={
          pendingRemove && t("settings.plugins.removeConfirmDesc", { name: pendingRemove.name })
        }
        confirmText={t("common.delete")}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        onConfirm={() => confirmRemove()}
      />
    </section>
  );
}

/* ─────────────────── panel tabs ─────────────────── */

/** The 总库 / 项目 / 节点 / 市场 switch in the header's right-hand action slot.
 *  Each label carries its count so "how much is in there" never needs a visit. */
