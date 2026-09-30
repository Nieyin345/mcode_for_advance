/**
 * 工作流库里的一行。
 *
 * ## 为什么单独一个组件
 *
 * 它是整个面板里**唯一渲染列表行**的东西,而列表行是面板上最容易悄悄坏掉的一块
 * (名字取错、徽章漏了、说明串行)。留在 `WorkflowLibraryView` 里的话,要画它就得
 * 挂载整个容器 —— 而容器一挂载就发 RPC,`react-dom/server` 下只能看到"加载中"那一
 * 帧,于是这一段标记**永远没被渲染过**(批次 C 的页签容器就是这么漏掉一个布局
 * bug 的)。抽出来之后 `scripts/workflow-view-smoke` 能直接把它画出来断言。
 *
 * 名字 / 说明 / 图标都走 `lib/workflowLabels.tsx` —— 内置的六个在界面上显示的是
 * 词条(切语言跟着变),自建的用作者自己起的名字。这里不重复那条规则。
 */
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import {
  workflowDisplayDescription,
  workflowDisplayName,
  workflowIcon,
} from "@renderer/lib/workflowLabels.js";
import type { WorkflowListEntry } from "@contracts/workflow";
import { WorkflowBadge } from "./WorkflowBadge.js";

export function WorkflowListRow({
  entry,
  active,
  unsaved,
  onSelect,
}: {
  entry: WorkflowListEntry;
  active: boolean;
  /** 这一条有**没保存的草稿**(见 `WorkflowLibraryView` 的 `DRAFTS`)。
   *  保存改成手点之后,这就是"我刚才改的东西去哪了"的唯一提示 —— 用户切到别的
   *  工作流之后,那条改动在列表上要看得出来。 */
  unsaved?: boolean;
  onSelect: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <button
      onClick={onSelect}
      className={cn(
        "relative block w-full rounded px-2.5 py-1.5 text-left transition-colors",
        active ? "bg-surface-hover" : "hover:bg-surface-hover/60",
      )}
    >
      {/* 「当前选中的是哪一个」—— 左侧那根强调色竖条,与 SkillsPanel 的列表同一形状。 */}
      {active && (
        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
      )}
      <div className="flex items-center gap-1">
        <span className="shrink-0 text-content-subtle">{workflowIcon(entry.id, 11)}</span>
        <span className="truncate text-[0.7857em] font-medium text-content">
          {workflowDisplayName(entry, locale)}
        </span>
        {/* 「已修改」= 内置工作流被用户覆盖过。自建的不打这个徽章 —— 它整条都是用户写的,
            再说"已修改"没有意义。 */}
        {entry.edited && (
          <WorkflowBadge tone="accent">{t("settings.workflows.badgeEdited")}</WorkflowBadge>
        )}
        {/* 软件自带的这一份出厂版有更新(见 applyShippedWorkflowUpdate)。 */}
        {entry.shippedUpdate && (
          <WorkflowBadge tone="info">{t("settings.workflows.badgeShippedUpdate")}</WorkflowBadge>
        )}
        {unsaved && (
          // 一颗实心小点,不是徽章:它说的是"还没定下来",而徽章读起来像个状态。
          // 用 `ml-auto` 顶到最右边,和名字之间隔着一段 —— 名字长短不一,挨着写会
          // 让人以为它是名字的一部分。
          <span
            className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
            title={t("settings.workflows.unsavedDot")}
          />
        )}
      </div>
      <div className="truncate text-[0.7143em] text-content-subtle">
        {workflowDisplayDescription(entry, locale)}
      </div>
    </button>
  );
}
