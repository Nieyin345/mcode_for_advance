/**
 * 【UI 重建】**Claude 形态的侧栏** —— 取代 Mcode 现在那棵「项目树」。
 *
 * ## 从本机 Claude 3.1623.4.0 读到的结构
 *
 * 纵向自上而下（文案是它自己的原文，不是翻译猜测）：
 *
 * ```
 * ┌──────────────────────────────┐
 * │ [≡]  Mcode            [+]    │  ← 顶部：折叠 + 品牌 + 新建
 * │ 🔍 Search                    │  ← 搜索（占位，不是按钮）
 * ├──────────────────────────────┤
 * │ Pinned                       │  ← 置顶区（有才显示）
 * │  ▸ 会话标题                  │
 * │ Projects                     │  ← 项目分组
 * │  ▾ 项目名                    │
 * │    ▸ 会话标题   ⎇ feat/x     │  ← 会话行内嵌分支徽章
 * │ Recents                      │  ← 最近（跨项目）
 * │  ▸ 会话标题                  │
 * ├──────────────────────────────┤
 * │ [资料库]              [设置] │  ← 底部入口（Mcode 自有功能挂这里）
 * └──────────────────────────────┘
 * ```
 *
 * **证据**（真实产物里的字符串常量）：
 *  - `"New session"` ×26、`"Pinned"` ×10、`"Projects"` ×130、`"Recents"` ×7
 *  - 会话行模型 `{ branch, settled, chatHost }` —— `branch` 是 Git 分支徽章
 *  - 侧栏固定宽 **288px**（`w-72` ×63、`288` 字面量 ×1849）
 *  - 会话行高 **28px**（v2 密度档）
 *
 * ## Mcode 自有功能怎么挂（功能文档 UI-04）
 *
 * **不新开区域。** 资料库作为**底部入口**（与设置同级），点开在主列显示。
 * 工作流 / 自动化 / 记忆 / 插件全部走命令面板与设置页。
 */
