import { PANEL_SCHEME } from "@contracts/customUiPanel";
/** CSP belongs to Mcode's renderer document, not to every response in the
 * default session. In particular, keep Document Server iframe headers intact. */
export function desktopCsp(requestUrl: string, rendererUrl: string, officeOrigin = ""): string | null {
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
  let office = "";
  try {
    const url = new URL(officeOrigin);
    if (url.protocol === "http:" || url.protocol === "https:") office = ` ${url.origin}`;
  } catch { /* not configured */ }
  return `default-src 'self'${office}; script-src 'self' 'wasm-unsafe-eval'${office}; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'${office}; img-src 'self' data: blob:${office}; font-src 'self' data:${office}; frame-src 'self' ${PANEL_SCHEME}:${office}; connect-src 'self' blob:${office}`;
}
