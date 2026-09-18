/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 真的那个会拉起 SDK 子进程。
 *
 * 这个套件不碰引擎:要验的是**挂载时推了几条 composer:attach**。而
 * `library/broadcast.ts` 从 RuntimeManager 引了 `emitExternal`(导入条目时发一条
 * "库里有新东西"的事件),那条链被 fileImport 带进来了 —— 库外路径要导入成 linked
 * 条目,所以这里躲不开。记下来,不转发。
 */
import type { RuntimeEvent } from "@contracts/runtime";

export const externals: RuntimeEvent[] = [];

export const runtimeManager = {
  emitExternal(event: RuntimeEvent): void {
    externals.push(event);
  },
  subscribe(): () => void {
    return () => {};
  },
};

export function resetExternals(): void {
  externals.length = 0;
}
