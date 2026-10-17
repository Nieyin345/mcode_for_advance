/**
 * 【ARC-005 M1】外观偏好的**纯 DOM 应用函数**（从 `appearance.ts` 拆出的叶子）。
 *
 * ## 为什么单独一层
 *
 * `appearance.ts` 是 React hook 模块，import 了 `sessionStore`（→ 整条渲染依赖图，
 * 含 Monaco worker 的 `?worker` 导入）。无头套件只要验"设置值 → `<html>` 属性"这条
 * 纯映射，不值得把整张图拉进来 —— 与 `realPathWithin.ts` 从 `pathGuard` 拆出同一条
 * 理由（叶子模块零依赖、可被无头/其它 bundle 复用）。
 *
 * ## 它管什么
 *
 * 每个函数只做一件事：把一份已校验的设置值写到 `<html>`（或从 `<html>` 移除）。
 * 不读 store、不订阅、不判断默认值 —— 那些留给 `appearance.ts` 的 hooks。于是
 * 「写什么属性」只有一份，「什么时候写」由 React 生命周期决定。
 *
 * 纯函数、只碰 `document`。无头套件塞最小 DOM 桩即可断言。
 */
import { reduceMotionAttribute, type ChatDensity, type ReduceMotion } from "@contracts/ipc";

/** 对话紧凑度 → `<html data-chat-density>`。 */
export function applyChatDensity(mode: ChatDensity): void {
  document.documentElement.setAttribute("data-chat-density", mode);
}

/** 减弱动效偏好 → `<html data-reduce-motion>`（`"system"` = 移除属性，
 *  交给 styles.css 的 `@media (prefers-reduced-motion: reduce)` 块）。 */
export function applyReduceMotion(mode: ReduceMotion): void {
  const attr = reduceMotionAttribute(mode);
  if (attr === null) document.documentElement.removeAttribute("data-reduce-motion");
  else document.documentElement.setAttribute("data-reduce-motion", attr);
}
