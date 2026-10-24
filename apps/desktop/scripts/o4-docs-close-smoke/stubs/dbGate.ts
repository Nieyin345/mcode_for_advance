/**
 * `@main/store/db.js` 的替身 —— 只给 O4 的无头探针用，**只有一个目的**：
 * 让 `awaitDb()` 变成一个**可控的门闸**，从而断言「包装层的 on 回调是否真的等
 * 数据库就绪」。
 *
 * ## 为什么不能用真 db
 *
 * `awaitDb()` 在真模块里是「initDb 还没跑过 → 立即 resolve」。要验「回调在 DB
 * 就绪前不执行」，必须能让它就绪**前**挂住 —— 真模块不提供这个接缝，而给生产
 * 模块加测试专用开关是圈套（生产代码不该为测试长分支）。alias 换桩是这套工具
 * 的既有做法。
 *
 * ## 与生产行为的关系
 *
 * 这里**不模拟**数据库本身：一不落盘、二不建库。任何走到 `initDb/getDb` 的代码
 * 都会立刻炸（那些路径不在这套判据里，出现了就是接线跑偏）。
 */

let ready = false;
let waiters: Array<() => void> = [];

export function awaitDb(): Promise<void> {
  if (ready) return Promise.resolve();
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

/** 探针专用：把门闸切到「未就绪」或「就绪」（就绪时放行所有等待者）。 */
export function __setDbReady(value: boolean): void {
  ready = value;
  if (value) {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  }
}

export function initDb(): never {
  throw new Error("o4-docs-close-smoke: 无头探针不该初始化真数据库（db 是门闸桩）");
}

export function getDb(): never {
  throw new Error("o4-docs-close-smoke: 无头探针不该拿真数据库句柄");
}
