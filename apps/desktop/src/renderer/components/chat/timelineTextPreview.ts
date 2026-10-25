/** Bounded, allocation-conscious text for chat timeline hover previews.
 * The full message and saved bookmark excerpts remain unchanged. */
import type { Block } from "@renderer/stores/sessionStore.js";

export const TIMELINE_EXCERPT_LIMIT = 1200;
type AttachmentLabel = (key: "chatStream.timeline.attachmentLine", params: { text: string }) => string;

export function truncateTimelineExcerpt(text: string): string {
  return text.length > TIMELINE_EXCERPT_LIMIT
    ? text.slice(0, TIMELINE_EXCERPT_LIMIT) + "…"
    : text;
}

/** Cheap accessible label for the always-mounted navigation dash.
 * Do not pre-format the 1200-character tooltip of every historical message;
 * most timeline dashes are never hovered. Keep screen-reader text available
 * at all times, including while no tooltip portal exists.
 */
export function timelineAccessibleSummary(blocks: readonly Block[], t: AttachmentLabel): string {
  const limit = 140;
  for (const block of blocks) {
    if (block.kind === "text") {
      const sample = block.text.slice(0, limit).trim();
      if (sample) return sample;
    } else if (block.kind === "thinking") {
      const sample = block.text.slice(0, limit).trim();
      if (sample) return sample;
    } else if (block.kind === "attachment") {
      return t("chatStream.timeline.attachmentLine", { text: block.preview.slice(0, limit) }).slice(0, limit);
    }
  }
  return "";
}

export function timelineBlocksPreview(blocks: readonly Block[], t: AttachmentLabel): string {
  const out: string[] = [];
  let remaining = TIMELINE_EXCERPT_LIMIT;
  let clipped = false;
  for (const b of blocks) {
    if (remaining <= 0) { clipped = true; break; }
    // Reserve separators before formatting: no need to materialize a huge
    // paste or thinking trace just to paint a 288px-wide hover card.
    if (out.length) remaining -= 2;
    if (remaining <= 0) { clipped = true; break; }
    let part = "";
    if (b.kind === "text") {
      part = b.text.slice(0, remaining);
      if (b.text.length > remaining) clipped = true;
    } else if (b.kind === "thinking") {
      const source = b.text.slice(0, remaining);
      const thinking = source.trim();
      if (thinking) part = "> " + thinking.replace(/\n/g, "\n> ");
      if (b.text.length > remaining) clipped = true;
    } else if (b.kind === "attachment") {
      const preview = b.preview.slice(0, remaining);
      part = t("chatStream.timeline.attachmentLine", { text: preview });
      if (b.preview.length > remaining) clipped = true;
    }
    if (!part) continue;
    const actual = part.slice(0, remaining);
    if (actual.length < part.length) clipped = true;
    out.push(actual);
    remaining -= actual.length;
  }
  return out.join("\n\n").trim() + (clipped ? "…" : "");
}
