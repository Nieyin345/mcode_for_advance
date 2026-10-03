/**
 * MCP 市场 —— 设置 → MCP 的「市场」tab。
 *
 * 源 = 说官方 MCP Registry API 的注册中心(内置 registry.modelcontextprotocol.io,
 * 用户可加自己的)。条目实时搜索(回车 / 停止输入后),每条带主进程换算好的安装方式
 * (npx / uvx / docker / 远程 http·sse)。安装 = 弹窗选方式、起名、填环境变量 / 请求头 /
 * 必填参数 → `buildMcpMarketConfig` → 老的 `mcp.save`(进总库,和手动添加同一条路)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildMcpMarketConfig,
  type McpMarketEntry,
  type McpMarketInput,
  type McpMarketSource,
} from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Dialog, Input } from "@renderer/components/ui/index.js";
import { IconLoader2 } from "@renderer/lib/icons.js";
import { MarketView, type MarketRow } from "./MarketView.js";

const NAME_RE = /^[A-Za-z0-9_-]+$/;

export function McpMarketView({
  className,
  visible,
  installedNames,
  onInstalled,
}: {
  className?: string;
  /** This tab is shown — the first search runs only then. */
  visible: boolean;
  /** Names already used by user-scope servers. */
  installedNames: ReadonlySet<string>;
  onInstalled: () => void;
}) {
  const { t } = useI18n();
  const [sources, setSources] = useState<McpMarketSource[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<McpMarketEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [searchedKey, setSearchedKey] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [installing, setInstalling] = useState<McpMarketEntry | null>(null);
  const seq = useRef(0);

  const reloadSources = useCallback(async () => {
    try {
      const res = await api.mcp.marketSources({});
      setSources(res.sources ?? []);
      return res.sources ?? [];
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (visible && !loaded) void reloadSources();
  }, [visible, loaded, reloadSources]);

  const active = sources.find((s) => s.id === activeId) ?? sources[0] ?? null;

  const search = useCallback(async (sourceId: string, q: string, cursor?: string) => {
    const my = ++seq.current;
    setBusyKey(cursor ? "more" : "search");
    setSearchError(null);
    try {
      const res = await api.mcp.marketSearch({ source: sourceId, ...(q ? { query: q } : {}), ...(cursor ? { cursor } : {}) });
      if (my !== seq.current) return;
      if (!res.ok) {
        setSearchError(res.error ?? "");
        if (!cursor) setEntries([]);
        setNextCursor(undefined);
      } else {
        setEntries((prev) => {
          if (!cursor) return res.entries;
          const seen = new Set(prev.map((e) => e.id));
          return [...prev, ...res.entries.filter((e) => !seen.has(e.id))];
        });
        setNextCursor(res.nextCursor);
      }
      setSearchedKey(`${sourceId}\n${q}`);
    } catch (err) {
      if (my === seq.current) setSearchError((err as Error).message);
    } finally {
      if (my === seq.current) setBusyKey(null);
    }
  }, []);

  // Search when the tab is shown / the source changes / typing pauses.
  const trimmed = query.trim();
  const key = active ? `${active.id}\n${trimmed}` : null;
  useEffect(() => {
    if (!visible || !active || key === searchedKey) return;
    const timer = window.setTimeout(() => void search(active.id, trimmed), searchedKey === null ? 0 : 450);
    return () => window.clearTimeout(timer);
  }, [visible, active, key, searchedKey, search, trimmed]);

  const addSource = async (url: string): Promise<boolean> => {
    setBusyKey("add");
    setError(null);
    try {
      const res = await api.mcp.marketSourceAdd({ url });
      if (!res.ok) {
        setError(t("settings.market.addFailed", { error: res.error ?? "" }));
        return false;
      }
      await reloadSources();
      if (res.id) setActiveId(res.id);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusyKey(null);
    }
  };

  const removeSource = async (id: string) => {
    setBusyKey(`remove:${id}`);
    setError(null);
    try {
      const res = await api.mcp.marketSourceRemove({ id });
      if (!res.ok) setError(t("settings.market.removeFailed", { error: res.error ?? "" }));
      await reloadSources();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const rows: MarketRow[] = entries.map((e) => ({
    key: e.id,
    name: e.title,
    version: e.version || undefined,
    description: e.description || e.id,
    badges: (
      <span className="inline-flex shrink-0 items-center gap-0.5">
        {e.options.map((o) => (
          <span
            key={o.id}
            className="rounded bg-surface-muted px-1 py-px font-mono text-[10px] leading-tight text-content-muted"
          >
            {o.command ?? o.label}
          </span>
        ))}
      </span>
    ),
    installed: installedNames.has(e.suggestedName),
    installDisabled: e.options.length === 0,
    installTitle: e.options.length === 0 ? t("settings.mcpMarket.noOption") : e.id,
  }));
  const searching = busyKey === "search";
  const notice = !active
    ? null
    : searchError
      ? t("settings.mcpMarket.searchFailed", { error: searchError })
      : searching && entries.length === 0
        ? t("settings.mcpMarket.searching")
        : searchedKey !== null && entries.length === 0
          ? trimmed
            ? t("settings.market.searchEmpty", { query: trimmed })
            : t("settings.mcpMarket.noEntries")
          : null;

  return (
    <div className={className}>
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
        hint={t("settings.mcpMarket.hint")}
        sourceCountLabel={t("settings.plugins.mpSourceCount", { n: sources.length })}
        sources={sources.map((s) => ({ id: s.id, label: s.label, title: s.url }))}
        activeId={active?.id ?? null}
        onSelect={(id) => {
          if (id === active?.id) return;
          setActiveId(id);
          setEntries([]);
          setNextCursor(undefined);
          setSearchedKey(null);
        }}
        query={query}
        onQuery={setQuery}
        searchPlaceholder={t("settings.mcpMarket.searchPlaceholder")}
        onSearchSubmit={() => active && void search(active.id, trimmed)}
        busy={busyKey != null && busyKey !== "search"}
        addLabel={t("settings.market.addSource")}
        addPlaceholder={t("settings.mcpMarket.addPlaceholder")}
        addBusy={busyKey === "add"}
        onAdd={addSource}
        loading={!loaded}
        catalog={
          active
            ? {
                kind: "registry",
                kindMono: true,
                builtin: active.builtin,
                ref: active.url,
                countLabel: t("settings.mcpMarket.count", { n: entries.length, more: nextCursor ? "+" : "" }),
                refreshing: searching,
                onRefresh: () => void search(active.id, trimmed),
                ...(active.builtin ? {} : { onRemove: () => void removeSource(active.id) }),
              }
            : null
        }
        notice={notice}
        rows={rows}
        onInstall={(id) => {
          const entry = entries.find((e) => e.id === id);
          if (entry) {
            setNote(null);
            setInstalling(entry);
          }
        }}
        footer={
          nextCursor && active ? (
            <div className="border-t border-edge px-3 py-2 text-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void search(active.id, trimmed, nextCursor)}
                disabled={busyKey != null}
              >
                {busyKey === "more" && <IconLoader2 size={12} className="animate-spin" />}
                {t("settings.mcpMarket.loadMore")}
              </Button>
            </div>
          ) : null
        }
      />
      <McpMarketInstallDialog
        entry={installing}
        takenNames={installedNames}
        onOpenChange={(open) => {
          if (!open) setInstalling(null);
        }}
        onInstalled={(name) => {
          setInstalling(null);
          setNote(t("settings.mcpMarket.installed", { name }));
          onInstalled();
        }}
      />
    </div>
  );
}

/** Templates such as `Bearer {api_key}` are hints, not values. */
function isTemplate(v: string | undefined): boolean {
  return !!v && /\{[^}]+\}/.test(v);
}

function McpMarketInstallDialog({
  entry,
  takenNames,
  onOpenChange,
  onInstalled,
}: {
  entry: McpMarketEntry | null;
  takenNames: ReadonlySet<string>;
  onOpenChange: (open: boolean) => void;
  onInstalled: (name: string) => void;
}) {
  const { t } = useI18n();
  const [optionId, setOptionId] = useState("");
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset per entry; defaults pre-filled (templates stay placeholders).
  useEffect(() => {
    if (!entry) return;
    const first = entry.options[0];
    setOptionId(first?.id ?? "");
    setName(entry.suggestedName);
    setError(null);
    setSaving(false);
    const init: Record<string, string> = {};
    for (const o of entry.options) {
      for (const i of o.inputs) if (i.default && !isTemplate(i.default)) init[`${o.id}|${i.key}`] = i.default;
    }
    setValues(init);
  }, [entry]);

  if (!entry) return null;
  const option = entry.options.find((o) => o.id === optionId) ?? entry.options[0];
  const optionValues: Record<string, string> = {};
  if (option) for (const i of option.inputs) optionValues[i.key] = values[`${option.id}|${i.key}`] ?? "";

  const trimmedName = name.trim();
  const nameError = !trimmedName
    ? t("settings.mcpMarket.nameRequired")
    : !NAME_RE.test(trimmedName)
      ? t("settings.mcpMarket.nameInvalid")
      : /^mcode[-_]/i.test(trimmedName)
        ? t("settings.mcpMarket.nameReserved")
        : takenNames.has(trimmedName)
          ? t("settings.mcpMarket.nameTaken")
          : null;

  const submit = async () => {
    if (!option || nameError) return;
    const built = buildMcpMarketConfig(option, optionValues);
    if (!built.config) {
      const names = built.missing
        .map((k) => option.inputs.find((i) => i.key === k))
        .map((i) => i?.name || i?.description || "")
        .filter(Boolean);
      setError(t("settings.mcpMarket.missing", { names: names.join(", ") }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.mcp.save({ name: trimmedName, config: built.config });
      if (!res.ok) {
        setError(res.error ?? t("settings.saveFailed"));
        return;
      }
      onInstalled(trimmedName);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const preview = option ? buildMcpMarketConfig(option, optionValues) : null;
  const previewText = option
    ? option.kind === "stdio"
      ? [option.command ?? "", ...(option.args ?? []).map((a) => ("value" in a ? a.value : `<${a.flag ?? a.input}>`))].join(" ")
      : `${option.kind.toUpperCase()} ${option.url ?? ""}`
    : "";

  const inputLabel = (i: McpMarketInput): string =>
    i.kind === "env"
      ? i.name
      : i.kind === "header"
        ? t("settings.mcpMarket.header", { name: i.name })
        : i.name || i.description || t("settings.mcpMarket.argument");

  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="flex max-h-[80vh] w-[560px] flex-col p-0">
          <Dialog.Title className="px-4 pt-4">
            <span className="min-w-0 truncate">
              {t("settings.mcpMarket.installTitle", { name: entry.title })}
              {entry.version && <span className="ml-1.5 font-mono text-[0.85em] text-content-muted">v{entry.version}</span>}
            </span>
          </Dialog.Title>
          <Dialog.Description className="truncate px-4 pt-1 font-mono text-[0.7857em]" title={entry.id}>
            {entry.id}
          </Dialog.Description>
          <Dialog.Close />
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-[0.8571em]">
            {entry.description && <p className="text-[0.92em] text-content-muted">{entry.description}</p>}

            {entry.options.length > 1 && (
              <div>
                <div className="mb-1 text-[0.92em] font-medium text-content">{t("settings.mcpMarket.method")}</div>
                <div className="flex flex-wrap gap-1" role="radiogroup">
                  {entry.options.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={o.id === option?.id}
                      onClick={() => setOptionId(o.id)}
                      className={cn(
                        "rounded border px-2.5 py-1 text-[0.92em] transition-colors",
                        o.id === option?.id
                          ? "border-accent bg-accent/10 font-medium text-accent"
                          : "border-edge bg-surface text-content-muted hover:text-content",
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <label className="block">
              <span className="mb-1 block text-[0.92em] font-medium text-content">{t("settings.mcpMarket.name")}</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-7 font-mono text-[0.92em]"
                spellCheck={false}
                aria-invalid={nameError != null}
              />
              {nameError && <span className="mt-0.5 block text-[0.85em] text-danger">{nameError}</span>}
            </label>

            {option && option.inputs.length > 0 && (
              <div className="space-y-2">
                {option.inputs.map((i) => (
                  <label key={i.key} className="block">
                    <span className="mb-1 flex items-baseline gap-1.5">
                      <span className="font-mono text-[0.92em] text-content">{inputLabel(i)}</span>
                      {i.required && <span className="text-[0.85em] text-danger">*</span>}
                      {i.secret && (
                        <span className="rounded bg-warning/10 px-1 text-[0.78em] text-warning">{t("settings.mcpMarket.secret")}</span>
                      )}
                    </span>
                    <Input
                      type={i.secret ? "password" : "text"}
                      value={values[`${option.id}|${i.key}`] ?? ""}
                      placeholder={isTemplate(i.default) ? i.default : undefined}
                      onChange={(e) => setValues((v) => ({ ...v, [`${option.id}|${i.key}`]: e.target.value }))}
                      className="h-7 font-mono text-[0.92em]"
                      spellCheck={false}
                      autoComplete="off"
                    />
                    {i.description && i.description !== inputLabel(i) && (
                      <span className="mt-0.5 block text-[0.85em] text-content-subtle">{i.description}</span>
                    )}
                  </label>
                ))}
              </div>
            )}

            <div>
              <div className="mb-1 text-[0.92em] font-medium text-content">{t("settings.mcpMarket.command")}</div>
              <code className="block break-all rounded border border-edge bg-surface-muted/40 px-2 py-1.5 font-mono text-[0.85em] text-content-muted">
                {previewText}
              </code>
              {option?.kind === "stdio" && (
                <p className="mt-1 text-[0.85em] text-content-subtle">
                  {t("settings.mcpMarket.runtimeHint", { command: option.command ?? "" })}
                </p>
              )}
            </div>
            {(entry.repositoryUrl || entry.websiteUrl) && (
              <p className="truncate text-[0.85em] text-content-subtle">
                {entry.repositoryUrl ?? entry.websiteUrl}
              </p>
            )}
            {error && (
              <div role="alert" className="rounded border border-danger/40 bg-danger/5 px-2.5 py-1.5 text-[0.92em] text-danger">
                {error}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-edge px-4 py-3">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void submit()}
              disabled={saving || !option || nameError != null || (preview?.missing.length ?? 0) > 0}
            >
              {saving && <IconLoader2 size={12} className="animate-spin" />}
              {t("settings.mcpMarket.install")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
