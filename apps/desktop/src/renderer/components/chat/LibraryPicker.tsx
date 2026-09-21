/**
 * 文献库选择器 —— 与「添加上下文文件」**同款形态与行为**。
 *
 * ## 为什么不是一个平铺的菜单列表
 *
 * 用户的文献库会很多,平铺进「+」菜单会把菜单撑爆。所以照 `FileMentionPicker`
 * 的做法做成可搜索的多选选择器:顶部搜索框(打开即聚焦)、限高可滚动列表、
 * ↑↓ 导航、空格/回车勾选、右上角「添加 N 个」确认、Esc 或点外部关闭。
 *
 * ## 选中之后发生什么
 *
 * 与文件附件完全一致:每个选中的库变成 composer 上方的一个 chip,发送时在提示词里
 * 落成一行 `@<清单文件路径>` —— **不内联正文**,agent 用 Read 工具自己读那份清单。
 * 清单由主进程的 `library.manifest` 生成(见 makeLibraryTag 的说明)。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { LIBRARY_KIND_LABEL } from "@renderer/lib/libraryLabels.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useLibraryStore } from "@renderer/stores/libraryStore.js";
import { api } from "@renderer/lib/api.js";
import {
  LIBRARY_KINDS,
  type LibraryCollection,
  type LibraryItem,
  type LibraryKind,
} from "@contracts/library";
import { IconBook, IconCheck, IconChevronRight, IconFileText, IconSearch } from "@renderer/lib/icons.js";

/** 三个库的文案 id。库名在不同库里可以重名,所以列表上必须标出它属于哪个库。 */

interface Props {
  open: boolean;
  /** 「+」按钮的位置 —— 选择器贴着它向上展开(与 FileMentionPicker 同款定位)。 */
  anchorRect: DOMRect | null;
  /** 已经加进上下文的库 id —— 列出来但标为已选,避免重复添加。 */
  excludeCollectionIds?: ReadonlyArray<string>;
  /**
   * 确认时回调选中的**附件键**(`c:<分类 id>` / `i:<条目 id>`)+ 显示名。
   * 调用方负责按前缀调对应的清单接口,并落成 tag。
   */
  onPick: (picked: Array<{ key: string; name: string }>) => void;
  onClose: () => void;
}

