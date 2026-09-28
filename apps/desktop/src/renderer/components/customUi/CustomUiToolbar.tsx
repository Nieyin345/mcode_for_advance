/**
 * **竖向工具栏** —— 主页面与右栏之间的一列按钮(挂载位 `toolbar`)。
 *
 * 位置由 `ThreePaneLayout` 决定:它排在中间主区的右边、右栏的左边;右栏收起时右栏整个
 * 不渲染,于是它自然贴到窗口最右边 —— 不需要额外的「跟着挪」逻辑。
 *
 * 它自己也能收起(用户:「相当于是一个独立的」):收起后只剩一条窄边,点一下再展开。
 * 收起状态每台机器各自记(`customUiStore.toolbarCollapsed`)。
 *
 * 按钮全是用户在「设置 → 自定义 UI → 工具栏」里摆的,没有内置按钮;点了做什么见
 * `runCustomItem`(打开视图 / 发给对话 / 复制 / 运行自动化 / 打开文件 / 切到右栏页签)。
 */
import { useMemo } from "react";
import { customUiLabel, type CustomUiItem } from "@contracts/customUi";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconAdjustmentsHorizontal, IconChevronLeft, IconChevronRight, IconPlus } from "@renderer/lib/icons.js";
import { openCustomUiSettings, useCustomUiStore } from "@renderer/stores/customUiStore.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { resolveSlotEntries } from "./CustomUiMenuItems.js";
import { CUSTOM_ICONS, DEFAULT_ACTION_ICON } from "./registry.js";
import { runCustomItem } from "./runCustomItem.js";
import { useWorkspaceTarget } from "./useWorkspaceTarget.js";

const NO_BUILTINS = {};
const NO_MODULES: never[] = [];

export function CustomUiToolbar() {
  const { t, locale } = useI18n();
  const items = useCustomUiStore((s) => s.config.items);
  const layout = useCustomUiStore((s) => s.config.layout.toolbar);
  const collapsed = useCustomUiStore((s) => s.toolbarCollapsed);
  const setCollapsed = useCustomUiStore((s) => s.setToolbarCollapsed);
  // 「切到页签」按钮要知道右栏此刻显示的是不是它(高亮)
  const activeTab = useCustomUiStore((s) => s.activeTab);
  const rightOpen = useSessionStore((s) => s.rightOpen);
  const rightPanelTab = useSessionStore((s) => s.rightPanelTab);
  const target = useWorkspaceTarget();

  const entries = useMemo(
    () => resolveSlotEntries("toolbar", target, items, layout, NO_BUILTINS, NO_MODULES),
    [target, items, layout],
  );

  if (collapsed) {
    return (
      <button
        type="button"
        data-testid="custom-ui-toolbar-collapsed"
        onClick={() => setCollapsed(false)}
        title={t("customUi.toolbar.expand")}
        aria-label={t("customUi.toolbar.expand")}
        className="group flex h-full w-3 shrink-0 flex-col items-center border-t border-edge-panel bg-surface-muted pt-2 text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
      >
        <IconChevronLeft size={10} className="shrink-0 opacity-60 group-hover:opacity-100" />
      </button>
    );
  }

  const isShowing = (item: CustomUiItem): boolean => {
    if (item.action.type !== "openTab" || !rightOpen) return false;
    const key = item.action.tab;
    return key.startsWith("custom:")
      ? activeTab === key.slice("custom:".length)
      : activeTab === null && key === `builtin:${rightPanelTab}`;
  };

  return (
    <div
      data-testid="custom-ui-toolbar"
      className="flex h-full w-10 shrink-0 flex-col items-center gap-1 border-t border-edge-panel bg-surface-muted py-1.5"
    >
      <button
        type="button"
        onClick={() => setCollapsed(true)}
        title={t("customUi.toolbar.collapse")}
        aria-label={t("customUi.toolbar.collapse")}
        className="flex h-5 w-7 items-center justify-center rounded text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
      >
        <IconChevronRight size={12} />
      </button>
      <div className="h-px w-5 shrink-0 bg-edge" />

      <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
        {entries.map((e) => {
          if (e.kind !== "custom") return null;
          const Icon = e.item.icon ? CUSTOM_ICONS[e.item.icon] : DEFAULT_ACTION_ICON[e.item.action.type];
          const label = customUiLabel(e.item.label, locale);
          const active = isShowing(e.item);
          return (
            <button
              key={e.key}
              type="button"
              data-testid="custom-ui-toolbar-button"
              onClick={() => void runCustomItem(e.item, target)}
              title={label}
              aria-label={label}
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors",
                active ? "bg-accent/15 text-accent" : "text-content-muted hover:bg-surface-hover hover:text-content",
              )}
            >
              <Icon size={16} className="shrink-0" />
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => openCustomUiSettings("toolbar")}
        title={entries.length === 0 ? t("customUi.toolbar.add") : t("customUi.toolbar.customize")}
        aria-label={entries.length === 0 ? t("customUi.toolbar.add") : t("customUi.toolbar.customize")}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
      >
        {entries.length === 0 ? <IconPlus size={15} /> : <IconAdjustmentsHorizontal size={15} />}
      </button>
    </div>
  );
}
