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
import type { ReactNode } from "react";
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
}

/** 一个叶子格。 */
function Tile({
  tile,
  renderTile,
  onCloseTile,
  chatColumn,
}: {
  tile: PaneTile;
  renderTile: (id: string) => ReactNode;
  onCloseTile?: (id: string) => void;
  chatColumn: ReactNode;
}) {
  const isChat = tile.tileId === "chat";
  return (
    <div
      data-pane-root={tile.tileId}
      // 【兼容标记】探针用 `[data-ui-center-pane]` 量中心区、用
      // `[data-cds-aside]` 量右栏。新壳里两者都是 tile，各自沿用对应属性。
      {...(isChat ? { "data-ui-center-pane": "" } : { "data-cds-aside": "", "aria-hidden": "false" })}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--m-surface-0)]"
    >
      {!isChat && (
        <div
          data-pane-title={tile.tileId}
          className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--m-border)] px-3"
        >
          <span className="min-w-0 flex-1 truncate text-[var(--m-font-size-caption)] text-[var(--m-text-secondary)]">
            {tileLabel(tile.tileId)}
          </span>
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
      <div className="min-h-0 flex-1 overflow-auto">
        {isChat ? chatColumn : renderTile(tile.tileId)}
      </div>
    </div>
  );
}

/** 递归渲染一个节点。props 显式往下传，不用 spread（避免把 layout 带下去）。 */
function Node({ node, renderTile, onCloseTile, chatColumn }: { node: PaneNode } & Omit<TilePaneProps, "layout">) {
  if (node.kind === "tile") {
    return <Tile tile={node} renderTile={renderTile} onCloseTile={onCloseTile} chatColumn={chatColumn} />;
  }
  const dir = node.direction === "row" ? "flex-row" : "flex-col";
  return (
    // `h-full` 是关键：父级是 flex 行，本节点若只写 flex-1 而没有确定高度，
    // 子 tile 的 height 会算成 0（实测：右栏 width 512 / height 0）。
    <div className={cn("flex h-full min-h-0 min-w-0 flex-1", dir)}>
      {node.children.map((child, i) => (
        <div
          key={child.kind === "tile" ? child.tileId : `stack-${i}`}
          className="flex h-full min-h-0 min-w-0"
          style={{ flex: String(nodeFlex(child)) }}
        >
          <Node node={child} renderTile={renderTile} onCloseTile={onCloseTile} chatColumn={chatColumn} />
        </div>
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

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** 对外入口。 */
export function TilePane({ layout, renderTile, onCloseTile, chatColumn }: TilePaneProps) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1" data-pane-layout-root="">
      <Node node={layout.root} renderTile={renderTile} onCloseTile={onCloseTile} chatColumn={chatColumn} />
    </div>
  );
}

export { isNonChatTile };
