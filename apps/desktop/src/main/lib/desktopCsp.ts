import { PANEL_SCHEME } from "@contracts/customUiPanel";
/** CSP belongs to Mcode's renderer document, not to every response in the
 * default session. In particular, keep an embedded external editor's iframe
 * headers intact.
 *
 * `extraFrameOrigin` adds one trusted external origin to the policy. Production
 * no longer passes it (OnlyOffice, its only caller, was removed on 2026-10-24);
 * `editor-market-smoke`'s Electron fixture still uses it to stand up a local
 * editor origin. Keep the guard below: an invalid origin must never be able to
 * inject directives into the main renderer's policy. */
export function desktopCsp(requestUrl: string, rendererUrl: string, extraFrameOrigin = ""): string | null {
  const clean = (value: string): string => {
    // WHATWG URL parsing silently drops TAB/LF/CR and leading/trailing
    // whitespace. Comparing only the parsed result can accidentally apply
    // the privileged renderer policy to a raw URL that wasn't the expected
    // document. Refuse ambiguous forms before normalization.
    if (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error("ambiguous renderer URL");
    }
    const u = new URL(value);
    u.search = ""; u.hash = "";
    return u.href;
  };
  try { if (clean(requestUrl) !== clean(rendererUrl)) return null; }
  catch { return null; }
  let extra = "";
  try {
    const url = new URL(extraFrameOrigin);
    if (url.protocol === "http:" || url.protocol === "https:") extra = ` ${url.origin}`;
  } catch { /* not configured */ }
  return `default-src 'self'${extra}; script-src 'self' 'wasm-unsafe-eval'${extra}; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'${extra}; img-src 'self' data: blob:${extra}; font-src 'self' data:${extra}; frame-src 'self' ${PANEL_SCHEME}:${extra}; connect-src 'self' blob:${extra}`;
}
