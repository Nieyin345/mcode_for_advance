/** ARC-005: layout geometry and the Claude Artifacts split physics.
 * Kept pure so corrupt settings and drag boundaries can be mutation tested.
 * The existing paneDock.ts remains the authority for the two-way legacy path.
 */
import { dockSideAtPoint } from "./paneDock.js";

export type PaneId = "left" | "right" | "bottom" | "editor";
export type DockSide = "left" | "right" | "bottom";
export type PaneContent =
  | { kind: "builtin"; id: "chat" | "files" | "git" | "terminal" }
  | { kind: "document"; documentId: string }
  | { kind: "flow"; flowId: string };
export interface PanePlacement { id: PaneId; side: DockSide; order: number; sizePct: number; content?: PaneContent; }
export interface PaneLayout { version: 1; placements: PanePlacement[]; }
const IDS: readonly PaneId[] = ["left", "right", "bottom", "editor"];
const SIDES: readonly DockSide[] = ["left", "right", "bottom"];

export const DEFAULT_PANE_LAYOUT: PaneLayout = {
  version: 1,
  placements: [
    { id: "left", side: "left", order: 0, sizePct: 24 },
    { id: "right", side: "right", order: 0, sizePct: 30 },
    { id: "bottom", side: "bottom", order: 0, sizePct: 30 },
    { id: "editor", side: "right", order: 1, sizePct: 50 },
  ],
};
/** Presets keep the virtual editor slot at zero so the visible right pane
 * receives its requested share rather than being proportionally squeezed. */
export const LAYOUT_PRESETS: Record<"chat" | "editor" | "balanced", PaneLayout> = {
  chat: { version: 1, placements: [
    { id: "left", side: "left", order: 0, sizePct: 18 },
    { id: "right", side: "right", order: 0, sizePct: 22 },
    { id: "bottom", side: "bottom", order: 0, sizePct: 30 },
    { id: "editor", side: "right", order: 1, sizePct: 0 },
  ] },
  editor: { version: 1, placements: [
    { id: "left", side: "left", order: 0, sizePct: 0 },
    { id: "right", side: "right", order: 0, sizePct: 60 },
    { id: "bottom", side: "bottom", order: 0, sizePct: 30 },
    { id: "editor", side: "right", order: 1, sizePct: 0 },
  ] },
  balanced: { version: 1, placements: [
    { id: "left", side: "left", order: 0, sizePct: 22 },
    { id: "right", side: "right", order: 0, sizePct: 50 },
    { id: "bottom", side: "bottom", order: 0, sizePct: 30 },
    { id: "editor", side: "right", order: 1, sizePct: 0 },
  ] },
};
export type PanePreset = keyof typeof LAYOUT_PRESETS;
export function copyPaneLayout(layout: PaneLayout): PaneLayout {
  return { version: 1, placements: layout.placements.map(p => ({ ...p })) };
}

/** A targeted drag should not lose its requested ratio to an invisible,
 * same-side placement: shrink siblings into the remaining space instead. */
export function setPaneSizePct(layout: PaneLayout, id: PaneId, sizePct: number): PaneLayout {
  const base = clampLayout(layout);
  if (!Number.isFinite(sizePct)) return base;
  const target = base.placements.find(p => p.id === id);
  if (!target) return base;
  const size = Math.max(0, Math.min(100, sizePct));
  const siblings = base.placements.filter(p => p.id !== id && p.side === target.side);
  const siblingSum = siblings.reduce((sum, p) => sum + p.sizePct, 0);
  const siblingScale = siblingSum > 100 - size ? (100 - size) / siblingSum : 1;
  return clampLayout({ version: 1, placements: base.placements.map(p =>
    p.id === id ? { ...p, sizePct: size } :
    p.side === target.side ? { ...p, sizePct: p.sizePct * siblingScale } : p,
  ) });
}

