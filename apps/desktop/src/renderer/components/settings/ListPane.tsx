/**
 * ListPane — 「列表 + 详情」那一类设置页的**左栏框**（也用于钩子页下方的执行记录窗）。
 *
 * ## 为什么要有它
 *
 * 设置页的共享外壳（`PanelHeader` → `SettingsSection` → `SettingRow`）是给**表单**
 * 用的：一行一个设置。而技能、钩子这两页是**左边一列条目、右边编辑选中的那一条**，
 * 表单外壳装不下 —— 于是每页自己画了一个左栏。`MCode-优化方向.md` §3.6 数出来的
 * "三个大面板几乎不用共享外壳"，根子就在这里：缺的不是自觉，是一个装得下这种布局的件。
 *
 * 自己画的结果（2026-09-26 在 `.tmp/panels-preview` 里对出来的）：
 *  - 标题行一页是 0.7857em、一页是 0.7143em 加全大写；
 *  - 列表还没回来时，钩子页左栏是**一片空白**、计数写着「…」（没有任何加载状态）；
 *  - 空列表各写一段居中小字，和别处的 `EmptyState` 不是一个样子。
 *
 * ## 形状
 *
 * 框（圆角 + 细边 + 浅底）→ 标题行（左：`title`；右：`actions` + 条数）→ 滚动区
 * （`children`）→ 可选底栏（`footer`，上面一条细线）。
 *
 * **空不空由调用方说**（`isEmpty`）：只有它知道什么算内容 —— 比如技能页"新建中"
 * 那一行草稿也是内容。`isEmpty && loading` 画骨架；`isEmpty && !loading` 画
 * `empty`（共享 `EmptyState`）；不空时照常画 `children`，`loading` 只把条数换成转圈
 * （刷新时不要把已有的列表清掉）。
 *
 * `data-list-pane` / `data-list-state` 是给预览台量的，不要删。
 */
import type { ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { EmptyState, Skeleton, Spinner } from "@renderer/components/ui/index.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

export function ListPane({
  title,
  count,
  loading = false,
  isEmpty = false,
  empty,
  actions,
  footer,
  handle,
  className,
  children,
}: {
  title: ReactNode;
  /** 条数，显示在标题行右端。省略则不显示。 */
  count?: number;
  /** 在拉数据。空的时候画骨架，不空时只把条数换成转圈。 */
  loading?: boolean;
  isEmpty?: boolean;
  /** 空列表时的那句话（已翻译）。 */
  empty?: ReactNode;
  /** 标题行右侧、条数左边的小按钮们。 */
  actions?: ReactNode;
  /** 底栏（新建 / 导入这类按钮）。 */
  footer?: ReactNode;
  /** 贴在框边上的东西（例如拖宽度的把手）。框是 `relative`，它自己 absolute 定位。 */
  handle?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const state = isEmpty ? (loading ? "loading" : "empty") : "ready";
  return (
    <aside
      data-list-pane=""
      data-list-state={state}
      className={cn("relative flex min-h-0 flex-col rounded-md border border-edge bg-surface/40", className)}
    >
      {handle}
      <div
        data-list-pane-head=""
        // **定高**（h-9）而不是上下留白：标题行里放不放小按钮，行高都一样 ——
        // 否则技能页（有「全选」「按来源」按钮）37px、钩子页（只有字）33px，并排切换会跳。
        className="flex h-9 shrink-0 items-center justify-between gap-2 px-2.5 text-[0.7857em] font-medium text-content-subtle"
      >
        <span className="flex min-w-0 items-center gap-2">{title}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {actions}
          {loading ? (
            <Spinner size="xs" label={t("common.loading")} />
          ) : count !== undefined ? (
            <span className="tabular-nums">{count}</span>
          ) : null}
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-1.5">
        {children}
        {state === "loading" && (
          <div className="space-y-1.5 px-1 pt-0.5">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9 w-4/5" />
          </div>
        )}
        {state === "empty" && empty ? <EmptyState className="py-6" title={empty} /> : null}
      </div>
      {footer && <div className="space-y-1.5 border-t border-edge p-1.5">{footer}</div>}
    </aside>
  );
}
