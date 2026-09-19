/**
 * 右栏:库内**全文检索**面板 —— 搜的是已转 Markdown 的正文。
 *
 * ## 和另外两个搜索框的分工
 *
 * 这个库有三处能搜,搜的东西完全不一样,界面上必须说清是哪一处(用户问过):
 *
 * - 列表上方那个框(`LibraryPanel`)—— 搜**元数据**(标题 / 作者 / 期刊 / 摘要 /
 *   DOI / 年份),走 SQL,秒回。找"库里有没有某一篇"用它。
 * - 右栏「检索」面板(`SearchPanel`)—— 去 Crossref / arXiv 找**还没入库**的新文献。
 * - **这里** —— 搜**已转换的 Markdown 正文**,走 ripgrep。找"哪篇里提过这个词"用它。
 *
 * `/api.library.fullTextSearch` 早就写好了(主进程里那条 ripgrep 通道,内部做了
 * UTF-8 + GBK 双通道所以中文可搜),只是一直没有入口 —— 而 `library.search.scopeHint`
 * 那句说明里**已经写着"右栏的全文检索"**。这个面板就是把那句话兑现。
 *
 * ## 为什么 PDF 搜不到
 *
 * 检索面只有 `markdown/` 下的文件:PDF 是二进制,rg 无从下手。没转换的条目自然搜
 * 不到 —— 界面上如实说明,而不是让用户以为"库里没有"。
 */
import { useEffect, useRef, useState } from "react";
import type { FullTextMatch } from "@contracts/library";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { useLibraryStore } from "@renderer/stores/libraryStore.js";
import { IconFileText, IconSearch, IconX } from "@renderer/lib/icons.js";

interface Props {
  onClose: () => void;
}

/** 输入到发请求之间的等待 —— 用户连打时不必每个字符都跑一次 rg。 */
const DEBOUNCE_MS = 260;

export function FullTextSearchPanel({ onClose }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<FullTextMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  /** 当前这次请求的号。主进程那边也有一个(后发的胜出),这里再判一次是因为
   *  组件可能已经卸载、或者用户又改了关键词 —— 迟到的结果不该画上去。 */
  const seqRef = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      setMatches([]);
      setSearched(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void api.library
        .fullTextSearch({ query: q })
        .then((res) => {
          if (seq !== seqRef.current) return;
          setMatches(res.matches);
        })
        .catch(() => {
          if (seq !== seqRef.current) return;
          setMatches([]);
        })
        .finally(() => {
          if (seq !== seqRef.current) return;
          setLoading(false);
          setSearched(true);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  /** 点一条命中:把那一篇设为当前条目,再让**外面**切到详情。
   *  面板自己不管详情怎么画 —— 它只负责"把用户带到那一篇"。
   *
   *  详情那一步由 `LibraryPanel` 的一个 effect 完成(它跟着 `activeItemId` 走 ——
   *  左栏点条目也是同一条路)。所以这里**不能**自己去 `openPreview`,否则两处各写
   *  一遍"打开详情",迟早漂成两种行为。 */
  const openMatch = (m: FullTextMatch) => {
    useLibraryStore.getState().setActiveItem(m.itemId);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-4 py-2.5">
        <IconFileText size={15} className="shrink-0 text-accent" />
        <span className="flex-1 text-xs font-medium text-content">
          {t("library.fullText.title")}
        </span>
        <button
          onClick={onClose}
          className="rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
        >
          <IconX size={14} />
        </button>
      </div>

      <div className="shrink-0 border-b border-edge bg-surface-hover/30 px-4 py-1.5 text-[0.7143em] leading-relaxed text-content-subtle">
        {t("library.fullText.scopeHint")}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-4 py-2">
        <IconSearch size={13} className="shrink-0 text-content-subtle" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("library.fullText.placeholder")}
          className="min-w-0 flex-1 rounded border border-edge bg-surface px-2 py-1 text-xs text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && matches.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-content-subtle">
            {t("library.fullText.searching")}
          </div>
        ) : matches.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-content-subtle">
            {/* **没搜过 ≠ 搜了没结果。** 前者不写话,后者要说清"没找到" ——
                否则用户分不清"还没开始"和"库里没有"。 */}
            {searched ? t("library.fullText.noResult") : ""}
          </div>
        ) : (
          <>
            <div className="shrink-0 border-b border-edge px-4 py-1.5 text-[0.7143em] text-content-subtle">
              {t("library.fullText.count", { n: matches.length })}
            </div>
            {matches.map((m) => (
              <button
                key={`${m.itemId}:${m.lineNumber}`}
                onClick={() => openMatch(m)}
                className="block w-full border-b border-edge/50 px-4 py-2 text-left transition-colors hover:bg-surface-hover/60"
              >
                <div className="truncate text-xs font-medium text-content">{m.title}</div>
                {/* 命中行本身 —— 让用户不点进去就能判断是不是他要找的那处。
                    前后用等宽字体,行号靠右,读起来像一段代码而不是一段正文。 */}
                <div className="mt-1 flex items-start gap-2">
                  <span className="shrink-0 tabular-nums text-[0.7143em] text-content-subtle">
                    {m.lineNumber}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[0.7143em] text-content-muted">
                    {m.lineText.trim()}
                  </span>
                </div>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
