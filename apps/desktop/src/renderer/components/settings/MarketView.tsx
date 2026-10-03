/**
 * MarketView —— 技能 / MCP 两个面板「市场」tab 的共用外壳。
 *
 * 样子照插件页的市场(`PluginsPanel` 的 MarketplacePane / MarketplaceCatalog):
 * 顶行(标题 · 源数 · 搜索 · 全部刷新)→ 源 tab 条(每个源带条目数)+ ⊕ 添加 →
 * 添加表单(地址 + 可选「本地文件夹」)→ 当前源的目录卡(类型 · 内置 · 地址 · 条数 ·
 * 刷新 / 移除)+ 条目行(名字 · 版本 · 说明 · 安装 / 已安装)。
 *
 * 纯展示:数据从哪来、安装做什么由 SkillMarketView / McpMarketView 决定。
 */
import type { ReactNode } from "react";
import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Card, EmptyState, InfoHint, Input, LoadingNote } from "@renderer/components/ui/index.js";
import {
  IconFolderOpen,
  IconLoader2,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
} from "@renderer/lib/icons.js";

export interface MarketSourceTab {
  id: string;
  label: string;
  /** Tooltip (source URL / ref). */
  title?: string;
  count?: number;
}

export interface MarketCatalogInfo {
  /** Short kind chip ("git" / "本地" / "registry"). */
  kind: string;
  /** Mono-styled chip (git / registry) vs plain (local). */
  kindMono?: boolean;
  builtin: boolean;
  ref: string;
  countLabel: string;
  refreshing: boolean;
  onRefresh?: () => void;
  /** Absent for built-in sources (they cannot be removed). */
  onRemove?: () => void;
}

export interface MarketRow {
  key: string;
  name: string;
  version?: string;
  /** Secondary line under the name (description). */
  description?: string;
  /** Extra chips after the name (engines, transports …). */
  badges?: ReactNode;
  installed: boolean;
  installing?: boolean;
  installDisabled?: boolean;
  installTitle?: string;
}

