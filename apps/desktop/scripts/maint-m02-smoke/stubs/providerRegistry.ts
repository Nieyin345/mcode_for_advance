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
  /** 【MC-056】`sessionFork` 改用 `getRequired`。本套夹具的引擎总是"在册"(不受 id 影响),
   *  所以照 `resolve` 一样返回;真正的"未注册必须拒绝"在 session-fork-smoke 验。 */
  getRequired(id: string): FakeProvider {
    if (!current || current.id !== id) return { id, calls: [] };
    return current;
  },
};