const freshDefault = (): PaneLayout => ({
  version: 1, placements: DEFAULT_PANE_LAYOUT.placements.map(p => ({ ...p })),
});
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** All malformed payloads fail together: never import a half-valid tree. */
export function parsePaneLayout(input: unknown): { layout: PaneLayout; repaired: string[] } {
  if (!isRecord(input)) return { layout: freshDefault(), repaired: ["not-an-object"] };
  if (input.version !== 1 || !Array.isArray(input.placements))
    return { layout: freshDefault(), repaired: ["legacy-or-unknown-version"] };
  if (input.placements.length !== IDS.length)
    return { layout: freshDefault(), repaired: ["missing-or-extra-placement"] };
  const seen = new Set<string>();
  const placements: PanePlacement[] = [];
  for (const value of input.placements as unknown[]) {
    if (!isRecord(value)) return { layout: freshDefault(), repaired: ["invalid-placement"] };
    const { id, side, order, sizePct } = value;
    if (!IDS.includes(id as PaneId)) return { layout: freshDefault(), repaired: ["invalid-id"] };
    if (seen.has(id as string)) return { layout: freshDefault(), repaired: ["duplicate-id"] };
    seen.add(id as string);
    if (!SIDES.includes(side as DockSide)) return { layout: freshDefault(), repaired: ["invalid-side"] };
    if (!Number.isSafeInteger(order) || (order as number) < 0)
      return { layout: freshDefault(), repaired: ["invalid-order"] };
    if (typeof sizePct !== "number" || !Number.isFinite(sizePct) || sizePct < 0 || sizePct > 100)
      return { layout: freshDefault(), repaired: ["invalid-sizePct"] };
    // Old persisted layouts have no content. New ones must be strictly shaped:
    // never trust a serialized document/flow identifier as a URL or path.
    let content: PaneContent | undefined;
    if ("content" in value && value.content !== undefined) {
      const c = value.content;
      if (!isRecord(c)) return { layout: freshDefault(), repaired: ["invalid-content"] };
      if (c.kind === "builtin" && typeof c.id === "string" && ["chat", "files", "git", "terminal"].includes(c.id)) {
        content = { kind: "builtin", id: c.id as "chat" | "files" | "git" | "terminal" } as PaneContent;
      } else if (c.kind === "document" && typeof c.documentId === "string" &&
          c.documentId.length > 0 && c.documentId.length <= 4096) {
        content = { kind: "document", documentId: c.documentId };
      } else if (c.kind === "flow" && typeof c.flowId === "string" &&
          /^[a-z0-9-]{1,100}$/.test(c.flowId)) {
        content = { kind: "flow", flowId: c.flowId };
      } else return { layout: freshDefault(), repaired: ["invalid-content"] };
    }
    placements.push({ id: id as PaneId, side: side as DockSide, order: order as number, sizePct, ...(content ? { content } : {}) });
  }
  if (seen.size !== IDS.length) return { layout: freshDefault(), repaired: ["missing-id"] };
  for (const side of SIDES) {
    const orders = placements.filter(p => p.side === side).map(p => p.order).sort((a,b)=>a-b);
    if (orders.some((v,i)=>v!==i)) return { layout: freshDefault(), repaired: ["noncontiguous-order"] };
  }
  return { layout: { version: 1, placements }, repaired: [] };
}

export function clampLayout(layout: PaneLayout): PaneLayout {
  const verified = parsePaneLayout(layout);
  if (verified.repaired.length) return verified.layout;
  const singles = verified.layout.placements.map(p => ({
    ...p, sizePct: Math.min(100, Math.max(0, p.sizePct)),
  }));
  // 同侧多个 pane 的 sizePct 之和必须 ≤ 100：否则两条分割线会互相推挤，
  // 右栏被挤出容器。按比例缩，谁也拿不到比原来更大的份额。
  const bySide = new Map<DockSide, typeof singles>();
  for (const p of singles) {
    const list = bySide.get(p.side) ?? [];
    list.push(p);
    bySide.set(p.side, list);
  }
  const scale = new Map<string, number>();
  for (const [, list] of bySide) {
    const sum = list.reduce((n, p) => n + p.sizePct, 0);
    if (sum > 100 && sum > 0) for (const p of list) scale.set(p.id, 100 / sum);
  }
  return {
    version: 1,
    placements: scale.size === 0 ? singles : singles.map(p => {
      const k = scale.get(p.id);
      return k === undefined ? p : { ...p, sizePct: p.sizePct * k };
    }),
  };
}

/** Change the payload without remounting a pane or changing its placement. */
export function withPaneContent(layout: PaneLayout, id: PaneId, content: PaneContent | undefined): PaneLayout {
  const base = clampLayout(layout);
  if (!IDS.includes(id)) return base;
  return { version: 1, placements: base.placements.map(p => {
    if (p.id !== id) return p;
    if (content !== undefined) return { ...p, content };
    const { content: _removed, ...withoutContent } = p;
    return withoutContent;
  }) };
}

/** The movable right host renders whichever physical zone it occupies.
 * Store the editor payload on that zone's own left/right/bottom placement,
 * not permanently on "right"; moving rebinds metadata, not its React view. */
