/**
 * `@renderer/components/ui/index.js` 的替身：只转出本套用到的四个 UI 组件，
 * 全部是**真实现**（Button / ErrorNote / Spinner / EmptyState）。
 *
 * 为什么不是通配 barrel：真 `ui/index.js` 会拉进 dialog / select / tooltip 一大串
 * `@base-ui/react` 子包，判据一个都用不到。为什么是真实文件而不是 esbuild 虚拟
 * 模块：虚拟模块没有 resolveDir，`@renderer/...` 的 tsconfig paths 解析不了。
 */
export { Button } from "@renderer/components/ui/button.js";
export { ErrorNote } from "@renderer/components/ui/error-note.js";
export { Spinner, Skeleton, LoadingNote } from "@renderer/components/ui/spinner.js";
export { EmptyState } from "@renderer/components/ui/empty-state.js";
