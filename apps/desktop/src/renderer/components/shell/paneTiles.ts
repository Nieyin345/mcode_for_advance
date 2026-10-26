/**
 * 【UI 重建】**Claude Code 页的 pane tile 树** —— 替代原来的「固定右栏 + 八个页签」。
 *
 * ## 从本机 Claude 3.1623.4.0 读到的真实结构
 *
 * 右侧不是一栏，是一棵**可递归切分的树**：
 *
 * ```js
 * { kind: "stack", direction: "row" | "column",
 *   children: [
 *     { kind: "tile", tileId: "chat", flex: 1 },
 *     { kind: "tile", tileId: "file", flex: 1 },
 *   ] }
 * ```
 *
 * 每个 tile 有 `flex`（占本层比例），`chat` 是主对话那一格。
 * 切分是 `{kind:"split", stackId, direction, index}` 插进 children。
 * 还有 `overlayTile`（一格临时铺满）与 `expandedTile`（放大后记住 baseLayout）。
 *
 * ## 真实的 tile 类型
 *
 * 从 bundle 的 `new Set([...])` 里读到的：`diff, preview, artifact, file, pr, cr,
 * watercolor, mcpapp`。加上 chat 与 terminal，共十种。
 *
 * **pane 内容视图**（`paneViews`）也读到了九个字段：
 * `sessionView, fileView, fileTabs, previewServerId, artifactView,
 *  browserView, subagentView, prView, crView`。
 *
 * ## 与旧 paneLayout.ts 的关系
 *
 * 旧的 `paneLayout.ts` 是「四个槽位 left/right/bottom/editor + 三个停靠边」，
 * 不能表达「同一个 stack 里并排两个 tile」。**这个文件取代它**。
 * 旧文件暂时保留（还有套件引用），但新壳只读这里。
 */

/** Claude Code 页的 tile 类型。值取自其 bundle 的 Set 字面量。 */
export type PaneTileKind =
  | "chat"
  | "diff"
  | "preview"
  | "artifact"
  | "file"
  | "pr"
  | "cr"
  | "terminal"
  | "watercolor"
  | "mcpapp";

/** 一个叶子 tile。 */
export interface PaneTile {
  kind: "tile";
  tileId: PaneTileKind;
  /** 在本层 stack 里占的比例权重（Claude 用 0..N，常见 1..3）。 */
  flex: number;
}

/** 一个切分节点：横向或纵向排布若干子节点。 */
export interface PaneStack {
  kind: "stack";
  direction: "row" | "column";
  children: PaneNode[];
}

export type PaneNode = PaneTile | PaneStack;

/** 一棵完整的 tile 布局。 */
export interface TileLayout {
  version: 2;
  root: PaneStack;
}

/** 从 Claude 的 `Ti` Set 中读到的、会「抢占主区」的类型。 */
const NON_CHAT_KINDS: readonly PaneTileKind[] = [
  "diff", "preview", "artifact", "file", "pr", "cr", "watercolor", "mcpapp",
];

export function isNonChatTile(kind: PaneTileKind): boolean {
  return NON_CHAT_KINDS.includes(kind);
}

/**
 * 默认布局：**只有 chat**。
 *
 * Claude 打开 Code 页时不预开任何右侧 pane —— 它们由消息内的卡片 / 用户动作
 * 「按需出现」。旧 Mcode 默认右栏常驻且开着八个页签之一，这正是「看起来不像」
 * 的直接来源之一。
 */
export const DEFAULT_TILE_LAYOUT: TileLayout = {
  version: 2,
  root: {
    kind: "stack",
    direction: "row",
    children: [{ kind: "tile", tileId: "chat", flex: 1 }],
  },
};

/** 找某个 tile 的父 stack（返回 null 表示不在树里）。 */
export function findParentStack(
  node: PaneNode,
  tileId: PaneTileKind,
): PaneStack | null {
  if (node.kind !== "stack") return null;
  for (const child of node.children) {
    if (child.kind === "tile" && child.tileId === tileId) return node;
    if (child.kind === "stack") {
      const found = findParentStack(child, tileId);
      if (found) return found;
    }
  }
  return null;
}

/** 树里是否有某个 tile。 */
export function hasTile(node: PaneNode, tileId: PaneTileKind): boolean {
  if (node.kind === "tile") return node.tileId === tileId;
  return node.children.some((c) => hasTile(c, tileId));
}

/** 数树里除 chat 之外的 tile 数量（Claude 的 `openNonChatTileCount`）。 */
export function openNonChatTileCount(node: PaneNode): number {
  if (node.kind === "tile") return isNonChatTile(node.tileId) ? 1 : 0;
  return node.children.reduce((n, c) => n + openNonChatTileCount(c), 0);
}

/**
 * 打开一个 tile：把它作为**新的右列**插到 chat 右边，两者各占一半。
 *
 * 这是 Claude 从消息卡片点开 diff / 文件的默认形态 —— 不是替换 chat，
 * 而是并排。若该 tile 已在树里，返回原树（幂等）。
 */
