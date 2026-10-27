/**
 * 【UI 重建】**Claude Code 页外壳** —— 取代 `ClassicShell` 的三栏并存。
 *
 * ## 它照抄的是什么
 *
 * 全部结构来自本机安装的 **Claude Desktop 3.1623.4.0**
 * （用户 2026-10-27 指定：只要 Code 模式，不要 Cowork）。
 *
 * | 结构 | Claude 的真实做法 | 本文件的实现 |
 * |---|---|---|
 * | 主区 | `data-chat-column` = `project` / `thread` / `loading`，一层盖一层 | `chatColumnOf()` + `data-covered` + `inert` |
 * | 右侧 | `paneTile` 递归切分树（`kind:"tile"` / `kind:"stack"`） | `paneTiles.ts` 的 `TileLayout` |
 * | 侧栏 | 288px 固定宽，会话行 28px，与主区 0.5px 发丝边 | `--m-sidebar-width` / 行高走 token |
 * | 密度 | `<html data-density>` 一条规则翻转整套尺寸 | 同样挂 `data-density` |
 * | 主题 | `data-mode="light|dark|system"` + `cds-root` | 同样挂 |
 *
 * ## 不变的东西（硬约束）
 *
 * **终端 PTY / Monaco / Tiptap 草稿必须全程挂载。** 列切换只做
 * `inert` + `data-covered`，**绝不卸载子树** —— 卸载会触发
 * `TerminalView` cleanup 里的 `api.terminal.kill`，Windows 上批量 kill
 * 偶发崩主进程。这条约束来自 `ClassicShell` 的历史注释，一字未改。
 *
 * ## 与旧外壳的关系
 *
 * 旧 `ClassicShell` 暂时保留（套件仍引用它），但 `App.tsx` 改为渲染本文件。
 * 旧外壳在新壳稳定后删除（见功能文档 UI-06）。
 */
