import type { Editor } from "@tiptap/react";

/** Convert serialized composer text offsets to editable ProseMirror positions.
 * The first offset (0) belongs INSIDE the opening paragraph, at document
 * position 1, not at the document root (position 0). Returning 0 previously
 * made /command and @skill insertion at the beginning of an empty composer
 * address a container boundary rather than an editable insertion point.
 *
 * Skill/command nodes are atomic: their serialized /name length differs
 * from their single ProseMirror node position. Offsets inside a pill snap
 * to its end; a hardBreak consumes one char/position in both spaces.
 */
export function composerTextOffsetToPos(
  doc: Editor["state"]["doc"],
  offset: number,
): number {
  const first = doc.content.size > 0 ? 1 : 0;
  if (!Number.isFinite(offset) || offset <= 0) return first;
  const limit = Math.max(first, doc.content.size - 1);
  let pos = first;
  let consumed = 0;
  doc.descendants((node, p) => {
    if (consumed >= offset) return false;
    if (node.isText) {
      const size = node.text?.length ?? 0;
      if (consumed + size >= offset) {
        pos = p + (offset - consumed);
        consumed = offset;
        return false;
      }
      consumed += size;
    } else if (node.type.name === "skill") {
      const size = `/${node.attrs.label ?? node.attrs.id ?? ""}`.length;
      if (consumed + size >= offset) {
        pos = p + node.nodeSize;
        consumed = offset;
        return false;
      }
      consumed += size;
    } else if (node.type.name === "hardBreak") {
      if (consumed + 1 >= offset) {
        pos = p + 1;
        consumed = offset;
        return false;
      }
      consumed += 1;
    }
    return true;
  });
  return consumed < offset ? limit : Math.max(first, Math.min(pos, limit));
}
