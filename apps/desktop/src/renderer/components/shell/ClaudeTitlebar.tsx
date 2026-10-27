/**
 * 【UI 重建】**Claude 形态的顶栏** —— 取代旧 `Titlebar` 那排图标按钮。
 *
 * ## 从本机 Claude 读到的结构
 *
 * 顶栏是**两层**：
 *
 * ```
 * ┌─ 标题行 ───────────────────────────────────────────────────┐
 * │ [折叠] ← 会话标题 ⌄    [📋][>_][＋][▷][📁] ⋯  ─ □ ✕      │ 高 48px
 * ├─ 页面头 ───────────────────────────────────────────────────┤
 * │ 分支 · 工作树 · 运行状态                                    │  有内容时才出现
 * └────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## ⚠️ 上一版注释写错了，已被真机截图推翻
 *
 * 上一版写「Claude 把这些收进 `⋯` 溢出菜单，顶栏只留一个主入口」，
 * 并据此把**所有**布局开关塞进 `⋯`。**那是错的。**
 *
 * 真机截图（`tools/claude-ui-reverse/reference-screenshot-175pct.webp`，
 * 裁顶栏右半）里，标题右侧是**一排五个图标按钮**：
 *
 * | 图标 | 语义（对应 Claude 的 `Show …` 文案） |
 * |---|---|
 * | 📋 列表 | Show …（当前激活 —— 有灰底圆角，是**选中态**） |
 * | `>_` | Show Terminal |
 * | ＋ | 新建 pane / 新侧聊 |
 * | ▷ | Show Preview |
 * | 📁 | Show Files |
 *
 * 之后才是 `⋯`，再之后是窗口按钮（─ □ ✕）。
 *
 * **所以「收进溢出菜单」是 Mcode 自己的做法，不是 Claude 的。**
 * 判据是**激活态**：截图里第一个图标有 `--cds-fill-ghost-selected` 那样的
 * 灰底 —— 一排只能有一个选中，这正是「pane 开关」的表现，菜单项不会这样。
 *
 * `changes` / `browser` 两个开关不在这一排里（Claude 按上下文显示），
 * 但它们仍在 `⋯` 里可达，不丢功能。
 *
 * 证据补充：`data-cds="PageHeader"` 在其 bundle 里被显式测量；
 * 布局变体枚举 `"chin" | "row" | "titlebar" | "rail" | "composer"`
 * 说明顶栏是 parts 系统里的一种。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";

/** 顶栏右侧的一个 pane 开关。 */
export interface PaneToggle {
  id: string;
  /** 无障碍标签与 tooltip（Claude 自己也只用图标 + tooltip）。 */
  label: string;
  icon: ReactNode;
  /** 该 pane 当前是否显示。 */
  active: boolean;
  onSelect: () => void;
}

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
  /** 标题右侧的 **pane 开关行**（Claude 的顶栏形态）。
   *
   *  ⚠️ 这**不是**菜单项的替代 —— 菜单项仍在 `⋯` 里，两处共用同一个
   *  store action（硬规矩 2：共享实现只有一份）。这里只是把最常用的
   *  五个提到台面上，与截图一致。 */
  paneToggles?: PaneToggle[];
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
  paneToggles,
  menuItems,
  actions,
}: ClaudeTitlebarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  /* 【UI 重建 2026-10-27】**菜单要有键盘出口。**
   *
   * 透明 backdrop 只服务鼠标（点外关闭）。键盘用户切不出去 —— 这是真实的
   * 可访问性缺陷，被 clickable-row-a11y-smoke 的静态规则抓到了
   *（「div 带 onClick 而无 role/tabIndex/onKeyDown」）。同族组件
   *（ContextStatsPopover / WatchSegment）都有 Escape 出口，这里对齐。
   *
   * 焦点也要还回去：Escape 之后如果焦点留在已被卸载的菜单项上，浏览器会把它
   * 丢到 body —— 用户的 Tab 序就断了。 */
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setMenuOpen(false);
      // 把焦点还给触发按钮（它是这个 div 里的那个 ⋯ 按钮）
      menuRef.current?.querySelector<HTMLButtonElement>("button[aria-haspopup]")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="shrink-0">
      {/* ── 标题行 ── */}
      <header
        data-cds="Titlebar"
        className="flex items-center gap-2 px-3"
        style={{ height: TITLEBAR_H }}
      >
        {/* 【UI 重建】折叠按钮**始终显示**（Claude 顶栏一直有它）。
            原来只在侧栏关闭时出现 —— 那样侧栏开着时标题会紧贴左边缘，
            而折叠入口又只在 ⋯ 菜单里，用户得找两次。 */}
        {onToggleSidebar && (
          <button
            type="button"
            aria-label={sidebarOpen ? "折叠侧栏" : "展开侧栏"}
            aria-pressed={sidebarOpen}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-[var(--m-text-secondary)] hover:bg-[var(--m-fill-ghost-hover)]"
            onClick={onToggleSidebar}
          >
            <SidebarIcon />
          </button>
        )}
        {/* 【UI 重建 2026-10-28 更正】标题组**占满剩余宽度**（`flex-1`）。
         *
         * 前一版我把它改成 `shrink`，把 pane 开关行紧贴在标题后面 —— 那是我
         * 读错了截图。**用户给的真机截图**里，图标组是在**最右边**：
         *
         *   `[☰ ▭ ← →]  标题 ⌄ ———————————— [📋 >_ ＋ ▷ 📁] ⋯ ─ □ ✕`
         *
         * 标题与图标组之间是一大片空白，图标组紧挨 ⋯ 与窗口按钮。
         * 所以标题组恢复 `flex-1`（吃掉空白），图标行靠 `ml-auto` 贴右。 */}
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          {/* 【UI 重建 2026-10-27】**标题字号从 `--m-fs-prose`（16px）降到 heading（14.12px）。**
           *
           * 真机截图实测：标题字形（cap height）约 **17 物理 px**，
           * ÷1.75 DPR = 9.7 css px。cap height ≈ 0.70 × font-size
           * → 字号 ≈ **13.9px**，对得上 `--m-fs-heading` = 14.12px，
           * 对不上 `--m-fs-prose` = 16px（那个的 cap 会是 11.2 css px = 19.6 物理）。
           *
           * 上一版用 prose —— 那是 **Markdown 正文**那一档，不是标题档。
           * 顶栏标题和正文用同一档，会让标题看起来偏大、和下面正文抢视觉重量。 */}
          <span className="min-w-0 truncate text-[length:var(--m-fs-heading)] font-medium text-[var(--m-text-primary)]">
            {title}
          </span>
          {subtitle && (
            <span className="min-w-0 shrink-0 truncate text-[var(--m-fs-caption)] text-[var(--m-text-muted)]">
              {subtitle}
            </span>
          )}
          {/* 会话切换器 chevron —— 真机截图里标题右侧有一个 `⌄`，
           * 表示「点这里切会话」。Mcode 的标题目前不可点，所以这里**只画
           * 形状不接交互**：先让布局与 Claude 一致，交互等接上会话切换再补。
           * 画一个不能点的控件会误导用户，所以带上 `aria-hidden` 且不给
           * hover 态。 */}
          <span aria-hidden className="shrink-0 self-center text-[var(--m-text-muted)]">
            <ChevronDownIcon />
          </span>
        </div>

        {/* ── pane 开关行 ──
         *
         * 【UI 重建 2026-10-27】真机截图里标题右侧就是**一排图标按钮**
         * （📋 `>_` ＋ ▷ 📁），不是菜单。当前显示的 pane 那个有灰底圆角。
         *
         * 每个按钮三个可观测状态，缺一不可：
         *   - `data-pane-toggle` / `data-active` —— 给套件定位；
         *   - `aria-pressed` —— 给辅助技术（这是**开关**，不是普通按钮）；
         *   - 视觉上的 `--m-fill-ghost-selected` 底 —— 给眼睛。
         *
         * 尺寸照截图：字形约 13px、按钮 28×28、圆角 6px、间距 2px。
         * Claude 的图标是线性、1.5 描边；这里用同一几何。 */}
        {paneToggles && paneToggles.length > 0 && (
          <div
            data-cds="PaneToggles"
            className="flex shrink-0 items-center gap-0.5"
            role="group"
            aria-label="面板开关"
          >
            {paneToggles.map((t) => (
              <button
                key={t.id}
                type="button"
                data-pane-toggle={t.id}
                data-active={t.active ? "" : undefined}
                aria-pressed={t.active}
                aria-label={t.label}
                title={t.label}
                onClick={t.onSelect}
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] transition-colors",
                  t.active
                    ? "bg-[var(--m-fill-ghost-selected)] text-[var(--m-text-primary)]"
                    : "text-[var(--m-text-secondary)] hover:bg-[var(--m-fill-ghost-hover)]",
                )}
              >
                {t.icon}
              </button>
            ))}
            {/* 分隔线：截图里开关行与 `⋯` 之间有一条极淡的竖线。 */}
            <span aria-hidden className="mx-0.5 h-4 w-px bg-[var(--m-border)]" />
          </div>
        )}

        {/* 图标组贴右：`ml-auto` 吃掉标题组之后的余量。
         * 【UI 重建 2026-10-28】不再需要单独的空隙 div —— 标题组 `flex-1`
         * 已经把空白吃掉了，这里再插一个 flex-1 会把它挤成两半。 */}

        {/* `⋯` 溢出菜单：其余布局开关与设置入口。
         * 【UI 重建 2026-10-27】上一版把**所有** pane 开关都塞在这里，
         * 理由是「Claude 收进溢出菜单」——真机截图否证了那个结论。
         * 常用的五个已经提到上面的 `paneToggles`，这里保留其余可达性。 */}
        {menuItems.length > 0 && (
          <div className="relative shrink-0" ref={menuRef}>
            <button
              type="button"
              aria-label="更多"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--m-text-secondary)] hover:bg-[var(--m-fill-ghost-hover)]"
              onClick={() => setMenuOpen((v) => !v)}
            >
              <MoreIcon />
            </button>
            {menuOpen && (
              <>
                {/* 透明 backdrop：只服务鼠标点外关闭；键盘出口是上面的 Escape。
                   让它不进无障碍树 —— 它不是控件。 */}
                <div className="fixed inset-0 z-40" aria-hidden onClick={() => setMenuOpen(false)} />
                <div
                  role="menu"
                  className="absolute right-0 top-8 z-50 min-w-[180px] rounded-[var(--radius-md)] border border-[var(--m-border)] bg-[var(--m-surface-3)] py-1 shadow-[var(--m-shadow-popover)]"
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

/** 标题右侧的会话切换 chevron（`⌄`，Phosphor `CaretDown` 形）。 */
function ChevronDownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3.5 6 8 10.5 12.5 6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
