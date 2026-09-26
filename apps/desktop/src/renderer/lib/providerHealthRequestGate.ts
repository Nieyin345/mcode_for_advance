/** Per-provider generation gate for async probes. A newer request invalidates
 * older completions for the same provider without affecting other providers. */
export function createProviderHealthRequestGate() {
  const latestByProvider = new Map<string, number>();

  return {
    begin(providerId: string): number {
      const generation = (latestByProvider.get(providerId) ?? 0) + 1;
      latestByProvider.set(providerId, generation);
      return generation;
    },
    isLatest(providerId: string, generation: number): boolean {
      return latestByProvider.get(providerId) === generation;
    },
  };
}
