/**
 * MCP 服务器管理面板 — Settings 页 "MCP" 菜单。
 *
 * 列出两类 MCP server 并提供开关 / 新增 / 编辑 / 删除 / 导入:
 *  - 用户级:`~/.mcode/.claude.json` 的 mcpServers(所有项目可用,由 claude
 *    binary 自动加载)。关闭 = 配置移出文件暂存到 settings 表;开启 = 移回。
 *  - 内置:进程内 mcode-browser server(应用内浏览器工具)。
 *
 * 三个 tab,与技能页同一个管理模型(总库 / 项目 / 节点):
 *  - 总库:上面两类 + 插件带来的服务器(按插件分组;插件层对某引擎关掉时那个开关变灰);
 *  - 项目:`<项目>/.mcp.json`,由 Mcode 自己读、只投递信任过的条目(见 ProjectMcpView);
 *  - 节点:哪些工作流节点 / 代理档案挂了哪个服务器(只读反查)。
 *
 * 改动自下一轮对话起生效(startTurn 每轮重建 options);Claude / Codex 生效,
 * Pi 没有 MCP。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { PANEL_MAX_W } from "./panelWidth.js";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import {
  Button,
  ConfirmDialog,
  Dialog,
  Switch,
} from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";
import {
  McpIcon,
  IconPlus,
  IconTrash,
  IconDownload,
  IconLoader2,
  IconExternalLink,
  IconLockOpen,
  IconPencil,
  IconServer,
  IconFileText,
} from "@renderer/lib/icons.js";
import { NODE_MCP_PARAM_KEY } from "@contracts/nodeType";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { ScopeTabs, useManagedProject } from "./ScopeTabs.js";
import { McpMarketView } from "./McpMarketView.js";
// 两个对话框从 `McpPanelParts.tsx` 拆出（纯搬迁，见那边文件头）。
import { AddServerDialog, ImportMcpDialog } from "@renderer/components/settings/McpPanelParts.js";
import { ProjectMcpView } from "./ProjectMcpView.js";
import { SkillNodesView } from "./SkillNodesView.js";
import {
  MCP_RESERVED_NAME,
  isReservedMcpServerName,
  type McpImportOrigin,
  type McpImportSource,
  type McpKind,
  type McpProjectServer,
  type McpScope,
  type McpServerConfig,
  type McpServerEntry,
  MCP_NAME_RE,
} from "@contracts/ipc";

/** Group key for the global scope. A plain string so the project-path groups
 *  and this one can live in the same record; the sentinel shares no shape
 *  with a real path (absolute paths start with a drive letter or a slash),
 *  so it cannot collide. Written as visible text, not an escape, so the file
 *  stays plain ASCII and git never mistakes it for binary. */
export const GLOBAL_ORIGIN_KEY = "<global>";

/** Group/sort/selection key for a scan source. Both the grouping record and
 *  the selection Set (`origin:name`) key on this, so it must be stable across
 *  renders — deriving it from the contract shape rather than formatting the
 *  origin for display is what keeps it so. */
export function originKey(origin: McpImportOrigin): string {
  return origin.kind === "global" ? GLOBAL_ORIGIN_KEY : origin.path;
}

/** Stable empty array (avoids per-render new references — store convention). */
const EMPTY_SERVERS: McpServerEntry[] = [];

/** Row identity across reloads (a name can exist under multiple scopes). */
function rowKey(s: { scope: McpScope; name: string }): string {
  return `${s.scope}:${s.name}`;
}

/** Transport badge label key per kind (same badge family as SkillsPanel).
 *  stdio/http/sse are proper transport names; only "builtin" localizes. */
const KIND_LABEL: Record<McpKind, MessageId | null> = {
  stdio: null,
  http: null,
  sse: null,
  builtin: "settings.mcp.builtinKind",
};
/** Raw (untranslated) label for the non-localizable kinds. */
const KIND_RAW: Partial<Record<McpKind, string>> = {
  stdio: "stdio",
  http: "http",
  sse: "sse",
};
const KIND_BADGE_CLS: Record<McpKind, string> = {
  stdio: "bg-accent/12 text-accent",
  http: "bg-purple-500/15 text-purple-500",
  sse: "bg-blue-500/15 text-blue-500",
  builtin: "bg-surface-hover text-content-subtle",
};

