import type { Box } from "./workflowLayout.js";
export interface EdgeLabel { id: string; text: string; x: number; y: number; width: number; height: number }
export function edgeLabelText(text: string): string {
  const chars = [...text.trim()];
  return chars.length > 32 ? chars.slice(0, 31).join("") + "…" : text.trim();
}
const intersects = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** Conservative character widths, deterministic placement, with both labels and nodes as obstacles. */
export function placeEdgeLabels(items: readonly { id: string; text: string; x: number; y: number }[], nodes: readonly Box[]): Map<string, EdgeLabel> {
  const occupied = nodes.map(n => ({ x: n.x - 4, y: n.y - 4, w: n.w + 8, h: n.h + 8 }));
  const result = new Map<string, EdgeLabel>();
  for (const item of items) {
    const text = edgeLabelText(item.text);
    if (!text) continue;
    const width = [...text].reduce((w, c) => w + ((c.codePointAt(0) ?? 0) > 0xffff ? 18 : 11), 0) + 8;
    const height = 22;
    let x = Math.max(width / 2 + 6, item.x), y = Math.max(height, item.y);
    let box = { x: x - width / 2, y: y - 16, w: width, h: height };
    // Each shift clears at least one horizontal obstacle band. A fallback below
    // all previous boxes guarantees termination even on a dense imported graph.
    for (let i = 0; occupied.some(b => intersects(box, b)); i++) {
      y = i < 20 ? Math.max(height, item.y + (i + 1) * 24) : Math.max(...occupied.map(b => b.y + b.h), y) + 24;
      box = { ...box, y: y - 16 };
    }
    occupied.push(box);
    result.set(item.id, { id: item.id, text, x, y, width, height });
  }
  return result;
}
