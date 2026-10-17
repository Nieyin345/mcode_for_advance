/**
 * Browser globals the renderer store graph touches while its module graph
 * evaluates. Imported FIRST by main.ts (ES-module evaluation order guarantees
 * these land before `lib/api.ts` runs `window.api ?? createWebApi()`).
 *
 * Same shape as scripts/session-store-smoke/prelude.ts — this suite drives the
 * REAL store (`useSessionStore.getState().init()` + `setShellPref`) rather
 * than a reimplementation, because the thing being proven is the wiring:
 * setting-table round-trip for `ui.shell`.
 */
const asyncNoop = (): Promise<undefined> => Promise.resolve(undefined);

/** Per-method overrides keyed by dot path (`setting.set`, `project.list`, …). */
const apiOverrides = new Map<string, (input: unknown) => Promise<unknown>>();
export function setApiStub(path: string, fn: ((input: unknown) => Promise<unknown>) | null): void {
  if (fn) apiOverrides.set(path, fn);
  else apiOverrides.delete(path);
}

/** Every `setting.set` call, in order — the persistence side of the round-trip. */
export const settingSetCalls: Array<{ key: string; value: string }> = [];
export function resetSettingSetCalls(): void {
  settingSetCalls.length = 0;
}

function deepApiStub(path: string[] = []): unknown {
  return new Proxy(asyncNoop, {
    get: (_target, prop) => {
      if (prop === "then") return undefined;
      if (prop === "constructor") return Object;
      return deepApiStub([...path, String(prop)]);
    },
    apply: (_target, _this, args: unknown[]) => {
      const method = path.join(".");
      const override = apiOverrides.get(method);
      if (override) return override(args[0]);
      if (method === "setting.set") {
        const input = args[0] as { key?: unknown; value?: unknown };
        if (typeof input?.key === "string" && typeof input?.value === "string") {
          settingSetCalls.push({ key: input.key, value: input.value });
        }
        return Promise.resolve(undefined);
      }
      // init()'s first-paint bulk read must return a plain object; an
      // undefined here would throw outside any try/catch further down.
      if (method === "setting.getMany") return Promise.resolve({});
      // init() schedules initDeferred in a microtask; give the store the
      // shaped empty answers it destructures so the log stays honest instead
      // of printing "failed" stack traces for calls this suite never asserts.
      if (method === "customModel.list") return Promise.resolve({ models: [], storeInvalid: false });
      if (method === "provider.list") return Promise.resolve({ providers: [] });
      if (method === "piModels.listAvailable") return Promise.resolve({ models: [] });
      if (method === "codexModels.list") return Promise.resolve({ providers: [] });
      if (method === "voice.modelList") return Promise.resolve({ selected: null, models: [] });
      if (method === "provider.healthCheck")
        return Promise.resolve({
          ok: false,
          status: "unavailable",
          providerId: (args[0] as { providerId?: string } | undefined)?.providerId ?? "smoke",
          checkedAt: Date.now(),
        });
      return Promise.resolve(undefined);
    },
  });
}

const localStorageMap = new Map<string, string>();

const globalTarget = globalThis as unknown as Record<string, unknown>;
if (typeof (globalThis as unknown as { navigator?: unknown }).navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "McodeSmoke", maxTouchPoints: 0 },
    configurable: true,
    writable: true,
  });
}
globalTarget.window = {
  api: deepApiStub(),
  // Not Electron: keeps initDeferred's desktop-only LSP/runtime block out of
  // the picture even if something schedules it.
  mcodeElectron: false,
};
globalTarget.document = {
  documentElement: {
    setAttribute: () => {},
    removeAttribute: () => {},
    lang: "zh",
    classList: { contains: () => false, add: () => {}, remove: () => {} },
    style: { setProperty: () => {}, removeProperty: () => {} },
  },
  body: { appendChild: () => {}, removeChild: () => {} },
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
};
globalTarget.localStorage = {
  getItem: (k: string) => localStorageMap.get(k) ?? null,
  setItem: (k: string, v: string) => void localStorageMap.set(k, String(v)),
  removeItem: (k: string) => void localStorageMap.delete(k),
  clear: () => localStorageMap.clear(),
  key: (i: number) => [...localStorageMap.keys()][i] ?? null,
  get length() {
    return localStorageMap.size;
  },
};
globalTarget.requestAnimationFrame = (cb: (t: number) => void) =>
  setTimeout(() => cb(Date.now()), 16) as unknown as number;
globalTarget.cancelAnimationFrame = (handle: number) => clearTimeout(handle);

export {};
