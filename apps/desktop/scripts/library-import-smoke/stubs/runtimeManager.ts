/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 真的那个会拉起 SDK 子进程。
 *
 * ## 为什么要换它(而不是换别的)
 *
 * 本套只需要 `library/broadcast.ts` 里的**两个信号**:
 *   - `sendToRenderer(LIBRARY_CHANGED, …)` —— 左栏那棵树重拉(见 stubs/window.ts);
 *   - `runtimeManager.emitExternal({type:"library.item.imported", …})` —— "有条目入库"
 *     的那条事件,**自动化的事件触发器与钩子唯一的信号**。
 *
 * 而真 RuntimeManager 一路拖到 `providers/registry.js` → **三个引擎实现**,三个引擎
 * 又都要 `workflows/seed.js` —— seed 的货是二十几个 `?raw` 的 `.py`/LICENSE(Vite 把
 * 它们变成字符串常量,esbuild 不认这个后缀;`LICENSE` 连后缀都没有,配 loader 也盖不住)。
 * 在 RuntimeManager 这一刀切,那整条引擎链就从被测路径上消失了 —— 与
 * `attach-links-smoke` / `session-fork-smoke` 同款做法。
 *
 * ## `emitExternal` 不是空实现
 *
 * 它是"导入成功"在库外的**唯一痕迹**:桩里记下来,冒烟才能验"每次导入都发了、发的是
 * 哪一条"。漏发就是那种"东西进库了、自动化却永远不响"的哑巴故障 —— 而这套是唯一
 * 盯得到它的地方(那条事件原来在 `fileImport` 自己手里发,见 broadcast 的注释)。
 */
import type { RuntimeEvent } from "@contracts/runtime";

/** 按顺序记下发出去的每条外部事件。 */
export const externals: RuntimeEvent[] = [];

export function resetExternals(): void {
  externals.length = 0;
}

/** 其中"有条目入库"的那些 —— 断言主要看这个。 */
export function importedIds(): string[] {
  return externals
    .filter((e) => e.type === "library.item.imported")
    .map((e) => (e as { itemId: string }).itemId);
}

export const runtimeManager = {
  emitExternal(event: RuntimeEvent): void {
    externals.push(event);
  },
  subscribe(): () => void {
    return () => {};
  },
};
