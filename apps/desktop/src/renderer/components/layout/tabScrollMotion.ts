/** The Mcode reduce-motion preference overrides the OS value. */
export function resolveTabScrollBehavior(
  preference: string | null,
  systemReduced: boolean,
): ScrollBehavior {
  if (preference === "true") return "auto";
  if (preference === "false") return "smooth";
  return systemReduced ? "auto" : "smooth";
}

/** Check at invocation time, not only at mount: OS and in-app prefs can
 * change while an Agent session and its tab strip stay mounted.
 */
export function tabScrollBehavior(): ScrollBehavior {
  if (typeof window === "undefined" || typeof document === "undefined") return "auto";
  const preference = document.documentElement.getAttribute("data-reduce-motion");
  const systemReduced = typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return resolveTabScrollBehavior(preference, systemReduced);
}