export function MarketView({
  className,
  title,
  hint,
  sourceCountLabel,
  sources,
  activeId,
  onSelect,
  query,
  onQuery,
  searchPlaceholder,
  onSearchSubmit,
  onRefreshAll,
  refreshingAll,
  busy,
  addLabel,
  addPlaceholder,
  addBusy,
  onAdd,
  onAddLocal,
  addLocalLabel,
  loading,
  catalog,
  notice,
  rows,
  onInstall,
  footer,
}: {
  className?: string;
  title: string;
  hint?: string;
  sourceCountLabel: string;
  sources: MarketSourceTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  query: string;
  onQuery: (q: string) => void;
  searchPlaceholder: string;
  /** Enter in the search box (server-side search). */
  onSearchSubmit?: () => void;
  onRefreshAll?: () => void;
  refreshingAll?: boolean;
  /** Any action in flight — disables the other controls. */
  busy: boolean;
  addLabel: string;
  addPlaceholder: string;
  addBusy: boolean;
  /** Resolves true when the source landed (the form then clears). */
  onAdd: (value: string) => Promise<boolean>;
  onAddLocal?: () => Promise<boolean>;
  addLocalLabel?: string;
  loading: boolean;
  catalog: MarketCatalogInfo | null;
  /** Replaces the rows (not fetched yet / no entries / no match / error). */
  notice?: string | null;
  rows: MarketRow[];
  onInstall: (key: string) => void;
  /** Under the rows (e.g. 加载更多). */
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  const [addOpen, setAddOpen] = useState(false);
  const [addValue, setAddValue] = useState("");

  const submitAdd = async () => {
    const v = addValue.trim();
    if (!v) return;
    if (await onAdd(v)) {
      setAddValue("");
      setAddOpen(false);
    }
  };

  return (
    <div className={cn("flex-col", className)}>
      <div className="flex flex-none flex-wrap items-center gap-2 py-2.5">
        <span className="text-[0.9286em] font-semibold text-content">{title}</span>
        <span className="text-[0.7857em] text-content-subtle">{sourceCountLabel}</span>
        {hint && <InfoHint>{hint}</InfoHint>}
        <span className="flex-1" />
        <div className="relative w-44 shrink-0">
          <IconSearch
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle"
          />
          <Input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSearchSubmit?.();
            }}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-7 pl-7 font-sans text-[0.7857em]"
            spellCheck={false}
            disabled={sources.length === 0}
          />
        </div>
        {onRefreshAll && (
          <Button
            variant="ghost"
            size="icon"
            title={t("settings.market.refreshAll")}
            onClick={onRefreshAll}
            disabled={busy || sources.length === 0}
          >
            <IconRefresh size={13} className={cn("text-content-subtle", refreshingAll && "animate-spin")} />
          </Button>
        )}
      </div>

      <div className="mb-2.5 flex flex-none items-center gap-2">
        <div className="min-w-0 overflow-x-auto">
          <div className="flex w-fit items-center gap-0.5 rounded-lg border border-edge bg-surface/40 p-0.5">
            {sources.map((src) => {
              const isActive = src.id === activeId;
              return (
                <button
                  key={src.id}
                  type="button"
                  title={src.title}
                  aria-pressed={isActive}
                  onClick={() => onSelect(src.id)}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1 text-[0.7857em] font-medium transition-colors",
                    isActive ? "bg-surface-hover text-content" : "text-content-muted hover:text-content",
                  )}
                >
                  <span className="max-w-[220px] truncate">{src.label}</span>
                  {src.count !== undefined && (
                    <span className="tabular-nums text-[0.8571em] text-content-subtle">{src.count}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          title={addLabel}
          aria-expanded={addOpen}
          onClick={() => setAddOpen((v) => !v)}
          disabled={busy}
        >
          <IconPlus size={13} className="text-content-subtle" />
        </Button>
      </div>

      {/* Kept mounted while closed so a half-typed address survives. */}
      <div
        className={cn(
          "mb-2.5 flex-none rounded-xl border border-dashed border-edge-input bg-surface-muted/35 p-2",
          addOpen ? "block" : "hidden",
        )}
      >
        <Input
          value={addValue}
          onChange={(e) => setAddValue(e.target.value)}
          placeholder={addPlaceholder}
          aria-label={addPlaceholder}
          className="h-7 text-[0.7857em]"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submitAdd();
          }}
        />
        <div className="mt-1.5 flex items-center gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            className="h-7 flex-1 justify-center"
            onClick={() => void submitAdd()}
            disabled={busy || !addValue.trim()}
          >
            {addBusy ? <IconLoader2 size={12} className="animate-spin" /> : <IconPlus size={12} />}
            {t("settings.market.add")}
          </Button>
          {onAddLocal && (
            <Button
              variant="secondary"
              size="sm"
              className="h-7 flex-1 justify-center"
              onClick={() =>
                void onAddLocal().then((ok) => {
                  if (ok) setAddOpen(false);
                })
              }
              disabled={busy}
            >
              <IconFolderOpen size={12} />
              {addLocalLabel}
            </Button>
          )}
          <Button variant="ghost" size="icon" title={t("common.close")} onClick={() => setAddOpen(false)}>
            <IconX size={13} className="text-content-subtle" />
          </Button>
        </div>
      </div>

      <div className="pb-4">
        {loading && !catalog ? (
          <LoadingNote label={t("settings.market.loading")} />
        ) : !catalog ? (
          <Card className="rounded-xl">
            <EmptyState className="py-6" title={t("settings.market.noSources")} />
          </Card>
        ) : (
          <div className="overflow-hidden rounded-xl border border-edge bg-surface">
            <div className="flex items-center gap-2 border-b border-edge bg-surface-muted/35 px-3 py-2.5">
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-[0.72em]",
                  catalog.kindMono ? "bg-info/10 font-mono text-info" : "bg-surface-muted text-content-muted",
                )}
              >
                {catalog.kind}
              </span>
              {catalog.builtin && (
                <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[0.72em] text-accent-strong">
                  {t("settings.plugins.mpBuiltin")}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-[0.7857em] text-content-subtle" title={catalog.ref}>
                {catalog.ref}
              </span>
              <span className="shrink-0 text-[0.7857em] text-content-subtle">{catalog.countLabel}</span>
              {catalog.onRefresh && (
                <Button
                  variant="ghost"
                  size="icon"
                  title={t("settings.plugins.mpRefresh")}
                  onClick={catalog.onRefresh}
                  disabled={busy}
                >
                  <IconRefresh
                    size={13}
                    className={cn("text-content-subtle hover:text-accent", catalog.refreshing && "animate-spin")}
                  />
                </Button>
              )}
              {catalog.onRemove && (
                <Button
                  variant="ghost"
                  size="icon"
                  title={t("settings.plugins.mpRemove")}
                  onClick={catalog.onRemove}
                  disabled={busy}
                  className="hover:text-danger"
                >
                  <IconTrash size={13} className="text-content-subtle" />
                </Button>
              )}
            </div>
            {notice ? (
              <div className="px-3 py-2.5 text-[0.7857em] text-content-subtle">{notice}</div>
            ) : (
              rows.map((row) => (
                <div
                  key={row.key}
                  className="flex items-center gap-2.5 border-t border-edge px-3 py-2.5 first:border-t-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate text-[0.8571em] font-medium text-content">{row.name}</span>
                      {row.version && (
                        <span className="shrink-0 font-mono text-[0.75em] text-content-subtle">v{row.version}</span>
                      )}
                      {row.badges}
                    </div>
                    {row.description && (
                      <p className="mt-0.5 truncate text-[0.7857em] text-content-subtle" title={row.description}>
                        {row.description}
                      </p>
                    )}
                  </div>
                  {row.installed ? (
                    <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[0.75em] text-accent-strong">
                      {t("settings.plugins.mpInstalled")}
                    </span>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 shrink-0"
                      onClick={() => onInstall(row.key)}
                      disabled={busy || row.installDisabled === true}
                      title={row.installTitle}
                    >
                      {row.installing ? <IconLoader2 size={12} className="animate-spin" /> : t("settings.plugins.mpInstall")}
                    </Button>
                  )}
                </div>
              ))
            )}
            {!notice && footer}
          </div>
        )}
      </div>
    </div>
  );
}
