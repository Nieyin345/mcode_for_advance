/**
 * `PluginsPanel` 的**子组件**（从 `PluginsPanel.tsx` 拆出）。
 *
 * 尾部挂着的标签栏 / 已装面板 / 插件行 / 详情 / hook 授权区 / 市场面板等是各自独立的渲染
 * 单元（AST 实测零闭包捕获）—— 纯搬迁，函数体逐字节一致。
 *
 * 网：`scripts/plugins-ui-smoke/` 在真 Chromium 里真渲染 `PluginsPanel`、真点真输入。
 */
import { useEffect, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorNote,
  InfoHint,
  Input,
  LoadingNote,
  Spinner,
  Switch,
} from "@renderer/components/ui/index.js";
import { ScopeTabs } from "./ScopeTabs.js";
import type {
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
import { useMarketProgress } from "./useMarketProgress.js";
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
import { ENGINES, deliveredTo, type InstallResult, type PanelOps, type TabId, PluginEngineKeys, EngineDeliveryTable, EcosystemBadge, PluginAvatar, pluginHaystack } from "@renderer/components/settings/PluginsPanel.js";

export function PanelTabs({
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

export function InstalledPane({
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
  // 勾选（批量启用/停用/删除）。用户 2026-10-11：「每个集合没有批量管理，批量选择」——
  // 插件页此前**完全没有**勾选。
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [pendingBulkRemove, setPendingBulkRemove] = useState(false);

  const enabledCount = plugins.filter((p) => p.enabled).length;
  const activeEngine = ENGINES.find((e) => e.id === engineFilter) ?? null;
  const q = query.trim().toLowerCase();
  const filtered = plugins.filter(
    (p) =>
      (!onlyEnabled || p.enabled) &&
      (!activeEngine || deliveredTo(p, activeEngine)) &&
      (!q || pluginHaystack(p).includes(q)),
  );

  // 已删掉的插件不要留在勾选里（列表一变就收敛，和技能页那条同一个道理）。
  useEffect(() => {
    const names = new Set(plugins.map((p) => p.name));
    setChecked((prev) => {
      const next = new Set([...prev].filter((n) => names.has(n)));
      return next.size === prev.size ? prev : next;
    });
  }, [plugins]);

  /** 批量启用/停用。后端 `plugins.setEnabled` 是单条，一个 IPC 一条 —— 同技能页
   *  组级删除的既有做法（毫秒级，失败如实计数、不中断其余）。 */
  const bulkSetEnabled = async (want: boolean) => {
    const names = plugins.filter((p) => checked.has(p.name) && p.enabled !== want).map((p) => p.name);
    if (!names.length) return;
    ops.setError(null);
    const failures: string[] = [];
    for (const name of names) {
      ops.setBusyKey(`toggle:${name}`);
      try {
        const res = await api.plugins.setEnabled({ name, enabled: want });
        if (!res.ok) failures.push(`${name}: ${res.error ?? t("settings.operationFailed")}`);
      } catch (err) {
        failures.push(`${name}: ${(err as Error).message}`);
      }
    }
    ops.setBusyKey(null);
    if (failures.length) ops.setError(failures.join("; "));
    await ops.reload();
  };

  /** 批量卸载。危险动作，走确认框。 */
  const bulkRemove = async () => {
    setPendingBulkRemove(false);
    const names = plugins.filter((p) => checked.has(p.name)).map((p) => p.name);
    if (!names.length) return;
    ops.setError(null);
    const failures: string[] = [];
    const removed = new Set<string>();
    for (const name of names) {
      ops.setBusyKey(`remove:${name}`);
      try {
        const res = await api.plugins.remove({ name });
        if (res.ok) removed.add(name);
        else failures.push(`${name}: ${res.error ?? t("settings.operationFailed")}`);
      } catch (err) {
        failures.push(`${name}: ${(err as Error).message}`);
      }
    }
    ops.setBusyKey(null);
    if (removed.size) setChecked((prev) => new Set([...prev].filter((n) => !removed.has(n))));
    if (failures.length) ops.setError(failures.join("; "));
    await ops.reload();
  };

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

      {/* 勾选批量条：勾了插件才出现。批量启用/停用/卸载。 */}
      {checked.size > 0 && (
        <div
          data-testid="plugins-bulk-bar"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-edge bg-surface/60 px-3 py-1.5"
        >
          <span className="text-[0.8571em] font-medium text-content-muted">
            {t("settings.plugins.bulkSelected", { n: checked.size })}
          </span>
          <Button variant="ghost" size="sm" data-testid="plugins-bulk-enable" disabled={ops.busyKey != null} onClick={() => void bulkSetEnabled(true)}>
            {t("settings.plugins.bulkEnable")}
          </Button>
          <Button variant="ghost" size="sm" data-testid="plugins-bulk-disable" disabled={ops.busyKey != null} onClick={() => void bulkSetEnabled(false)}>
            {t("settings.plugins.bulkDisable")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid="plugins-bulk-remove"
            disabled={ops.busyKey != null}
            onClick={() => setPendingBulkRemove(true)}
            className="ml-auto gap-1 text-danger hover:bg-danger/10"
          >
            <IconTrash size={12} />
            {t("settings.plugins.bulkRemove")}
          </Button>
          <Button variant="ghost" size="sm" disabled={ops.busyKey != null} onClick={() => setChecked(new Set())}>
            {t("settings.skills.clearSelection")}
          </Button>
        </div>
      )}

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
                checked={checked.has(p.name)}
                onCheckedChange={(next) =>
                  setChecked((prev) => {
                    const set = new Set(prev);
                    if (next) set.add(p.name);
                    else set.delete(p.name);
                    return set;
                  })
                }
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

      <ConfirmDialog
        open={pendingBulkRemove}
        title={t("settings.plugins.bulkRemove")}
        danger
        description={t("settings.plugins.bulkRemoveDesc", { n: checked.size })}
        confirmText={t("common.delete")}
        onOpenChange={(open) => {
          if (!open) setPendingBulkRemove(false);
        }}
        onConfirm={() => void bulkRemove()}
      />
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
              "min-w-[180px] origin-top-right rounded-[var(--radius-btn-xs)] border border-edge bg-surface p-1 shadow-[var(--shadow-popover)]",
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
  checked,
  onCheckedChange,
}: {
  plugin: PluginState;
  /** Global busy key — disables this row's controls while any action runs. */
  busy: string | null;
  expanded: boolean;
  onExpand: () => void;
  onToggle: () => void;
  onEngine: (engine: PluginEngineId, want: boolean) => void;
  onRemove: () => void;
  /** 勾选（批量启用/停用/删除的源）。 */
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
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
        {/* 勾选：批量启用/停用/删除的源。点勾不能顺带展开详情 —— 两件事。 */}
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onCheckedChange(e.target.checked)}
          onClick={(e) => e.stopPropagation()}
          className="h-3.5 w-3.5 shrink-0 accent-accent"
          aria-label={plugin.name}
          data-plugin-check={plugin.name}
        />
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
            {/* 【MC-030】读不了的插件目录:必须在这一行说清原因,不能让它看起来
                像"装了个空插件"(组件的 0 是读不出来,不是没声明)。 */}
            {(plugin.problems?.length ?? 0) > 0 && (
              <span className="mt-0.5 block text-[0.8em] text-warning" data-plugin-problems={plugin.name}>
                {t("settings.plugins.problems", { n: plugin.problems!.length })}:{plugin.problems!.join(";")}
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
        {/* 【MC-061】用户给插件携带的 hook **逐条授权**的入口 —— 这块此前在渲染端
            一处都没有(签发 IPC 早就有,面板没接通,于是"默认拒绝"成了"永远拒绝")。 */}
        {plugin.components.hooks.length > 0 && <HookGrantsSection plugin={plugin} />}
        <ComponentDetails plugin={plugin} showProviders={false} />
        <div className="mt-2.5 break-all text-[0.7143em] text-content-subtle">
          {t("settings.plugins.pathLabel")}: <span className="font-mono">{plugin.rootDir}</span>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────── plugin hook grants (MC-061) ─────────────────── */

/** The user-facing grant issuance / list / revoke surface for the plugin's own
 *  hooks. Reads grants over `useRpc` (house rule 7); the issue / revoke calls
 *  are mutations and stay explicit `await api.*` in the handlers.
 *
 *  A plugin row is rendered once per expanded plugin, so this section owns its
 *  own fetch — it is only mounted when the row is open. Because the read is a
 *  live list RPC (grants change outside this panel too), it refetches on
 *  mount and after every mutation, and re-computes the active set from the
 *  same `now` the host judges with is not possible here — `now` is read at
 *  render time, and the badge for a grant is derived from the *host-issued*
 *  `expiresAt` / `revoked` it carries. */
function HookGrantsSection({ plugin }: { plugin: PluginState }) {
  const { t } = useI18n();
  const { data, loading, error, refetch } = useRpc(
    () => api.hooks.listHostHookGrants({}),
    [],
    { toastOnError: false },
  );
  const grants: HostHookGrant[] = data?.grants ?? [];
  // Per-hook in-flight marker ("issue:<event>" / "revoke:<grantId>"), so the
  // busy state disables just the control that fired.
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * 【MC-061 残余】订阅「主机 hook 授权变了」推送 —— 授权**签发 / 撤销 / 用尽**时主进程推一条,
   * 这一块据此**重读**(不必等用户手动切页)。推送带 `pluginId`,所以只在该条说的就是**本插件**
   * 时重读(判据走纯函数 {@link shouldRefetchHookGrants});别的插件的授权变了不该让这一块也重拉。
   *
   * `refetch` 有意**不进依赖数组**:`useRpc` 的 `refetch` 每次渲染都是新函数(它是个稳定的
   * `run` 回调,但引用会变),放进依赖会反复重订阅。这里只按 `plugin.name` 重订阅 —— 订阅逻辑
   * 只用到它。`refetchRef` 保证回调里调到的永远是最新那份 `refetch`。
   *
   * 手机端 `webApi.ts` 没有这条推送(空实现返回 no-op 的退订函数),`?.` 兜住老 preload ——
   * 与 `LibrarySection` 订阅 `library:changed` 是同一姿势。
   */
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  useEffect(() => {
    const off = window.api?.on?.hostHookGrantsChanged?.((msg) => {
      if (shouldRefetchHookGrants(plugin.name, msg.pluginId)) void refetchRef.current();
    });
    return off;
  }, [plugin.name]);

  const now = Date.now();
  const pluginGrantList = pluginGrants(grants, plugin.name);
  const activeCount = activePluginGrants(grants, plugin.name, now).length;

  const authorize = async (hook: PluginHookSummary) => {
    setPending(`issue:${hook.event}`);
    setActionError(null);
    try {
      // 递的是命令/matcher **原文**;宿主用唯一一份摘要函数算 commandDigest ——
      // 与面板(execution=granted)同一份来源身份,不会分家。
      const res = await api.hooks.issueHostHookGrant(hookGrantIssueInput(plugin, hook));
      if (!res.ok) {
        setActionError(t("settings.plugins.hookGrants.issueFailed", { error: res.error ?? "" }));
        return;
      }
      await refetch();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setPending(null);
    }
  };

  const revoke = async (grantId: string) => {
    setPending(`revoke:${grantId}`);
    setActionError(null);
    try {
      const res = await api.hooks.revokeHostHookGrant({ grantId });
      if (!res.ok) {
        setActionError(t("settings.plugins.hookGrants.revokeFailed", { error: res.error ?? "" }));
        return;
      }
      await refetch();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      data-testid={`plugins-hook-grants-${plugin.name}`}
      className="mb-2.5 border-b border-edge pb-2.5"
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[0.7143em] font-semibold text-content-muted">
        <IconShieldCheck size={13} className="shrink-0 text-content-subtle" />
        {t("settings.plugins.hookGrants.title")}
        <InfoHint>{t("settings.plugins.hookGrants.desc")}</InfoHint>
      </div>

      {actionError !== null && (
        <ErrorNote tone="danger" className="mb-2">
          {actionError}
        </ErrorNote>
      )}
      {error !== null && (
        <ErrorNote tone="warning" className="mb-2">
          {t("settings.plugins.hookGrants.listFailed", { error: error.message })}
        </ErrorNote>
      )}

      {/* One row per declared hook: what it is, its current grant state and the
          authorize / revoke control. */}
      <div className="space-y-1.5">
        {plugin.components.hooks.map((hook, i) => {
          const granted = hook.execution === "granted";
          const unmappable = hook.execution === "unmappable";
          const issuing = pending === `issue:${hook.event}`;
          return (
            <div
              key={`${hook.event}:${hook.command}:${i}`}
              className="rounded border border-edge bg-surface/50 px-2 py-1.5"
            >
              <div className="flex items-center gap-2.5 text-[0.75em]">
                <span className="min-w-0 flex-1 break-all">
                  <span className="font-mono text-content">{hook.event}</span>
                  {hook.matcher && <span className="font-mono text-content-subtle"> ({hook.matcher})</span>}
                  :{" "}
                  <span className="font-mono text-content-muted">{hook.command}</span>
                </span>
                {granted ? (
                  <Badge variant="success" className="shrink-0">
                    {t("settings.plugins.hookGrants.grantedBadge")}
                  </Badge>
                ) : unmappable ? (
                  <Badge variant="warning" className="shrink-0">
                    {t("settings.plugins.hookGrants.unmappableBadge")}
                  </Badge>
                ) : (
                  <Badge variant="neutral" className="shrink-0">
                    {t("settings.plugins.hookGrants.pendingBadge")}
                  </Badge>
                )}
                {/* 已授权 / 不可映射的 hook 不再给"授权"按钮:前者已授过(要撤去下面的
                    授权列表撤,那里按 grantId 精确到某一份),后者签了也不生效。给一个
                    签了没用 / 点不通的按钮比不给更坏。 */}
                {canAuthorizeHook(hook) && (
                  <Button
                    variant="primary"
                    size="sm"
                    className="h-6 shrink-0"
                    disabled={pending !== null}
                    data-testid={`hook-authorize-${plugin.name}-${hook.event}`}
                    onClick={() => void authorize(hook)}
                  >
                    {issuing && <IconLoader2 size={12} className="animate-spin" />}
                    {t("settings.plugins.hookGrants.authorize")}
                  </Button>
                )}
              </div>
              {unmappable && (
                <div className="mt-1 text-[0.7143em] leading-relaxed text-content-subtle">
                  {t("settings.plugins.hookGrants.unmappableHint")}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* The live grants themselves — the user must be able to SEE what is
          currently authorized (not only infer it from the badge), and revoke
          one. Inactive (revoked / expired) grants are listed too so a revoke
          does not make a row vanish. */}
      <div className="mt-2.5">
        <div className="mb-1 flex items-center gap-1.5 text-[0.7143em] font-semibold text-content-muted">
          {t("settings.plugins.hookGrants.activeListTitle")}
          <span className="tabular-nums text-content-subtle">{activeCount}</span>
          {loading && <Spinner size="xs" className="text-content-subtle" />}
        </div>
        {pluginGrantList.length === 0 ? (
          <div className="text-[0.7143em] text-content-subtle">
            {t("settings.plugins.hookGrants.activeListEmpty")}
          </div>
        ) : (
          <ul className="space-y-1">
            {pluginGrantList.map((g) => {
              const live = !g.revoked && now < g.expiresAt;
              const revoking = pending === `revoke:${g.grantId}`;
              return (
                <li
                  key={g.grantId}
                  className="flex items-center gap-2 text-[0.7143em] text-content-muted"
                >
                  <span className="shrink-0 font-mono text-content-subtle">{g.grantId}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {g.version ? `v${g.version} · ` : ""}
                    {g.events.length > 0 ? g.events.join(", ") : t("settings.plugins.engineDeclared")}
                  </span>
                  {g.revoked ? (
                    <Badge variant="neutral" className="shrink-0">
                      {t("settings.plugins.hookGrants.revokedBadge")}
                    </Badge>
                  ) : now >= g.expiresAt ? (
                    <Badge variant="warning" className="shrink-0">
                      {t("settings.plugins.hookGrants.expiredBadge")}
                    </Badge>
                  ) : (
                    <Badge variant="success" className="shrink-0">
                      {t("settings.plugins.hookGrants.grantedBadge")}
                    </Badge>
                  )}
                  {live && (
                    <span className="shrink-0 text-content-subtle">
                      {t("settings.plugins.hookGrants.expiresAt", {
                        time: new Date(g.expiresAt).toLocaleString(),
                      })}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 gap-1 text-danger"
                    disabled={pending !== null || g.revoked}
                    data-testid={`hook-revoke-${g.grantId}`}
                    onClick={() => void revoke(g.grantId)}
                  >
                    {revoking ? (
                      <IconLoader2 size={12} className="animate-spin" />
                    ) : (
                      <IconLock size={12} />
                    )}
                    {t("settings.plugins.hookGrants.revoke")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
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
                      ? "bg-surface-hover text-content ring-1 ring-inset ring-edge/70"
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

export function PluginReviewDialog({
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
          {/* 带 hooks 的插件:审查卡顶部固定一条「这些 hooks 不会执行」——**不**放进
              下面可滚动的组件清单里(那里会随滚动滑走,等于把一件事降级成提示)。
              报告 MSP4:用户易以为「装了插件 = hooks 生效」,所以这条要显式、不可忽略。 */}
          {plugin.components.hooks.length > 0 && (
            <div data-testid="plugins-review-hooks-banner" className="mx-4 mt-2 shrink-0">
              <ErrorNote tone="warning" icon={IconAlertTriangle}>
                {t("settings.plugins.hooksNotExecuted", { n: plugin.components.hooks.length })}
              </ErrorNote>
            </div>
          )}
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
  // **同步**的提交闸 —— `busy` 是 `ops.busyKey` 派生来的 React state,`onBusy()`
  // 到重渲染之间有一小段窗口:这段里回车键(和按钮连点)能再进 `submit()`,
  // 发第二次 `installGit`(会真的重新克隆一遍)。按钮的 `disabled` 挡不住回车,
  // 所以这里用 ref 同步拦一道(同 QuestionPrompt / FileTree 的 submittingRef 写法)。
  const submittingRef = useRef(false);

  const submit = async () => {
    if (submittingRef.current) return;
    const trimmed = url.trim();
    if (!trimmed) return;
    submittingRef.current = true;
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
    } finally {
      submittingRef.current = false;
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
          if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) void submit();
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
export function MarketplacePane({
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
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-edge px-3 py-2 text-[0.8571em] font-medium text-content-muted transition-colors hover:border-edge/80 hover:bg-surface-hover hover:text-content"
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
            if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) void addGit();
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
          <span className="shrink-0 rounded bg-surface-hover px-1.5 py-0.5 text-[0.72em] text-content-muted">
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
            className={cn("text-content-subtle hover:text-content", fetching && "animate-spin")}
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
              <span className="shrink-0 rounded bg-surface-hover px-1.5 py-0.5 text-[0.75em] text-content-muted">
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
                ? "bg-surface-hover text-content"
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
