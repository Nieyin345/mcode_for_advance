/**
 * 【UI 重建】**递归渲染 pane tile 树**（Claude 3.1623.4.0 的 `tileLayout`）。
 *
 * 一棵树长这样：
 *
 * ```
 * { kind:"stack", direction:"row", children:[
 *     { kind:"tile", tileId:"chat", flex:1 },
 *     { kind:"stack", direction:"column", children:[
 *         { kind:"tile", tileId:"diff", flex:1 },
 *         { kind:"tile", tileId:"terminal", flex:1 },
 *     ]},
 * ]}
 * ```
 *
 * 渲染规则照 Claude：
 *  - `stack` → 一条 flex 行/列，子节点按 `flex` 分配；
 *  - `tile` → 一格，带标题栏与关闭按钮；`chat` 那格**不画标题栏**（它就是主对话）；
 *  - 相邻格之间是 `data-tile-divider` 拖拽条（Claude 同名属性）。
 *
 * **不卸载原则**：本轮先只做「渲染 + 关闭」。真正拖动切分留到下一步，
 * 因为拖动要改 store 持久化，而那属于基础壳之后的批次。
 */
import { cn } from "@renderer/lib/cn.js";
import { Fragment, useCallback, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { PaneNode, PaneTile, PaneStack } from "./paneTiles.js";
import { isNonChatTile } from "./paneTiles.js";

export interface TilePaneProps {
  layout: { root: PaneStack };
  /** 渲染某个 tile 的内容。`chat` 由调用方传入的 chatColumn 承担。 */
  renderTile: (tileId: string) => ReactNode;
  /** 关闭按钮回调（chat 没有关闭按钮）。 */
  onCloseTile?: (tileId: string) => void;
  /** 主对话那一格的内容。 */
  chatColumn: ReactNode;
  /**
   * 拖拽分栏回调：某个 stack 里相邻两格的 flex 要改成 na / nb。
   * 不传则分栏条只画不拖（只读场景）。
   */
  onResize?: (stack: PaneStack, a: PaneNode, na: number, b: PaneNode, nb: number) => void;
  /** 放大/还原某一格（Claude 的 expandedTile）。 */
  onExpand?: (tileId: string | null) => void;
  /** 当前被放大的格（null = 没有）。 */
  expandedTile?: string | null;
}

/** 一个叶子格。 */
function Tile({
  tile,
  renderTile,
  onCloseTile,
  chatColumn,
  onExpand,
  expanded,
}: {
  tile: PaneTile;
  renderTile: (id: string) => ReactNode;
  onCloseTile?: (id: string) => void;
  chatColumn: ReactNode;
  onExpand?: (id: string | null) => void;
  expanded?: boolean;
}) {
  const isChat = tile.tileId === "chat";
  return (
    <div
      data-pane-root={tile.tileId}
      // 【兼容标记】探针用 `[data-ui-center-pane]` 量中心区、用
      // `[data-cds-aside]` 量右栏。新壳里两者都是 tile，各自沿用对应属性。
      // chat tile 额外带 `data-cds-center` —— 那是 U1 真机探针
      //（`arc005-pane-electron-smoke`）认的标记，旧 `ThreePaneLayout` 有。
      // 换壳时漏了它，那套真机验证直接报「real ThreePaneLayout missing」，
      // 看起来像壳没渲染，实际只是少了一个属性。
      {...(isChat
        ? { "data-ui-center-pane": "", "data-cds-center": "" }
        : { "data-cds-aside": "", "aria-hidden": "false" })}
      className="flex min-h-0 min-w-0 flex-1 self-stretch flex-col overflow-hidden bg-[var(--m-surface-0)]"
    >
      {!isChat && (
        <div
          data-pane-title={tile.tileId}
          className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--m-border)] px-3"
        >
          <span className="min-w-0 flex-1 truncate text-[var(--m-font-size-caption)] text-[var(--m-text-secondary)]">
            {tileLabel(tile.tileId)}
          </span>
          {onExpand && (
            <button
              type="button"
              aria-label={expanded ? "还原" : "放大"}
              aria-pressed={expanded}
              className="shrink-0 rounded p-1 hover:bg-[var(--m-fill-ghost-hover)]"
              onClick={() => onExpand(expanded ? null : tile.tileId)}
            >
              {expanded ? <CollapseIcon /> : <ExpandIcon />}
            </button>
          )}
          {onCloseTile && (
            <button
              type="button"
              aria-label={`关闭 ${tileLabel(tile.tileId)}`}
              className="shrink-0 rounded p-1 hover:bg-[var(--m-fill-ghost-hover)]"
              onClick={() => onCloseTile(tile.tileId)}
            >
              <CloseIcon />
            </button>
          )}
        </div>
      )}
      <div className="min-h-0 min-w-0 flex-1 self-stretch overflow-auto">
        {isChat ? chatColumn : renderTile(tile.tileId)}
      </div>
    </div>
  );
}

