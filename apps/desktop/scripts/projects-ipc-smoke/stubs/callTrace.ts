/**
 * 全桩共享的**调用流水** —— 只管顺序,不区分是谁记的。
 *
 * ## 为什么单独开一个文件
 *
 * 验「先掐图、再放运行时」时,拿两个**各自独立**的数组去比下标是错的:
 * `cancelAsked` 是跨用例累计的,它的下标跟 `disposedIds()` 根本不可比。第一版就那么
 * 写的,红了一条假 FAIL。
 *
 * 所以两边在记录自己的时候,往同一条流水里各记一笔,顺序就成了一条可比的时间线。
 *
 * 放独立文件是为了避开 `runner ↔ runtimeManager` 的循环依赖 —— 用动态 `import()`
 * 记流水的话,它是**异步**的,断言读的时候还没记上。
 *
 * ⚠️ 这是本仓库里唯一一处跨桩共享状态。加它是因为「两件事的先后」本身就是被测对象,
 * 别的用例别往这里加东西。
 */
export const callTrace: string[] = [];

export function traceCall(who: string, id: string): void {
  callTrace.push(`${who}:${id}`);
}

export function resetCallTrace(): void {
  callTrace.length = 0;
}
