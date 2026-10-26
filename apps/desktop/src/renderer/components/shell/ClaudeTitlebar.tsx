/**
 * 【UI 重建】**Claude 形态的顶栏** —— 取代旧 `Titlebar` 那排图标按钮。
 *
 * ## 从本机 Claude 3.1623.4.0 读到的结构
 *
 * 它的顶栏不是一条塞满按钮的横条，而是**两层**：
 *
 * ```
 * ┌─ 标题行 (titlebar) ────────────────────────────────┐
 * │ [折叠侧栏]   ← 会话标题 · 项目        [⋯] [设置]    │  高 45px
 * ├─ 页面头 (data-cds=PageHeader) ─────────────────────┤
 * │ 分支 · 工作树 · 运行状态                            │  有内容时才出现
 * └────────────────────────────────────────────────────┘
 * ```
 *
 * 证据：
 *  - `data-cds="PageHeader"` 出现在其 bundle 里，并且被显式测量
 *    （`classList.contains(…querySelector("[data-cds=PageHeader]").getBoundingClientRect())`）
 *  - 布局变体枚举 `"chin" | "row" | "titlebar" | "rail" | "composer"`
 *    —— 同一套 parts 系统在五种区域里用，说明顶栏是其中一种「parts」
 *  - `underTitleRow: { top: 48 }` / `underPageHeader: { top: 64 }`
 *    —— 这是它自己写的吸附偏移，说明标题行约 48px、页面头在 64px 处
 *
 * ## 与旧 Titlebar 的区别
 *
 * 旧版把「布局预设 / 编辑器开关 / 终端开关 / 右栏开关」全塞在顶栏右侧，
 * 一排 6 个图标。Claude 把这些收进 `⋯` 溢出菜单，顶栏只留**一个主入口**和
 * **必要状态**。这是「看着干净」与「看着拥挤」的分界。
 */
import { useState, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";

export interface ClaudeTitlebarProps {
  /** 会话标题（无会话时显示项目名）。 */
  title: string;
  /** 所属项目名（显示成次级文字）。 */
  subtitle?: string;
  /** 左侧折叠按钮（侧栏关闭时显示）。 */
  onToggleSidebar?: () => void;
  sidebarOpen: boolean;
  /** 页面头里的状态胶囊（分支 / 工作树 / 运行状态）。 */
  statusChips?: ReactNode;
  /** `⋯` 溢出菜单里的条目。 */
  menuItems: Array<{ id: string; label: string; onSelect: () => void; checked?: boolean }>;
  /** 右侧固定入口（设置等）。 */
  actions?: ReactNode;
}

/** 标题行高度。Claude 自己的吸附偏移写的是 48px（`underTitleRow.top`）。 */
const TITLEBAR_H = 48;

export function ClaudeTitlebar({
  title,
  subtitle,
  onToggleSidebar,
  sidebarOpen,
  statusChips,
  menuItems,
  actions,
}: ClaudeTitlebarProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="shrink-0">
      {/* ── 标题行 ── */}
      <header
        data-cds="Titlebar"
        className="flex items-center gap-2 px-3"
        style={{ height: TITLEBAR_H }}
      >
        {!sidebarOpen && onToggleSidebar && (
          <button
            type="button"
            aria-label="展开侧栏"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-[var(--m-text-secondary)] hover:bg-[var(--m-fill-ghost-hover)]"
            onClick={onToggleSidebar}
          >
            <SidebarIcon />
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="min-w-0 truncate text-[var(--m-fs-prose)] font-medium text-[var(--m-text-primary)]">
            {title}
          </span>
          {subtitle && (
            <span className="min-w-0 shrink-0 truncate text-[var(--m-fs-caption)] text-[var(--m-text-muted)]">
              {subtitle}
            </span>
          )}
        </div>

        {/* `⋯` 溢出菜单：布局开关、面板开关等都收在这里，不在顶栏排一排。 */}
        {menuItems.length > 0 && (
          <div className="relative shrink-0">
            <button
              type="button"
              aria-label="更多"
              aria-expanded={menuOpen}
              className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--m-text-secondary)] hover:bg-[var(--m-fill-ghost-hover)]"
              onClick={() => setMenuOpen((v) => !v)}
            >
              <MoreIcon />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div
                  role="menu"
                  className="absolute right-0 top-8 z-50 min-w-[180px] rounded-[var(--m-radius-md)] border border-[var(--m-border)] bg-[var(--m-surface-3)] py-1 shadow-[var(--m-shadow-popover)]"
                >
                  {menuItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--m-fs-body)] hover:bg-[var(--m-fill-ghost-hover)]"
                      onClick={() => {
                        item.onSelect();
                        setMenuOpen(false);
                      }}
                    >
                      <span className="w-3.5 shrink-0 text-[var(--m-accent)]">
                        {item.checked ? "✓" : ""}
                      </span>
                      {item.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {actions}
      </header>

      {/* ── 页面头：只有真的有状态时才出现（Claude 也是按需渲染） ── */}
      {statusChips && (
        <div
          data-cds="PageHeader"
          className={cn(
            "flex items-center gap-2 px-3 pb-2",
            "text-[var(--m-fs-caption)] text-[var(--m-text-secondary)]",
          )}
        >
          {statusChips}
        </div>
      )}
    </div>
  );
}

function SidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </svg>
  );
}
