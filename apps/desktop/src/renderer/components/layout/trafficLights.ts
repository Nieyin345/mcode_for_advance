/**
 * Derived from open-claude-ui/code-examples/ClaudeDesktopHeader.tsx.
 * CSS pixels reserved for macOS' native traffic lights. Other platforms never
 * receive this left-side inset. The sidebar has its own traffic-light row.
 */
export function trafficLightSpacerWidth(
  platform: "mac" | "windows" | "linux",
  isFullscreen: boolean,
  zoomFactor: number,
  sidebarOwnsTrafficLights: boolean,
): number {
  if (platform !== "mac" || isFullscreen || sidebarOwnsTrafficLights) return 0;
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return Math.round(74 / Math.min(zoom, 1));
}