export function LibraryPicker({
  open,
  anchorRect,
  excludeCollectionIds = [],
  onPick,
  onClose,
  autoExpandItems = false,
}: Props & {
  /**
   * **默认就把分类展开、直接列出条目**（2026-09-21）。
   *
   * ## 为什么关联那一处要它
   *
   * 用户发来关联的截图：「关联的问题很大」—— 选择器打开是**空的**，只有几行分类，
   * 条目藏在分类的 `>` 后面。他以为"没东西可挑"，其实要点一下才出现。
   *
   * 而关联这个场景**只能选条目**（分类不是可以挂关联的对象，见 `ItemDetail` 里
   * `handlePick` 那段）—— 那就没有理由再让用户逐级点开。
   *
   * ⚠️ 默认 `false`：composer 那个「@ 引用」要的是"分类也能选"，展开会改变它的
   * 手感和性能（一次拉全部条目）。**只给需要的那一处开**。
   */
  autoExpandItems?: boolean;
}) {
  const { t } = useI18n();
  const collections = useLibraryStore((s) => s.collections);
  const loadCollections = useLibraryStore((s) => s.loadCollections);

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** 展开的分类 id —— 展开后列出这个分类里的条目,可以单独挑一篇。 */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** 展开时才拉的条目缓存。 */
  const [itemsOf, setItemsOf] = useState<Record<string, LibraryItem[] | "loading">>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const excluded = useMemo(() => new Set(excludeCollectionIds), [excludeCollectionIds]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setSelected(new Set());
      // `autoExpandItems` 时**预展开**（见那个 prop 的说明）。
      // ⚠️ 展开要在 `collections` 到位之后才有意义，所以不只在这里设一次 ——
      // 下面还有一个跟着 `collections` 走的 effect 兜底。
      setExpanded(autoExpandItems ? new Set(collections.map((c) => c.id)) : new Set());
      void loadCollections();
      // 打开即聚焦搜索框,用户可以直接打字过滤
      const id = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [open, loadCollections]);

  /**
   * 按库分组的行序列:先是「文献」那一组,再「教材」,再「笔记」。
   *
   * 分组而不是平铺的理由:分类名只在**自己的库里**唯一,平铺会出现两个「第一章」;
   * 分组之后"它属于哪个库"由标题行交代,行尾就不用再挂一个库名标签了。
   */
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: Array<{
      key: string;
      header?: string;
      collection?: LibraryCollection;
      item?: LibraryItem;
    }> = [];
    for (const k of LIBRARY_KINDS) {
      const inKind = collections.filter((c) => c.kind === k);
      const matched = q
        ? inKind.filter(
            (c) => c.name.toLowerCase().includes(q) || t(LIBRARY_KIND_LABEL[k]).toLowerCase().includes(q),
          )
        : inKind;
      // 搜索时空组直接不画 —— 否则屏幕上全是空标题
      if (matched.length === 0) continue;
      out.push({ key: `h-${k}`, header: t(LIBRARY_KIND_LABEL[k]) });
      for (const c of matched) {
        out.push({ key: `c:${c.id}`, collection: c });
        // 展开了才列出条目;搜索时也列出来(用户搜的就是某一篇的标题)
        const items = itemsOf[c.id];
        if (!expanded.has(c.id) && !q) continue;
        if (items === "loading") {
          out.push({ key: `l:${c.id}`, header: t("common.loading") });
          continue;
        }
        for (const item of items ?? []) {
          if (q && !item.title.toLowerCase().includes(q)) continue;
          out.push({ key: `i:${item.id}`, item });
        }
      }
    }
    return out;
  }, [collections, query, t, expanded, itemsOf]);

  /**
   * 只含**可选中**的项 —— 分类与条目都可以选,分组标题和"加载中"行不参与键盘导航。
   * `key` 是附件键(`c:` / `i:` 前缀),它在选中态、去重、以及发给主进程时是同一个东西。
   */
  const options = useMemo(
    () => rows.flatMap((r) => (r.collection || r.item ? [{ key: r.key }] : [])),
    [rows],
  );

  useEffect(() => {
    setActiveIdx((i) => Math.min(i, Math.max(0, options.length - 1)));
  }, [options.length]);

  // `autoExpandItems` 的兜底：首次打开时 `collections` 可能还没拉回来（上面那个
  // effect 里展开到的是空集合）。等它到位、且用户还没手动改过展开态时，补展开一次。
  useEffect(() => {
    if (!open || !autoExpandItems || collections.length === 0) return;
    setExpanded((prev) => (prev.size === 0 ? new Set(collections.map((c) => c.id)) : prev));
  }, [open, autoExpandItems, collections]);

  const toggle = (key: string) => {
    if (excluded.has(key)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** 展开一个分类 —— 第一次展开时把它的条目拉回来。 */
  const expand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      next.add(id);
      return next;
    });
    setItemsOf((prev) => {
      if (prev[id]) return prev;
      void api.library
        .list({ collectionId: id, limit: 200 })
        .then((res) => setItemsOf((cur) => ({ ...cur, [id]: res.items })))
        // 拉不到就当空列表 —— 选择器不该因为一个分类读不动就整个崩掉
        .catch(() => setItemsOf((cur) => ({ ...cur, [id]: [] })));
      return { ...prev, [id]: "loading" };
    });
  };

  const confirm = () => {
    if (selected.size === 0) {
      onClose();
      return;
    }
    // 从**全量**行里取名字 —— 勾完再改搜索词时,被过滤掉的那几条仍然是勾选状态,
    // 不能悄悄丢掉,也不能拿不到名字
    const picked: Array<{ key: string; name: string }> = [];
    for (const key of selected) {
      const row = rows.find((r) => r.key === key);
      if (row) picked.push({ key, name: row.collection?.name ?? row.item?.title ?? key });
    }
    onPick(picked);
    onClose();
  };

  // 键盘:↑↓ 导航、空格/回车勾选、Esc 关闭。捕获阶段,免得被编辑器的按键处理吃掉。
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => Math.min(i + 1, options.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setActiveIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        const target = options[activeIdx];
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        // 空格 = 勾选(多选语义);回车 = 确认。与 FileMentionPicker 的 attach 模式一致。
        if (e.key === " ") toggle(target.key);
        else confirm();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, options, activeIdx, selected, excluded, onClose]);

  // 点外部关闭(与 FileMentionPicker 同款:document mousedown + ref.contains)
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node;
      if (rootRef.current && !rootRef.current.contains(node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose]);

  if (!open || !anchorRect) return null;

  const left = anchorRect.left;
  const width = Math.min(Math.max(anchorRect.width, 260), 380);

  return (
    <div
      ref={rootRef}
      className="fixed z-[70] flex max-h-64 flex-col overflow-hidden rounded-lg border border-edge bg-surface shadow-xl"
      style={{
        left,
        width,
        top: Math.max(8, anchorRect.top - 8),
        // 从锚点向上生长 —— 与 FileMentionPicker 一致(输入框在屏幕底部)
        transform: "translateY(-100%)",
      }}
    >
      <div className="flex items-center gap-1.5 border-b border-edge px-2 py-1">
        <IconSearch size={12} className="shrink-0 text-content-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("library.chat.searchPlaceholder")}
          className="h-6 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content-subtle"
        />
        {selected.size > 0 && (
          <button
            type="button"
            onClick={confirm}
            className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-surface hover:brightness-110"
          >
            {t("library.chat.addN", { n: selected.size })}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {options.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-content-subtle">
            {query.trim() ? t("library.list.noMatch") : t("library.list.emptyHint")}
          </div>
        ) : (
          rows.map((row) => {
            // 分组标题:说明"下面这些是哪个库的"。不可选中 —— 它只是路牌。
            // 分组标题:说明"下面这些是哪个库的"。不可选中 —— 它只是路牌。
            if (row.header !== undefined) {
              return (
                <div
                  key={row.key}
                  className="px-2.5 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-content-subtle"
                >
                  {row.header}
                </div>
              );
            }

            const idx = options.findIndex((o) => o.key === row.key);
            const isExcluded = excluded.has(row.key);
            const isSelected = selected.has(row.key);

            // ── 条目行(分类展开后的单篇):缩进一级,直接挑一篇 ──
            if (row.item) {
              const item = row.item;
              return (
                <button
                  key={row.key}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => toggle(row.key)}
                  disabled={isExcluded}
                  className={cn(
                    "flex w-full items-center gap-2 py-1 pl-7 pr-2.5 text-left text-[12px] transition-colors",
                    idx === activeIdx ? "bg-surface-muted text-content" : "text-content-muted",
                    isExcluded && "opacity-40",
                  )}
                  title={isExcluded ? t("library.chat.alreadyAdded") : item.title}
                >
                  <span className="w-3.5 shrink-0">
                    {(isSelected || isExcluded) && <IconCheck size={12} className="text-accent" />}
                  </span>
                  <IconFileText size={12} className="shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                </button>
              );
            }

            // ── 分类行:chevron 展开出条目,勾选则挂整个分类 ──
            const c = row.collection!;
            const isOpen = expanded.has(c.id);
            return (
              <div
                key={row.key}
                className={cn(
                  "flex items-center gap-1 px-1 transition-colors",
                  idx === activeIdx ? "bg-surface-muted" : "",
                )}
              >
                <button
                  onClick={() => expand(c.id)}
                  className="flex w-4 shrink-0 items-center justify-center text-content-subtle"
                  title={isOpen ? t("layout.collapse") : t("layout.expand")}
                >
                  <IconChevronRight
                    size={11}
                    className={cn("transition-transform", isOpen && "rotate-90")}
                  />
                </button>
                <button
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => toggle(row.key)}
                  disabled={isExcluded}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1.5 text-left text-[12px]",
                    isExcluded ? "opacity-40" : "text-content-muted",
                    idx === activeIdx && "text-content",
                  )}
                  title={isExcluded ? t("library.chat.alreadyAdded") : c.name}
                >
                  <span className="w-3.5 shrink-0">
                    {(isSelected || isExcluded) && <IconCheck size={12} className="text-accent" />}
                  </span>
                  <IconBook size={13} className="shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