export function openTile(layout: TileLayout, tileId: PaneTileKind): TileLayout {
  if (hasTile(layout.root, tileId)) return layout;
  const root = layout.root;
  // 顶层已经是横向 stack：直接追加一族，与 chat 平分。
  if (root.direction === "row") {
    const chat = root.children.find(
      (c): c is PaneTile => c.kind === "tile" && c.tileId === "chat",
    );
    const baseFlex = chat?.flex ?? 1;
    const children = root.children.map((c) =>
      c.kind === "tile" && c.tileId === "chat" ? { ...c, flex: baseFlex } : c,
    );
    return {
      ...layout,
      root: {
        ...root,
        children: [...children, { kind: "tile", tileId, flex: baseFlex }],
      },
    };
  }
  // 顶层是纵向 stack：套一层横向。
  return {
    ...layout,
    root: {
      kind: "stack",
      direction: "row",
      children: [
        { kind: "stack", direction: root.direction, children: root.children },
        { kind: "tile", tileId, flex: 1 },
      ],
    },
  };
}

/** 关掉一个 tile（幂等）。永远不关 chat——它就是主区本身。 */
export function closeTile(layout: TileLayout, tileId: PaneTileKind): TileLayout {
  if (tileId === "chat") return layout;
  const prune = (node: PaneNode): PaneNode | null => {
    if (node.kind === "tile") return node.tileId === tileId ? null : node;
    const kids = node.children.map(prune).filter((c): c is PaneNode => c !== null);
    if (kids.length === 0) return null;
    // 只剩一个子节点时塌缩掉这层 stack —— 避免「一格里面套一格」。
    if (kids.length === 1) return kids[0];
    return { ...node, children: kids };
  };
  const root = prune(layout.root);
  if (!root) return DEFAULT_TILE_LAYOUT;
  return {
    ...layout,
    root: root.kind === "stack" ? root : { kind: "stack", direction: "row", children: [root] },
  };
}

/**
 * 把某一格设为「临时铺满」（Claude 的 `overlayTile` / `expandedTile`）。
 * 这里只记 tileId；真正的铺满由渲染层用 CSS 实现，不改树——
 * 这样退出放大时布局原封不动回来（Claude 的 `baseLayout` 同思路）。
 */
export function expandTile(
  layout: TileLayout,
  tileId: PaneTileKind | null,
): TileLayout & { expanded: PaneTileKind | null } {
  return { ...layout, expanded: tileId };
}

/** 校验一棵从磁盘读回的布局。坏数据回默认，不抛。 */
export function parseTileLayout(raw: unknown): TileLayout {
  if (!raw || typeof raw !== "object") return DEFAULT_TILE_LAYOUT;
  const o = raw as Partial<TileLayout>;
  if (o.version !== 2 || !o.root || o.root.kind !== "stack") return DEFAULT_TILE_LAYOUT;
  const validNode = (n: unknown): boolean => {
    if (!n || typeof n !== "object") return false;
    const node = n as PaneNode;
    if (node.kind === "tile") {
      return typeof node.tileId === "string" && typeof node.flex === "number" && node.flex >= 0;
    }
    if (node.kind === "stack") {
      return (node.direction === "row" || node.direction === "column") &&
        Array.isArray(node.children) && node.children.every(validNode);
    }
    return false;
  };
  return validNode(o.root) ? (o as TileLayout) : DEFAULT_TILE_LAYOUT;
}

/**
 * 拖拽分栏：把某个 stack 里相邻两个子节点的 flex 改成 `na` / `nb`。
 *
 * 用**结构相等**定位那对节点（不是按下标）—— 树是递归的，下标只在本层有意义，
 * 而调用方拿到的是节点对象本身，按引用定位会把「同一份布局的克隆」判成不同。
 */
export function resizeStack(
  layout: TileLayout,
  target: PaneStack,
  a: PaneNode,
  na: number,
  b: PaneNode,
  nb: number,
): TileLayout {
  const idOf = (n: PaneNode): string =>
    n.kind === "tile" ? n.tileId : n.children.map(idOf).join("|");

  const aId = idOf(a);
  const bId = idOf(b);
  let touched = false;

  const walk = (node: PaneNode): PaneNode => {
    if (node.kind === "tile") return node;
    // 找到同一个 stack：方向一致且子节点集合一致。
    const sameStack =
      node.direction === target.direction &&
      node.children.length === target.children.length &&
      node.children.map(idOf).join(",") === target.children.map(idOf).join(",");
    if (sameStack) {
      touched = true;
      return {
        ...node,
        children: node.children.map((c) => {
          const id = idOf(c);
          if (id === aId && c.kind === "tile") return { ...c, flex: na };
          if (id === bId && c.kind === "tile") return { ...c, flex: nb };
          return c;
        }),
      };
    }
    return { ...node, children: node.children.map(walk) };
  };

  const root = walk(layout.root);
  return touched ? { ...layout, root: root.kind === "stack" ? root : layout.root } : layout;
}
