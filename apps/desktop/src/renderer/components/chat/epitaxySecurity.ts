/** Epitaxy's seven artifact MIME variants, routed without executing code by default. */
export const EPITAXY_MIMES = [
  "application/vnd.ant.react",
  "application/vnd.ant.code",
  "application/vnd.ant.markdown",
  "application/vnd.ant.mermaid",
  "application/vnd.ant.svg",
  "application/vnd.ant.html",
  "application/vnd.ant.latex",
] as const;
export type EpitaxyMime = (typeof EPITAXY_MIMES)[number];
export type EpitaxyRoute = "frame" | "text" | "unsupported";

/** Only HTML and SVG require an opaque-origin iframe. Never interpret JSX,
 * Markdown, Mermaid or LaTeX as executable HTML in the host renderer. */
export function epitaxyRoute(mime: string): EpitaxyRoute {
  if (mime === "application/vnd.ant.html" || mime === "application/vnd.ant.svg") return "frame";
  return EPITAXY_MIMES.some((entry) => entry === mime) ? "text" : "unsupported";
}

/**
 * Gate sandbox-origin messages before invoking host capabilities.
 * MessageEvent.userActivation is not universally implemented in Chromium.
 * NO navigator.userActivation.hasBeenActive fallback: it is a sticky bit for
 * an unrelated host click, not proof that THIS frame message was user-initiated.
 * When native provenance is absent, reject the privileged command.
 */
export function epitaxyHostCommandAllowed(event: {
  isTrusted: boolean;
  origin: string;
  userActivation?: { isActive?: boolean };
}): boolean {
  return event.isTrusted === true &&
    event.origin === "null" &&
    event.userActivation?.isActive === true;
}