export function KindBadge({ kind }: { kind: McpKind }) {
  const { t } = useI18n();
  const labelKey = KIND_LABEL[kind];
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 text-[9px] leading-tight",
        KIND_BADGE_CLS[kind],
      )}
    >
      {labelKey ? t(labelKey) : KIND_RAW[kind]}
    </span>
  );
}

/** Per-engine visibility chips (claude / codex) — the same matrix the engines
 *  load from (missing = enabled; pi has no MCP support so there is no third
 *  chip). A dimmed, struck-through chip = that engine cannot see the server.
 *  Shared by the user-scope and plugin sections; builtin rows have no chips
 *  (they follow the browserDisabled toggle only). */
function EngineVisibilityChips({
  s,
  busy,
  onToggle,
}: {
  s: McpServerEntry;
  busy: boolean;
  onToggle: (s: McpServerEntry, engine: "claude" | "codex") => void;
}) {
  const { t } = useI18n();
  const current = s.perEngine ?? { claude: true, codex: true };
  const blockedBy = s.pluginEngines;
  return (
    <div
      className="flex shrink-0 items-center gap-1"
      role="group"
      aria-label={t("settings.mcp.engines")}
      title={t("settings.mcp.enginesHint")}
    >
      {(["claude", "codex"] as const).map((engine) => {
        const on = current[engine];
        const label = engine === "claude" ? "Claude" : "Codex";
        // 插件层(插件面板)对这个引擎关掉了:这一格怎么点都送不到,画成虚线框提示去插件页。
        const blocked = blockedBy?.[engine] === false;
        return (
          <button
            key={engine}
            type="button"
            role="switch"
            aria-checked={on}
            disabled={busy}
            onClick={() => onToggle(s, engine)}
            title={
              blocked
                ? t("settings.skills.pluginEngineOffNamed", { engine: label, plugin: s.pluginName ?? "" })
                : on
                  ? t("settings.mcp.engineOnHint", { engine: label })
                  : t("settings.mcp.engineOffHint", { engine: label })
            }
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight transition-colors",
              on && !blocked
                ? "bg-surface-hover text-content ring-1 ring-inset ring-edge/70"
                : "bg-surface-hover text-content-subtle line-through decoration-content-subtle/60",
              blocked && "border border-dashed border-warning/60",
            )}
          >
            {engine === "claude" ? "Claude" : "Codex"}
          </button>
        );
      })}
    </div>
  );
}

/** Right-side extras for a remote server's OAuth state: 「已授权」badge +
 *  sign-out (a stored token exists), or 「待授权」badge + browser login (the
 *  CLI flagged the server as requiring OAuth with no token). Renders nothing
 *  for local servers or remote ones with no known OAuth history. */
function OAuthRowActions({
  s,
  busy,
  onAuthorize,
  onUnauthorize,
}: {
  s: McpServerEntry;
  busy: boolean;
  onAuthorize: () => void;
  onUnauthorize: () => void;
}) {
  const { t } = useI18n();
  if (s.authorized) {
    return (
      <>
        <span
          title={t("settings.mcp.unauthorizeHint")}
          className="shrink-0 rounded bg-emerald-500/15 px-1 text-[9px] leading-tight text-emerald-500"
        >
          {t("settings.mcp.authorized")}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1"
          disabled={busy}
          onClick={onUnauthorize}
          title={t("settings.mcp.unauthorizeHint")}
        >
          {busy ? <IconLoader2 size={12} className="animate-spin" /> : <IconLockOpen size={12} />}
          {t("settings.mcp.unauthorize")}
        </Button>
      </>
    );
  }
  if (!s.needsAuth) return null;
  return (
    <>
      <span
        title={t("settings.mcp.authorizeHint")}
        className="shrink-0 rounded bg-amber-500/15 px-1 text-[9px] leading-tight text-amber-500"
      >
        {t("settings.mcp.needsAuth")}
      </span>
      <Button
        variant="secondary"
        size="sm"
        className="gap-1"
        disabled={busy}
        onClick={onAuthorize}
        title={t("settings.mcp.authorizeHint")}
      >
        {busy ? <IconLoader2 size={12} className="animate-spin" /> : <IconExternalLink size={12} />}
        {t("settings.mcp.authorize")}
      </Button>
    </>
  );
}

