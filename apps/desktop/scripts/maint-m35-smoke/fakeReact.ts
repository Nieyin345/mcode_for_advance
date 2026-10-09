/**
 * 给 maint-m35 的 pickers 用例用的极小 React 运行时 —— 需要有**真状态**的
 * `useState`/`useEffect`(LibraryPicker 靠 effect 触发拉条目、ItemNotes 靠 effect
 * 触发拉笔记),与 preview-panel-smoke 那份同一个形状。这里只做一次转发,
 * 避免同一套运行时维护两份漂移。
 */
export * from "../preview-panel-smoke/fakeReact.js";
