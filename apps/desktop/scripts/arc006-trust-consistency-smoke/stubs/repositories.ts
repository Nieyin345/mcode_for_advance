/** Pure in-memory SettingRepo for trust consistency; never touches user data. */
const state = new Map<string,string>();
let afterNextGet: { key: string; replacement: string } | null = null;
let beforeNextMutation: { key: string; replacement: string } | null = null;
export function changeBeforeNextWrite(key: string, replacement: string): void {
  beforeNextMutation = { key, replacement };
}
function mutateBeforeWrite(key: string): void {
  if (beforeNextMutation?.key === key) {
    state.set(key, beforeNextMutation.replacement);
    beforeNextMutation = null;
  }
}
/** Simulate a second writer changing the record while approval reads it. */
export function changeAfterNextRead(key: string, replacement: string): void {
  afterNextGet = { key, replacement };
}
export const SettingRepo = {
  get(key: string): string | null {
    const value = state.get(key) ?? null;
    if (afterNextGet?.key === key) {
      state.set(key, afterNextGet.replacement);
      afterNextGet = null;
    }
    return value;
  },
  set(key: string, value: string): void {
    mutateBeforeWrite(key);
    state.set(key, value);
  },
  compareAndSet(key: string, expected: string | null, next: string): boolean {
    // Simulates a second writer before SQLite's single conditional statement.
    mutateBeforeWrite(key);
    if ((state.get(key) ?? null) !== expected) return false;
    state.set(key, next);
    return true;
  },
  clear(): void { state.clear(); afterNextGet = null; beforeNextMutation = null; },
};
