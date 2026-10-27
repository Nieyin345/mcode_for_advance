/**
 * Left-edge timeline in the chat stream: one small dash per USER message,
 * plus a gold dash PER BOOKMARK (assistant replies included — that is where
 * the key conclusions live). Dashes are stacked vertically in a fixed
 * cluster on the left edge, ordered by the stream's render order. The
 * cluster does NOT move with content — it stays anchored to the left edge's
 * vertical middle.
 *
 * The rule is color-only: gold dash = bookmark (any message type), gray
 * dash = plain user message. Bookmark dashes are a touch thicker so they
 * hold their own next to the gray ones; several bookmarks on one message
 * sit as adjacent gold dashes.
 *
 * Virtual-list mode (default):
 *   - `userItemIndices` and `onJumpToIndex` are provided by the parent
 *     (ChatPane) which owns the LegendList ref.
 *   - The active dash is decided by the parent: ChatPane reads the virtual
 *     list's real per-item positions (getState().positionAtIndex) on scroll
 *     and passes the resulting `activeId` down. An earlier in-component
 *     estimate (scrollTop / 80px) saturated after ~two screens of scroll in
 *     tall sessions — the highlight then sat on the LAST user dash no matter
 *     where the viewport was, which read as bookmarks sitting "above the
 *     current position" right after jumping to one.
 *
 * Feature set:
 *   - Active dash highlight (the user message at/above the viewport top —
 *     computed by ChatPane from the list's real positions, passed as
 *     `activeId`).
 *   - Hover card with timestamp + text body (bookmark dashes show the
 *     bookmark's excerpt instead of the full message text).
 *   - Click to scroll to that message (via onJumpItem).
 */
import { useState, useMemo, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconBookmark } from "@renderer/lib/icons.js";
import { timelinePreviewPosition } from "./timelinePreviewGeometry.js";
import { timelineDashWindow, TIMELINE_WINDOW_THRESHOLD } from "./timelineVirtualWindow.js";
import { ClickableRow } from "@renderer/components/ui/clickable-row.js";
import type { ChatMessage } from "@renderer/stores/sessionStore.js";
import { timelineAccessibleSummary, timelineBlocksPreview, truncateTimelineExcerpt } from "./timelineTextPreview.js";

/** Map of messageId → render-item index (from the virtual list's data array). */
export type UserItemIndexMap = Map<string, number>;

/** A live bookmark resolved against the current stream: the message it
 *  anchors to plus its LegendList item index and display excerpt. One entry
 *  PER BOOKMARK — several bookmarks on the same message each get their own
 *  gold dot. Stale bookmarks (message truncated away) are filtered out by
 *  the caller. */
export interface TimelineBookmarkItem {
  bookmarkId: string;
  message: ChatMessage;
  index: number;
  excerpt: string;
  /** User-defined display name (rename); null = not renamed. */
  title?: string | null;
}

/** Format a wall-clock ms timestamp as HH:MM:SS (local time). */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Hover body comes from a bounded, memoized preview formatter; the raw
 * message and stored bookmark excerpts remain untouched. */
interface MessageTimelineProps {
  messages: ChatMessage[];
  /** The user message currently at/above the viewport top (computed by the
   *  parent from the virtual list's real positions). Rendered as the accent
   *  "you are here" dash. Null when no user messages exist. */
  activeId?: string | null;
  /** Map of user-message id → its index in the LegendList data array. */
  userItemIndices?: UserItemIndexMap;
  /** Live bookmarks for gold dashes (user + assistant messages alike). */
  bookmarkedItems?: TimelineBookmarkItem[];
  /** Called when a dash is clicked, with the dash's message id (the exact
   *  row to center on — NOT just the item index, which is too coarse for
   *  turnGroups), its render index, and the bookmark excerpt when the dash
   *  carries one (keyword fallback for the jump). Provided by ChatPane. */
  onJumpItem?: (messageId: string, index: number, excerpt?: string) => void;
}

