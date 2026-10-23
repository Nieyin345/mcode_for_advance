/**
 * T46 —— `@renderer/stores/sessionStore.js` 的选择器桩。
 *
 * 生产组件 `ApprovalPrompt` 只读一个字段：
 *
 * ```ts
 * const settingsOpen = useSessionStore((s) => s.settingsOpen);
 * ```
 *
 * 真 store 会拖进整棵 Zustand 依赖（IPC、路由、引擎状态），而这个套件要验的是
 * **`settingsOpen` 切换时审批卡的焦点/键盘行为**，不是 store 本身。所以这里给一份
 * 形状相同、可外部写的选择器：探针页面写 `window.__t46Store.settingsOpen`，
 * 组件下次渲染读到的就是新值。
 *
 * 与 E1（`approval-keyboard-safety-smoke`）的差异：那边恒为 `false`；这里是
 * **可变**的 —— T46 的第 3 条判据就是 `settingsOpen` 打开时卡片暂停。
 *
 * ⚠️ 只导出审批卡真正用到的形状。`getState` 一并给出，是因为同一模块的其它
 * 分支（不在本页面里）也按 store 语义调用；不实现会静默 `undefined`。
 */

type State = { settingsOpen: boolean };

const state: State = { settingsOpen: false };
(window as unknown as { __t46Store?: State }).__t46Store = state;

export const useSessionStore = <T,>(selector: (s: State) => T): T => selector(state);
useSessionStore.getState = (): State => state;
