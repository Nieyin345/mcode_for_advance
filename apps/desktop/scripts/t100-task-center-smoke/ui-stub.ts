/**
 * `@renderer/components/ui/index.js` 替身 —— 转出本套用到的四个 UI 组件，全部
 * **真实现**（Button / EmptyState / ErrorNote / Skeleton）。
 *
 * ⚠️ `Button` 真实现建在 `@base-ui/react` 上，而那一族在 node 下要 DOM；build.mjs
 * 把 `@base-ui/react/button` 换成一个**真的渲染 `<button>`** 的桩（见那边 stub）
 * —— 否则按钮只是一个 `p.children`，`__nodes()` 里看不到 `onClick`，点不动。
 */
export { Button } from "@renderer/components/ui/button.js";
export { ErrorNote } from "@renderer/components/ui/error-note.js";
export { Skeleton } from "@renderer/components/ui/spinner.js";
export { EmptyState } from "@renderer/components/ui/empty-state.js";
export { Badge } from "@renderer/components/ui/badge.js";
