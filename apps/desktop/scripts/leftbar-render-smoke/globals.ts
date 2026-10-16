// SSR 探针的最小窗口桩：LeftBar 那一族只读 `window.api` / `matchMedia` 之类。
const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.window === "undefined") {
  const win: Record<string, unknown> = {
    api: new Proxy({}, { get: () => async () => ({ ok: true }) }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    location: { href: "http://localhost/", pathname: "/", search: "" },
    navigator: { platform: "Linux", userAgent: "node" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  win.window = win;
  g.window = win;
}
if (typeof g.document === "undefined") {
  g.document = {
    documentElement: { classList: { add() {}, remove() {}, contains: () => false } },
    body: { classList: { add() {}, remove() {} }, appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {} } }),
  };
}
export {};
