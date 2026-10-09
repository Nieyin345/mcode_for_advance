/**
 * Browser globals the renderer session store touches while its module graph
 * evaluates. Imported FIRST by main.ts — ES module evaluation order guarantees
 * these land before `lib/api.ts` runs its `window.api ?? createWebApi()`.
 *
 * Most methods are await-safe no-ops; sendTurn can be overridden to test a
 * failed phone RPC / desktop IPC without opening a provider or real database.
 */
const asyncNoop = (): Promise<undefined> => Promise.resolve(undefined);

let sendTurnStub: ((input: unknown) => Promise<unknown>) | null = null;
let sessionMessagesStub: ((input: unknown) => Promise<unknown>) | null = null;
let skillsListStub: ((input: unknown) => Promise<unknown>) | null = null;
let truncateStub: ((input: unknown) => Promise<unknown>) | null = null;
let interruptStub: ((input: unknown) => Promise<unknown>) | null = null;
let updateSettingsStub: ((input: unknown) => Promise<unknown>) | null = null;
let updateBookmarksStub: ((input: unknown) => Promise<unknown>) | null = null;
export function setSendTurnStub(fn: ((input: unknown) => Promise<unknown>) | null): void {
  sendTurnStub = fn;
}
export function setSessionMessagesStub(fn: ((input: unknown) => Promise<unknown>) | null): void {
  sessionMessagesStub = fn;
}
/** 覆盖 `skills.list`(验 reloadSkills 的旧回包竞态用)。 */
export function setSkillsListStub(fn: ((input: unknown) => Promise<unknown>) | null): void {
  skillsListStub = fn;
}
/** 覆盖 `session.truncateAndInsertMessages`(验"编辑重发的落库失败要报出来")。 */
export function setTruncateStub(fn: ((input: unknown) => Promise<unknown>) | null): void {
  truncateStub = fn;
}
/** 覆盖 `claude.interrupt`(验"点停止时 IPC 失败不能把界面钉在运行中")。 */
export function setInterruptStub(fn: ((input: unknown) => Promise<unknown>) | null): void {
  interruptStub = fn;
}
/** 覆盖 `session.updateSettings`(验 moveSession 目录切换被拒要报出来)。 */
export function setUpdateSettingsStub(fn: ((input: unknown) => Promise<unknown>) | null): void {
  updateSettingsStub = fn;
}
/** 覆盖 `session.updateBookmarks`(验书签落库失败要报出来)。 */
export function setUpdateBookmarksStub(fn: ((input: unknown) => Promise<unknown>) | null): void {
  updateBookmarksStub = fn;
}

function deepApiStub(path: string[] = []): unknown {
  return new Proxy(asyncNoop, {
    get: (_target, prop) => {
      if (prop === "then") return undefined;
      if (prop === "constructor") return Object;
      return deepApiStub([...path, String(prop)]);
    },
    apply: (_target, _this, args: unknown[]) =>
      path.join(".") === "claude.sendTurn" && sendTurnStub
        ? sendTurnStub(args[0])
        : path.join(".") === "session.messages" && sessionMessagesStub
          ? sessionMessagesStub(args[0])
          : path.join(".") === "session.truncateAndInsertMessages" && truncateStub
            ? truncateStub(args[0])
          : path.join(".") === "claude.interrupt" && interruptStub
            ? interruptStub(args[0])
          : path.join(".") === "session.updateSettings" && updateSettingsStub
            ? updateSettingsStub(args[0])
          : path.join(".") === "session.updateBookmarks" && updateBookmarksStub
            ? updateBookmarksStub(args[0])
          : path.join(".") === "skills.list" && skillsListStub
            ? skillsListStub(args[0])
            : Promise.resolve(undefined),
  });
}

const localStorageMap = new Map<string, string>();

const globalWindow = {
  api: deepApiStub(),
  mcodeElectron: true,
};

const globalTarget = globalThis as unknown as Record<string, unknown>;
// Node exposes `navigator` only from v21 on (and as a getter there), so define
// it defensively instead of assigning — ESM is strict mode, so writing to a
// getter-only global would throw.
if (typeof (globalThis as unknown as { navigator?: unknown }).navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "McodeSmoke", maxTouchPoints: 0 },
    configurable: true,
    writable: true,
  });
}
globalTarget.window = globalWindow;
globalTarget.document = {
  documentElement: { setAttribute: () => {}, lang: "zh" },
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
