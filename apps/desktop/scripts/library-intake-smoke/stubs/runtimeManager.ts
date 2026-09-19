/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 真的那个会拉起 SDK 子进程。
 *
 * ## 为什么要换它
 *
 * 本套只需要 `library/broadcast.ts` 的**一个信号**:`runtimeManager.emitExternal({
 * type:"library.item.imported" })` —— 也就是"有条目入库"的那条事件,自动化的
 * 「事件发生时」触发器与钩子**唯一**的信号。
 *
 * 真 RuntimeManager 一路拖到 `providers/registry.js` → **三个引擎实现**,三个引擎
 * 又都要 `workflows/seed.js` —— seed 的货是二十几个 `?raw` 的 `.py`/LICENSE(Vite
 * 把它们变成字符串常量,esbuild 不认这个后缀;`LICENSE` 连后缀都没有,配 loader 也
 * 盖不住)。在这一刀切,那整条引擎链就从被测路径上消失了。
 *
 * ⚠️ **`subscribe` 是空实现,所以本套验不了"触发器真的被叫起来了"。** 它验的是
 * 更靠上一层的、也是真正会坏的那一层:**事件到底发了没有**。触发器那一侧挂在
 * `automationRunner` 上,由 `automation-smoke` 负责 —— 两边合起来才是一条完整的链。
 * 别把这条注释删了当成"桩可以更偷懒":`subscribe` 返回一个真的退订函数(而不是
 * 返回 undefined),是因为 `emitExternal` 的调用方里有人 `const off = subscribe(...)`
 * 之后直接 `off()`;桩返回 undefined 会在那儿抛 TypeError,报出来的长相与"被测代码
 * 坏了"一模一样。
 */
import type { RuntimeEvent } from "@contracts/runtime";

/** 按顺序记下发出去的每条外部事件。 */
export const externals: RuntimeEvent[] = [];

export function resetExternals(): void {
  externals.length = 0;
}

/** 其中"有条目入库"的那些 id —— 断言主要看这个。 */
export function importedIds(): string[] {
  return externals
    .filter((e) => e.type === "library.item.imported")
    .map((e) => (e as { itemId: string }).itemId);
}

/** 按顺序记下每条事件的标题 —— 判"载荷里到底带了什么"。 */
export function importedTitles(): string[] {
  return externals
    .filter((e) => e.type === "library.item.imported")
    .map((e) => (e as { title?: string }).title ?? "");
}

export const runtimeManager = {
  emitExternal(event: RuntimeEvent): void {
    externals.push(event);
  },
  subscribe(): () => void {
    return () => {};
  },
};
