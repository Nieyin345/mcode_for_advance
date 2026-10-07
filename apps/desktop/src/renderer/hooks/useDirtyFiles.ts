import { useSyncExternalStore } from "react";
import { ideDirtyTracker } from "@renderer/lib/ideDirty.js";

/** Hook returning the current set of dirty file paths. Re-renders the caller
 *  when the set changes. Shared by the classic and unified tab bars, which
 *  show the same dirty dots on their file tabs and guard their close actions.
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
