/** REA ContainerResponsiveBar breakpoints: 576 / 480 / 384 / 320px. */
export type ComposerFluidTier = "full" | "medium" | "narrow" | "tight" | "micro";
export function composerFluidTier(width: number): ComposerFluidTier {
  if (width < 320) return "micro";
  if (width < 384) return "tight";
  if (width < 480) return "narrow";
  if (width < 576) return "medium";
  return "full";
}
