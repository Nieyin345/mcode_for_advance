/**
 * Copy text to the clipboard, with a fallback for non-secure contexts.
 *
 * The mobile shell is served over plain HTTP on the LAN, where
 * `navigator.clipboard` is undefined (clipboard API requires a secure
 * context). Fall back to the legacy hidden-textarea + execCommand path so
 * copy affordances keep working on the phone.
 *
 * Returns whether the copy succeeded — callers use it to toggle a brief
 * "已复制" confirmation instead of surfacing an error toast.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path (write can still be denied by the
      // platform even in a secure context)
    }
  }
  // The legacy copy fallback steals focus for its hidden textarea. Preserve
  // the user's focused editor/composer/button so keyboard input continues
  // working immediately after copy, without scrolling its pane into view.
  const previousFocus = document.activeElement as HTMLElement | null;
  let ta: HTMLTextAreaElement | null = null;
  try {
    ta = document.createElement("textarea");
    ta.value = text;
    // Position off the visible area but keep it focusable/selectable —
    // `display:none` and `visibility:hidden` both break execCommand copy.
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    // Some platforms throw from execCommand. Never strand a focusable
    // invisible textarea in the document on a denied/failed copy.
    ta?.remove();
    if (previousFocus?.isConnected && typeof previousFocus.focus === "function") {
      try { previousFocus.focus({ preventScroll: true }); } catch { /* restore best-effort */ }
    }
  }
}
