/**
 * 模版选择器 —— 与「文献库选择器」(`LibraryPicker`)**同款形态与行为**。
 *
 * ## 为什么照抄文献库那一套
 *
 * 用户的原话是「仿照之前的文献库做」。行为确实应当完全一致:多选、可搜索、
 * 确认后每个模版落成一个 content tag,发送时在提示词里只放一行 `@<清单路径>` ——
 * AI 拿到清单(里面列了这条模版的全部文件 + 小文件的正文)自己去读。
 *
 * ## 与文献库选择器唯一的差别:多了**类目**
 *
 * 模版分五个类目(PPT / LaTeX / Word / 代码 / 图片),所以列表按类目**分组**:
 * 每个类目一行标题,它的模版排在下面(与文献库选择器按库分组同一套观感)。
 * 类目名**参与搜索** —— 打 `latex` / `ppt` / `图` 就能收窄到那一组。
 *
 * 一开始是"平铺 + 每行挂一个类目标签",但那样和文献库那两个库混在一起时,一眼看不出
 * 分了几类;分组把结构直接摆出来。
 *
 * ## 每次打开都重新扫盘
 *
 * 模版库的设计是「文件系统即事实源」(见 `contracts/src/templates.ts`),用户会直接
 * 在资源管理器里往里丢文件。所以这里不做缓存 —— 打开即扫,你刚放进去的东西立刻就
 * 在列表里。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  TEMPLATE_KINDS,
  type TemplateEntry,
  type TemplateKind,
} from "@contracts/templates";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { TEMPLATE_KIND_LABEL } from "@renderer/lib/templateLabels.js";
import { api } from "@renderer/lib/api.js";
// 一条模版的去重键来自 `@contracts/templates` 的 `templateAttachKey` —— chip 那边
// (`makeTemplateTag`)和主进程发附件时用的都是**同一个函数**,所以不可能算出两个
// 不一样的值(分叉的后果是同一条模版被重复加进输入框)。
import { templateAttachKey } from "@contracts/templates";
import { IconCheck, IconLoader2, IconSearch, IconTemplate } from "@renderer/lib/icons.js";

// 与 TemplatesPanel 同一张表 —— 类目在界面上的名字只有一处定义,两处必须一致

interface Props {
  open: boolean;
  /** 「+」按钮的位置 —— 贴着它向上展开(与 LibraryPicker 同款定位)。 */
  anchorRect: DOMRect | null;
  /** 已经加进上下文的模版键 —— 列出来但标为已选,避免重复添加。 */
  excludeKeys?: ReadonlyArray<string>;
  /** 确认时回调选中的模版。调用方负责生成清单并落成 tag。 */
  onPick: (entries: Array<{ kind: TemplateKind; dirName: string }>) => void;
  onClose: () => void;
}

