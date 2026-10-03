import { useMarketProgress } from "./useMarketProgress.js";
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
import { useCallback, useEffect, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { PANEL_MAX_W } from "./panelWidth.js";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorNote,
  InfoHint,
  Input,
  LoadingNote,
  Switch,
} from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { NODE_PLUGINS_PARAM_KEY } from "@contracts/nodeType";
import { ScopeTabs, useManagedProject } from "./ScopeTabs.js";
import { ProjectPluginsView } from "./ProjectPluginsView.js";
import { SkillNodesView } from "./SkillNodesView.js";
import type {
  PluginEcosystem,
  PluginEngineId,
  PluginMarketplaceState,
  PluginState,
} from "@contracts/ipc";
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
interface InstallResult {
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
interface PanelOps {
  busyKey: string | null;
  setBusyKey: (key: string | null) => void;
  setError: (msg: string | null) => void;
  /** Shared tail of every install RPC: surface errors, pop the review dialog
   *  on success, re-list so the row appears. */
  afterInstall: (res: InstallResult) => Promise<void>;
  reload: () => Promise<PluginCollections | null>;
}

type TabId = "installed" | "project" | "nodes" | "market";

/* ─────────────────── engines ─────────────────── */

/** The three local engines in matrix order, with the provider id the main
 *  process filters delivery on (mirrors PLUGIN_ENGINE_PROVIDER_IDS). */
const ENGINES: ReadonlyArray<{ id: PluginEngineId; provider: string; label: string }> = [
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
function deliveredTo(p: PluginState, engine: (typeof ENGINES)[number]): boolean {
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

/** Why an engine cannot use the plugin at all (tooltip of a struck-out key). */
function engineNoneKey(engine: PluginEngineId): MessageId {
  if (engine === "codex") return "settings.plugins.engineNoneCodex";
  if (engine === "pi") return "settings.plugins.engineNonePi";
  return "settings.plugins.engineNoneClaude";
}

/** Row-level engine keys — the plugin twin of the skill page's group switches.
 *  On = accent; switched off = struck through (click to turn back on); an
 *  engine with nothing to receive = dimmed + disabled. */
function PluginEngineKeys({
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
function EngineDeliveryTable({
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
                    {t("settings.plugins.engineHooksNote")}
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

function EcosystemBadge({ ecosystem }: { ecosystem?: PluginEcosystem }) {
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
function PluginAvatar({
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
function pluginHaystack(p: PluginState): string {
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

  /** Re-list both collections; returns the fresh data so callers (e.g. the
   *  marketplace add flow) can react to what actually landed. Null on error. */
  const reload = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([api.plugins.list(), api.plugins.marketplaceList()]);
      const plugins = p.plugins ?? EMPTY_PLUGINS;
      const marketplaces = m.marketplaces ?? EMPTY_MARKETPLACES;
      setPlugins(plugins);
      setMarketplaces(marketplaces);
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
    if (!target) return;
    setBusyKey(`remove:${target.name}`);
    setError(null);
    try {
      const res = await api.plugins.remove({ name: target.name });
      if (!res.ok) setError(t("settings.plugins.removeFailed", { error: res.error ?? "" }));
      await reload();
      // Keep the composer's `/` menu in sync (the plugin's skills are gone).
      void useSessionStore.getState().reloadSkills();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPendingRemove(null);
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
            onJumpToWorkflow={() => useSessionStore.getState().setSettingsOpen(true, "workflows")}
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
        onConfirm={() => void confirmRemove()}
      />
    </section>
  );
}

/* ─────────────────── panel tabs ─────────────────── */

/** The 总库 / 项目 / 节点 / 市场 switch in the header's right-hand action slot.
 *  Each label carries its count so "how much is in there" never needs a visit. */
function PanelTabs({
  tab,
  onChange,
  installedCount,
  marketCount,
}: {
  tab: TabId;
  onChange: (tab: TabId) => void;
  installedCount: number;
  marketCount: number;
}) {
  const { t } = useI18n();
  // Same tab strip as the Skills / MCP panels (总库 / 项目 / 节点 / 市场).
  return (
    <ScopeTabs
      items={[
        { id: "installed", label: t("settings.skills.tabLibrary"), count: installedCount },
        { id: "project", label: t("settings.skills.tabProject") },
        { id: "nodes", label: t("settings.skills.tabNodes") },
        { id: "market", label: t("settings.market.tab"), count: marketCount },
      ]}
      value={tab}
      onChange={onChange}
    />
  );
}

/** One segment of the 全部 / 已启用 filter. */
function FilterButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded-md px-2 py-1 text-[0.7857em] transition-colors",
        active ? "bg-surface-hover font-semibold text-content" : "text-content-muted hover:text-content",
      )}
    >
      {label}
      <span className="tabular-nums text-[0.92em] text-content-subtle">{count}</span>
    </button>
  );
}

/* ─────────────────── installed pane ─────────────────── */

function InstalledPane({
  className,
  plugins,
  loaded,
  ops,
  onToggle,
  onEngine,
  onRemove,
}: {
  className?: string;
  plugins: PluginState[];
  loaded: boolean;
  ops: PanelOps;
  onToggle: (plugin: PluginState) => void;
  onEngine: (plugin: PluginState, engine: PluginEngineId, want: boolean) => void;
  onRemove: (plugin: PluginState) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  // Engine filter: only plugins that actually reach this engine (capable AND
  // switched on) — "what does Codex get from my plugins".
  const [engineFilter, setEngineFilter] = useState<PluginEngineId | null>(null);
  const [installFormOpen, setInstallFormOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const enabledCount = plugins.filter((p) => p.enabled).length;
  const activeEngine = ENGINES.find((e) => e.id === engineFilter) ?? null;
  const q = query.trim().toLowerCase();
  const filtered = plugins.filter(
    (p) =>
      (!onlyEnabled || p.enabled) &&
      (!activeEngine || deliveredTo(p, activeEngine)) &&
      (!q || pluginHaystack(p).includes(q)),
  );

  const installLocal = async (key: string, pick: () => Promise<string | null>) => {
    const localPath = await pick();
    if (!localPath) return;
    ops.setBusyKey(key);
    ops.setError(null);
    try {
      await ops.afterInstall(await api.plugins.installLocal({ localPath }));
    } catch (err) {
      ops.setBusyKey(null);
      ops.setError((err as Error).message);
    }
  };

  return (
    <div className={cn("flex-col", className)}>
      {/* Tool row: search + filter + the single install entry point. */}
      <div className="flex flex-none flex-wrap items-center gap-2 py-2.5">
        <div className="relative min-w-[180px] flex-1">
          <IconSearch
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("settings.plugins.searchPlaceholder")}
            className="h-7 pl-7 font-sans text-[0.7857em]"
            spellCheck={false}
          />
        </div>
        {/* The one fact that is not visible anywhere else in the pane: a plugin
            enabled mid-conversation cannot reach the running turn. 收进 ⓘ。 */}
        <InfoHint>{t("settings.plugins.installedSectionDesc")}</InfoHint>
        {/* Pill group, same treatment as the marketplace tab strip in the
            other pane — the two filters read as one family of controls. */}
        <div className="flex flex-none items-center gap-0.5 rounded-lg border border-edge bg-surface/40 p-0.5">
          <FilterButton
            active={!onlyEnabled}
            label={t("settings.plugins.filterAll")}
            count={plugins.length}
            onClick={() => setOnlyEnabled(false)}
          />
          <FilterButton
            active={onlyEnabled}
            label={t("settings.plugins.enabled")}
            count={enabledCount}
            onClick={() => setOnlyEnabled(true)}
          />
        </div>
        <div className="flex flex-none items-center gap-0.5 rounded-lg border border-edge bg-surface/40 p-0.5">
          <FilterButton
            active={engineFilter == null}
            label={t("settings.plugins.engineFilterAll")}
            count={plugins.length}
            onClick={() => setEngineFilter(null)}
          />
          {ENGINES.map((e) => (
            <FilterButton
              key={e.id}
              active={engineFilter === e.id}
              label={e.label}
              count={plugins.filter((p) => (!onlyEnabled || p.enabled) && deliveredTo(p, e)).length}
              onClick={() => setEngineFilter(e.id)}
            />
          ))}
        </div>
        <InstallMenu
          busy={ops.busyKey != null}
          onGit={() => setInstallFormOpen((v) => !v)}
          onDir={() => void installLocal("install:local", async () => (await api.pickFolder()).path)}
          onZip={() =>
            void installLocal("install:zip", async () => {
              const { paths } = await api.pickFiles({ title: t("settings.plugins.pickZip") });
              return paths?.[0] ?? null;
            })
          }
        />
      </div>


      {/* Inline git form — only present once that source was chosen, but
          kept mounted while closed so a half-typed URL survives the toggle. */}
      <div
        className={cn(
          "mb-2 flex-none items-center gap-1.5 rounded-lg border border-edge-input bg-surface-muted/50 px-2 py-1.5",
          installFormOpen ? "flex" : "hidden",
        )}
      >
        <GitInstallForm
          busy={ops.busyKey === "install:git"}
          onBusy={() => ops.setBusyKey("install:git")}
          onDone={(res) => void ops.afterInstall(res)}
          onError={(msg) => {
            // A thrown IPC error never reaches afterInstall (the normal path
            // that clears busyKey), so release the form here as well.
            ops.setBusyKey(null);
            ops.setError(msg);
          }}
        />
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-content-subtle hover:text-content"
          title={t("common.close")}
          onClick={() => setInstallFormOpen(false)}
        >
          <IconX size={13} />
        </button>
      </div>

      <div className="pb-4">
        {!loaded ? (
          <LoadingNote label={t("settings.plugins.loading")} />
        ) : plugins.length === 0 ? (
          <Card className="rounded-xl">
            <EmptyState className="py-6" icon={IconPuzzle} title={t("settings.plugins.empty")} />
          </Card>
        ) : filtered.length === 0 ? (
          <Card className="rounded-xl">
            <EmptyState
              className="py-6"
              title={
                q
                  ? t("settings.plugins.searchEmpty", { query: query.trim() })
                  : activeEngine
                    ? t("settings.plugins.engineFilterEmpty", { engine: activeEngine.label })
                    : t("settings.plugins.filterEmpty")
              }
            />
          </Card>
        ) : (
          <div className="divide-y divide-edge overflow-hidden rounded-xl border border-edge bg-surface">
            {filtered.map((p) => (
              <PluginRow
                key={p.name}
                plugin={p}
                busy={ops.busyKey}
                expanded={expanded === p.name}
                // Rows are addressed by name; keeping the expanded row open
                // while the filter hides it is harmless (it re-appears as-is).
                onExpand={() => setExpanded((cur) => (cur === p.name ? null : p.name))}
                onToggle={() => onToggle(p)}
                onEngine={(engine, want) => onEngine(p, engine, want)}
                onRemove={() => onRemove(p)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────── install menu ─────────────────── */

/** The three install sources behind one button. The git form is inline (it
 *  needs two fields); dir / zip are pickers and fire straight away. */
function InstallMenu({
  busy,
  onGit,
  onDir,
  onZip,
}: {
  busy: boolean;
  onGit: () => void;
  onDir: () => void;
  onZip: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const itemClass =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.7857em] text-content-muted outline-none select-none data-[highlighted]:bg-surface-hover data-[highlighted]:text-content";

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        render={<Button variant="primary" size="sm" className="h-7 gap-1 px-2.5" />}
        disabled={busy}
      >
        <IconPlus size={12} />
        {t("settings.plugins.installMenu")}
        <IconChevronDown size={11} className="opacity-80" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-[60]">
          <Menu.Popup
            className={cn(
              "min-w-[180px] origin-top-right rounded-lg border border-edge bg-surface p-1 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <Menu.Item className={itemClass} onClick={onGit}>
              <IconGitBranch size={13} className="shrink-0 opacity-80" />
              {t("settings.plugins.installGitAction")}
            </Menu.Item>
            <Menu.Item className={itemClass} onClick={onDir}>
              <IconFolderOpen size={13} className="shrink-0 opacity-80" />
              {t("settings.plugins.installDir")}
            </Menu.Item>
            <Menu.Item className={itemClass} onClick={onZip}>
              <IconFileZip size={13} className="shrink-0 opacity-80" />
              {t("settings.plugins.installZip")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/* ───────────────────────── plugin row ───────────────────────── */

function PluginRow({
  plugin,
  busy,
  expanded,
  onExpand,
  onToggle,
  onEngine,
  onRemove,
}: {
  plugin: PluginState;
  /** Global busy key — disables this row's controls while any action runs. */
  busy: string | null;
  expanded: boolean;
  onExpand: () => void;
  onToggle: () => void;
  onEngine: (engine: PluginEngineId, want: boolean) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const rowBusy =
    busy === `toggle:${plugin.name}` ||
    busy === `remove:${plugin.name}` ||
    busy === `engines:${plugin.name}`;
  const enginesBusy = rowBusy || !!busy?.startsWith("install:");
  const on = plugin.enabled;
  const c = plugin.components;

  const chips: Array<{ key: MessageId; n: number; warn?: boolean }> = [
    { key: "settings.plugins.cmpSkills", n: c.skills.length },
    { key: "settings.plugins.cmpCommands", n: c.commands.length },
    { key: "settings.plugins.cmpAgents", n: c.agents.length },
    { key: "settings.plugins.cmpMcp", n: c.mcpServers.length },
    { key: "settings.plugins.cmpHooks", n: c.hooks.length, warn: true },
    { key: "settings.plugins.cmpApps", n: c.apps?.length ?? 0, warn: true },
  ];
  const empty = chips.every(({ n }) => n === 0);

  return (
    <div>
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          onClick={onExpand}
          aria-expanded={expanded}
        >
          <IconChevronRight
            size={13}
            className={cn(
              "shrink-0 text-content-subtle transition-transform",
              expanded && "rotate-90",
            )}
          />
          <PluginAvatar name={plugin.name} enabled={on} />
          <span className="block min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span
                className={cn(
                  "truncate text-[0.9286em] font-semibold",
                  on ? "text-content" : "text-content-subtle",
                )}
              >
                {plugin.name}
              </span>
              <span className="shrink-0 font-mono text-[0.75em] text-content-subtle">
                v{plugin.version}
              </span>
              {chips.map(({ key, n, warn }) =>
                n > 0 ? (
                  <span
                    key={key}
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-[0.72em]",
                      warn ? "bg-warning/10 text-warning" : "bg-surface-muted text-content-subtle",
                    )}
                  >
                    {t(key)} {n}
                  </span>
                ) : null,
              )}
            </span>
            {/* Second line of the row: the description, or the "nothing
                declared" note when a manifest carries neither. */}
            {(plugin.description || empty) && (
              <span className="mt-0.5 block truncate text-[0.8em] text-content-subtle">
                {plugin.description || t("settings.plugins.noComponents")}
              </span>
            )}
          </span>
        </button>
        <PluginEngineKeys plugin={plugin} busy={enginesBusy} onToggle={onEngine} />
        <Switch
          checked={on}
          onCheckedChange={onToggle}
          disabled={rowBusy || !!busy?.startsWith("install:")}
          label={t(
            on ? "settings.plugins.disableAction" : "settings.plugins.enableAction",
            { name: plugin.name },
          )}
        />
        <Button
          variant="ghost"
          size="icon"
          title={t("settings.plugins.remove")}
          onClick={onRemove}
          disabled={rowBusy}
          className="hover:text-danger"
        >
          <IconTrash size={13} className="text-content-subtle" />
        </Button>
      </div>

      {expanded && <PluginDetail plugin={plugin} busy={enginesBusy} onEngine={onEngine} />}
    </div>
  );
}

/** Expanded row body: where it came from, what works on which engine, the full
 *  inventory and where it lives on disk. */
function PluginDetail({
  plugin,
  busy,
  onEngine,
}: {
  plugin: PluginState;
  busy: boolean;
  onEngine: (engine: PluginEngineId, want: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="pb-3 pl-[52px] pr-3">
      <div className="rounded-lg border border-edge bg-surface-muted/40 p-3">
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75em] text-content-subtle">
          <span>
            {t("settings.plugins.sourceLabel")}:{" "}
            <b className="font-semibold text-content-muted">
              {t(sourceLabelKey(plugin.source.kind))}
            </b>
            {plugin.source.ref && (
              <span className="ml-1 break-all font-mono">{plugin.source.ref}</span>
            )}
          </span>
          {plugin.installedAt && (
            <span>
              {t("settings.plugins.installedAt", {
                time: new Date(plugin.installedAt).toLocaleString(),
              })}
            </span>
          )}
        </div>
        <EngineDeliveryTable plugin={plugin} busy={busy} onToggle={onEngine} />
        <ComponentDetails plugin={plugin} showProviders={false} />
        <div className="mt-2.5 break-all text-[0.7143em] text-content-subtle">
          {t("settings.plugins.pathLabel")}: <span className="font-mono">{plugin.rootDir}</span>
        </div>
      </div>
    </div>
  );
}

function sourceLabelKey(kind: PluginState["source"]["kind"]): MessageId {
  switch (kind) {
    case "local-dir":
      return "settings.plugins.source.local-dir";
    case "local-zip":
      return "settings.plugins.source.local-zip";
    case "git":
      return "settings.plugins.source.git";
    case "marketplace":
      return "settings.plugins.source.marketplace";
    default:
      return "settings.plugins.source.unknown";
  }
}

/* ─────────────────── component inventory ─────────────────── */

/** The plugin's declarative inventory — rendered identically in the row's
 *  expanded area and the install-review dialog (one source of truth). MCP
 *  commands/urls and hook commands are exactly what would run, spelled out. */
function ComponentDetails({
  plugin,
  showProviders = true,
}: {
  plugin: PluginState;
  /** The static "可用引擎" badges — the install-review dialog shows them; the
   *  installed row has the editable delivery table instead. */
  showProviders?: boolean;
}) {
  const { t } = useI18n();
  const c = plugin.components;
  const compatible = new Set(plugin.compatibleProviderIds ?? ["claude-sdk", "codex-sdk", "pi-sdk"]);

  const namedList = (
    title: string,
    items: Array<{ name: string; description: string }>,
    prefix = "",
  ) =>
    items.length > 0 && (
      <div className="mt-2.5 first:mt-0">
        <div className="mb-1 text-[0.7143em] font-semibold text-content-muted">
          {title} · {items.length}
        </div>
        <ul className="space-y-1">
          {items.map((s) => (
            <li key={s.name} className="text-[0.75em] leading-relaxed">
              <span className="font-mono text-content">
                {prefix}
                {s.name}
              </span>
              {s.description && (
                <span className="ml-1.5 text-content-subtle">— {s.description}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <div>
      {showProviders && (
        <div className="mb-2.5 first:mt-0">
          <div className="mb-1 text-[0.7143em] font-semibold text-content-muted">
            {t("settings.plugins.compatibleProviders")}
          </div>
          <div className="flex flex-wrap gap-1">
            {([
              ["claude-sdk", "Claude"],
              ["codex-sdk", "Codex"],
              ["pi-sdk", "Pi"],
            ] as const).map(([id, label]) => {
              const on = compatible.has(id);
              return (
                <span
                  key={id}
                  title={t(on ? "settings.plugins.providerCompatible" : "settings.plugins.providerIncompatible", { provider: label })}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight",
                    on
                      ? "bg-accent/15 text-accent"
                      : "bg-surface-hover text-content-subtle line-through decoration-content-subtle/60",
                  )}
                >
                  {label}
                </span>
              );
            })}
          </div>
        </div>
      )}
      {namedList(t("settings.plugins.cmpSkills"), c.skills)}
      {namedList(t("settings.plugins.cmpCommands"), c.commands, "/")}
      {namedList(t("settings.plugins.cmpAgents"), c.agents)}

      {c.mcpServers.length > 0 && (
        <div className="mt-2.5 first:mt-0">
          <div className="mb-1 text-[0.7143em] font-semibold text-content-muted">
            {t("settings.plugins.cmpMcp")} · {c.mcpServers.length}
          </div>
          <ul className="space-y-1">
            {c.mcpServers.map((s) => (
              <li key={s.name} className="text-[0.75em] leading-relaxed">
                <span className="rounded bg-surface-muted px-1 py-0.5 font-mono text-[0.92em] text-content-muted">
                  {s.kind}
                </span>{" "}
                <span className="font-mono text-content">{s.name}</span>
                <span className="ml-1.5 break-all font-mono text-content-subtle">{s.detail}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[0.7143em] text-content-subtle">
            {t("settings.plugins.reviewMcpNote")}
          </p>
        </div>
      )}

      {(c.apps?.length ?? 0) > 0 && (
        <div className="mt-2.5 first:mt-0">
          <div className="mb-1 text-[0.7143em] font-semibold text-content-muted">
            {t("settings.plugins.cmpApps")} · {c.apps?.length ?? 0}
          </div>
          <p className="break-all font-mono text-[0.75em] text-content-subtle">
            {(c.apps ?? []).join(" · ")}
          </p>
          <p className="mt-1 text-[0.7143em] text-warning">
            {t("settings.plugins.appsNote", { n: c.apps?.length ?? 0 })}
          </p>
        </div>
      )}

      {c.hooks.length > 0 && (
        <ErrorNote
          tone="warning"
          icon={IconAlertTriangle}
          className="mt-2.5"
          title={t("settings.plugins.hooksNotExecuted", { n: c.hooks.length })}
        >
          <ul className="space-y-1">
            {c.hooks.map((h, i) => (
              <li key={i} className="break-all text-[0.7143em] leading-relaxed text-content-muted">
                <span className="font-mono text-content">{h.event}</span>
                {h.matcher && <span className="font-mono"> ({h.matcher})</span>}:{" "}
                <span className="font-mono">{h.command}</span>
              </li>
            ))}
          </ul>
        </ErrorNote>
      )}
    </div>
  );
}

/* ─────────────────── install-review dialog ─────────────────── */

function PluginReviewDialog({
  plugin,
  onOpenChange,
  onEnable,
}: {
  plugin: PluginState | null;
  onOpenChange: (open: boolean) => void;
  onEnable: (plugin: PluginState) => void;
}) {
  const { t } = useI18n();
  if (!plugin) return null;
  return (
    <Dialog.Root open={plugin != null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="flex max-h-[80vh] w-[560px] flex-col p-0">
          <Dialog.Title className="flex items-center gap-2 px-4 pt-4">
            <PluginAvatar name={plugin.name} size={22} />
            <span className="min-w-0 truncate">
              {t("settings.plugins.reviewTitle")} · {plugin.name}{" "}
              <span className="font-mono text-[0.85em] text-content-muted">v{plugin.version}</span>
            </span>
          </Dialog.Title>
          <Dialog.Description className="px-4 pt-1">
            {t("settings.plugins.reviewDesc")}
          </Dialog.Description>
          <Dialog.Close />
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {plugin.description && (
              <p className="mb-3 text-[0.7857em] text-content-muted">{plugin.description}</p>
            )}
            <ComponentDetails plugin={plugin} />
          </div>
          <div className="flex justify-end gap-2 border-t border-edge px-4 py-3">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t("settings.plugins.reviewLater")}
            </Button>
            <Button variant="primary" size="sm" onClick={() => onEnable(plugin)}>
              {t("settings.plugins.reviewEnable")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ─────────────────── git install form ─────────────────── */

function GitInstallForm({
  busy,
  onBusy,
  onDone,
  onError,
}: {
  busy: boolean;
  onBusy: () => void;
  onDone: (res: InstallResult) => void;
  onError: (msg: string) => void;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");

  const submit = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    onBusy();
    try {
      const res = await api.plugins.installGit({
        url: trimmed,
        ...(ref.trim() ? { ref: ref.trim() } : {}),
      });
      setUrl("");
      setRef("");
      onDone(res);
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <>
      <IconGitBranch size={12} className="shrink-0 text-content-subtle" />
      <Input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={t("settings.plugins.gitPlaceholder")}
        className="h-7 min-w-0 flex-1 text-[0.7857em]"
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
      <Input
        value={ref}
        onChange={(e) => setRef(e.target.value)}
        placeholder={t("settings.plugins.gitRefPlaceholder")}
        className="h-7 w-24 text-[0.7857em]"
        spellCheck={false}
      />
      <Button
        variant="primary"
        size="sm"
        className="h-7"
        onClick={() => void submit()}
        disabled={busy || !url.trim()}
      >
        {busy && <IconLoader2 size={12} className="animate-spin" />}
        {t("settings.plugins.installGitAction")}
      </Button>
    </>
  );
}

/* ─────────────────── marketplace pane ─────────────────── */

/** Marketplaces are TABS, one per source: a marketplace is the unit the user
 *  thinks in ("which catalog am I browsing"), its name + entry count fit a tab
 *  label, and stacking every catalog as group cards made a 292-entry official
 *  market and a 3-entry private one fight for the same scroll. The search box
 *  stays panel-level and applies to the active tab (switching tabs clears it —
 *  the query was written for the catalog you are leaving). */
function MarketplacePane({
  className,
  visible,
  marketplaces,
  loaded,
  ops,
}: {
  className?: string;
  /** True while this pane is the shown tab. The panes stay mounted, so without
   *  it the first-fetch effect below would clone catalogs while the user is
   *  still on the 已安装 tab. */
  visible: boolean;
  marketplaces: PluginMarketplaceState[];
  loaded: boolean;
  ops: PanelOps;
}) {
  const { t } = useI18n();
  const marketProgress = useMarketProgress();
  const [activeName, setActiveName] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [mpUrl, setMpUrl] = useState("");

  // Resolve by name with a fallback to the first entry, so removing the active
  // marketplace lands on a neighbour instead of an empty pane.
  const active = marketplaces.find((m) => m.name === activeName) ?? marketplaces[0] ?? null;
  const q = query.trim().toLowerCase();
  const entries = active
    ? q
      ? active.plugins.filter(
          (e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q),
        )
      : active.plugins
    : [];

  /** Add a marketplace (git URL or local directory) and re-list. Both kinds
   *  land under the manifest's own name, which may differ from the typed ref —
   *  selecting whatever landed keeps the new catalog in view. */
  const addMarketplace = async (kind: "git" | "local", ref: string) => {
    ops.setBusyKey("mp:add");
    ops.setError(null);
    const before = new Set(marketplaces.map((m) => m.name));
    try {
      const res = await marketProgress.run(requestId => api.plugins.marketplaceAdd({ kind, ref, requestId }));
      if (!res.ok) ops.setError(t("settings.plugins.mpAddFailed", { error: res.error ?? "" }));
      else setMpUrl("");
      const fresh = await ops.reload();
      const added = fresh?.marketplaces.find((m) => !before.has(m.name));
      if (added) setActiveName(added.name);
    } catch (err) {
      ops.setError((err as Error).message);
    } finally {
      ops.setBusyKey(null);
    }
  };

  const addGit = async () => {
    const trimmed = mpUrl.trim();
    if (!trimmed) return;
    await addMarketplace("git", trimmed);
  };

  const addLocal = async () => {
    const { path } = await api.pickFolder();
    if (!path) return;
    await addMarketplace("local", path);
    setAddOpen(false);
  };

  const mpAction = async (name: string, action: "refresh" | "remove") => {
    ops.setBusyKey(`mp:${action}:${name}`);
    ops.setError(null);
    try {
      const res =
        action === "refresh"
          ? await marketProgress.run(requestId => api.plugins.marketplaceRefresh({ name, requestId }))
          : await api.plugins.marketplaceRemove({ name });
      if (!res.ok) {
        ops.setError(
          t(
            action === "refresh"
              ? "settings.plugins.mpRefreshFailed"
              : "settings.plugins.mpRemoveFailed",
            { error: res.error ?? "" },
          ),
        );
      }
      await ops.reload();
    } catch (err) {
      ops.setError((err as Error).message);
    } finally {
      ops.setBusyKey(null);
    }
  };

  /* A shipped marketplace (BUILTIN_MARKETPLACES) is listed before it has ever
     been cloned, so fetch it the first time it is actually looked at — that is
     the one moment downloading a catalog is unambiguously what the user wants.
     One attempt per marketplace per mount: a failure surfaces in the error
     banner and leaves the Refresh button, never a retry loop. `busyKey` gates
     it to one clone at a time when both built-ins still need fetching. */
  const fetchTried = useRef<Set<string>>(new Set());
  // Ref mirror so the effect's deps stay primitive (mpAction is rebuilt every
  // render — same idiom as useSuppressBrowserView).
  const refreshRef = useRef<(name: string) => void>(() => {});
  refreshRef.current = (name) => void mpAction(name, "refresh");
  useEffect(() => {
    if (!visible || !loaded || !active || !active.builtin || active.cloned) return;
    if (ops.busyKey || fetchTried.current.has(active.name)) return;
    fetchTried.current.add(active.name);
    refreshRef.current(active.name);
  }, [visible, loaded, active, ops.busyKey]);

  /** Refresh every marketplace sequentially — each one re-clones, so firing
   *  them in parallel would just contend for the network and the git lock. */
  const refreshAll = async () => {
    if (marketplaces.length === 0) return;
    ops.setError(null);
    for (const mp of marketplaces) {
      ops.setBusyKey(`mp:refresh:${mp.name}`);
      try {
        const res = await marketProgress.run(requestId => api.plugins.marketplaceRefresh({ name: mp.name, requestId }));
        if (!res.ok) {
          ops.setError(t("settings.plugins.mpRefreshFailed", { error: res.error ?? "" }));
          break;
        }
      } catch (err) {
        ops.setError((err as Error).message);
        break;
      }
    }
    ops.setBusyKey(null);
    await ops.reload();
  };

  const installEntry = async (marketplace: string, name: string) => {
    const key = `mpEntry:${marketplace}/${name}`;
    ops.setBusyKey(key);
    ops.setError(null);
    try {
      await ops.afterInstall(await api.plugins.installMarketplace({ marketplace, name }));
    } catch (err) {
      ops.setError((err as Error).message);
      ops.setBusyKey(null);
    }
  };

  return (
    <div className={cn("flex-col", className)}>
      {marketProgress.status}
      <div className="flex flex-none flex-wrap items-center gap-2 py-2.5">
        <span className="text-[0.9286em] font-semibold text-content">
          {t("settings.plugins.marketplaceSection")}
        </span>
        <span className="text-[0.7857em] text-content-subtle">
          {t("settings.plugins.mpSourceCount", { n: marketplaces.length })}
        </span>
        <InfoHint>{t("settings.plugins.marketplaceSectionDesc")}</InfoHint>
        <span className="flex-1" />
        <div className="relative w-44 shrink-0">
          <IconSearch
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("settings.plugins.mpSearchPlaceholder")}
            className="h-7 pl-7 font-sans text-[0.7857em]"
            spellCheck={false}
            disabled={marketplaces.length === 0}
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          title={t("settings.plugins.mpRefreshAll")}
          onClick={() => void refreshAll()}
          disabled={ops.busyKey != null || marketplaces.length === 0}
        >
          <IconRefresh
            size={13}
            className={cn(
              "text-content-subtle",
              ops.busyKey?.startsWith("mp:refresh:") && "animate-spin",
            )}
          />
        </Button>
      </div>

      {/* One tab per marketplace, with the add entry right beside them (a tab
          bar is where "another source" is looked for; the dashed button that
          scrolled with the catalog was reachable only after 292 rows). With
          no marketplaces at all there is no strip to sit next to, so that
          case gets the labelled button instead of a lone ⊕. */}
      <div className="mb-2.5 flex flex-none items-center gap-2">
        {marketplaces.length > 0 ? (
          <>
            <div className="min-w-0 overflow-x-auto">
              <div className="flex w-fit items-center gap-0.5 rounded-lg border border-edge bg-surface/40 p-0.5">
                {marketplaces.map((mp) => {
                  const isActive = mp.name === active?.name;
                  return (
                    <button
                      key={mp.name}
                      type="button"
                      title={mp.sourceRef}
                      onClick={() => {
                        setActiveName(mp.name);
                        setQuery("");
                      }}
                      className={cn(
                        "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1 text-[0.7857em] font-medium transition-colors",
                        isActive
                          ? "bg-surface-hover text-content"
                          : "text-content-muted hover:text-content",
                      )}
                    >
                      <EcosystemBadge ecosystem={mp.ecosystem} />
                      <span className="max-w-[220px] truncate">{mp.name}</span>
                      <span className="tabular-nums text-[0.8571em] text-content-subtle">
                        {mp.plugins.length}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              title={t("settings.plugins.mpAddMarketplace")}
              aria-expanded={addOpen}
              onClick={() => setAddOpen((v) => !v)}
              disabled={ops.busyKey != null}
            >
              <IconPlus size={13} className="text-content-subtle" />
            </Button>
          </>
        ) : (
          loaded &&
          !addOpen && (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-edge px-3 py-2 text-[0.8571em] font-medium text-content-muted transition-colors hover:border-accent/45 hover:text-accent"
            >
              <IconPlus size={13} />
              {t("settings.plugins.mpAddMarketplace")}
            </button>
          )
        )}
      </div>

      {/* Add form — kept mounted while closed so a half-typed URL survives. */}
      <div
        className={cn(
          "mb-2.5 flex-none rounded-xl border border-dashed border-edge-input bg-surface-muted/35 p-2",
          addOpen ? "block" : "hidden",
        )}
      >
        <Input
          value={mpUrl}
          onChange={(e) => setMpUrl(e.target.value)}
          placeholder={t("settings.plugins.mpAddPlaceholder")}
          className="h-7 text-[0.7857em]"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addGit();
          }}
        />
        <div className="mt-1.5 flex items-center gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            className="h-7 flex-1 justify-center"
            onClick={() => void addGit()}
            disabled={ops.busyKey === "mp:add" || !mpUrl.trim()}
          >
            {ops.busyKey === "mp:add" ? (
              <IconLoader2 size={12} className="animate-spin" />
            ) : (
              <IconPlus size={12} />
            )}
            {t("settings.plugins.mpAdd")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="h-7 flex-1 justify-center"
            onClick={() => void addLocal()}
            disabled={ops.busyKey != null}
          >
            <IconFolderOpen size={12} />
            {t("settings.plugins.mpAddLocal")}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title={t("common.close")}
            onClick={() => setAddOpen(false)}
          >
            <IconX size={13} className="text-content-subtle" />
          </Button>
        </div>
      </div>

      <div className="pb-4">
        {!loaded ? (
          <LoadingNote label={t("settings.plugins.loading")} />
        ) : marketplaces.length === 0 ? (
          <Card className="rounded-xl">
            <EmptyState className="py-6" title={t("settings.plugins.mpEmpty")} />
          </Card>
        ) : q && entries.length === 0 ? (
          <Card className="rounded-xl">
            <EmptyState className="py-6" title={t("settings.plugins.mpSearchEmpty", { query: query.trim() })} />
          </Card>
        ) : active ? (
          <MarketplaceCatalog
            marketplace={active}
            entries={entries}
            busyKey={ops.busyKey}
            onRefresh={() => void mpAction(active.name, "refresh")}
            onRemove={() => void mpAction(active.name, "remove")}
            onInstall={(name) => void installEntry(active.name, name)}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The active marketplace's catalog: a source strip (transport, source ref,
 *  entry count, refresh / remove) over the entry rows. The marketplace NAME is
 *  not repeated here — it is the tab the user just clicked. */
function MarketplaceCatalog({
  marketplace,
  entries,
  busyKey,
  onRefresh,
  onRemove,
  onInstall,
}: {
  marketplace: PluginMarketplaceState;
  entries: PluginMarketplaceState["plugins"];
  busyKey: string | null;
  onRefresh: () => void;
  onRemove: () => void;
  onInstall: (name: string) => void;
}) {
  const { t } = useI18n();
  const busy = busyKey != null;
  const fetching = busyKey === `mp:refresh:${marketplace.name}`;

  return (
    <div className="overflow-hidden rounded-xl border border-edge bg-surface">
      <div className="flex items-center gap-2 border-b border-edge bg-surface-muted/35 px-3 py-2.5">
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[0.72em]",
            marketplace.sourceKind === "git"
              ? "bg-info/10 font-mono text-info"
              : "bg-surface-muted text-content-muted",
          )}
        >
          {marketplace.sourceKind === "git" ? "git" : t("settings.plugins.source.local-dir")}
        </span>
        {marketplace.builtin && (
          <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[0.72em] text-accent-strong">
            {t("settings.plugins.mpBuiltin")}
          </span>
        )}
        <span className="text-[0.92em]">
          <EcosystemBadge ecosystem={marketplace.ecosystem} />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[0.7857em] text-content-subtle">
          {marketplace.sourceRef}
        </span>
        <span className="shrink-0 text-[0.7857em] text-content-subtle">
          {t("settings.plugins.mpPluginCount", { n: marketplace.plugins.length })}
        </span>
        <Button
          variant="ghost"
          size="icon"
          title={t("settings.plugins.mpRefresh")}
          onClick={onRefresh}
          disabled={busy}
        >
          <IconRefresh
            size={13}
            className={cn("text-content-subtle hover:text-accent", fetching && "animate-spin")}
          />
        </Button>
        {/* Shipped catalogs carry no remove action (the main process refuses it
            too) — this just keeps a dead control off the screen. */}
        {!marketplace.builtin && (
          <Button
            variant="ghost"
            size="icon"
            title={t("settings.plugins.mpRemove")}
            onClick={onRemove}
            disabled={busy}
            className="hover:text-danger"
          >
            <IconTrash size={13} className="text-content-subtle" />
          </Button>
        )}
      </div>
      {!marketplace.cloned ? (
        <div className="px-3 py-2.5 text-[0.7857em] text-content-subtle">
          {t(fetching ? "settings.plugins.mpFetching" : "settings.plugins.mpNotFetched")}
        </div>
      ) : entries.length === 0 ? (
        <div className="px-3 py-2.5 text-[0.7857em] text-content-subtle">
          {t("settings.plugins.mpNoEntries")}
        </div>
      ) : (
        entries.map((entry) => (
          <div
            key={entry.name}
            className="flex items-center gap-2.5 border-t border-edge px-3 py-2.5 first:border-t-0"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className="truncate text-[0.8571em] font-medium text-content">
                  {entry.name}
                </span>
                {entry.version && (
                  <span className="shrink-0 font-mono text-[0.75em] text-content-subtle">
                    v{entry.version}
                  </span>
                )}
                <MarketEntryEngines entry={entry} />
              </div>
              {entry.description && (
                <p className="mt-0.5 truncate text-[0.7857em] text-content-subtle">
                  {entry.description}
                </p>
              )}
            </div>
            {entry.installed ? (
              <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[0.75em] text-accent-strong">
                {t("settings.plugins.mpInstalled")}
              </span>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                className="h-7 shrink-0"
                onClick={() => onInstall(entry.name)}
                // App-only Codex entries would install as an empty shell.
                disabled={busy || entry.appsOnly === true}
                title={entry.appsOnly ? t("settings.plugins.mpAppsOnlyTitle") : undefined}
              >
                {busyKey === `mpEntry:${marketplace.name}/${entry.name}` ? (
                  <IconLoader2 size={12} className="animate-spin" />
                ) : (
                  t("settings.plugins.mpInstall")
                )}
              </Button>
            )}
          </div>
        ))
      )}
    </div>
  );
}

/** Engine chips of a catalog entry, when the entry could be inspected before
 *  install (its tree is inside the cloned catalog). Remote entries show
 *  nothing — that is "unknown", not "none". */
function MarketEntryEngines({ entry }: { entry: PluginMarketplaceState["plugins"][number] }) {
  const { t } = useI18n();
  if (entry.appsOnly) {
    return (
      <span
        title={t("settings.plugins.mpAppsOnlyTitle")}
        className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-[0.72em] text-warning"
      >
        {t("settings.plugins.mpAppsOnly")}
      </span>
    );
  }
  const ids = entry.compatibleProviderIds;
  if (!ids) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      {ENGINES.map((e) => {
        const can = ids.includes(e.provider);
        return (
          <span
            key={e.id}
            title={t(
              can ? "settings.plugins.providerCompatible" : "settings.plugins.providerIncompatible",
              { provider: e.label },
            )}
            className={cn(
              "rounded px-1 py-px text-[10px] font-medium leading-tight",
              can
                ? "bg-accent/10 text-accent"
                : "text-content-subtle/50 line-through",
            )}
          >
            {e.label}
          </span>
        );
      })}
    </span>
  );
}
