/**
 * 技能市场 —— 设置 → Skills 的「市场」tab。
 *
 * 源 = 一个装着若干 SKILL.md 目录的仓库(内置 anthropics/skills、openai/skills,
 * 用户可加任意 git 仓库 / GitHub `owner/repo` / 本地文件夹)。内置源第一次被看到
 * 时才拉取(和插件市场同一个规矩)。安装 = 复制进总库(`~/.mcode/skills`),同名跳过;
 * 装好的技能出现在「总库」tab,引擎开关在那里调。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SkillMarketState } from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useMarketProgress } from "./useMarketProgress.js";
import { MarketView, type MarketRow } from "./MarketView.js";

export function SkillMarketView({
  className,
  visible,
  onInstalled,
  onCountChange,
}: {
  className?: string;
  /** This tab is shown — gates the first-look fetch of built-in catalogs. */
  visible: boolean;
  /** Skills landed in the library (refresh the library list). */
  onInstalled: () => void;
  onCountChange?: (n: number) => void;
}) {
  const { t } = useI18n();
  const marketProgress = useMarketProgress();
  const [markets, setMarkets] = useState<SkillMarketState[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await api.skills.marketList({});
      setMarkets(res.markets ?? []);
      return res.markets ?? [];
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (visible && !loaded) void reload();
  }, [visible, loaded, reload]);

  const total = markets.reduce((n, m) => n + m.skills.length, 0);
  useEffect(() => {
    onCountChange?.(total);
  }, [total, onCountChange]);

  const active = markets.find((m) => m.name === activeName) ?? markets[0] ?? null;

  const refresh = async (name: string) => {
    setBusyKey(`refresh:${name}`);
    setError(null);
    try {
      const res = await marketProgress.run(requestId => api.skills.marketRefresh({ name, requestId }));
      if (!res.ok) setError(t("settings.market.refreshFailed", { error: res.error ?? "" }));
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  // Built-in catalogs are listed unfetched — fetch one the first time it is
  // actually looked at (one attempt per mount; failures leave the refresh button).
  const tried = useRef<Set<string>>(new Set());
  const refreshRef = useRef<(name: string) => void>(() => {});
  refreshRef.current = (name) => void refresh(name);
  useEffect(() => {
    if (!visible || !loaded || !active || active.cloned || busyKey) return;
    if (tried.current.has(active.name)) return;
    tried.current.add(active.name);
    refreshRef.current(active.name);
  }, [visible, loaded, active, busyKey]);

  const refreshAll = async () => {
    setError(null);
    for (const m of markets) {
      setBusyKey(`refresh:${m.name}`);
      try {
        const res = await marketProgress.run(requestId => api.skills.marketRefresh({ name: m.name, requestId }));
        if (!res.ok) {
          setError(t("settings.market.refreshFailed", { error: res.error ?? "" }));
          break;
        }
      } catch (err) {
        setError((err as Error).message);
        break;
      }
    }
    setBusyKey(null);
    await reload();
  };

  const add = async (kind: "git" | "local", ref: string): Promise<boolean> => {
    setBusyKey("add");
    setError(null);
    try {
      const res = await marketProgress.run(requestId => api.skills.marketAdd({ kind, ref, requestId }));
      if (!res.ok) {
        setError(t("settings.market.addFailed", { error: res.error ?? "" }));
        return false;
      }
      await reload();
      if (res.name) setActiveName(res.name);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusyKey(null);
    }
  };

  const remove = async (name: string) => {
    setBusyKey(`remove:${name}`);
    setError(null);
    try {
      const res = await api.skills.marketRemove({ name });
      if (!res.ok) setError(t("settings.market.removeFailed", { error: res.error ?? "" }));
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const install = async (market: string, name: string) => {
    setBusyKey(`install:${market}/${name}`);
    setError(null);
    setNote(null);
    try {
      const res = await api.skills.marketInstall({ market, names: [name] });
      if (res.errors.length > 0 || !res.ok) {
        setError(t("settings.market.installFailed", { error: res.error ?? res.errors.map((e) => `${e.name}: ${e.error}`).join("; ") }));
      } else if (res.imported.length > 0) {
        setNote(t("settings.skillMarket.installed", { name }));
        onInstalled();
      }
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const q = query.trim().toLowerCase();
  const entries = active
    ? q
      ? active.skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      : active.skills
    : [];
  const fetching = !!active && busyKey === `refresh:${active.name}`;
  const rows: MarketRow[] = entries.map((s) => ({
    key: s.name,
    name: s.name,
    description: s.description,
    badges: (
      <span className="min-w-0 truncate font-mono text-[0.72em] text-content-subtle/70">{s.relPath}</span>
    ),
    installed: s.installed,
    installing: busyKey === `install:${s.market}/${s.name}`,
  }));
  const notice = !active
    ? null
    : !active.cloned
      ? t(fetching ? "settings.market.fetching" : "settings.market.notFetched")
      : active.skills.length === 0
        ? t("settings.skillMarket.noEntries")
        : q && entries.length === 0
          ? t("settings.market.searchEmpty", { query: query.trim() })
          : null;

  return (
    <div className={className}>
      {marketProgress.status}
      {error && (
        <div role="alert" className="mb-2 rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[0.7857em] text-danger">
          {error}
        </div>
      )}
      {note && !error && (
        <div role="status" className="mb-2 rounded border border-accent/30 bg-accent/5 px-3 py-2 text-[0.7857em] text-content">
          {note}
        </div>
      )}
      <MarketView
        className="flex"
        title={t("settings.market.title")}
        hint={t("settings.skillMarket.hint")}
        sourceCountLabel={t("settings.plugins.mpSourceCount", { n: markets.length })}
        sources={markets.map((m) => ({ id: m.name, label: m.name, title: m.sourceRef, count: m.skills.length }))}
        activeId={active?.name ?? null}
        onSelect={(id) => {
          setActiveName(id);
          setQuery("");
        }}
        query={query}
        onQuery={setQuery}
        searchPlaceholder={t("settings.skillMarket.searchPlaceholder")}
        onRefreshAll={() => void refreshAll()}
        refreshingAll={busyKey?.startsWith("refresh:") ?? false}
        busy={busyKey != null}
        addLabel={t("settings.market.addSource")}
        addPlaceholder={t("settings.skillMarket.addPlaceholder")}
        addBusy={busyKey === "add"}
        onAdd={(v) => add("git", v)}
        addLocalLabel={t("settings.market.addLocal")}
        onAddLocal={async () => {
          const { path } = await api.pickFolder();
          if (!path) return false;
          return add("local", path);
        }}
        loading={!loaded}
        catalog={
          active
            ? {
                kind: active.sourceKind === "git" ? "git" : t("settings.plugins.source.local-dir"),
                kindMono: active.sourceKind === "git",
                builtin: active.builtin,
                ref: active.sourceRef,
                countLabel: t("settings.skillMarket.count", { n: active.skills.length }),
                refreshing: fetching,
                onRefresh: () => void refresh(active.name),
                ...(active.builtin ? {} : { onRemove: () => void remove(active.name) }),
              }
            : null
        }
        notice={notice}
        rows={rows}
        onInstall={(name) => active && void install(active.name, name)}
      />
    </div>
  );
}
