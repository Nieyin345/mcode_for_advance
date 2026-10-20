/**
 * 【ARC-005 V2】**View Transition 封装** —— 复用 `open-claude-ui` 的
 * `useClaudeSharedElementTransition.ts` 背后的平台能力（View Transitions API，
 * Chromium 111+，Electron 44 自带），但**不引入 framer-motion**。
 *
 * 上游用它做"会话/面板切换时的共享元素过渡"。Mcode 的硬约束是：
 * **PTY / Monaco / Tiptap 草稿必须全程挂载**（见 ClassicShell 文件头）——
 * 所以这里只包一层 `document.startViewTransition`，让浏览器对**同一棵已挂载
 * 子树**的 class 变化做快照过渡，绝不触发 React 卸载。
 *
 * 降级：不支持 `startViewTransition` 的引擎（或用户开了减少动效）直接同步
 * 执行回调，行为与今天完全一致。
 */

/** 减少动效总闸（应用内属性）+ 系统偏好，两者任一成立就不做过渡。 */
function prefersReducedMotion(): boolean {
  if (typeof document === "undefined") return true;
  if (document.documentElement.getAttribute("data-reduce-motion") === "true") return true;
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => { finished: Promise<void> };
};

/**
 * 在浏览器支持的平台上，用 View Transition 包裹一次**同步的** DOM/state 更新。
 *
 * 要求 `update` 是同步的（只做 setState / class 切换）。异步工作（读 RPC、
 * 加载历史）必须放在过渡之外先做完 —— 否则快照会拍到"加载中"。
 */
export function withViewTransition(update: () => void): void {
  if (typeof document === "undefined" || prefersReducedMotion()) {
    update();
    return;
  }
  const doc = document as ViewTransitionDocument;
  if (typeof doc.startViewTransition !== "function") {
    update();
    return;
  }
  try {
    doc.startViewTransition(update).finished.catch(() => {
      /* 过渡被用户操作打断是正常现象；更新已经发生，不需要补救。 */
    });
  } catch {
    // 某些引擎在 document 不可见时抛错 —— 直接执行更新。
    update();
  }
}
