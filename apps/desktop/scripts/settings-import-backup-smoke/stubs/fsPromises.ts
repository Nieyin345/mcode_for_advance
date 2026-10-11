/**
 * `node:fs/promises` 的**记录式**替身 —— 只给 MC-030 用。
 *
 * ## 为什么需要它
 *
 * MC-030 的判据是**读取顺序**:导入文件必须**先 `stat` 看大小、超限就不读**,而不是
 * 先 `readFile` 整份读进内存再检查长度。功能断言(超大文件返回"文件太大")能证明
 * "拒绝了",但证明不了"没有先把它读进来" —— 一个"先读后拒"的实现照样能通过功能断言。
 * 所以要捕到**真实的调用顺序与是否调用**,只有把 `node:fs/promises` 换掉。
 *
 * `--alias:node:fs/promises=...`(run.sh)让被测的 `ipc/settingsTransfer.ts` 里那句
 * `import { readFile, stat, ... } from "node:fs/promises"` 落到这里。其余名字(`mkdir`
 * / `writeFile` …)原样转发真实现(`export *`),`readFile` / `stat` 包一层记一笔调用。
 *
 * ## 记到哪儿
 *
 * 记在**进程级 `globalThis`**(一个 `Symbol.for` 键)上 —— main.ts 直接 import 本文件
 * 的 `fsOps()` 读同一个数组(esbuild 按解析路径去重,两边是同一模块实例)。
 *
 * ## `setStatSizeOverride` —— 模拟"检查与读取之间文件长大"
 *
 * MC-030 的第二道闸是:读完之后按**实际字节**再核一遍,堵住 `stat` 与 `read` 之间
 * 文件被追加的竞态。无头里没法真的让文件在两次系统调用之间变大,所以这里让 `stat`
 * 对指定路径**谎报**一个大小:于是预检查放过、真读到的是大文件、第二道闸必须兜住。
 */
export * from "fs/promises";
import * as real from "fs/promises";

export interface FsOp {
  op: string;
  path: string;
}

const KEY = Symbol.for("mcode.smoke.settingsImport.fsOps");
const OVERRIDE_KEY = Symbol.for("mcode.smoke.settingsImport.statSizeOverride");

/** 到此刻为止的所有 `readFile` / `stat` 调用(按发生顺序)。 */
export function fsOps(): FsOp[] {
  const g = globalThis as unknown as Record<symbol, FsOp[]>;
  return (g[KEY] ??= []);
}

export function resetFsOps(): void {
  fsOps().length = 0;
}

function overrides(): Map<string, number> {
  const g = globalThis as unknown as Record<symbol, Map<string, number>>;
  return (g[OVERRIDE_KEY] ??= new Map());
}

/** 让 `stat(<absPath>)` 谎报 `size` 字节(其余字段照真)。传 `null` 清掉。 */
export function setStatSizeOverride(absPath: string, size: number | null): void {
  if (size === null) overrides().delete(absPath);
  else overrides().set(absPath, size);
}

function record(op: string, p: unknown): void {
  fsOps().push({ op, path: String(p) });
}

export const readFile = ((...args: Parameters<typeof real.readFile>) => {
  record("readFile", args[0]);
  return (real.readFile as (...a: unknown[]) => unknown)(...args);
}) as unknown as typeof real.readFile;

export const stat = (async (...args: Parameters<typeof real.stat>) => {
  record("stat", args[0]);
  const realStat = await (real.stat as (...a: unknown[]) => Promise<import("node:fs").Stats>)(...args);
  const override = overrides().get(String(args[0]));
  if (override === undefined) return realStat;
  // 保留 Stats 的原型(isFile 等方法在原型上,`{...st}` 会丢掉它们),只覆盖 size。
  return Object.assign(
    Object.create(Object.getPrototypeOf(realStat)) as import("node:fs").Stats,
    realStat,
    { size: override },
  );
}) as unknown as typeof real.stat;
