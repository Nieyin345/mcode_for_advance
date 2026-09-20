/**
 * 中栏:文献列表。
 *
 * 列表刻意做成**紧凑的单行 + 状态徽标**而不是卡片:一个研究方向动辄几十上百篇,
 * 卡片会让人必须不停滚动才能建立全局印象,而这里用户最常做的是「扫一眼哪些还
 * 没下到 PDF」。
 */
import type { LibraryItem, PdfState } from "@contracts/library";
import { formatAuthorList, needsMetadata, type LibraryKind } from "@contracts/library";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { cn } from "@renderer/lib/cn.js";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconDownload,
  IconFileTypePdf,
  IconLoader2,
  IconLock,
  IconSearch,
  IconUpload,
} from "@renderer/lib/icons.js";

interface Props {
  /** 当前在哪个库 —— 只影响空态文案:笔记库收的是 md,另外两个库收 PDF 再转录。 */
  kind: LibraryKind;
  items: LibraryItem[];
  pdfStateOf: (item: LibraryItem) => PdfState;
  activeId: string | null;
  selectedIds: string[];
  onActivate: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onSelectAll: (ids: string[]) => void;
  /** 空态里那两个按钮的动作。空态是最该给下一步动作的地方 —— 只写"用检索或
   *  粘贴 DOI"而不给按钮,用户会卡在这儿(真发生过:找不到导入入口)。 */
  onImport: () => void;
  onSearch: () => void;
  /**
   * 当前看的是**某个分类**时给出:点它回到「全部<库>」。
   *
   * 为什么需要:分类是视图,不是所有权。用户建完分类、右栏切过去,刚导入的条目
   * (没归进这个分类)**就从视野里消失了** —— 看起来像数据没了(实际一条没丢)。
   * 空态里给一条明确的退路,"东西去哪了"这个疑问就不会成立。
   */
  onShowAll?: () => void;
}

/** PDF 状态徽标。文案与配色一一对应「用户该做什么」,不只是描述状态。 */
export function PdfBadge({ state, compact = false }: { state: PdfState; compact?: boolean }) {
  const { t } = useI18n();

  const spec: Record<PdfState, { icon: React.ReactNode; label: string; cls: string }> = {
    ready: {
      icon: <IconFileTypePdf size={13} />,
      label: t("library.pdf.ready"),
      cls: "text-accent",
    },
    none: {
      icon: <IconDownload size={13} />,
      label: t("library.pdf.none"),
      cls: "text-content-subtle",
    },
    queued: {
      icon: <IconLoader2 size={13} />,
      label: t("library.pdf.queued"),
      cls: "text-content-muted",
    },
    downloading: {
      icon: <IconLoader2 size={13} className="animate-spin" />,
      label: t("library.pdf.downloading"),
      cls: "text-content-muted",
    },
    // 需要登录用暖色 —— 这是唯一需要用户动手的状态
    needs_login: {
      icon: <IconLock size={13} />,
      label: t("library.pdf.needsLogin"),
      cls: "text-amber-600 dark:text-amber-500",
    },
    // 找不到来源也走暖色、也用警告图标,但**不说「失败」** —— 五个源都翻过而
    // 确实没有开放版本,这不是"下砸了",用户重试多少次结果都一样。
    // 见 `derivePdfState` 里那段说明。
    not_found: {
      icon: <IconAlertTriangle size={13} />,
      label: t("library.pdf.notFound"),
      cls: "text-amber-600 dark:text-amber-500",
    },
    failed: {
      icon: <IconAlertTriangle size={13} />,
      label: t("library.pdf.failed"),
      cls: "text-red-600 dark:text-red-400",
    },
  };

  const s = spec[state];
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1", s.cls)}
      title={compact ? s.label : undefined}
    >
      {s.icon}
      {!compact && <span className="text-[0.9em]">{s.label}</span>}
    </span>
  );
}