/** One rendered dash in the merged, index-ordered stack. */
interface DashEntry {
  key: string;
  message: ChatMessage;
  index: number;
  /** Carries a bookmark → gold, slightly thicker dash. */
  bookmarked: boolean;
  /** Bookmark excerpt for the hover card (bookmark dashes only). */
  excerpt?: string;
  /** Renamed bookmark's display title (hover card headline). */
  title?: string | null;
}

export function MessageTimeline({
  messages,
  activeId = null,
  userItemIndices,
  bookmarkedItems,
  onJumpItem,
}: MessageTimelineProps) {
  const { t } = useI18n();
  const userMessages = useMemo(
    () => messages.filter((m) => m.role === "user"),
    [messages],
  );

  // Bookmarks grouped by their anchor message — one entry PER BOOKMARK, so
  // several bookmarks on the same message each survive (the capsule counts
  // them individually and the timeline shows one dot each).
  const bookmarkGroups = useMemo(() => {
    const m = new Map<string, TimelineBookmarkItem[]>();
    for (const item of bookmarkedItems ?? []) {
      const list = m.get(item.message.id);
      if (list) list.push(item);
      else m.set(item.message.id, [item]);
    }
    return m;
  }, [bookmarkedItems]);

  // Merged dash stack: every user message (gold when bookmarked) plus one
  // gold dash PER non-user bookmark, sorted by render index so the stack
  // mirrors the stream's vertical order. Bookmarks on the same message sit
  // adjacent; each hover card shows that bookmark's own excerpt.
  const dashes = useMemo<DashEntry[]>(() => {
    const out: DashEntry[] = [];
    for (const m of userMessages) {
      const group = bookmarkGroups.get(m.id);
      out.push({
        key: m.id,
        message: m,
        index: userItemIndices?.get(m.id) ?? group?.[0]?.index ?? -1,
        bookmarked: !!group,
        // A single bookmark's excerpt is a useful hover summary; with
        // several, the full message text reads better than an arbitrary one.
        excerpt: group?.length === 1 ? group[0].excerpt : undefined,
        title: group?.length === 1 ? group[0].title : undefined,
      });
    }
    for (const items of bookmarkGroups.values()) {
      if (items[0].message.role === "user") continue; // already a dash above
      for (const item of items) {
        out.push({
          key: `bm-${item.bookmarkId}`,
          message: item.message,
          index: item.index,
          bookmarked: true,
          excerpt: item.excerpt,
          title: item.title,
        });
      }
    }
    out.sort((a, b) => a.index - b.index);
    return out;
  }, [userMessages, bookmarkGroups, userItemIndices]);

  // LegendList virtualizes the chat body, but not its independent timeline.
  // Thousands of user turns used to mount thousands of ClickableRow controls
  // and per-row memo hooks in a 70vh strip. Keep every target in the scroll
  // range while only mounting the markers near the visible viewport.
  const stripRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(720);
  const [focusedDashKey, setFocusedDashKey] = useState<string | null>(null);
  const windowed = dashes.length > TIMELINE_WINDOW_THRESHOLD;
  useLayoutEffect(() => {
    if (!windowed) return;
    const track = stripRef.current;
    if (!track) return;
    const measure = () => {
      const height = track.clientHeight;
      setViewportHeight(previous => height > 0 && previous !== height ? height : previous);
      setScrollTop(previous => previous !== track.scrollTop ? track.scrollTop : previous);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(track);
    return () => {
      observer?.disconnect();
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [windowed, dashes.length]);

  const range = timelineDashWindow(dashes.length, scrollTop, viewportHeight);
  const dashIndexByKey = useMemo(
    () => new Map(dashes.map((dash, index) => [dash.key, index] as const)),
    [dashes],
  );
  const focusedDashIndex = focusedDashKey === null ? null : dashIndexByKey.get(focusedDashKey) ?? null;
  const validFocusedDashIndex = focusedDashIndex !== null &&
    focusedDashIndex >= 0 && focusedDashIndex < dashes.length &&
    dashes[focusedDashIndex]?.index >= 0 ? focusedDashIndex : null;
  const firstFocusableOffset = dashes.slice(range.start, range.end).findIndex(d => d.index >= 0);
  const rovingDashIndex = validFocusedDashIndex ??
    (firstFocusableOffset >= 0 ? range.start + firstFocusableOffset : null);

  // If the user scrolls the timeline with a focused marker, pin that one
  // marker in the DOM even when it leaves the visible virtual window. This
  // keeps browser focus alive; the rest of the offscreen history stays
  // unmounted.
  const visibleDashIndices = useMemo(() => {
    const indices = Array.from({ length: Math.max(0, range.end - range.start) }, (_, i) => range.start + i);
    if (windowed && validFocusedDashIndex !== null &&
        (validFocusedDashIndex < range.start || validFocusedDashIndex >= range.end)) {
      indices.push(validFocusedDashIndex);
      indices.sort((a, b) => a - b);
    }
    return indices;
  }, [range.start, range.end, windowed, validFocusedDashIndex]);

  useLayoutEffect(() => {
    if (!windowed || validFocusedDashIndex === null) return;
    const track = stripRef.current;
    const target = track?.querySelector<HTMLElement>(
      `[data-ui-timeline-dash-index="${validFocusedDashIndex}"] [role="button"]`,
    );
    target?.focus({ preventScroll: true });
  }, [windowed, validFocusedDashIndex, range.start, range.end]);

  const renderDash = (d: DashEntry, ordinal: number) => (
    <div
      key={d.key}
      data-ui-timeline-dash-index={ordinal}
      data-ui-timeline-dash-key={d.key}
      className={windowed ? "absolute left-0 top-0 w-6" : "relative w-6 shrink-0"}
      style={windowed ? { transform: `translateY(${ordinal * range.pitch}px)` } : undefined}
    >
    <TimelineDash
      message={d.message}
      active={d.message.id === activeId}
      bookmarked={d.bookmarked}
      excerpt={d.excerpt}
      title={d.title}
      canJump={d.index >= 0 && !!onJumpItem}
      tabIndex={windowed ? (ordinal === rovingDashIndex ? 0 : -1) : 0}
      onJump={() => {
        if (d.index >= 0 && onJumpItem) onJumpItem(d.message.id, d.index, d.excerpt);
      }}
    />
    </div>
  );

  if (dashes.length === 0) return null;

  return (
    /* 【UI 重建 2026-10-28】**静态时不可见，悬停聊天区才淡入。**
     *
     * 真机截图（`reference-screenshot-175pct.webp` 的正文左侧）**什么都没有** ——
     * Claude 的 AI 输出左边干干净净，没有这排刻度。
     *
     * 而 Mcode 这排 `—` 一直挂着，在深色/浅色下都形成一条干扰竖线，
     * 贴着正文左缘。这是「UI 全盘模仿 Claude」最直接的一处违背。
     *
     * ## 为什么是「隐藏」而不是「删除」
     *
     * 它不是装饰 —— 每条灰色 dash 是一个用户消息、金色是书签，
     * 点一下能跳过去。这是 Mcode 比 Claude 多出来的**导航能力**，
     * 删掉会丢功能。
     *
     * 按「Claude 有的照 Claude，没有的保留但先不抢视觉」这条规矩：
     * **功能保留，静态静音，悬停才出现**。
     *
     * 用 `group` + `group-hover` 而不是加 JS 状态：这条 nav 是
     * `absolute` + `pointer-events-none`（不占布局宽度），
     * 纯 CSS 就能做到零状态、零重渲染。 */
    <nav
      aria-label={t("chatStream.timeline.navigation")}
      className="chat-timeline-rail pointer-events-none absolute left-0 top-1/2 z-10 -translate-y-1/2"
    >
      <div
        ref={stripRef}
        data-ui-timeline-strip=""
        data-ui-timeline-windowed={windowed ? "true" : "false"}
        onScroll={windowed ? (event) => {
          const track = event.currentTarget;
          if (scrollFrameRef.current !== null) return;
          scrollFrameRef.current = window.requestAnimationFrame(() => {
            scrollFrameRef.current = null;
            setScrollTop(previous => previous !== track.scrollTop ? track.scrollTop : previous);
          });
        } : undefined}
        onFocusCapture={windowed ? (event) => {
          const wrapper = (event.target as HTMLElement).closest<HTMLElement>("[data-ui-timeline-dash-index]");
          const key = wrapper?.dataset.uiTimelineDashKey;
          if (wrapper && key) setFocusedDashKey(key);
        } : undefined}
        onBlurCapture={windowed ? (event) => {
          const next = event.relatedTarget as Node | null;
          if (!next || !event.currentTarget.contains(next)) setFocusedDashKey(null);
        } : undefined}
        onKeyDownCapture={windowed ? (event) => {
          const wrapper = (event.target as HTMLElement).closest<HTMLElement>("[data-ui-timeline-dash-index]");
          const current = Number(wrapper?.dataset.uiTimelineDashIndex);
          if (!wrapper || !Number.isInteger(current)) return;
          const key = event.key;
          if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(key)) return;
          event.preventDefault();
          event.stopPropagation();
          const track = event.currentTarget;
          const pageStep = Math.max(1, Math.floor((track.clientHeight || viewportHeight) / range.pitch) - 2);
          let target = current;
          let direction = 0;
          if (key === "Home") target = 0;
          else if (key === "End") target = dashes.length - 1;
          else if (key === "ArrowUp") { target = current - 1; direction = -1; }
          else if (key === "ArrowDown") { target = current + 1; direction = 1; }
          else if (key === "PageUp") { target = current - pageStep; direction = -1; }
          else if (key === "PageDown") { target = current + pageStep; direction = 1; }
          target = Math.max(0, Math.min(dashes.length - 1, target));
          if (dashes[target]?.index < 0) {
            const step = direction || (key === "Home" ? 1 : -1);
            while (target >= 0 && target < dashes.length && dashes[target]?.index < 0) target += step;
            target = Math.max(0, Math.min(dashes.length - 1, target));
          }
          if (dashes[target]?.index < 0) return;
          setFocusedDashKey(dashes[target]!.key);
          const targetTop = target * range.pitch;
          let nextTop = track.scrollTop;
          if (targetTop < track.scrollTop) nextTop = targetTop;
          else if (targetTop + range.pitch > track.scrollTop + track.clientHeight) {
            nextTop = targetTop + range.pitch - track.clientHeight;
          }
          if (nextTop !== track.scrollTop) {
            track.scrollTop = Math.max(0, nextTop);
            setScrollTop(track.scrollTop);
          }
        } : undefined}
        className="pointer-events-auto flex max-h-[70vh] flex-col items-center justify-start gap-1.5 overflow-y-auto overflow-x-visible py-1 [scrollbar-width:thin]"
      >
        {windowed ? (
          <div className="relative w-6 shrink-0" style={{ height: range.totalHeight }}>
            {visibleDashIndices.map(index => renderDash(dashes[index]!, index))}
          </div>
        ) : dashes.map((d, index) => renderDash(d, index))}
      </div>
    </nav>
  );
}

/** A single timeline dash with its hover-revealed detail card. */
function TimelineDash({
  message,
  active,
  bookmarked,
  excerpt,
  title,
  canJump,
  tabIndex,
  onJump,
}: {
  message: ChatMessage;
  active: boolean;
  /** Carries a bookmark → gold, slightly thicker dash. */
  bookmarked: boolean;
  /** Bookmark excerpt shown in the hover card instead of the full text. */
  excerpt?: string;
  /** Renamed bookmark's display title (hover card headline). */
  title?: string | null;
  canJump: boolean;
  tabIndex: number;
  onJump: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [previewPos, setPreviewPos] = useState({ left: 8, top: 8 });
  const { t } = useI18n();
  const summary = useMemo(() => (title || excerpt?.slice(0, 140) ||
    timelineAccessibleSummary(message.blocks, t) ||
    t("chatStream.timeline.noText")).slice(0, 140), [title, excerpt, message.blocks, t]);
  // Keep an accessible name on every dash, but defer expensive 1200-char
  // tooltip formatting until hover / keyboard focus. Large conversations can
  // have hundreds of timeline dashes even though LegendList virtualizes the
  // message rows underneath them.
  const text = useMemo(() => !hovered ? "" : excerpt
    ? truncateTimelineExcerpt(excerpt)
    : timelineBlocksPreview(message.blocks, t), [hovered, excerpt, message.blocks, t]);
  // A long conversation needs its timeline to scroll. The hover preview must
  // therefore live outside that scroll viewport or it gets clipped. Measure
  // both the dash and portal card, and keep it within the active window.
  useLayoutEffect(() => {
    if (!hovered || !anchorRef.current || !previewRef.current) return;
    const measure = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const preview = previewRef.current;
      if (!anchor || !preview) return;
      const next = timelinePreviewPosition(anchor, preview.offsetWidth, preview.offsetHeight,
        window.innerWidth, window.innerHeight);
      setPreviewPos((old) => old.left === next.left && old.top === next.top ? old : next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (previewRef.current) observer?.observe(previewRef.current);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [hovered, text, title]);

  return (
    // 【MC-049】刻度点击跳到该消息 —— 键盘也要能跳(共享 ClickableRow)。
    // onFocus/onBlur 与 hover 同源:hover 卡在键盘聚焦时也要出现,否则聚焦一个
    // 纯色块没有任何提示。鼠标离开/失焦都收起。aria-label 用预览正文当名字
    // (纯色刻度自身无文本,读屏无从念起)。
    <ClickableRow
      className="relative flex min-h-6 min-w-6 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-btn-xs)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      disabled={!canJump}
      tabIndex={tabIndex}
      aria-label={t("chatStream.timeline.jumpTo", { time: fmtClock(message.createdAt), text: summary })}
      onMouseEnter={(e) => { anchorRef.current = e.currentTarget; setHovered(true); }}
      onMouseLeave={() => setHovered(false)}
      onFocus={(e) => { anchorRef.current = e.currentTarget; setHovered(true); }}
      onBlur={() => setHovered(false)}
      onClick={onJump}
    >
      {bookmarked ? (
        // Bookmark: gold, a touch thicker than the gray user dashes so the
        // color-only rule ("gold = bookmark") also reads by weight.
        <span
          className={cn(
            "block h-[3px] rounded-full bg-warning transition-all",
            hovered ? "w-4" : "w-3.5",
          )}
        />
      ) : (
        <span
          className={cn(
            "block h-0.5 rounded-full transition-all",
            active ? "w-4 bg-accent" : hovered ? "w-4 bg-info" : "w-3 bg-content-subtle/60",
          )}
        />
      )}
      {hovered && createPortal(
        <div
          ref={previewRef}
          data-ui-timeline-preview=""
          aria-hidden="true"
          style={{ position: "fixed", left: previewPos.left, top: previewPos.top }}
          className={cn(
            "pointer-events-none z-[80] max-h-[calc(100vh-16px)] w-[min(18rem,calc(100vw-16px))] overflow-y-auto",
            "rounded-[var(--radius-btn-xs)] border border-edge bg-surface p-3 shadow-[var(--shadow-popover)]",
          )}
        >
          <div className="mb-1.5 flex items-center gap-1.5 border-b border-edge pb-1.5">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                bookmarked ? "bg-warning" : active ? "bg-accent" : "bg-info",
              )}
            />
            <span className="text-[11px] tabular-nums text-content-muted">
              {fmtClock(message.createdAt)}
            </span>
            {active && !bookmarked && (
              <span className="ml-auto rounded bg-accent/15 px-1 text-[9px] text-accent">{t("chatStream.timeline.current")}</span>
            )}
          </div>
          {title && (
            <div className="mb-1 flex items-center gap-1">
              <IconBookmark size={10} className="shrink-0 text-warning" />
              <span className="truncate text-[11px] font-medium text-warning">{title}</span>
            </div>
          )}
          <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-content">
            {text || <span className="text-content-subtle">{t("chatStream.timeline.noText")}</span>}
          </div>
        </div>,
        document.body,
      )}
    </ClickableRow>
  );
}
