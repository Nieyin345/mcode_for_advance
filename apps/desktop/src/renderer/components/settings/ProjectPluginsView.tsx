/**
 * **项目插件** —— 插件面板的「项目」tab。
 *
 * 插件只在总库装一次;每个项目可以单独决定**启用哪些、对哪个引擎启用**。没设过的插件
 * 跟随总库(行上标「跟随总库」);改过的标「本项目」,可一键恢复跟随。会话的工作目录
 * 落在这个项目里时按这里的结果投递(下一轮生效)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@contracts/session";
import type { PluginEngineId, PluginProjectRow } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button, ErrorNote, Switch } from "@renderer/components/ui/index.js";
import { IconLoader2, IconPuzzle } from "@renderer/lib/icons.js";
import { ProjectPicker } from "./ScopeTabs.js";

const ENGINES: ReadonlyArray<{ id: PluginEngineId; provider: string; label: string }> = [
  { id: "claude", provider: "claude-sdk", label: "Claude" },
  { id: "codex", provider: "codex-sdk", label: "Codex" },
  { id: "pi", provider: "pi-sdk", label: "Pi" },
];

export function ProjectPluginsView({
  project,
  projects,
  onSelectProject,
  refreshKey,
}: {
  project: Project | undefined;
  projects: Project[];
  onSelectProject: (id: string) => void;
  /** Changes identity when the global plugin list reloads (install / enable / remove). */
  refreshKey: unknown;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<PluginProjectRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const projectPath = project?.path;
  /** 请求序号:切项目(或 refreshKey 变)时同一个实例重跑 `load`,先发起的那次
   *  `projectList` 若后回来,会把上一个项目的插件行画到**新项目**的这一页。 */
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    if (!projectPath) return;
    const seq = ++loadSeqRef.current;
    try {
      const res = await api.plugins.projectList({ projectPath });
      if (seq !== loadSeqRef.current) return; // superseded (project switched)
      setRows(res.plugins);
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setError((err as Error).message);
      setRows([]);
    }
  }, [projectPath]);

  useEffect(() => {
    setRows(null);
    setError(null);
    void load();
  }, [load, refreshKey]);

  const apply = async (
    key: string,
    patch: { name: string; enabled?: boolean | null; engines?: Partial<Record<PluginEngineId, boolean>> | null },
  ) => {
    if (!projectPath) return;
    setBusy(key);
    setError(null);
    try {
      const res = await api.plugins.projectSet({ projectPath, ...patch });
      if (!res.ok) setError(res.error ?? t("settings.operationFailed"));
      await load();
      // The composer's `/` menu lists plugin skills — keep it in sync.
      void useSessionStore.getState().reloadSkills();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () => (rows ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)),
    [rows, q],
  );

  if (!project || !projectPath) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="text-[0.8571em] leading-relaxed text-content-muted">{t("settings.plugins.projectNoProject")}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto pr-1">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-edge bg-surface/40 px-3 py-2">
        <ProjectPicker project={project} projects={projects} onSelect={onSelectProject} disabled={busy !== null} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("settings.plugins.searchPlaceholder")}
          aria-label={t("settings.plugins.searchPlaceholder")}
          className="w-[200px] rounded border border-edge bg-surface px-2 py-1 text-[0.7857em] text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
        />
      </div>
      <p className="px-1 text-[0.7857em] leading-relaxed text-content-subtle">{t("settings.plugins.projectHint")}</p>
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="rounded-md border border-edge bg-surface/40">
        {rows === null ? (
          <div className="flex items-center justify-center gap-2 py-6 text-[0.7857em] text-content-subtle">
            <IconLoader2 size={14} className="animate-spin" />
            {t("common.loading")}
          </div>
        ) : visible.length === 0 ? (
          <div className="px-4 py-6 text-center text-[0.7857em] text-content-subtle">
            {rows.length === 0 ? t("settings.plugins.projectEmpty") : t("settings.plugins.searchEmpty", { query: query.trim() })}
          </div>
        ) : (
          visible.map((r) => {
            const custom = r.override !== undefined;
            const rowBusy = busy !== null;
            return (
              <div key={r.name} className="flex items-center gap-2 border-b border-edge/60 px-3 py-2 last:border-b-0">
                <IconPuzzle size={14} className="shrink-0 text-content-subtle" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[0.8571em] font-medium text-content">{r.name}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded px-1 text-[9px] leading-tight",
                        custom ? "bg-accent/15 text-accent" : "bg-surface-hover text-content-subtle",
                      )}
                      title={custom ? undefined : t("settings.plugins.projectFollowHint", {
                        state: r.globalEnabled ? t("settings.plugins.projectGlobalOn") : t("settings.plugins.projectGlobalOff"),
                      })}
                    >
                      {custom ? t("settings.plugins.projectCustom") : t("settings.plugins.projectFollow")}
                    </span>
                  </div>
                  {r.description && (
                    <div className="truncate text-[0.7143em] text-content-subtle" title={r.description}>{r.description}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1" role="group" aria-label={t("settings.skills.engines")}>
                  {ENGINES.map((e) => {
                    const capable = r.compatibleProviderIds.includes(e.provider);
                    const on = r.engines[e.id];
                    const delivered = r.deliveredProviderIds.includes(e.provider);
                    return (
                      <button
                        key={e.id}
                        type="button"
                        role="switch"
                        aria-checked={on}
                        disabled={rowBusy || !capable}
                        onClick={() => void apply(`e:${r.name}`, { name: r.name, engines: { [e.id]: !on } })}
                        title={!capable ? t("settings.plugins.projectEngineIncapable", { engine: e.label }) : e.label}
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight transition-colors",
                          delivered
                            ? "bg-accent/15 text-accent"
                            : "bg-surface-hover text-content-subtle line-through decoration-content-subtle/60",
                          !capable && "opacity-40",
                        )}
                      >
                        {e.label}
                      </button>
                    );
                  })}
                </div>
                <Switch
                  checked={r.enabled}
                  disabled={rowBusy}
                  onCheckedChange={() => void apply(`s:${r.name}`, { name: r.name, enabled: !r.enabled })}
                  label={r.name}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(!custom && "invisible")}
                  disabled={rowBusy || !custom}
                  onClick={() => void apply(`r:${r.name}`, { name: r.name, enabled: null, engines: null })}
                >
                  {t("settings.plugins.projectReset")}
                </Button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
