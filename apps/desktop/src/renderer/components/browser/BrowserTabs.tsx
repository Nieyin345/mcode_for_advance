import { cn } from "@renderer/lib/cn.js";
import { IconX, IconPlus, IconLoader2, IconWorld } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type React from "react";

/** A single browser tab's display state (mirrors the BrowserTab in BrowserPanel
 *  minus browserId, which the tab strip doesn't need). */
export interface BrowserTabDisplay {
  id: string;
  title: string;
  url: string;
  loading: boolean;
}

/**
 * Tab strip for the embedded browser panel. Mirrors the SessionTabs visual
 * pattern (rounded-t, border-b-2 accent on active, close-on-hover) but
 * simplified: fixed order (no drag-reorder), horizontal scroll on overflow
 * (no chevrons/overflow menu), and a trailing "+" new-tab button.
 *
 * Middle-click on a tab closes it (browser convention).
 *
 * 【UI-013】键盘可访问:整条是一个 `role="tablist"`,每个标签是 `role="tab"` 且带
 * **roving tabindex**(只有选中标签 tabIndex=0,其余 -1)—— Tab 键进入 tablist 后,
 * ArrowLeft/Right/Home/End 在标签间移动并切换,Enter/Space 选中当前标签。关闭按钮
 * 在**焦点进入标签时**可见(`group-focus-within`),不再只靠 hover —— 键盘用户看不到
 * 一个 opacity-0 却可聚焦的按钮。关闭按钮 `stopPropagation` 仍保留,避免点击双触发。
 */
export interface BrowserTabsProps {
  tabs: BrowserTabDisplay[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

/** 在标签条里做 roving-tabindex 键盘导航 + 选择。与 WorkflowsPanel 的
 *  `moveTabFocus` 同一模式(方向键移动焦点并切换、Home/End 到两端)。 */
function onTabKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
  const tab = event.currentTarget;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    tab.click();
    return;
  }
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = Array.from(
    tab.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
  );
  if (tabs.length === 0) return;
  event.preventDefault();
  const current = Math.max(0, tabs.indexOf(tab));
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  const target = tabs[next];
  target?.focus();
  target?.click();
}

export function BrowserTabs({ tabs, activeTabId, onSelect, onClose, onNew }: BrowserTabsProps) {
  const { t } = useI18n();
  if (tabs.length === 0) return null;
  return (
    <div className="flex h-9 shrink-0 items-end gap-0.5 border-b border-edge bg-surface/40 px-2 pt-1.5">
      <div role="tablist" aria-label={t("browser.tabsAria")} className="no-scrollbar flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto">
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTabId;
          // Derive a short tab title: prefer the page title, fall back to the
          // URL's hostname, then the "new tab" placeholder for about:blank/empty.
          const host = (() => {
            try {
              if (tab.url && tab.url !== "about:blank") return new URL(tab.url).hostname;
            } catch {
              /* not a valid URL */
            }
            return null;
          })();
          const label = tab.title || host || (tab.url && tab.url !== "about:blank" ? tab.url : t("browser.newTab"));
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              // 【UI-013】roving tabindex:只有选中标签可被 Tab 聚焦,方向键在组内移动。
              tabIndex={isActive ? 0 : -1}
              aria-label={t("browser.tabAria", { n: String(index + 1), total: String(tabs.length), title: label })}
              onKeyDown={onTabKeyDown}
              onClick={() => onSelect(tab.id)}
              onMouseDown={(e) => {
                // Middle-click closes the tab (browser convention).
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
              className={cn(
                "group flex max-w-[180px] min-w-0 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-[11px] transition-colors",
                "outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent",
                isActive
                  ? "border-accent bg-surface text-content"
                  : "border-transparent text-content-muted hover:bg-surface-muted/50 hover:text-content",
              )}
              title={label}
            >
              {tab.loading ? (
                <IconLoader2 size={12} className="shrink-0 animate-spin text-accent" />
              ) : (
                <IconWorld size={12} className="shrink-0 text-content-subtle" />
              )}
              <span className="min-w-0 truncate">{label}</span>
              <button
                type="button"
                aria-label={t("browser.closeTabAria")}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className={cn(
                  // 【UI-013】`group-focus-within:opacity-100` —— 焦点进入标签(或关闭键)时
                  // 关闭按钮即显现,不再只靠 hover,键盘用户不会聚焦到一个看不见的按钮。
                  "ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle transition-opacity hover:bg-surface-hover hover:text-content focus-visible:ring-1 focus-visible:ring-accent",
                  isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                )}
              >
                <IconX size={11} />
              </button>
            </div>
          );
        })}
      </div>
      {/* New-tab button. */}
      <button
        type="button"
        onClick={onNew}
        title={t("browser.createTab")}
        aria-label={t("browser.createTab")}
        className="mb-0.5 ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-content-muted transition-colors hover:bg-surface-muted hover:text-content"
      >
        <IconPlus size={14} />
      </button>
    </div>
  );
}