import { useState, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

export interface ClaudeSession {
  id: string;
  title: string;
  /** Git 分支名（有就显示成等宽徽章）。 */
  branch?: string;
  /** 运行中。 */
  running?: boolean;
  /** 有未读。 */
  unread?: number;
  /** 失败。 */
  failed?: boolean;
  /** 置顶。 */
  pinned?: boolean;
}

export interface ClaudeProjectGroup {
  id: string;
  name: string;
  sessions: ClaudeSession[];
}

export interface ClaudeSidebarProps {
  /** 顶栏标题（品牌或工作区名）。 */
  brand: string;
  /** 置顶会话（跨项目）。 */
  pinned: ClaudeSession[];
  /** 按项目分组的会话。 */
  projects: ClaudeProjectGroup[];
  /** 最近会话（跨项目，不含已在上面的）。 */
  recents: ClaudeSession[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onSearch: () => void;
  /** 底部入口：资料库。 */
  onOpenLibrary: () => void;
  /** 底部入口：设置。 */
  onOpenSettings: () => void;
  /** 折叠侧栏。 */
  onCollapse: () => void;
}

/** Claude 侧栏固定宽（`w-72` = 288px）。 */
export const CLAUDE_SIDEBAR_WIDTH = 288;

export function ClaudeSidebar({
  brand,
  pinned,
  projects,
  recents,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onSearch,
  onOpenLibrary,
  onOpenSettings,
  onCollapse,
}: ClaudeSidebarProps) {
  const { t } = useI18n();
  return (
    <nav
      data-cds="Sidebar"
      className="flex h-full flex-col bg-[var(--m-surface-0)] text-[var(--m-text-secondary)]"
      style={{ width: CLAUDE_SIDEBAR_WIDTH }}
    >
      {/* ── 顶部：Cowork / Code 分段切换 ──
       *
       * 【UI 重建 2026-10-27 更正】上一版这里是「折叠按钮 + 品牌名 + 加号」，
       * 而**真实 Claude 的侧栏顶部是一个横跨整栏的分段控件**：左边 `Cowork`、
       * 右边 `Code`，当前那个是白底凸起、另一个是透明。
       *
       * Mcode 只实现 Code（用户明确「我只要 code 部分，不要 cowork」），
       * 但**分段控件本身要留着**：它是 Claude 侧栏的视觉锚点，去掉之后
       * 整个左上角就空了，一眼就不像。左段禁用并标注「未实现」，
       * 而不是假装有个 Cowork。 */}
      <div className="shrink-0 px-2 pt-2">
        <div
          role="tablist"
          aria-label="工作模式"
          className="flex h-8 items-center rounded-[8px] bg-[var(--m-surface-1)] p-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={false}
            disabled
            title="Mcode 只实现 Code 模式"
            className="flex h-full flex-1 cursor-not-allowed items-center justify-center gap-1.5 rounded-[6px] text-[var(--m-fs-body)] text-[var(--m-text-muted)] opacity-50"
          >
            <CoworkIcon />
            Cowork
          </button>
          <button
            type="button"
            role="tab"
            aria-selected
            className="flex h-full flex-1 items-center justify-center gap-1.5 rounded-[6px] bg-[var(--m-surface-2)] text-[var(--m-fs-body)] font-medium text-[var(--m-text-primary)] shadow-[var(--m-shadow-sm)]"
          >
            <CodeIcon />
            Code
          </button>
        </div>
      </div>

      {/* ── New ──
       * 真实 Claude 这里是 `+ New`（一个横条按钮，不是只有加号）。
       * 搜索不在顶部 —— 它在侧栏**最底部**的一个图标。 */}
      <div className="shrink-0 px-2 pt-2">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-[6px] px-2 text-left text-[var(--m-fs-body)] text-[var(--m-text-secondary)] hover:bg-[var(--m-fill-ghost-hover)] active:bg-[var(--m-fill-ghost-selected)]"
          style={{ minHeight: 30 }}
          onClick={onNewSession}
        >
          <PlusIcon />
          <span className="flex-1">{t("layout.newSession")}</span>
        </button>
      </div>

      {/* ── 会话区（可滚） ── */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <Section title={t("layout.pinned")} items={pinned} activeId={activeSessionId} onSelect={onSelectSession} />
        {projects.map((p) => (
          <ProjectGroup key={p.id} group={p} activeId={activeSessionId} onSelect={onSelectSession} />
        ))}
        <Section title={t("layout.recents")} items={recents} activeId={activeSessionId} onSelect={onSelectSession} />
      </div>

      {/* ── 底部：Mcode 自有入口 + 搜索 ──
       *
       * 【UI 重建 2026-10-27 更正】真实 Claude 的侧栏底部是：
       *   `Relaunch to update`（有更新时）→ `用户名 · 网关 ⌄` → 🔍
       * 也就是说**搜索在最底下**，不是顶部。
       *
       * Mcode 的资料库/设置仍是自有功能，挂在同一区域（功能文档 UI-04：
       * 不新开区域，底部入口）。**顺序对齐 Claude**：功能入口在上、
       * 用户/搜索在最后一行。 */}
      <div className="shrink-0 border-t border-[var(--m-border)] px-2 py-1.5">
        <RowButton onClick={onOpenLibrary} icon={<LibraryIcon />}>{t("layout.library")}</RowButton>
        <RowButton onClick={onOpenSettings} icon={<SettingsIcon />}>{t("layout.settings")}</RowButton>
        {/* 最后一行：品牌 + 搜索。Claude 那里是「用户名 · 网关」，Mcode 用品牌名。 */}
        <div className="mt-1 flex items-center gap-1 px-1">
          <span className="min-w-0 flex-1 truncate text-[var(--m-fs-caption)] text-[var(--m-text-muted)]">
            {brand}
          </span>
          <IconButton label={t("layout.search")} onClick={onSearch}>
            <SearchIcon />
          </IconButton>
          <IconButton label={t("layout.collapseSidebar")} onClick={onCollapse}>
            <CollapseIcon />
          </IconButton>
        </div>
      </div>
    </nav>
  );
}

/** 分组标题 + 一组会话。空组不渲染（Claude 也不摆空标题）。 */
function Section({
  title,
  items,
  activeId,
  onSelect,
}: {
  title: string;
  items: ClaudeSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="px-2 py-1 text-[var(--m-fs-caption)] font-medium uppercase tracking-wide text-[var(--m-text-muted)]">
        {title}
      </div>
      {items.map((s) => (
        <SessionRow key={s.id} session={s} active={s.id === activeId} onSelect={onSelect} />
      ))}
    </div>
  );
}

/** 项目分组：可折叠，默认展开。 */
function ProjectGroup({
  group,
  activeId,
  onSelect,
}: {
  group: ClaudeProjectGroup;
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-2">
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded-[6px] px-2 py-1 text-left text-[var(--m-fs-caption)] font-medium uppercase tracking-wide text-[var(--m-text-muted)] hover:bg-[var(--m-fill-ghost-hover)]"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Caret open={open} />
        <span className="min-w-0 flex-1 truncate">{group.name}</span>
      </button>
      {open &&
        group.sessions.map((s) => (
          <SessionRow key={s.id} session={s} active={s.id === activeId} onSelect={onSelect} indent />
        ))}
    </div>
  );
}

/**
 * 一行会话。
 *
 * 行高 28px 是 Claude v2 的密度值。分支徽章用等宽字，与 Claude 一致。
 * 运行中/失败/未读用左侧的小圆点，不占额外高度。
 */
function SessionRow({
  session,
  active,
  onSelect,
  indent,
}: {
  session: ClaudeSession;
  active: boolean;
  onSelect: (id: string) => void;
  indent?: boolean;
}) {
  return (
    <button
      type="button"
      data-session-row={session.id}
      data-active={active ? "" : undefined}
      className={cn(
        "group flex w-full items-center gap-1.5 rounded-[6px] px-2 text-left",
        "text-[var(--m-fs-body)]",
        indent && "pl-5",
        active
          ? "bg-[var(--m-fill-ghost-selected)] text-[var(--m-text-primary)] font-medium"
          : "text-[var(--m-text-secondary)] hover:bg-[var(--m-fill-ghost-hover)]",
      )}
      style={{ height: 28 }}
      onClick={() => onSelect(session.id)}
      title={session.title}
    >
      <StatusDot running={session.running} failed={session.failed} unread={session.unread} />
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
      {session.branch && (
        <span className="max-w-[80px] shrink-0 truncate font-mono text-[var(--m-fs-caption)] text-[var(--m-text-muted)]">
          {session.branch}
        </span>
      )}
    </button>
  );
}

/** 状态点：运行中 / 失败 / 未读 / 无。 */
function StatusDot({
  running,
  failed,
  unread,
}: {
  running?: boolean;
  failed?: boolean;
  unread?: number;
}) {
  if (running) {
    return <span className="size-1.5 shrink-0 rounded-full bg-[var(--m-accent)] animate-pulse" />;
  }
  if (failed) {
    return <span className="size-1.5 shrink-0 rounded-full bg-[var(--m-danger)]" />;
  }
  if (unread && unread > 0) {
    return <span className="size-1.5 shrink-0 rounded-full bg-[var(--m-text-muted)]" />;
  }
  return <span className="size-1.5 shrink-0" />;
}

function RowButton({
  children,
  icon,
  onClick,
}: {
  children: ReactNode;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-[6px] px-2 text-left text-[var(--m-fs-body)] text-[var(--m-text-secondary)] hover:bg-[var(--m-fill-ghost-hover)]"
      style={{ height: 28 }}
      onClick={onClick}
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  );
}

function IconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-[var(--m-text-secondary)] hover:bg-[var(--m-fill-ghost-hover)]"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden
      style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms" }}
    >
      <path d="M3 1.5L7 5l-4 3.5z" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M9.5 2.5v11" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
/** Cowork 段：两个重叠的人形（协作语义）。 */
function CoworkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="6" cy="5.5" r="2.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.2 13c0-2.1 1.7-3.5 3.8-3.5s3.8 1.4 3.8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="11.4" cy="6.4" r="1.7" stroke="currentColor" strokeWidth="1.2" opacity=".7" />
    </svg>
  );
}
/** Code 段：尖括号（代码语义，与 Claude 的图标同形）。 */
function CodeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M5.5 4.5 1.8 8l3.7 3.5M10.5 4.5 14.2 8l-3.7 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M9 9l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function LibraryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M2 2.5h3v9H2zM6 2.5h3v9H6zM10.5 3l2 .5-1.5 8-2-.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.6 1.6" />
    </svg>
  );
}
