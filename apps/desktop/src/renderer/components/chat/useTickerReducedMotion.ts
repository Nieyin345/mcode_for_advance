import { useSyncExternalStore } from "react";

/** ARC-005: app preference takes priority over operating-system motion. */
export function resolveTickerReducedMotion(attribute: string | null, systemReduced: boolean): boolean {
  if (attribute === "true") return true;
  if (attribute === "false") return false;
  return systemReduced;
}

const QUERY = "(prefers-reduced-motion: reduce)";

export function tickerMotionSnapshot(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const attribute = document.documentElement.getAttribute("data-reduce-motion");
  const systemReduced = typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches;
  return resolveTickerReducedMotion(attribute, systemReduced);
}

export function subscribeTickerMotion(notify: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const media = typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
  media?.addEventListener("change", notify);
  const observer = typeof MutationObserver !== "undefined"
    ? new MutationObserver(notify)
    : null;
  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-reduce-motion"],
  });
  return () => {
    observer?.disconnect();
    media?.removeEventListener("change", notify);
  };
}

/** React subscription, not a one-time OS snapshot.
 * Handles OS toggles and Mcode's explicit on/off in the same mounted ticker.
 */
export function useTickerReducedMotion(): boolean {
  return useSyncExternalStore(subscribeTickerMotion, tickerMotionSnapshot, () => false);
}