export function hostedPaneContent(layout: PaneLayout): PaneContent | undefined {
  const right = layout.placements.find(p => p.id === "right");
  const zone = right?.side ?? "right";
  return layout.placements.find(p => p.id === zone)?.content ?? right?.content;
}
export function withHostedPaneContent(layout: PaneLayout, content: PaneContent | undefined): PaneLayout {
  const base = clampLayout(layout);
  const zone = base.placements.find(p => p.id === "right")?.side ?? "right";
  return { version: 1, placements: base.placements.map(p => {
    if (p.id === zone && content !== undefined) return { ...p, content };
    if (p.id === zone || p.content?.kind === "document" || p.content?.kind === "flow") {
      const { content: _removed, ...withoutContent } = p;
      return withoutContent;
    }
    return p;
  }) };
}
export function moveHostedPane(layout: PaneLayout, side: DockSide, order: number): PaneLayout {
  const content = hostedPaneContent(layout);
  const moved = movePane(layout, "right", side, order);
  return content?.kind === "document" || content?.kind === "flow"
    ? withHostedPaneContent(moved, content) : moved;
}

export function movePane(layout: PaneLayout, id: PaneId, side: DockSide, order: number): PaneLayout {
  const base = clampLayout(layout);
  if (!IDS.includes(id) || !SIDES.includes(side)) return base;
  const moving = base.placements.find(p => p.id === id);
  if (!moving) return base;
  const rest = base.placements.filter(p => p.id !== id);
  const sideMembers = rest.filter(p => p.side === side).sort((a,b)=>a.order-b.order);
  sideMembers.splice(Math.max(0, Math.min(sideMembers.length, Number.isFinite(order) ? Math.floor(order) : 0)),
    0, { ...moving, side });
  return { version: 1, placements: rest.filter(p => p.side !== side)
    .concat(sideMembers).map(p => p.side === side ? ({ ...p, order: sideMembers.findIndex(s => s.id === p.id) }) : p)
    .map(p => p.side !== side ? ({ ...p, order: rest.filter(s => s.side === p.side && s.order < p.order).length }) : p) };
}

/** Three zones: lower third is bottom; upper two thirds reuse the exact
 * two-way midpoint authority from paneDock.ts. */
export function dockSideAtRect(
  x: number, y: number, left: number, top: number, width: number, height: number,
): DockSide | null {
  if (![x,y,left,top,width,height].every(Number.isFinite) || height <= 0 || width <= 0) return null;
  const horizontal = dockSideAtPoint(x, left, width);
  if (!horizontal) return null;
  return y >= top + height * (2 / 3) ? "bottom" : horizontal;
}

// Constants mirror open-claude-ui/code-examples/ArtifactsSplitPaneResizer.tsx.
export const SPLIT_DEAD_ZONE_PX = 4;
export const SPLIT_COLLAPSE_THRESHOLD = 0.18;
export const SPLIT_MIN_LEFT_PX = 380;
export const SPLIT_MIN_RIGHT_PX = 420;
export const SPLIT_SNAP_RATIO = 0.5;

export interface SplitResult { ratio: number; collapsed: "left" | "right" | null; moved: boolean }
/** Input ratio measures left/center share, never the right pane share. */
export function computeSplitDrag(startRatio: number, deltaPx: number, containerWidth: number): SplitResult {
  if (![startRatio, deltaPx, containerWidth].every(Number.isFinite) || containerWidth <= 0 ||
      Math.abs(deltaPx) < SPLIT_DEAD_ZONE_PX) {
    return { ratio: startRatio, collapsed: null, moved: false };
  }
  const raw = startRatio + deltaPx / containerWidth;
  if (raw < SPLIT_COLLAPSE_THRESHOLD)
    return { ratio: 0, collapsed: "left", moved: true };
  if (raw > 1 - SPLIT_COLLAPSE_THRESHOLD)
    return { ratio: 1, collapsed: "right", moved: true };
  // Very narrow windows cannot satisfy both pixel minima. Keep a usable split.
  const minRatio = containerWidth >= SPLIT_MIN_LEFT_PX + SPLIT_MIN_RIGHT_PX
    ? SPLIT_MIN_LEFT_PX / containerWidth : 0.18;
  const maxRatio = containerWidth >= SPLIT_MIN_LEFT_PX + SPLIT_MIN_RIGHT_PX
    ? (containerWidth - SPLIT_MIN_RIGHT_PX) / containerWidth : 0.82;
  return { ratio: Math.max(minRatio, Math.min(maxRatio, raw)), collapsed: null, moved: true };
}