export function ItemList({
  kind,
  items,
  pdfStateOf,
  activeId,
  selectedIds,
  onActivate,
  onToggleSelect,
  onSelectAll,
  onImport,
  onSearch,
  onShowAll,
}: Props) {
  const { t } = useI18n();

  if (items.length === 0) {
    // 在某个分类里看到空 —— 这和"整个库是空的"是两回事,说法与出口都要不一样
    if (onShowAll) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <IconCircleCheck size={28} className="text-content-subtle" />
          <div className="text-sm text-content-muted">{t("library.collection.empty")}</div>
          <div className="max-w-xs text-xs text-content-subtle">
            {t("library.list.emptyInCollection")}
          </div>
          <button
            onClick={onShowAll}
            className="mt-1 flex items-center gap-1.5 rounded border border-edge px-3 py-1.5 text-xs text-content-muted hover:bg-surface-hover hover:text-content"
          >
            <IconSearch size={13} />
            {t("library.list.showAll")}
          </button>
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <IconCircleCheck size={28} className="text-content-subtle" />
        <div className="text-sm text-content-muted">
          {kind === "note" ? t("library.list.emptyNote") : t("library.list.empty")}
        </div>
        <div className="max-w-xs text-xs text-content-subtle">
          {kind === "note" ? t("library.list.emptyHintNote") : t("library.list.emptyHint")}
        </div>
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={onImport}
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white hover:opacity-90"
          >
            <IconUpload size={13} />
            {kind === "note" ? t("library.import.pickNote") : t("library.import.pickPdf")}
          </button>
          <button
            onClick={onSearch}
            className="flex items-center gap-1.5 rounded border border-edge px-3 py-1.5 text-xs text-content-muted hover:bg-surface-hover hover:text-content"
          >
            <IconSearch size={13} />
            {t("library.action.search")}
          </button>
        </div>
      </div>
    );
  }

  const allSelected = selectedIds.length === items.length && items.length > 0;

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-edge px-4 py-1">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={() => onSelectAll(allSelected ? [] : items.map((i) => i.id))}
          className="h-3 w-3 accent-[var(--accent)]"
        />
        <span className="text-[0.7143em] text-content-subtle">{t("library.list.count", { n: items.length })}</span>
      </div>

      {items.map((item) => {
        const state = pdfStateOf(item);
        const isActive = item.id === activeId;
        const isSelected = selectedIds.includes(item.id);
        return (
          <div
            key={item.id}
            onClick={() => onActivate(item.id)}
            className={cn(
              // `relative` 不能省 —— 下面那条选中竖条是 `absolute`,锚的是**最近的
              // 定位祖先**。少了它,竖条会锚到整个列表容器上:每选中一行,同一根竖条
              // 就出现在列表左边线上那一行的位置(而不是行首),看起来像列表串了个门。
              "relative flex cursor-pointer items-start gap-2 border-b border-edge/50 px-4 py-2 transition-colors",
              isActive ? "bg-surface-hover" : "hover:bg-surface-hover/60",
            )}
          >
            <input
              type="checkbox"
              checked={isSelected}
              onClick={(e) => e.stopPropagation()}
              onChange={() => onToggleSelect(item.id)}
              className="mt-0.5 h-3 w-3 shrink-0 accent-[var(--accent)]"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-content" title={item.title}>
                {item.title}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[0.7143em] text-content-subtle">
                {item.year && <span className="tabular-nums">{item.year}</span>}
                {item.authors.length > 0 && (
                  <span className="min-w-0 truncate">{formatAuthorList(item.authors, 2)}</span>
                )}
                {item.venue && <span className="min-w-0 truncate">{item.venue}</span>}
              </div>
            </div>
            {/* 元数据不全 —— 用**文字**而不是又一个警告图标:一行里已经可能有一个
                琥珀色的失败图标(PDF 状态),再放一个形状相近的图标只会让人分不清
                哪个是哪个。文字说的正是缺什么这件事。 */}
            {needsMetadata(item) && (
              <span
                title={t("library.list.needsMeta")}
                className="shrink-0 rounded bg-amber-500/15 px-1 py-px text-[0.7143em] text-amber-700 dark:text-amber-400"
              >
                {t("library.list.needsMetaShort")}
              </span>
            )}
            {/* 笔记本来就没有 PDF,给每一行挂一个「没有 PDF」是纯噪音 */}
            {kind !== "note" && <PdfBadge state={state} compact />}
            {isActive && (
              <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
            )}
          </div>
        );
      })}
    </div>
  );
}
