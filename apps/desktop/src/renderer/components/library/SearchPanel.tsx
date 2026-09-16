/**
 * 右栏:外部检索面板。
 *
 * 检索结果**不会自动入库** —— 用户勾选后手动加入。这是刻意的:一次关键词检索
 * 常出几十条噪声,自动入库会让文献库迅速变成垃圾场,而清理比添加麻烦得多。
 */
import { useState } from "react";
import type { ExternalSearchResult } from "@contracts/library";
import { formatAuthorList } from "@contracts/library";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { IconPlus, IconSearch, IconX } from "@renderer/lib/icons.js";

interface Props {
  onClose: () => void;
  /** 选中的文献归入哪个库。null = 不归任何库(仍进总库)。 */
  collectionId: string | null;
  onAdded: () => void | Promise<void>;
}

/** 结果条目的稳定键 —— 没有 DOI 时退化用标题。 */
function resultKey(r: ExternalSearchResult): string {
  return r.doi ?? r.arxivId ?? r.title;
}

export function SearchPanel({ onClose, collectionId, onAdded }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ExternalSearchResult[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setSearched(true);
    try {
      const res = await api.library.searchExternal({ query: q, limit: 30 });
      setResults(res.results);
      setPicked(new Set());
    } finally {
      setLoading(false);
    }
  };

  const addPicked = async () => {
    const chosen = results.filter((r) => picked.has(resultKey(r)));
    if (chosen.length === 0) return;
    await api.library.addItems({
      items: chosen.map((r) => ({
        doi: r.doi,
        arxivId: r.arxivId,
        title: r.title,
        authors: r.authors,
        year: r.year,
        venue: r.venue,
        // 卷 / 期 / 页码 / 出版商是引用格式的前提,检索时 Crossref 已经给了,
        // 落库时丢掉的话这条路导入的文献引用永远缺一段
        volume: r.volume,
        issue: r.issue,
        page: r.page,
        publisher: r.publisher,
        abstract: r.abstract,
        url: r.url,
        source: r.source,
        // 归入当前正在看的库;没选库就只进总库
        collectionIds: collectionId ? [collectionId] : undefined,
      })),
    });
    setPicked(new Set());
    await onAdded();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-4 py-2.5">
        <IconSearch size={15} className="shrink-0 text-accent" />
        <span className="flex-1 text-xs font-medium text-content">{t("library.search.title")}</span>
        <button
          onClick={onClose}
          className="rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
        >
          <IconX size={14} />
        </button>
      </div>

      {/* 说清楚这个检索的作用域 —— 用户问过「这是对当前 collection 检索吗」。
          不是:这里是去 Crossref / arXiv 找**新**文献,库内搜索是另外两个入口。 */}
      <div className="shrink-0 border-b border-edge bg-surface-hover/30 px-4 py-1.5 text-[0.7143em] leading-relaxed text-content-subtle">
        {t("library.search.scopeHint")}
      </div>

      <div className="flex shrink-0 gap-2 border-b border-edge px-4 py-2">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch();
          }}
          placeholder={t("library.search.placeholder")}
          className="min-w-0 flex-1 rounded border border-edge bg-surface px-2 py-1 text-xs text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
        />
        <button
          onClick={() => void runSearch()}
          disabled={loading || !query.trim()}
          className="shrink-0 rounded bg-accent px-2.5 py-1 text-xs text-white hover:opacity-90 disabled:opacity-50"
        >
          {loading ? t("library.search.searching") : t("library.search.submit")}
        </button>
      </div>

      {picked.size > 0 && (
        <div className="flex shrink-0 items-center justify-between border-b border-edge bg-surface-hover/60 px-4 py-1.5">
          <span className="text-xs text-content-muted">
            {t("library.list.selected", { n: picked.size })}
          </span>
          <button
            onClick={() => void addPicked()}
            className="rounded bg-accent px-2 py-0.5 text-[0.7857em] text-white hover:opacity-90"
          >
            {t("library.search.addSelected")}
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {results.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-content-subtle">
            {searched && !loading ? t("library.search.noResult") : ""}
          </div>
        ) : (
          results.map((r) => {
            const key = resultKey(r);
            const isPicked = picked.has(key);
            return (
              <div
                key={key}
                onClick={() =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
                className={cn(
                  "cursor-pointer border-b border-edge/50 px-4 py-2 transition-colors",
                  isPicked ? "bg-surface-hover" : "hover:bg-surface-hover/60",
                )}
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={isPicked}
                    onChange={() => {}}
                    className="mt-0.5 h-3 w-3 shrink-0 accent-[var(--accent)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-content">{r.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[0.7143em] text-content-subtle">
                      <span className="rounded bg-surface-hover px-1 py-px">{r.source}</span>
                      {r.year && <span className="tabular-nums">{r.year}</span>}
                      {r.hasOpenAccessPdf && (
                        // 能直接下的优先让用户看到
                        <span className="text-accent">PDF</span>
                      )}
                      {r.authors.length > 0 && (
                        <span className="min-w-0 truncate">{formatAuthorList(r.authors, 2)}</span>
                      )}
                    </div>
                  </div>
                  <IconPlus
                    size={13}
                    className={cn("mt-1 shrink-0", isPicked ? "text-accent" : "text-content-subtle")}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