import { memo, useMemo, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "../../stores/sessionStore.js";
import { chatColumnOf, isCovered, type ChatColumn } from "./chatColumn.js";
import { TilePane } from "./TilePane.js";
import type { TileLayout } from "./paneTiles.js";

export interface ClaudeShellProps {
  /** 左栏（会话/项目）。 */
  sidebar: ReactNode;
  /** `project` 列：项目首页。 */
  projectColumn: ReactNode;
  /** `thread` 列：单个会话。 */
  threadColumn: ReactNode;
  /** 顶栏。 */
  titlebar: ReactNode;
  /** 底部终端（保活，塌高不卸载）。 */
  bottomTerminal?: ReactNode;
  /** 终端是否展开。 */
  bottomTerminalOpen: boolean;
  /** 左栏是否展开。 */
  leftOpen: boolean;
  /** 左栏宽度（px）。 */
  leftWidth: number;
  /** 右侧 tile 布局。 */
  tileLayout: TileLayout;
  /** 渲染某个 tile 的内容。 */
  renderTile: (tileId: string) => ReactNode;
  /** 关闭某个 tile。 */
  onCloseTile?: (tileId: string) => void;
  /** 拖拽分栏：相邻两格的 flex 改成 na / nb。 */
  onResizeTile?: (stack: import("./paneTiles.js").PaneStack, a: import("./paneTiles.js").PaneNode, na: number, b: import("./paneTiles.js").PaneNode, nb: number) => void;
  /** 放大/还原某一格（Claude 的 expandedTile）。null = 没有放大。 */
  onExpandTile?: (tileId: string | null) => void;
  /** 当前被放大的格。 */
  expandedTile?: string | null;
  /** 当前是否有会话在加载。 */
  isLoadingThread: boolean;
  /** 把某一格挪到另一侧（换 dock 边）。透传给 TilePane。 */
  onMoveTile?: (tileId: string) => void;
  /** 非 chat 的格（右侧 pane）是否展开。关掉时**不卸载**，只把 flex 归 0
   *  并标 `aria-hidden` —— PTY/Monaco/草稿保活。 */
  asideOpen?: boolean;
  /** 中心列是否有内容要画 —— 除「打开了会话」之外的另一种情况：
   *  没有会话但用户直接打开了一个文件（编辑器占中心列）。
   *  为 true 时即使  也渲染 thread 列与 tile 区，
   *  否则「点文件 → 什么都没发生」。 */
  centerOccupied?: boolean;
  /** 【UI 重建 2026-10-28】aside 格标题行左侧的内容（右栏页签切换器）。
   *
   *  由 `ClaudeShellMount` 传 `PaneTabSwitcher`。放在 props 而不是在这里
   *  直接 import：`ClaudeShell` 是通用外壳，页签清单属于「新壳接了哪些
   *  右栏页签」这件业务事实，不属于壳的布局规则。 */
  asideHeader?: ReactNode;
}

/**
 * 列容器：**一列盖一列**。
 *
 * 被盖住的列保持挂载（`inert` + `data-covered`），不被盖住的列 `flex-1` 占满。
 * 两层都用绝对定位铺满同一块区域，靠 `data-covered` 的 CSS 决定谁在上。
 */
const Column = memo(function Column({
  column,
  active,
  children,
}: {
  column: ChatColumn;
  active: ChatColumn;
  children: ReactNode;
}) {
  const covered = isCovered(column, active);
  return (
    <div
      data-chat-column={column}
      data-covered={covered ? "" : undefined}
      // React 19 原生支持 inert：退出 Tab 序与辅助技术，不接受指针。
      inert={covered}
      aria-hidden={covered || undefined}
      className={cn(
        // `self-stretch` **无条件加**：这一层在 flex-row 父级里，
        // `flex-1` 只分配宽度，高度全靠交叉轴拉伸。
        "flex min-h-0 min-w-0 flex-col self-stretch",
        covered
          ? "pointer-events-none absolute inset-0 opacity-0"
          : "relative min-h-0 flex-1",
      )}
    >
      {children}
    </div>
  );
});

/**
 * Claude 风格的工作台外壳。
 *
 * 布局是 **两段式**：
 *   ┌──────────┬────────────────────────────────────┐
 *   │ 侧栏      │ 顶栏                                │
 *   │ 288px    ├────────────────────────────────────┤
 *   │          │ project 列（被盖住时 inert）         │
 *   │          │ thread 列（盖在上面）                │
 *   │          ├────────────────────────────────────┤
 *   │          │ 底部终端（可塌高保活）                │
 *   └──────────┴────────────────────────────────────┘
 *
 * 右侧 tile 由 `TilePane` 在 thread 列内部渲染 —— 因为 Claude 的右侧 pane
 * 属于**会话**，切会话时 pane 内容跟着换，不是全窗口的一块。
 */
export function ClaudeShell({
  sidebar,
  projectColumn,
  threadColumn,
  titlebar,
  bottomTerminal,
  bottomTerminalOpen,
  leftOpen,
  leftWidth,
  tileLayout,
  renderTile,
  onCloseTile,
  onResizeTile,
  onExpandTile,
  expandedTile,
  isLoadingThread,
  centerOccupied = false,
  onMoveTile,
  asideOpen = true,
  asideHeader,
}: ClaudeShellProps) {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const column = chatColumnOf({ hasActiveSession: !!activeSessionId, isLoadingThread });

  /* 【UI 重建 2026-10-27】**「中心区有内容」不只等于「有一个会话」。**
   *
   * Claude 的三列模型里 project 列是「项目首页」，thread 列是「当前这个会话」。
   * 但 Mcode 多一个状态：**用户可以在没有会话时直接打开一个文件**（在文件树里点）。
   * 那时 thread 列应该显示编辑器，而不是整列不渲染 —— 否则点文件什么都不会发生。
   *
   * 由宿主显式告诉壳「中心列有东西要画」（`centerOccupied`），不在这里猜 store 的形状。 */
  const showThread = column !== "project" || centerOccupied;

  // 右侧 pane 只在 thread 列里出现 —— 没有会话（也没有文档）就没有「会话的 pane」。
  const showTiles = column === "thread" || centerOccupied;

  return (
    <div
      className="flex h-full w-full overflow-hidden bg-surface-muted text-[var(--m-text-primary)]"
      data-ui-shell="claude"
      // 【兼容标记】视觉基线探针（`arc005-visual-baseline`）用这个属性判断
      // 「工作区外观层有没有挂上」。新壳沿用同一个值，这样**探针不用改**、
      // 旧证据链继续可比。真正的区分用 `data-ui-shell="claude"`。
      data-ui-shell-variant="workspace"
    >
      {leftOpen && (
        <aside
          data-testid="workspace-sidebar"
          className="flex h-full shrink-0 flex-col"
          style={{ width: leftWidth }}
        >
          {sidebar}
        </aside>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="workspace-main">
        {titlebar}
        {/* 高度链。**每一层都同时给 `h-full` 与 `flex-1`**：
            - `h-full` 从父级的确定高度取 100%（父级 h 已知时这是可靠的）；
            - `flex-1` 让它在兄弟之间分配剩余空间。
            只写 `flex-1` 在「父级高度来自 flex 分配」时会算成 0（实测）。 */}
        <div className="relative flex h-full min-h-0 flex-1 flex-col">
          <div className="relative flex h-full min-h-0 flex-1 items-stretch">
            {/* project 列**始终挂载**：它承载项目首页（会话列表/起点卡片），
                被 thread 盖住时不卸载，切回来滚动位置与草稿都还在。

                【UI 重建 2026-10-27】它同时是**没有会话时的主内容区**，所以也带
                `data-cds-center` —— 与 chat tile 上那个是同一个语义「当前主列」。
                没有它就出现「新装应用（零会话）时主区没有任何标记」，
                真机探针（`arc005-pane-electron-smoke` 的 REAL_ELECTRON_APP）
                直接报「real ThreePaneLayout missing」，看起来像壳没渲染。 */}
            <Column column="project" active={column}>
              <div data-cds-center="" className="flex min-h-0 min-w-0 flex-1 flex-col">
                {projectColumn}
              </div>
            </Column>
            {showThread && (
              <Column column="thread" active={column}>
                {showTiles ? (
                  <TilePane
                    layout={tileLayout}
                    renderTile={renderTile}
                    onCloseTile={onCloseTile}
                    onResize={onResizeTile}
                    onExpand={onExpandTile}
                    expandedTile={expandedTile}
                    onMoveTile={onMoveTile}
                    asideOpen={asideOpen}
                    chatColumn={threadColumn}
                    asideHeader={asideHeader}
                  />
                ) : (
                  <div data-ui-center-pane="" className="flex min-h-0 flex-1 flex-col">
                    {threadColumn}
                  </div>
                )}
              </Column>
            )}
          </div>
          {/* 底部终端：**必须包一层高度容器**。
              `BottomTerminalBar` 自己始终 `h-full`，折叠靠父级给 0 高度
              （与旧壳 `ThreePaneLayout:414-417` 完全一致的契约）。
              直接放进来会让它 `h-full` 吃掉全部剩余高度 —— 实测 727px，
              把主对话挤成 height 0。 */}
          {bottomTerminal && (
            <div
              className={cn(
                "shrink-0 overflow-hidden",
                bottomTerminalOpen ? "border-t border-[var(--m-border)]" : "h-0",
              )}
              inert={!bottomTerminalOpen}
              aria-hidden={!bottomTerminalOpen}
            >
              {bottomTerminal}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
