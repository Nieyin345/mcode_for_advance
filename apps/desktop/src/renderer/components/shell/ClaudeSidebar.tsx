/**
 * 【UI 重建】**Claude 形态的侧栏** —— 取代 Mcode 现在那棵「项目树」。
 *
 * ## 从本机 Claude 3.6556.2.0 读到的结构（以真机截图为准）
 *
 * 纵向自上而下：
 *
 * ```
 * ┌──────────────────────────────┐
 * │  [☰] [▭] [←] [→]             │  ← 顶部图标行（侧栏折叠 / 分栏 / 前进后退）
 * │ ┌────────────┬─────────────┐ │
 * │ │  Cowork    │   Code      │ │  ← 分段控件（当前档白底凸起）
 * │ └────────────┴─────────────┘ │
 * │  + New                       │
 * │  ▭ Customize                 │
 * │  ⋯ More                      │
 * ├──────────────────────────────┤
 * │  Pinned  ›                   │  ← 分组标题带 chevron，点开折叠
 * │   ▸ 会话标题   +             │  ← 会话行右侧一个「新建分栏」+
 * ├──────────────────────────────┤
 * │  项目名  +                   │  ← 项目分组（同样是 chevron + 悬停 +）
 * │   ▸ 会话标题                 │
 * ├──────────────────────────────┤
 * │  ✳ Nieyin · Gateway      🔍  │  ← 底部：账号 + 网关 + 搜索图标
 * └──────────────────────────────┘
 * ```
 *
 * ## 与上一版注释的差异（都是真机纠出来的）
 *
 * | 项 | 上一版写的 | 真机 |
 * |---|---|---|
 * | 顶部 | 折叠 + 品牌 + 加号 | **图标行 + Cowork/Code 分段 + New/Customize/More** |
 * | 搜索 | 顶部输入框 | **底部一个图标**，不是输入框 |
 * | 分组标题 | `Pinned` | `Pinned ›`（带 chevron） |
 * | 会话行高 | **28px（v2 密度档）** | **32px**（comfortable 档；28 是 compact） |
 * | 底部 | 资料库 + 设置 | **账号 · 网关 + 搜索**（Mcode 自有入口另挂） |
 *
 * ## 几何真值（本机 Claude `--df-*`，comfortable 层）
 *
 * | 变量 | 值 |
 * |---|---|
 * | 侧栏宽 `--df-sidebar-width` | **288px** |
 * | 会话行高 `--df-row-h` | **32px** |
 * | 会话行字号 `--df-row-font` | **14px** |
 * | 图标 `--df-icon-size` | **20px** |
 * | 图标槽 `--df-leading-slot` | **28px** |
 * | 胶囊圆角 `--df-radius-pill` | **8px** |
 * | 分组标题字号 `--df-group-font` | **13px** |
 * | 分组上内边距 `--df-group-pt` | **16px** |
 * | 行间距 `--df-row-gap` | **8px** |
 *
 * 这些已经在 styles.css 立成 `--m-sb-*` 语义别名，组件只引用不写死。
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
  /** 【UI 重建 2026-10-28】在某个项目下**开分支工作树**新建会话
   *  （分组标题的 `⑂`）。底层是 `startSession({ envMode:"worktree",
   *  wtStyle:"branch" })`，能力早就有，之前只缺渲染端入口。 */
  onNewSessionInWorktree: (projectId: string) => void;
  onSearch: () => void;
  /** 底部入口：资料库。 */
  onOpenLibrary: () => void;
  /** 底部入口：设置。 */
  onOpenSettings: () => void;
  /** 折叠侧栏。 */
  onCollapse: () => void;

  /* ── 【UI 重建 2026-10-28】顶部图标行与底部账号行需要的接线 ──
   *
   * 这些全部**可选**：可选是为了让已有的调用点（套件夹具、手机端）不必
   * 一次性补齐。缺省时对应按钮 disabled 而不是崩溃 —— 一个点不动的按钮
   * 比一个报错的侧栏好，而且 disabled 的样式本身就是 Claude 里「无历史」时
   * 前进键的样子。
   */

  /** 右侧 pane 当前是否展开（顶部 `▭` 图标的激活态）。 */
  panesOpen?: boolean;
  /** 切换右侧 pane。 */
  onTogglePanes?: () => void;
  /** 会话导航：能否后退 / 前进（决定 `←` `→` 是否禁用）。 */
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  /** 底部账号行：显示名与次级标识（Claude 是 `Nieyin · Gateway`）。 */
  accountName?: string;
  accountSubtitle?: string;
  /** 账号行右侧的下拉入口（切换到别的账号/网关）。 */
  onOpenAccountMenu?: () => void;
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
  onNewSessionInWorktree,
  onSearch,
  onOpenLibrary,
  onOpenSettings,
  onCollapse,
  panesOpen = false,
  onTogglePanes,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
  accountName,
  accountSubtitle,
  onOpenAccountMenu,
}: ClaudeSidebarProps) {
  const { t } = useI18n();
  return (
    <nav
      data-cds="Sidebar"
      className="flex h-full flex-col bg-[var(--m-surface-0)] text-[var(--m-text-secondary)]"
      style={{ width: CLAUDE_SIDEBAR_WIDTH }}
    >
      {/* ── 顶部图标行：☰  ▭  ←  → ──
       *
       * 【UI 重建 2026-10-28】真机截图最上方是**四个图标**：
       *   1. `☰`  三横线 —— 折叠/展开侧栏
       *   2. `▭`  分栏图标 —— 切换「显示右栏 pane」
       *   3. `←`  后退
       *   4. `→`  前进（截图里是禁用灰，说明没有前进历史）
       *
       * 上一版**完全没有这一行** —— 侧栏从 Cowork/Code 开始，顶部直接是
       * 分段控件。少了它，左上角看起来是空的，而这是每次看侧栏都会扫到的
       * 第一眼位置。
       *
       * 后退/前进接的是 `navBack` / `navForward`（Mcode 已有这组 action，
       * 边界状态也从同一处读）。 */}
      <div className="flex shrink-0 items-center gap-0.5 px-2 pt-2">
        <SidebarIconButton label="折叠侧栏" onClick={onCollapse}>
          <MenuIcon />
        </SidebarIconButton>
        <SidebarIconButton
          label="右侧面板"
          active={panesOpen}
          onClick={onTogglePanes}
        >
          <SplitIcon />
        </SidebarIconButton>
        <SidebarIconButton label="后退" disabled={!canGoBack} onClick={onBack}>
          <ArrowLeftIcon />
        </SidebarIconButton>
        <SidebarIconButton label="前进" disabled={!canGoForward} onClick={onForward}>
          <ArrowRightIcon />
        </SidebarIconButton>
      </div>

      {/* ── Cowork / Code 分段切换 ──
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

      {/* ── New / Customize / More 三行 ──
       *
       * 【UI 重建 2026-10-28】真机截图是**三行**，不是一行：
       *   `⊕ New`         —— 新建会话（圆圈加号 + 文字）
       *   `🎨 Customize`  —— 自定义（工具栏图标）
       *   `⋯ More`        —— 更多（三个点）
       *
       * 上一版只有一个 `+ 新建会话`。少两行会让分段控件和会话列表之间
       * 差出一大块，而那块正是 Claude 侧栏「有地方放功能」的证据。
       *
       * Mcode 的映射（**不新造能力**）：
       *   - New → `startSession`（已有）
       *   - Customize → 打开设置（Mcode 的自定义入口就在设置里）
       *   - More → 命令面板（Mcode 的「所有功能都在这」的入口）
       *
       * ⚠️ 三行共用同一个行高与左内边距（`--m-sb-row-h`），
       * 且**不用 uppercase / tracking-wide** —— 截图里它们是普通大小写的
       * 常规文字，与分组标题同色系但更亮一档。 */}
      <div className="shrink-0 px-2 pt-2">
        <SidebarMenuRow icon={<PlusCircleIcon />} onClick={onNewSession}>
          New
        </SidebarMenuRow>
        <SidebarMenuRow icon={<CustomizeIcon />} onClick={onOpenSettings}>
          Customize
        </SidebarMenuRow>
        <SidebarMenuRow icon={<MoreDotsIcon />} onClick={onSearch}>
          More
        </SidebarMenuRow>
      </div>

      {/* ── 会话区（可滚） ── */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <Section title={t("layout.pinned")} items={pinned} activeId={activeSessionId} onSelect={onSelectSession} />
        {projects.map((p) => (
          <ProjectGroup
            key={p.id}
            group={p}
            activeId={activeSessionId}
            onSelect={onSelectSession}
            /* 分组标题右侧的 `+`：在这个项目下新建会话。
             * 复用 `onNewSession`（与侧栏顶部的 `New` 同一个动作）——
             * 严格来说 Claude 的「在项目下新建」会预置项目上下文，
             * 但 Mcode 的 `startSession` 本来就从 `activeProjectId` 读，
             * 而这里点的是**当前**项目分组，语义对得上。 */
            onNewSessionIn={() => onNewSession()}
            onNewWorktreeIn={() => onNewSessionInWorktree(p.id)}
          />
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
        {/* ── 账号行 ──
         *
         * 【UI 重建 2026-10-28】真机截图最后一行是
         *   `✳ Nieyin · Gateway ⌄` + 🔍
         * —— 一个**品牌小标 + 账号名 · 网关 + 下拉箭头**的整体按钮，
         * 右侧单独一个搜索图标。
         *
         * 上一版这里是「品牌名纯文本 + 搜索 + 折叠」。三处不对：
         *   1. 品牌名是不可点的纯文本 —— 截图里整行是个**菜单按钮**；
         *   2. `· 网关` 那一截缺失（它说明当前连的是哪个后端）；
         *   3. 折叠按钮在这里重复了一遍（顶部图标行已经有了）。
         *
         * 现在：整行做成一个按钮（打开账号/网关菜单），搜索留最右。
         * `accountName` / `accountSubtitle` 没传时退回 `brand` —— 不伪造
         * 一个「· Gateway」，那会显示成假的后端状态。 */}
        <div className="mt-1 flex items-center gap-1">
          <button
            type="button"
            data-sidebar-account=""
            onClick={onOpenAccountMenu}
            disabled={!onOpenAccountMenu}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[6px] px-1 py-0.5 text-left transition-colors enabled:hover:bg-[var(--m-fill-ghost-hover)] disabled:cursor-default"
            title={accountName ? `${accountName}${accountSubtitle ? ` · ${accountSubtitle}` : ""}` : brand}
          >
            <span className="shrink-0 text-[var(--m-accent)]">
              <BrandMark />
            </span>
            <span className="min-w-0 truncate text-[length:var(--m-sb-group-font)] text-[var(--m-text-secondary)]">
              {accountName ?? brand}
              {accountSubtitle ? (
                <span className="text-[var(--m-text-muted)]"> · {accountSubtitle}</span>
              ) : null}
            </span>
            {onOpenAccountMenu && (
              <span aria-hidden className="shrink-0 text-[var(--m-text-muted)]">
                <ChevronDownSmall />
              </span>
            )}
          </button>
          <IconButton label={t("layout.search")} onClick={onSearch}>
            <SearchIcon />
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
  onNewSessionIn,
  onNewWorktreeIn,
}: {
  group: ClaudeProjectGroup;
  activeId: string | null;
  onSelect: (id: string) => void;
  /** 分组标题右侧的 `+`：在这个项目下新建会话。
   *  用户截图里每个分组标题右边都有它（悬停时出现）。 */
  onNewSessionIn?: (groupId: string) => void;
  /** 分组标题右侧的 `⑂`：在这个项目下**开一个分支工作树**新建会话。
   *  `session.create` 的 `envMode:"worktree"` + `wtStyle:"branch"` 早就支持，
   *  这里只是补渲染端入口。 */
  onNewWorktreeIn?: (groupId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom: "var(--m-sb-row-gap, 8px)" }}>
      {/* 分组标题行 = 折叠按钮 + 右侧动作。
       *
       * 【UI 重建 2026-10-28】**这一行不能是一个大 `<button>`。**
       * 用户截图里标题右边有独立的 `+`（temp 那一行还有 `⑂` 和 `+` 两个）——
       * 按钮里套按钮是非法 HTML，浏览器会把内层拆出去，点击行为跟着错乱。
       * 所以改成：外层 `div` 包两个兄弟按钮。 */}
      <div
        data-sidebar-group-header=""
        className="group/hdr flex w-full items-center gap-1 rounded-[6px] px-2 text-left font-medium text-[var(--m-text-secondary)] hover:bg-[var(--m-fill-ghost-hover)]"
        style={{
          height: "var(--m-sb-row-h, 32px)",
          fontSize: "var(--m-sb-group-font, 13px)",
        }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          {/* 上游真实形态是**非粗体、非大写**的分组名 + 一个**始终向右**的
           * `›` chevron。展开/折叠时**不旋转** —— 折叠的是内容，不是箭头。 */}
          <span className="min-w-0 flex-1 truncate">{group.name}</span>
          <span aria-hidden className="shrink-0 text-[var(--m-text-muted)]">
            <ChevronRight size={12} />
          </span>
        </button>
        {onNewSessionIn && (
          <button
            type="button"
            aria-label={`在 ${group.name} 下新建会话`}
            title={`在 ${group.name} 下新建会话`}
            onClick={() => onNewSessionIn(group.id)}
            className="flex size-5 shrink-0 items-center justify-center rounded-[4px] text-[var(--m-text-muted)] opacity-0 transition-opacity hover:bg-[var(--m-fill-ghost-hover)] hover:text-[var(--m-text-secondary)] group-hover/hdr:opacity-100 focus-visible:opacity-100"
          >
            <PlusSmallIcon />
          </button>
        )}
        {/* 【UI 重建 2026-10-28】`⑂` —— 在这个项目下**开一个分支工作树**新建会话。
         *
         * 用户截图里 `temp` 那一行有两个按钮：`⑂` 和 `+`。
         *
         * 底层能力**早就存在**（`session.create` 的 `envMode:"worktree"` +
         * `wtStyle:"branch"`，意图先行、首次发送时才物化），之前只是渲染端
         * 没有入口 —— 所以这一处不需要新的主进程能力。
         *
         * 顺序照截图：`⑂` 在左、`+` 在右。 */}
        {onNewWorktreeIn && (
          <button
            type="button"
            aria-label={`在 ${group.name} 下新建分支工作树`}
            title={`在 ${group.name} 下新建分支工作树`}
            onClick={() => onNewWorktreeIn(group.id)}
            className="flex size-5 shrink-0 items-center justify-center rounded-[4px] text-[var(--m-text-muted)] opacity-0 transition-opacity hover:bg-[var(--m-fill-ghost-hover)] hover:text-[var(--m-text-secondary)] group-hover/hdr:opacity-100 focus-visible:opacity-100"
          >
            <BranchSmallIcon />
          </button>
        )}
      </div>
      {open &&
        group.sessions.map((s) => (
          /* ⚠️ **不缩进。** 用户截图里会话名与分组名左对齐（`环境启动问题`
           * 和 `~` 同一列）—— Claude 用「分组名是灰色小字」来分层，不用缩进。
           * 之前的 `indent` 会多出 12px，整列看起来右移了一格。 */
          <SessionRow key={s.id} session={s} active={s.id === activeId} onSelect={onSelect} />
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
        "group flex w-full items-center gap-1.5 px-2 text-left",
        "text-[length:var(--m-sb-row-font)]",
        indent && "pl-5",
        active
          ? "bg-[var(--m-fill-ghost-selected)] text-[var(--m-text-primary)] font-medium"
          : "text-[var(--m-text-secondary)] hover:bg-[var(--m-fill-ghost-hover)]",
      )}
      // 【UI 重建 2026-10-27】行高与圆角走上游 `--df-row-h` / `--df-radius-pill`
      // 的 comfortable 档（32 / 8），此前是写死的 28 / 6。见 styles.css
      // 「侧栏几何」那段的分档表 —— 28/6 是 `.dframe-root` 的**基准**档，
      // 不是真实默认档。
      style={{
        height: "var(--m-sb-row-h, 32px)",
        borderRadius: "var(--m-sb-radius-pill, 8px)",
      }}
      onClick={() => onSelect(session.id)}
      // 分支名不在行内显示（Claude 不显示），但**不能丢** —— 放进 tooltip，
      // 悬停时仍能看到这个会话跑在哪个 worktree 上。
      title={session.branch ? `${session.title} · ${session.branch}` : session.title}
    >
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
      {/* 【UI 重建 2026-10-28】**行尾只有一个状态点，没有 `+`。**
       *
       * 用户给的真机截图：每行右端就是一个**圆点**（工作中的会呼吸、
       * 已结束的是静态点）。悬停时**不换成加号** —— 那是上一版自己发明的。
       * 新建会话的入口在**分组标题**右侧的 `+`（见 ProjectGroup），
       * 不在每条会话行上。
       *
       * 分支名仍然不在行内显示（Claude 不显示），保留在 `title` 里。 */}
      <span className="flex size-4 shrink-0 items-center justify-center">
        <StatusDot running={session.running} failed={session.failed} unread={session.unread} />
      </span>
    </button>
  );
}

/** 状态点：运行中 / 失败 / 未读 / 无。 */
/** 会话行右端的**状态点**。
 *
 * 【UI 重建 2026-10-28】**尺寸与动画改成上游真值**（逆向自
 * `c6a992d55-Che1orl5.css`，见 `tools/claude-ui-reverse/animations.txt`）：
 *
 *   --df-dot-r: calc(.1875rem * var(--cds-rem-scale,1))  → 半径 2.82px
 *   直径 = 5.64px（上一版 `size-1.5` = 6px，差 0.36px —— 一行里看不出来，
 *   但一行 6 个会话叠起来，整列的圆点大小会比上游「胖一圈」）
 *
 * 动画：`cds-dot-pulse`，1.8s linear，`opacity .2857 → 1 → .2857`。
 * **不是** `animate-pulse`（那是 2s ease 的 1→.5，读起来是闪），
 * 也**不是**我先前写的 `sidebar-breathe`（scale + opacity 同时动）。
 * 真身**只有不透明度在变**。
 *
 * 为什么单点也要用同一套关键帧：侧栏和聊天区那两个「忙碌指示」在上游
 * 是**同一个 `.cds-dot`**（同一个 class、同一段 keyframes），只是容器不同。
 * 这里沿用同一个类名 `.cds-dot`，两处才会永远同步。 */
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
    return <span data-session-status="running" aria-label="正在工作" className="cds-dot shrink-0" />;
  }
  if (failed) {
    return <span data-session-status="failed" aria-label="上次运行失败" className="cds-dot cds-dot--danger shrink-0" />;
  }
  if (unread && unread > 0) {
    return <span data-session-status="done" aria-label="有未读" className="cds-dot cds-dot--muted shrink-0" />;
  }
  // 无状态也要占位：否则有状态的行会把标题挤窄，整列标题右缘参差不齐。
  return <span aria-hidden className="cds-dot-slot shrink-0" />;
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

/**
 * 分组标题右侧的 chevron —— Claude 真实形状。
 *
 * 【UI 重建 2026-10-27】上游用的是 **Phosphor `CaretRight`**
 * （`viewBox="0 0 256 256"`，见 `tools/claude-ui-reverse/file-icons.txt`
 * 的同源库）。Mcode 不用 @phosphor-icons（未安装），这里按 Phosphor 的
 * `CaretRight` 几何手写：一个**细描边的开口箭头**，不是实心三角。
 *
 * 与 `Caret` 的区别：`Caret` 是实心三角（v2 的旧形状），这个是描边 V 形。
 * 截图里 `Pinned ›` / `temp ›` 都是后者。
 */
function ChevronRight({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden
    >
      <path
        d="M6 3.5 10.5 8 6 12.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
/* ───────── 顶部图标行与 New/Customize/More 的零件（2026-10-28）───────── */

/** 顶部图标行里的一个图标按钮（28×28，圆角 6，激活态有灰底）。 */
function SidebarIconButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-[6px] transition-colors",
        disabled
          ? "cursor-not-allowed text-[var(--m-text-muted)] opacity-40"
          : active
            ? "bg-[var(--m-fill-ghost-selected)] text-[var(--m-text-primary)]"
            : "text-[var(--m-text-secondary)] hover:bg-[var(--m-fill-ghost-hover)]",
      )}
    >
      {children}
    </button>
  );
}

/** `New` / `Customize` / `More` 的一行：左图标 + 文字，整行可点。 */
function SidebarMenuRow({
  icon,
  onClick,
  children,
}: {
  icon: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-[6px] px-2 text-left text-[var(--m-text-secondary)] transition-colors hover:bg-[var(--m-fill-ghost-hover)] active:bg-[var(--m-fill-ghost-selected)]"
      // 行高与会话行同一档（截图里三者等高）—— 走同一个 token，
      // 不在这里另写数字。
      style={{ height: "var(--m-sb-row-h, 32px)", fontSize: "var(--m-sb-row-font, 14px)" }}
    >
      <span className="flex size-[18px] shrink-0 items-center justify-center text-[var(--m-text-muted)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

/** `☰` 三横线（截图第一个图标）。 */
function MenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2.5 4.2h11M2.5 8h11M2.5 11.8h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** `▭` 分栏（截图第二个图标：一个带竖分隔的方框）。 */
function SplitIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="3.5" width="12" height="9" rx="1.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.6 3.5v9" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** `←` 后退。 */
function ArrowLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M12.5 8H3.8M7 4.3 3.3 8 7 11.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** `→` 前进。 */
function ArrowRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3.5 8h8.7M9 4.3 12.7 8 9 11.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** `⊕` 圆圈加号（`New` 行）。 */
function PlusCircleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 5.6v4.8M5.6 8h4.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** `🎨` 自定义（`Customize` 行）：调色板形。 */
function CustomizeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 2.2a5.8 5.8 0 0 0 0 11.6c.8 0 1.3-.6 1.3-1.3 0-.4-.2-.7-.4-1-.2-.2-.4-.5-.4-.9 0-.7.6-1.3 1.3-1.3h1c1.6 0 2.9-1.3 2.9-2.9C13.7 3.9 11.2 2.2 8 2.2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="5.6" cy="6.2" r=".8" fill="currentColor" />
      <circle cx="9" cy="5.2" r=".8" fill="currentColor" />
      <circle cx="5.4" cy="9.4" r=".8" fill="currentColor" />
    </svg>
  );
}

/** `⋯` 三个点（`More` 行）。 */
function MoreDotsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <circle cx="3.6" cy="8" r="1.1" />
      <circle cx="8" cy="8" r="1.1" />
      <circle cx="12.4" cy="8" r="1.1" />
    </svg>
  );
}

/** 底部账号行左侧的品牌小标（Claude 是一个彩色星芒）。 */
function BrandMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 1.6v12.8M1.6 8h12.8M3.5 3.5l9 9M12.5 3.5l-9 9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
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

/** 账号行右端的小 `⌄`（会话切换器同形，只是更小）。 */
function ChevronDownSmall() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3.5 6 8 10.5 12.5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 分组标题右侧的 `+`（新建会话）—— 比行首图标的加号小一档。 */
function PlusSmallIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** 分组标题的 `⑂` —— 「在此项目下开分支工作树」。
 *  形状照 Phosphor 的 `GitBranch`：两个端点 + 一条分叉。 */
function BranchSmallIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="4.6" cy="3.2" r="1.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.6" cy="12.8" r="1.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11.4" cy="5.4" r="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.6 4.7v6.6M11.4 6.9c0 2.1-2.2 3-4.6 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
