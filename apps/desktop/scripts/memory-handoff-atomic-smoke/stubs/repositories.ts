/**
 * 【MC-025 故障注入夹具】`@main/store/repositories.js` 的替身 —— 只做一件事:
 * 在 `SettingRepo.set` / `setMany` **真正写下去之前**,按被写的 key 前缀武装一枪
 * (`process.exit(9)` 或抛错)。其余一切**原样转发**真模块。
 *
 * ## 为什么要把故障点放在"写之前"
 *
 * 台账 MC-025 的失败形状是**两次 `SettingRepo.set` 之间**中断:第一次(job 行)已经
 * 落盘并 persist,第二次(源索引 / 目标指针)没发生 —— 重启后就有"job 在、索引没有"
 * 的不可见 job。夹具要能确定性地复刻这一刻:
 *
 *   - 对**旧代码**(set 写 job → set 写索引):武装前缀 `memory.assistant.source.` /
 *     `.target.`,job 那次不匹配、照常落盘,第二次 set 被prefix 命中 → 当场 exit(9)。
 *     `persist()` 已在第一次 set 内完成 → 磁盘上正是"半发表"。
 *   - 对**修复后代码**(`setMany` 一次事务):entries 里包含索引/指针 key → 整个
 *     事务在写之前就被杀 → 一个字节都没写。
 *
 * 同一把武装、两种代码各自死在自己的写点上 —— 这正是"修复前会红、修复后全绿"的
 * 判据来源,不需要为旧代码单独写一套夹具。
 *
 * ## 为什么用 `process.exit(9)` 模拟崩溃而不是抛错
 *
 * 崩溃模拟里**不允许**桩后面还有代码替它收尾(比如 try/finally 里再补一次写);
 * `exit` 让进程当场死掉,和断电/被杀的可见后果一致。抛错模式(第二次保存失败)也
 * 提供 —— 写点之前抛,磁盘同样停留在"第一次已落盘"的状态。
 *
 * ## `export *` + 局部覆盖
 *
 * 相对路径 import 真模块(不能用 `@main/...` —— 那会被 esbuild 的 alias 再替回本
 * 文件自己,模仿佛里 `db-persistence-smoke/stubs/fs.ts` "import bare fs" 的写法)。
 * `SettingRepo` 局部导出**遮蔽** `export *` 带进来的同名导出(ES 模块语义,局部优先),
 * 其余 `SessionRepo`/`ProjectRepo` 等全是真货 —— 夹具建的会话行,被测代码读得到。
 */
import * as real from "../../../src/main/store/repositories.js";
// `flushDb` 走**同一份** db.js 实例(real barrel 用的是相对 ../db.js,esbuild 按解析
// 后的绝对路径去重,是同一个模块)—— trip 里把当前内存态同步写盘,再模拟进程中止。
import { flushDb } from "../../../src/main/store/db.js";

export * from "../../../src/main/store/repositories.js";

export type FaultMode = "exit" | "throw";

let armed: { mode: FaultMode; prefix: string } | null = null;

/** 武装:下一次(且每次)写 key 以 `prefix` 开头时,在该写**生效之前**触发故障。传 null 解除。 */
export function armWriteFault(mode: FaultMode, prefix: string): void {
  armed = { mode, prefix };
}

/** 解除武装 —— verify 趟要在同一进程里做"重试"正控,必须先解除。 */
export function disarmWriteFault(): void {
  armed = null;
}

/**
 * ⚠️ **必须先把内存态 flush 到盘上再崩。**
 *
 * 真的 `SettingRepo.set` 内部是 `persist()` —— 它只 `queueMicrotask` 排队异步落盘。
 * 崩溃趟从"上一次写"到"这一次写"之间**没有 await 边界**,microtask 还没轮到执行;
 * 直接 `process.exit` 会把上一次写也一起丢掉,重启后什么都看不见 —— 那样**旧代码的
 * 半发表也测不出来**(变异验证会得到"修没修都绿")。所以这里模拟的是真实崩溃的形状:
 * 前一次写已经 durable(落盘),这一次写还没发生(甚至事务都没开始),进程才死。
 */
function trip(key: string): void {
  if (!armed || !key.startsWith(armed.prefix)) return;
  flushDb();
  if (armed.mode === "exit") process.exit(9); // 崩溃:没有任何后续代码能补偿
  throw new Error(`注入故障:第二次保存失败(隔离冒烟,key=${key})`);
}

export const SettingRepo: typeof real.SettingRepo = {
  ...real.SettingRepo,
  set(key: string, value: string): void {
    trip(key);
    real.SettingRepo.set(key, value);
  },
  setMany(entries: ReadonlyArray<readonly [string, string]>): void {
    // 事务**写之前**触发:entries 里任一 key 命中即杀 —— 复刻"第二次 set 没发生",
    // 对修复后的单事务实现则是"事务根本没开始"。
    for (const [key] of entries) trip(key);
    real.SettingRepo.setMany(entries);
  },
};
