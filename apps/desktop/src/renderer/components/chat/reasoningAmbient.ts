/** CDS ReasoningAmbientGlow state gate: completed thinking never animates. */
export function reasoningAmbientState(live: boolean) {
  return {
    glow: live,
    shimmer: live,
    sweep: live,
  };
}