export function TemplatePicker({ open, anchorRect, excludeKeys = [], onPick, onClose }: Props) {
  const { t, locale } = useI18n();
  const [entries, setEntries] = useState<TemplateEntry[]>([]);
  const [loading, setLoading] = useState(false);
  /** 拉列表失败 —— 必须说出来。空列表和"读不到"在界面上长得一样,不能混。 */
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const excluded = useMemo(() => new Set(excludeKeys), [excludeKeys]);

  // 打开即拉最新列表 + 聚焦搜索框。不缓存 —— 理由见文件头。
  useEffect(() => {
    if (!open) return undefined;
    setQuery("");
    setActiveIdx(0);
    setSelected(new Set());
    setError(null);
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    let cancelled = false;
    setLoading(true);
    // 包在 async IIFE 里而不是直接挂 `.then` —— 手机端的 web shim 对没有映射的
    // 命名空间是**同步抛错**的(`webApi.ts` 的 unsupportedNamespace),直接
    // `api.templates.list({}).then(...)` 会让这个异常逃出 effect,React 19 会
    // 因此整棵卸载。try/catch 把它变成一条能看见的错误文案。
    void (async () => {
      try {
        const res = await api.templates.list({});
        if (!cancelled) setEntries(res.entries);
      } catch {
        if (!cancelled) setError(t("templates.chat.loadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
    // t 不进依赖:locale 变了重拉一次列表是无意义的写(choice 只是取文案)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 全部条目按固定顺序排好(类目顺序 → 名字)。顺序稳定:键盘导航才可预期,
  // 提交时也能保证提示词里的模版顺序和用户看到的一致。
  const allSorted = useMemo(() => {
    const kindIndex = new Map(TEMPLATE_KINDS.map((k, i) => [k, i]));
    return [...entries].sort((a, b) => {
      const d = (kindIndex.get(a.kind) ?? 99) - (kindIndex.get(b.kind) ?? 99);
      return d !== 0 ? d : a.dirName.localeCompare(b.dirName, locale);
    });
  }, [entries, locale]);

  /** 过滤(含类目名),但**保留类目顺序** —— 分组标题就靠这个顺序。 */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allSorted;
    return allSorted.filter((e) => {
      // 类目名也进搜索域:打 "latex" / "ppt" / "图" 都能收窄
      const label = t(TEMPLATE_KIND_LABEL[e.kind]).toLowerCase();
      return e.dirName.toLowerCase().includes(q) || e.kind.includes(q) || label.includes(q);
    });
  }, [query, allSorted, t]);

  /**
   * 按**类目**分组的行序列:PPT / LaTeX / Word / 代码 / 图片 各一行标题,模版排在
   * 各自标题下面(用户要求"模版也是三级选择" —— 类目是第一级)。标题行不可选中。
   */
  const rows = useMemo(() => {
    const out: Array<{ key: string; header?: string; entry?: TemplateEntry }> = [];
    for (const k of TEMPLATE_KINDS) {
      const inKind = filtered.filter((e) => e.kind === k);
      if (inKind.length === 0) continue;
      out.push({ key: `h-${k}`, header: t(TEMPLATE_KIND_LABEL[k]) });
      for (const e of inKind) out.push({ key: templateAttachKey(e.kind, e.dirName), entry: e });
    }
    return out;
  }, [filtered, t]);

  /** 只含可选中项 —— 键盘导航与确认基于它。 */
  const options = useMemo(
    () => rows.flatMap((r) => (r.entry ? [r.entry] : [])),
    [rows],
  );

  useEffect(() => {
    setActiveIdx((i) => Math.min(i, Math.max(0, options.length - 1)));
  }, [options.length]);

  const toggle = (key: string) => {
    if (excluded.has(key)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const confirm = () => {
    if (selected.size === 0) {
      onClose();
      return;
    }
    // 从**全量**列表而不是当前过滤结果里取 —— 勾完再改搜索词时,被过滤掉的那几条
    // 仍然是勾选状态,不能悄悄丢掉(勾了却不见了比没勾更让人恼火)。
    onPick(
      allSorted
        .filter((e) => selected.has(templateAttachKey(e.kind, e.dirName)))
        .map((e) => ({ kind: e.kind, dirName: e.dirName })),
    );
    onClose();
  };

  // 键盘:↑↓ 导航、空格勾选、回车确认、Esc 关闭。捕获阶段,免得被编辑器的按键处理吃掉。
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
        // 空格 = 勾选(多选语义);回车 = 确认。与 LibraryPicker / FileMentionPicker 一致。
        if (e.key === " ") toggle(templateAttachKey(target.kind, target.dirName));
        else confirm();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, options, activeIdx, selected, excluded, onClose]);

  // 点外部关闭(与 LibraryPicker 同款:document mousedown + ref.contains)
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
  const width = Math.min(Math.max(anchorRect.width, 280), 400);

  return (
    <div
      ref={rootRef}
      className="fixed z-[70] flex max-h-72 flex-col overflow-hidden rounded-lg border border-edge bg-surface shadow-xl"
      style={{
        left,
        width,
        top: Math.max(8, anchorRect.top - 8),
        // 从锚点向上生长 —— 与 LibraryPicker 一致(输入框在屏幕底部)
        transform: "translateY(-100%)",
      }}
    >
      <div className="flex items-center gap-1.5 border-b border-edge px-2 py-1">
        <IconSearch size={12} className="shrink-0 text-content-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("templates.chat.searchPlaceholder")}
          className="h-6 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content-subtle"
        />
        {selected.size > 0 && (
          <button
            type="button"
            onClick={confirm}
            className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-surface hover:brightness-110"
          >
            {t("templates.chat.addN", { n: selected.size })}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {loading ? (
          <div className="flex items-center justify-center gap-1.5 px-3 py-4 text-[12px] text-content-subtle">
            <IconLoader2 size={12} className="animate-spin" />
            {t("common.loading")}
          </div>
        ) : error ? (
          <div className="px-3 py-4 text-center text-[12px] text-red-500">{error}</div>
        ) : options.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-content-subtle">
            {entries.length === 0 ? (
              <>
                <div>{t("templates.chat.empty")}</div>
                {/* 空的时候告诉用户去哪儿加 —— 否则这里就是一条死路 */}
                <div className="mt-1 text-[11px] opacity-80">{t("templates.chat.emptyHint")}</div>
              </>
            ) : (
              t("templates.chat.noMatch")
            )}
          </div>
        ) : (
          rows.map((row) => {
            if (!row.entry) {
              return (
                <div
                  key={row.key}
                  className="px-2.5 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-content-subtle"
                >
                  {row.header}
                </div>
              );
            }
            const e = row.entry;
            const key = row.key;
            const i = options.indexOf(e);
            const isExcluded = excluded.has(key);
            const isSelected = selected.has(key);
            return (
              <button
                key={key}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => toggle(key)}
                disabled={isExcluded}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors",
                  i === activeIdx ? "bg-surface-muted text-content" : "text-content-muted",
                  isExcluded && "opacity-40",
                )}
                title={
                  isExcluded
                    ? t("templates.chat.alreadyAdded")
                    : `${t(TEMPLATE_KIND_LABEL[e.kind])} · ${
                        e.kind === "image" && e.imageCount > 0
                          ? t("settings.templates.imagePair", {
                              img: e.imageCount,
                              code: e.codeFiles.length,
                            })
                          : t("settings.templates.fileCount", { n: e.files.length })
                      }`
                }
              >
                {/* 勾选位固定宽度,列表左边缘对齐 */}
                <span className="w-3.5 shrink-0">
                  {(isSelected || isExcluded) && <IconCheck size={12} className="text-accent" />}
                </span>
                <IconTemplate size={13} className="shrink-0 opacity-80" />
                <span className="min-w-0 flex-1 truncate">{e.dirName}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
