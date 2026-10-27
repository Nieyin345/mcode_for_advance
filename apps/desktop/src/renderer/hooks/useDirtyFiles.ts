import { useSyncExternalStore } from "react";
import { ideDirtyTracker } from "@renderer/lib/ideDirty.js";

/** Hook returning file paths with unsaved Mcode/Monaco text edits. Re-renders
 *  the caller when that set changes. Native document editors own their own
 *  save/discard guard and are closed asynchronously before the tab is removed.
 *
 *  ⚠️ 订阅跑在 React 里，所以这个钩子单独一个模块 —— `lib/ideDirty.ts` 被 store
 *  引用（纯 node 的 smoke 会跑它），那里不许出现 React。 */
export function useDirtyFiles(): ReadonlySet<string> {
  // 快照每次变更都换新引用，`Object.is` 才判得出变化 —— 见 `ideDirtyTracker.set`。
  return useSyncExternalStore(
    ideDirtyTracker.subscribe,
    () => ideDirtyTracker.snapshot(),
    () => ideDirtyTracker.snapshot(),
  );
}