export function McpPanel() {
  const { t } = useI18n();

  const [servers, setServers] = useState<McpServerEntry[]>(EMPTY_SERVERS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Row key of an in-flight toggle (disables that row's switch only).
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // 非空 = 对话框处于编辑模式(预填该行 config,保存走 replace 通道)。
  const [editServer, setEditServer] = useState<McpServerEntry | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<McpServerEntry | null>(null);
  // 三个 tab(总库 / 项目 / 节点)+ 总库的搜索词。
  const [view, setView] = useState<"library" | "project" | "nodes" | "market">("library");
  const [marketSeen, setMarketSeen] = useState(false);
  useEffect(() => {
    if (view === "market") setMarketSeen(true);
  }, [view]);
  const [query, setQuery] = useState("");
  const { project, projects, setManagedProjectId } = useManagedProject();
  // 新增 / 编辑对话框的目标:null = 总库(用户级);非空 = 这个项目的 .mcp.json。
  const [dialogProject, setDialogProject] = useState<string | null>(null);
  const [projectRefresh, setProjectRefresh] = useState(0);
  // 勾选（批量启用/停用/删除）。用户 2026-10-11：「每个集合没有批量管理，批量选择」。
  // ⚠️ 只有**用户级**那组能勾：插件带来的服务器归插件管、内置的不可删 —— 同技能页
  //    "只有总库可勾选复制"、插件页"只有已装的可勾"是同一条规矩。
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  // GenOffice 一键安装:null = 空闲;安装是短动作(解析路径 + 写真相层 + 物化),
  // 但围栏根多时物化两个引擎视图要写两三个文件,给个行内 spinner。
  const [genofficeBusy, setGenofficeBusy] = useState(false);

  /** `load` 的序号守卫 —— 它在挂载/每次 toggle/authorize/import 后都会并发触发,
   *  旧回包(成功或失败)不能盖掉更新的那次。 */
  const loadSeqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const { servers: list } = await api.mcp.list({});
      if (seq !== loadSeqRef.current) return; // 有更新的一次在飞,这次作废
      setServers(list.length ? list : EMPTY_SERVERS);
      setError(null); // 成功即清掉旧错误横幅,否则一次失败会黏住
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      console.error("McpPanel load failed:", err);
      setError((err as Error).message);
      // ⚠️ **不清空列表。** 一次瞬时 list 失败不该把用户已配置的行全抹掉 —— 那比
      // 保留旧数据 + 一条错误横幅糟得多(用户得重开面板才恢复)。保留上次成功的列表。
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (s: McpServerEntry) => {
    setError(null);
    setBusyKey(rowKey(s));
    try {
      const res = await api.mcp.toggle({
        name: s.name,
        scope: s.scope,
        enabled: !s.enabled,
      });
      // 先 `load()` 再报错:`load` 成功时会 `setError(null)` 清旧横幅 —— 顺序反了
      // 就把这次的失败横幅一起清掉,toggle 失败时用户看到开关弹回、屏幕上一句话没有。
      await load();
      if (!res.ok) setError(res.error ?? t("settings.operationFailed"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  /** Toggle one server's per-engine visibility (claude/codex). The full
   *  desired pair is sent; the resolved state comes back and updates the row
   *  so the chips render exactly what's on disk. Both engine views
   *  re-materialize main-side; each engine picks it up on its next turn. */
  const setEngineVisibility = async (s: McpServerEntry, engine: "claude" | "codex") => {
    const current: Record<"claude" | "codex", boolean> = s.perEngine ?? { claude: true, codex: true };
    const wanted = { ...current, [engine]: !current[engine] };
    setError(null);
    setBusyKey(rowKey(s));
    try {
      const res = await api.mcp.enginesSet({ name: s.name, ...wanted });
      if (!res.ok || !res.perEngine) {
        setError(res.error ?? t("settings.operationFailed"));
        return;
      }
      const resolved = res.perEngine;
      setServers((prev) =>
        prev.map((x) => (x.scope === s.scope && x.name === s.name ? { ...x, perEngine: resolved } : x)),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const confirmDelete = async () => {
    const target = pendingDelete;
    if (!target) return { ok: true };
    setError(null);
    try {
      const res = await api.mcp.remove({ name: target.name });
      // 同 `toggle`:先重拉(它成功会清旧横幅)再挂这次的错误,否则删失败的提示被 `load` 清掉。
      await load();
      if (!res.ok) setError(res.error ?? t("settings.deleteFailed"));
      // 失败交给 ConfirmDialog 保留弹窗显示(UI-001);成功才让它关闭。
      return res;
    } catch (err) {
      setError((err as Error).message);
      throw err; // 让 ConfirmDialog 保留弹窗,不假装删除成功
    }
  };

  /** 勾选批量的启用/停用。后端 `mcp.toggle` 是单条，前端逐条循环 —— 同技能页 /
   *  插件页的既有做法。只作用于勾中的用户级服务器（只有那组能勾）。 */
  const bulkSetEnabled = async (want: boolean) => {
    const targets = servers.filter(
      (s) => s.scope === "user" && checked.has(s.name) && s.enabled !== want,
    );
    if (!targets.length) return;
    setError(null);
    const failures: string[] = [];
    for (const s of targets) {
      setBusyKey(rowKey(s));
      try {
        const res = await api.mcp.toggle({ name: s.name, scope: s.scope, enabled: want });
        if (!res.ok) failures.push(`${s.name}: ${res.error ?? t("settings.operationFailed")}`);
      } catch (err) {
        failures.push(`${s.name}: ${(err as Error).message}`);
      }
    }
    setBusyKey(null);
    await load();
    if (failures.length) setError(failures.join("; "));
  };

  /** 勾选批量的删除。危险动作，走确认框；失败如实计数。返回结果交给
   *  ConfirmDialog —— 只要有失败的就不让它静默关闭(UI-001)。 */
  const bulkDelete = async () => {
    const targets = servers.filter((s) => s.scope === "user" && checked.has(s.name));
    if (!targets.length) return { ok: true };
    setError(null);
    const failures: string[] = [];
    const removed = new Set<string>();
    for (const s of targets) {
      setBusyKey(rowKey(s));
      try {
        const res = await api.mcp.remove({ name: s.name });
        if (res.ok) removed.add(s.name);
        else failures.push(`${s.name}: ${res.error ?? t("settings.deleteFailed")}`);
      } catch (err) {
        failures.push(`${s.name}: ${(err as Error).message}`);
      }
    }
    setBusyKey(null);
    if (removed.size) setChecked((prev) => new Set([...prev].filter((n) => !removed.has(n))));
    await load();
    if (failures.length) {
      setError(failures.join("; "));
      // 有失败的:保留弹窗并显示原因,不假装批量删除都成功了。
      return { ok: false, error: failures.join("; ") };
    }
    return { ok: true };
  };

  /** OAuth browser login for a remote server flagged needsAuth. Blocks until
   *  the CLI reports the flow done (success or failure) — the button spins
   *  meanwhile; the browser tab does the actual Canva/… account login. */
  const authorize = async (s: McpServerEntry) => {
    setError(null);
    setBusyKey(rowKey(s));
    try {
      const res = await api.mcp.authorize({
        name: s.name,
        // For http/sse rows `detail` IS the server URL (the describers put
        // nothing else there — verified for user/plugin scopes).
        url: s.detail,
        kind: s.kind === "sse" ? "sse" : "http",
        // The main process resolves the server's real config (headers
        // included) by name; scope pins WHICH source to read, since a name can
        // exist in both user and plugin scope.
        scope: s.scope,
      });
      // 同 `toggle`:授权失败那句话必须在 `load()` 之后写,否则被成功重拉的 `setError(null)` 清掉。
      await load();
      if (!res.ok) setError(t("settings.mcp.authorizeFailed", { error: res.error ?? "" }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  /** Clear a remote server's stored OAuth token (claude mcp logout). Same
   *  identity (name + URL) as authorize — credentials are keyed by both. */
  const unauthorize = async (s: McpServerEntry) => {
    setError(null);
    setBusyKey(rowKey(s));
    try {
      const res = await api.mcp.unauthorize({
        name: s.name,
        url: s.detail,
        kind: s.kind === "sse" ? "sse" : "http",
        scope: s.scope,
      });
      // 同 `toggle`:取消授权失败的话也要在 `load()` 之后挂,否则被清。
      await load();
      if (!res.ok) setError(t("settings.mcp.unauthorizeFailed", { error: res.error ?? "" }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  /** 一键安装随仓库快照的 GenOffice 文档工具(见 ipc/mcp.ts 的
   *  MCP_GENOFFICE_INSTALL)。入口是用户点出来的而不是随启动预置:这条配置会让
   *  引擎每轮拉起一个本地进程,与「新增 MCP server」同一件事。
   *  已存在时传 replace —— 重装就是**刷新围栏根快照**的方式(新项目/工作树
   *  不进旧快照,见 genofficeMcp.ts 文件头「围栏是快照」)。 */
  const installGenoffice = async () => {
    setError(null);
    setGenofficeBusy(true);
    try {
      const res = await api.mcp.genofficeInstall({ replace: true });
      // 先重拉(成功会清旧横幅),再把这次失败挂上去 —— 同 toggle 的顺序讲究。
      await load();
      if (!res.ok) {
        setError(t("settings.mcp.genofficeInstallFailed", { reason: res.reason }));
        return;
      }
      useToastStore.getState().push({
        kind: "info",
        title: t("settings.mcp.genofficeInstallSuccess", { name: res.name, n: res.roots.length }),
      });
    } catch (err) {
      setError(t("settings.mcp.genofficeInstallFailed", { reason: (err as Error).message }));
    } finally {
      setGenofficeBusy(false);
    }
  };

  const q = query.trim().toLowerCase();
  const matches = (s: McpServerEntry): boolean =>
    !q || s.name.toLowerCase().includes(q) || s.detail.toLowerCase().includes(q);
  const allUserServers = servers.filter((s) => s.scope === "user");
  const userServerNames = new Set(allUserServers.map((s) => s.name));
  // 安装卡片的文案随「已装 / 未装」切换:已装时按钮是「重新安装(刷新工作区根)」。
  const genofficeInstalled = userServerNames.has("genoffice");
  const userServers = allUserServers.filter(matches);
  const pluginServers = servers.filter((s) => s.scope === "plugin" && matches(s));
  const builtin = servers.find((s) => s.scope === "builtin");
  // 插件服务器按插件分组(插件一多,平铺就分不清谁是谁的)。
  const pluginGroupMap = new Map<string, McpServerEntry[]>();
  for (const s of pluginServers) {
    const key = s.pluginName ?? s.name.split("__")[0] ?? s.name;
    const list = pluginGroupMap.get(key) ?? [];
    list.push(s);
    pluginGroupMap.set(key, list);
  }
  const pluginGroups = [...pluginGroupMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const nodeInventory = useMemo(
    () => servers.filter((s) => s.scope !== "builtin").map((s) => ({ name: s.name, description: s.detail })),
    [servers],
  );

  return (
    <section className={cn("mx-auto w-full space-y-4", PANEL_MAX_W.form)}>
      <PanelHeader
        title={t("settings.mcp.title")}
        icon={McpIcon}
        action={
          <ScopeTabs
            items={[
              { id: "library", label: t("settings.skills.tabLibrary"), count: allUserServers.length },
              { id: "project", label: t("settings.skills.tabProject") },
              { id: "nodes", label: t("settings.skills.tabNodes") },
              { id: "market", label: t("settings.market.tab") },
            ]}
            value={view}
            onChange={setView}
          />
        }
      />

      <div className={cn("flex flex-wrap items-center justify-end gap-2", view === "library" ? "" : "hidden")}>
        {view === "library" && (
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("settings.mcp.searchPlaceholder")}
            aria-label={t("settings.mcp.searchPlaceholder")}
            className="w-[200px] rounded border border-edge bg-surface px-2 py-1 text-[0.7857em] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
          />
        )}
      </div>

      {error && (
        <div className="rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[0.7857em] text-danger">
          {error}
        </div>
      )}

      {view === "project" && (
        <ProjectMcpView
          project={project}
          projects={projects}
          onSelectProject={setManagedProjectId}
          userServers={allUserServers}
          refreshKey={projectRefresh}
          onAdd={(projectPath) => {
            setDialogProject(projectPath);
            setEditServer(null);
            setAddOpen(true);
          }}
          onEdit={(projectPath, server: McpProjectServer) => {
            setDialogProject(projectPath);
            setEditServer({
              name: server.name,
              scope: "user",
              kind: server.kind,
              detail: server.detail,
              enabled: true,
              config: server.config,
            });
            setAddOpen(true);
          }}
        />
      )}

      {view === "nodes" && (
        <SkillNodesView
          skills={nodeInventory}
          paramKey={NODE_MCP_PARAM_KEY}
          hint={t("settings.mcp.nodesHint")}
          empty={t("settings.mcp.nodesEmpty")}
          icon={IconServer}
          onJumpToWorkflow={(workflowId) => useSessionStore.getState().setSettingsOpen(true, "workflows", workflowId)}
          onJumpToProfile={() => useSessionStore.getState().setSettingsOpen(true, "workflows")}
        />
      )}

      {marketSeen && (
        <McpMarketView
          className={view === "market" ? "" : "hidden"}
          visible={view === "market"}
          installedNames={userServerNames}
          onInstalled={() => void load()}
        />
      )}

      <div className={cn("space-y-4", view === "library" ? "" : "hidden")}>
      {/* ───────── GenOffice 文档工具(一键安装) ─────────
          为什么是一个**显眼的按钮卡片**而不是藏在「新增」对话框里:这条条目
          不能靠用户手拼 —— 它必须带 `GENOFFICE_ALLOWED_ROOTS` 围栏,而根集合
          只有主进程算得准(pathGuard 同一批判据)。把生成点留在主进程、把入口
          放在面板最上面,用户点一下得到的就是带围栏的那一份。 */}
      <SettingsSection title={t("settings.mcp.genofficeTitle")} icon={IconFileText}>
        <SettingRow
          title={
            <span className="flex items-center gap-1.5">
              <span className="font-mono">genoffice</span>
              <KindBadge kind="stdio" />
            </span>
          }
          desc={t("settings.mcp.genofficeInstallDesc")}
          descMode="inline"
        >
          <Button
            variant="secondary"
            size="sm"
            className="gap-1"
            disabled={genofficeBusy}
            onClick={() => void installGenoffice()}
          >
            {genofficeBusy ? <IconLoader2 size={12} className="animate-spin" /> : <IconDownload size={12} />}
            {t(genofficeInstalled ? "settings.mcp.genofficeReinstall" : "settings.mcp.genofficeInstall")}
          </Button>
        </SettingRow>
      </SettingsSection>
      {/* 勾选批量条：勾了用户级服务器才出现。 */}
      {checked.size > 0 && (
        <div
          data-testid="mcp-bulk-bar"
          className="flex flex-wrap items-center gap-2 rounded-md border border-edge bg-surface/60 px-3 py-1.5"
        >
          <span className="text-[0.8571em] font-medium text-content-muted">
            {t("settings.mcp.bulkSelected", { n: checked.size })}
          </span>
          <Button variant="ghost" size="sm" data-testid="mcp-bulk-enable" disabled={busyKey != null} onClick={() => void bulkSetEnabled(true)}>
            {t("settings.mcp.bulkEnable")}
          </Button>
          <Button variant="ghost" size="sm" data-testid="mcp-bulk-disable" disabled={busyKey != null} onClick={() => void bulkSetEnabled(false)}>
            {t("settings.mcp.bulkDisable")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid="mcp-bulk-delete"
            disabled={busyKey != null}
            onClick={() => setPendingBulkDelete(true)}
            className="ml-auto gap-1 text-danger hover:bg-danger/10"
          >
            <IconTrash size={12} />
            {t("settings.mcp.bulkDelete")}
          </Button>
          <Button variant="ghost" size="sm" disabled={busyKey != null} onClick={() => setChecked(new Set())}>
            {t("settings.skills.clearSelection")}
          </Button>
        </div>
      )}
      {/* ───────── 用户级 ───────── */}
      <SettingsSection
        title={t("settings.mcp.userSection")}
        desc={t("settings.mcp.userSectionDesc")}
      >
        {/* 手改告警:Mcode 把 .claude.json 的 mcpServers 当**派生视图**整格重写
            (见 lib/mcpConfig.ts 的 materializeClaudeMcpView:视图 = 启用 ∧ 分配给
            claude)。绕过本页直接往文件里加 server,会被下一轮物化覆盖,且不合并 ——
            同名两份来源会分不清谁赢。所以如实告知「此文件由 Mcode 管理」,而不是留个
            用户在 UI 里看不见的脚枪。 */}
        <p className="border-l-2 border-warning/50 px-4 py-2 text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.mcp.managedFileNote")}
        </p>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-[0.7857em] text-content-subtle">
            <IconLoader2 size={14} className="animate-spin" />
            {t("common.loading")}
          </div>
        ) : userServers.length === 0 ? (
          <div className="px-4 py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
            {t("settings.mcp.userEmpty1")}
            <br />
            {t("settings.mcp.userEmpty2")}
          </div>
        ) : (
          userServers.map((s) => (
            <SettingRow
              key={rowKey(s)}
              leading={
                <input
                  type="checkbox"
                  checked={checked.has(s.name)}
                  onChange={(e) =>
                    setChecked((prev) => {
                      const set = new Set(prev);
                      if (e.target.checked) set.add(s.name);
                      else set.delete(s.name);
                      return set;
                    })
                  }
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
                  aria-label={s.name}
                  data-mcp-check={s.name}
                />
              }
              title={
                <span className="flex items-center gap-1.5">
                  <span className="font-mono">{s.name}</span>
                  <KindBadge kind={s.kind} />
                </span>
              }
              desc={<span className="font-mono">{s.detail}</span>}
            >
              <OAuthRowActions
                s={s}
                busy={busyKey === rowKey(s)}
                onAuthorize={() => void authorize(s)}
                onUnauthorize={() => void unauthorize(s)}
              />
              <EngineVisibilityChips
                s={s}
                busy={busyKey === rowKey(s)}
                onToggle={(row, engine) => void setEngineVisibility(row, engine)}
              />
              <Switch
                checked={s.enabled}
                onCheckedChange={() => void toggle(s)}
                disabled={busyKey === rowKey(s)}
                label={t(s.enabled ? "settings.mcp.toggleOff" : "settings.mcp.toggleOn", { name: s.name })}
              />
              <Button
                variant="ghost"
                size="icon"
                title={t("settings.mcp.editServer")}
                disabled={!s.config}
                onClick={() => {
                  setEditServer(s);
                  setAddOpen(true);
                }}
              >
                <IconPencil size={13} className="text-content-subtle" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title={t("settings.mcp.deleteServer")}
                onClick={() => setPendingDelete(s)}
              >
                <IconTrash size={13} className="text-content-subtle" />
              </Button>
            </SettingRow>
          ))
        )}
        <div className="flex justify-end gap-2 px-4 py-2.5">
          <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)} className="gap-1">
            <IconDownload size={12} />
            {t("settings.mcp.importFromCli")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)} className="gap-1">
            <IconPlus size={12} />
            {t("settings.mcp.addServer")}
          </Button>
        </div>
      </SettingsSection>

      {/* ───────── 插件 ───────── */}
      <SettingsSection
        title={t("settings.mcp.pluginSection")}
        desc={t("settings.mcp.pluginSectionDesc")}
      >
        {pluginServers.length === 0 ? (
          <div className="px-4 py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
            {t("settings.mcp.noPluginServers")}
          </div>
        ) : (
          pluginGroups.map(([pluginName, rows]) => (
            <div key={pluginName}>
            <div className="flex items-center gap-1.5 px-4 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-content-subtle/80">
              <span className="truncate">{pluginName}</span>
              <span className="tabular-nums normal-case">{rows.length}</span>
              {rows[0]?.pluginEngines && (["claude", "codex"] as const).some((e) => rows[0]?.pluginEngines?.[e] === false) && (
                <span className="normal-case tracking-normal text-warning">
                  {t("settings.mcp.pluginEnginesOff", {
                    engines: (["claude", "codex"] as const)
                      .filter((e) => rows[0]?.pluginEngines?.[e] === false)
                      .map((e) => (e === "claude" ? "Claude" : "Codex"))
                      .join(" / "),
                  })}
                </span>
              )}
            </div>
            {rows.map((s) => (
            <SettingRow
              key={rowKey(s)}
              title={
                <span className="flex items-center gap-1.5">
                  <span className="font-mono">{s.name}</span>
                  <KindBadge kind={s.kind} />
                </span>
              }
              desc={<span className="font-mono">{s.detail}</span>}
            >
              <OAuthRowActions
                s={s}
                busy={busyKey === rowKey(s)}
                onAuthorize={() => void authorize(s)}
                onUnauthorize={() => void unauthorize(s)}
              />
              <EngineVisibilityChips
                s={s}
                busy={busyKey === rowKey(s)}
                onToggle={(row, engine) => void setEngineVisibility(row, engine)}
              />
              <Switch
                checked={s.enabled}
                onCheckedChange={() => void toggle(s)}
                disabled={busyKey === rowKey(s)}
                label={t(s.enabled ? "settings.mcp.toggleOff" : "settings.mcp.toggleOn", { name: s.name })}
              />
            </SettingRow>
            ))}
            </div>
          ))
        )}
      </SettingsSection>

      {/* ───────── 内置 ───────── */}
      <SettingsSection title={t("settings.mcp.builtinSection")} desc={t("settings.mcp.builtinSectionDesc")}>
        {builtin && (
          <SettingRow
            title={
              <span className="flex items-center gap-1.5">
                <span className="font-mono">{builtin.name}</span>
                <KindBadge kind={builtin.kind} />
              </span>
            }
            desc={builtin.detail}
            descMode="inline"
          >
            <div
              className="flex shrink-0 items-center gap-1"
              role="group"
              aria-label={t("settings.mcp.engines")}
              title={t("settings.mcp.builtinProviderHint")}
            >
              <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium leading-tight text-accent">
                Claude
              </span>
              <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] font-medium leading-tight text-content-subtle line-through decoration-content-subtle/60">
                Codex
              </span>
            </div>
            <Switch
              checked={builtin.enabled}
              onCheckedChange={() => void toggle(builtin)}
              disabled={busyKey === rowKey(builtin)}
              label={t(builtin.enabled ? "settings.mcp.toggleOff" : "settings.mcp.toggleOn", { name: builtin.name })}
            />
          </SettingRow>
        )}
      </SettingsSection>
      </div>

      <ConfirmDialog
        open={pendingDelete != null}
        title={t("settings.mcp.deleteTitle")}
        danger
        description={
          <>
            {t("settings.mcp.deleteDescPre")}
            {pendingDelete?.name}
            {t("settings.mcp.deleteDescMid")}
            <code className="rounded bg-surface-muted px-0.5">~/.mcode/.claude.json</code>
            {t("settings.mcp.deleteDescPost")}
          </>
        }
        confirmText={t("common.delete")}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => confirmDelete()}
      />

      <ConfirmDialog
        open={pendingBulkDelete}
        title={t("settings.mcp.bulkDelete")}
        danger
        description={t("settings.mcp.bulkDeleteDesc", { n: checked.size })}
        confirmText={t("common.delete")}
        onOpenChange={(open) => {
          if (!open) setPendingBulkDelete(false);
        }}
        onConfirm={() => bulkDelete()}
      />

      <AddServerDialog
        open={addOpen}
        editServer={editServer}
        projectPath={dialogProject}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) {
            setEditServer(null);
            setDialogProject(null);
          }
        }}
        onSaved={() => {
          if (dialogProject) setProjectRefresh((n) => n + 1);
          else void load();
        }}
      />
      <ImportMcpDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => void load()}
      />
    </section>
  );
}

/* ───────── Add server dialog ───────── */
