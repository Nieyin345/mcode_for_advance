// `@renderer/lib/icons.js` 的替身 —— **任意图标名**都还回同一个不渲染的组件。
//
// ## 为什么是 CJS + Proxy,而不是再列一遍名字
//
// 这份桩原来是 14 个 `export const IconX = () => null`,而被测组件每加一个图标,
// esbuild 就 `No matching export in stubs/icons.ts for import "IconAlertTriangle"`
// —— **整套编译不过**,不是某条断言失败。同一类漂移在这套里已经犯过两回(react 桩缺
// createElement/forwardRef/createContext/useContext/useLayoutEffect 是另一回)。
//
// 图标对这套冒烟**没有任何观察点**:它验的是元素树的形状和异步竞态,没有一条断言看
// 图标。既然如此,"有哪些图标"就不该成为它能不能跑起来的前提。
//
// ESM 的具名导入是静态校验的,列举躲不掉;**CJS 不是** —— esbuild 会把
// `import { IconFoo } from ...` 编成一次属性读取,于是 Proxy 能兜住任意名字。
// 文件名用 `.cjs` 也顺带让它落在 tsconfig 的 include 之外,不必为一个桩写类型。
//
// ⚠️ 只兜 `Icon` 开头的名字。真从这个模块里导出的非图标东西(比如某天加一个
// `iconForKind()` 辅助函数)会照旧 `undefined` 并当场炸 —— 那种才是真该有人看见的漂移。
const noop = () => null;
module.exports = new Proxy(
  {},
  {
    get: (_target, name) =>
      typeof name === "string" && name.startsWith("Icon") ? noop : undefined,
    // esbuild / node 的 interop 会探这个,不答应的话具名导入会被判成缺失。
    has: (_target, name) => typeof name === "string" && name.startsWith("Icon"),
  },
);