/** 相邻格之间的拖拽条。Claude 用 `data-tile-divider` 标它。 */
function TileDivider({
  direction,
  onDrag,
}: {
  direction: "row" | "column";
  onDrag: (deltaPx: number, containerPx: number) => void;
}) {
  const dragging = useRef<{ start: number; container: number } | null>(null);
  const isRow = direction === "row";

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const container = e.currentTarget.parentElement;
      if (!container) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const rect = container.getBoundingClientRect();
      dragging.current = { start: isRow ? e.clientX : e.clientY, container: isRow ? rect.width : rect.height };
    },
    [isRow],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = dragging.current;
      if (!d) return;
      const now = isRow ? e.clientX : e.clientY;
      onDrag(now - d.start, d.container);
      // 每帧都把起点推到当前位置 —— 这样 onDrag 收到的是增量，
      // 而两侧 flex 已经在上一帧被改过，累积不会重复应用。
      dragging.current = { ...d, start: now };
    },
    [isRow, onDrag],
  );

  const end = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  return (
    <div
      data-tile-divider=""
      role="separator"
      aria-orientation={isRow ? "vertical" : "horizontal"}
      className={cn(
        "shrink-0 bg-[var(--m-border)] transition-colors hover:bg-[var(--m-fill-accent)]",
        isRow ? "cursor-col-resize" : "cursor-row-resize",
      )}
      style={isRow ? { width: 1 } : { height: 1 }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
    />
  );
}

/** 递归渲染一个节点。props 显式往下传，不用 spread（避免把 layout 带下去）。 */
function Node({ node, renderTile, onCloseTile, chatColumn, onResize, onExpand, expandedTile }: { node: PaneNode } & Omit<TilePaneProps, "layout">) {
  if (node.kind === "tile") {
    return <Tile tile={node} renderTile={renderTile} onCloseTile={onCloseTile} chatColumn={chatColumn} onExpand={onExpand} expanded={expandedTile === node.tileId} />;
  }
  const dir = node.direction === "row" ? "flex-row" : "flex-col";
  const total = node.children.reduce((n, c) => n + nodeFlex(c), 0) || 1;
  // 放大态：若这一层里有被放大的格，它独占全部份额，兄弟归 0。
  // **不改树**（Claude 的 expandedTile 也是记在旁路，退出时布局原样回来）。
  const hasExpandedHere =
    !!expandedTile && node.children.some((c) => c.kind === "tile" && c.tileId === expandedTile);
  return (
    // 高度链：`min-h-0 + flex-1` 让 flex 自己分配。**不写 `h-full`** ——
    // 它和 `flex-1` 同时出现时高度会算成 0（实测 center/right 恒为 0）。
    // `min-w-0` 同理，否则横向的 `flex-1` 会被内容撑破。
    <div className={cn("flex min-h-0 min-w-0 flex-1 self-stretch", dir)}>
      {node.children.map((child, i) => (
        <Fragment key={child.kind === "tile" ? child.tileId : `stack-${i}`}>
          {/* 相邻格之间的拖拽条（Claude 的同名属性 `data-tile-divider`）。
              第一条之前不画。拖动时把 px 位移换算成两侧 flex 的此消彼长。 */}
          {i > 0 && onResize && (
            <TileDivider
              direction={node.direction}
              onDrag={(deltaPx, containerPx) => {
                const prev = node.children[i - 1];
                const cur = child;
                const a = nodeFlex(prev);
                const b = nodeFlex(cur);
                const share = containerPx > 0 ? deltaPx / containerPx : 0;
                const delta = share * total;
                // 两侧都至少保留 10% 的份额，避免拖成 0 宽。
                const na = Math.max(total * 0.1, Math.min(total * 0.9, a + delta));
                const nb = Math.max(total * 0.1, a + b - na);
                onResize(node, prev, na, cur, nb);
              }}
            />
          )}
          <div
            className="flex min-h-0 min-w-0 self-stretch"
            style={{
              flex: String(
                hasExpandedHere
                  ? (child.kind === "tile" && child.tileId === expandedTile ? 1 : 0)
                  : nodeFlex(child),
              ),
              // 归 0 的兄弟要彻底让开，否则 min-width/min-height 仍占位。
              ...(hasExpandedHere &&
              !(child.kind === "tile" && child.tileId === expandedTile)
                ? { overflow: "hidden", minWidth: 0, minHeight: 0 }
                : null),
            }}
          >
            <Node node={child} renderTile={renderTile} onCloseTile={onCloseTile} chatColumn={chatColumn} onResize={onResize} onExpand={onExpand} expandedTile={expandedTile} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** stack 自己的 flex 取它内部 tile 的和；tile 取自己的 flex。 */
function nodeFlex(node: PaneNode): number {
  if (node.kind === "tile") return node.flex;
  const sum = node.children.reduce((n, c) => n + nodeFlex(c), 0);
  return sum > 0 ? sum : 1;
}

/** tile 的中文标题。i18n 之后接进来；这里先给稳定文案。 */
function tileLabel(id: string): string {
  const map: Record<string, string> = {
    chat: "对话",
    diff: "改动",
    preview: "预览",
    artifact: "产物",
    file: "文件",
    pr: "合并请求",
    cr: "评审",
    terminal: "终端",
    watercolor: "画布",
    mcpapp: "MCP 应用",
  };
  return map[id] ?? id;
}

/** 放大：四角向外的箭头。 */
function ExpandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M5.5 2.5h-3v3M8.5 2.5h3v3M5.5 11.5h-3v-3M8.5 11.5h3v-3"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 还原：四角向内的箭头。 */
function CollapseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M2.5 5.5h3v-3M11.5 5.5h-3v-3M2.5 8.5h3v3M11.5 8.5h-3v3"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** 对外入口。 */
export function TilePane({ layout, renderTile, onCloseTile, chatColumn, onResize, onExpand, expandedTile }: TilePaneProps) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 self-stretch" data-pane-layout-root="">
      <Node node={layout.root} renderTile={renderTile} onCloseTile={onCloseTile} chatColumn={chatColumn} onResize={onResize} onExpand={onExpand} expandedTile={expandedTile} />
    </div>
  );
}

export { isNonChatTile };
