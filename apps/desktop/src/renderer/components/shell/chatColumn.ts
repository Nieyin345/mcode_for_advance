/**
 * 【UI 重建】**Claude Code 页的列覆盖模型** —— 替代原来的「左栏 + 中栏 + 右栏同时并存」。
 *
 * ## 从本机 Claude 3.1623.4.0 读到的真实结构
 *
 * 三个 `data-chat-column` 值，是**同一块区域的不同层**，不是三栏：
 *
 * | 值 | 是什么 | 何时可见 |
 * |---|---|---|
 * | `project` | 项目首页（该项目的会话列表 / 起点卡片） | 没选中具体会话时 |
 * | `thread` | 单个会话（消息流 + composer） | 选中会话后**盖住** project 列 |
 * | `loading` | 骨架 | 会话加载中 |
 *
 * 被盖住的那列不是卸载，而是 **`inert` + `data-covered`**：
 * 保留 DOM（滚动位置、草稿、Monaco 都不丢），只是退出 Tab 序与指针命中。
 * 这是 Claude 的 `data-covered` 与 `inert` 用法（见其 bundle 里
 * `"data-covered":na?"":void 0` + `inert:na&&!oa`）。
 *
 * ## 为什么必须照这个模型
 *
 * 旧的 Mcode 是「左栏 + 中栏 + 右栏」三块各自独立、同时可见。Claude 是
 * 「一列盖一列」——**同一时间只有一块内容在视觉中心**。这决定了两者看起来完全不同：
 * 旧版永远三栏挤在一起，新版任何时刻只有一个主工作面。
 *
 * ## 状态从哪来
 *
 * 不新增 store 字段。映射自现有 Mcode 状态：
 *  - `activeSessionId == null` → `project`
 *  - 有 `activeSessionId` 且该会话的消息还在加载 → `loading`
 *  - 否则 → `thread`
 *
 * 这样零业务改动，纯粹是呈现层。
 */

/** Claude 的三个列。顺序即栈序：后面的盖前面的。 */
export type ChatColumn = "project" | "thread" | "loading";

export interface ChatColumnInput {
  /** 当前是否有选中的会话。 */
  hasActiveSession: boolean;
  /** 该会话的首屏消息是否还在加载。 */
  isLoadingThread: boolean;
}

/**
 * 计算当前该显示哪一列。
 *
 * **加载态优先于 thread**：Claude 的 `loading` 是第三列而不是 thread 的内部状态，
 * 因为骨架要盖住当时的 `project` 列，而不是盖住一个还没内容可显示的 thread。
 */
export function chatColumnOf(input: ChatColumnInput): ChatColumn {
  if (!input.hasActiveSession) return "project";
  if (input.isLoadingThread) return "loading";
  return "thread";
}

/** 某列是否被后面某一列盖住。被盖住时应当 `inert` 并标 `data-covered`。 */
export function isCovered(column: ChatColumn, active: ChatColumn): boolean {
  const order: ChatColumn[] = ["project", "loading", "thread"];
  return order.indexOf(column) < order.indexOf(active);
}

/**
 * 侧栏在每一列下是否应当收起。
 *
 * Claude 的 Code 页在 `thread` 列下**仍保留侧栏**（并行会话列表是它的核心卖点），
 * 所以这里恒为 false —— 但保留这个函数，是为了把「要不要收起」变成一个
 * 有名字、可被单独推翻的决定，而不是散在 JSX 里。
 */
export function sidebarCollapsedIn(_column: ChatColumn): boolean {
  return false;
}
