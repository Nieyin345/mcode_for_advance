import { useLayoutEffect, useRef, useState } from "react";

/**
 * Composer action-row compactness tier (prototypes/composer-redesign.html
 * 方案 B · 迷你药丸, single-pill revision). The mini pill is the ONLY inline
 * presentation of the session-config controls — attach "+", model, effort,
 * permission and the context ring all live in it at EVERY width. The tier
 * only decides how compact it renders; the pill itself never folds away
 * ("随着卡片变窄仍保持显示" — the + and the ring stay visible throughout).
 *
 *   0 — pill expanded (segment labels + ring percentage visible)
 *   1 — pill compact (labels collapse to icons + level bars + color dot; the
 *       + and the ring persist, the ring's % number collapses)
 *
 * `forceCollapsed` (the side-chat panel / phone shell) skips measuring and
 * pins tier 1 — but the caller renders the single-icon toggle instead of the
 * pill there, so "collapsed hosts" keep the vertical-settings popup entry.
 */
export type ComposerRowTier = 0 | 1;

/** Card-width threshold under which the pill renders compact. Above it the
 *  pill stays expanded, but measured overflow can still promote (long labels
 *  — locale switches, long model ids — overflow the row before the
 *  threshold does). */
const COMPACT_BELOW_PX = 560;

/** After a promotion, the card must widen by at least this many px before
 *  the pill expands back — without hysteresis the decision flaps on every
 *  pixel around the boundary. */
const RESHOW_SLACK_PX = 24;

export function useComposerRowFit(forceCollapsed = false) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  /** The composer card (the rounded input box) — the element whose width the
   *  COMPACT_BELOW_PX threshold is measured against. Attached by the caller
   *  to the card container so the decision tracks the box the user sees. */
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [tier, setTier] = useState<ComposerRowTier>(forceCollapsed ? 1 : 0);
  /** Card width at which the LAST overflow promotion happened; re-expanding
   *  requires clearing this + RESHOW_SLACK_PX. */
  const collapseAtRef = useRef(0);
  const overflowCollapsedRef = useRef(false);

  useLayoutEffect(() => {
    // Forced-compact hosts: no measuring, no observer.
    if (forceCollapsed) return;

    const row = rowRef.current;
    if (!row) return;

    const measure = () => {
      const card = cardRef.current;
      if (!card) return;
      let next: ComposerRowTier = card.clientWidth < COMPACT_BELOW_PX ? 1 : 0;
      // The overflow gate only holds the expansion back to the FULL pill:
      // an overflow promotion proves the expanded labels don't fit below
      // collapseAt, so re-expanding needs the slack; the compact pill bounds
      // its own width and is never gated.
      if (
        next === 0 &&
        tier === 1 &&
        overflowCollapsedRef.current &&
        card.clientWidth <= collapseAtRef.current + RESHOW_SLACK_PX
      ) {
        next = 1;
      } else if (next === 0) {
        overflowCollapsedRef.current = false;
      }
      // Measured fit at tier 0: freeze the pill at its natural (label) width
      // and check whether the row overflows — labels differ by locale and
      // selected value, so only content can tell. All style changes are
      // restored synchronously, so nothing paints mid-measure. The compact
      // pill truncates its own labels and can't overflow, so it's exempt.
      if (next === 0) {
        const pill = row.querySelector<HTMLElement>(".composer-minipill");
        const chips = pill?.parentElement;
        if (pill && chips && pill.offsetWidth > 0) {
          const prevMinWidth = pill.style.minWidth;
          const prevWrap = row.style.flexWrap;
          const prevChipsMin = chips.style.minWidth;
          pill.style.minWidth = "max-content";
          row.style.flexWrap = "nowrap";
          // ⚠️ **量的是"整行放不放得下",而药丸住在 `.composer-chips` 里。**
          // 那个容器是 `flex-1 min-w-0` —— `min-width: 0` 会让它**被压到比内容还窄
          // 却不溢出整行**,长度全被药丸内部那些 `shrink-1` 的标签吃掉(表现是标签
          // 被截成 `Defaul` 这种)。只量整行的 `scrollWidth` **看不到这种情况**,
          // 于是该收缩时不收缩、标签一直被截 —— 用户报的"挤在一起"就是这个。
          //
          // 所以把容器的 `min-width` 也临时放开,让药丸的真实宽度**顶到整行上**:
          // 那样 `row.scrollWidth` 才如实反映"这行到底放不放得下"。
          chips.style.minWidth = "max-content";
          const rowOverflows = row.scrollWidth > row.clientWidth + 1;
          // 补一道**直接的**判据:药丸有没有被它的容器挤窄(容器比药丸窄)。
          // 这一条挡的是上面那种"整行没溢出、但药丸已经被截"的情况。
          const pillSqueezed = chips.clientWidth + 1 < pill.scrollWidth;
          pill.style.minWidth = prevMinWidth;
          row.style.flexWrap = prevWrap;
          chips.style.minWidth = prevChipsMin;
          if (rowOverflows || pillSqueezed) {
            overflowCollapsedRef.current = true;
            collapseAtRef.current = card.clientWidth;
            next = 1;
          }
        }
      }
      if (next !== tier) setTier(next);
    };

    // Observe the row (pane/sidebar resizes), the pill itself (locale
    // switches / value selections change its natural width without resizing
    // the row), and the card (the threshold reads its width).
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    if (cardRef.current) ro.observe(cardRef.current);
    const pill = row.querySelector<HTMLElement>(".composer-minipill");
    if (pill) ro.observe(pill);
    measure();
    return () => ro.disconnect();
  }, [tier, forceCollapsed]);

  return { rowRef, cardRef, tier };
}
