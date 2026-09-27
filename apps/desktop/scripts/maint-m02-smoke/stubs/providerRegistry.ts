/** Fake provider: records fork requests and never contacts an external model. */
export interface FakeProvider {
  id: string;
  calls: Array<{ providerSessionId: string; cwd: string; title: string }>;
  forkSession?: (providerSessionId: string, options: { cwd: string; title: string }) => Promise<string>;
}

let current: FakeProvider | null = null;
export function setFakeProvider(provider: FakeProvider): void {
  current = provider;
}

export const providerRegistry = {
  resolve(id: string): FakeProvider {
    if (!current || current.id !== id) return { id, calls: [] };
    return current;
  },
};
