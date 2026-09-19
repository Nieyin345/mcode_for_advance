/**
 * `node:fs/promises` 的替身 —— **记录型**,真身转发。
 *
 * ## 为什么需要它
 *
 * `dialog.ts` 那条"图片白名单"的核心承诺是「**不在名单里的、超大的,都不许读进内存**」。
 * 光看返回值分不出两种写法:
 *
 * ```ts
 * // 写法甲(对的):先判扩展名,不合格的直接 continue
 * // 写法乙(错的):先 readFile 读进来,再判 —— 结果一样是 skipped
 * ```
 *
 * 用 mtime 也分不开:读文件**不改 mtime**(那是 atime,而 Windows 上 atime 更新默认
 * 是关的)。用超大文件也分不开:两种写法都 skip。唯一直接的判据是**记下 readFile 到底
 * 被调了哪几个路径**。
 *
 * ## 真身转发,不是空壳
 *
 * 所有导出都转给真的 `node:fs`(promise 版是同一个对象:`require("fs/promises") ===
 * require("fs").promises`),所以被测代码的行为**一字不改**,只是每次调用多记一笔。
 * 桩里返回假值的话,断言验的就是桩而不是源码了。
 */
import { promises as real } from "node:fs";

/** 每次 `stat` / `readFile` 的调用记录,形如 `readFile:C:\x\y.png`。 */
export const fsCalls: string[] = [];

export function resetFsCalls(): void {
  fsCalls.length = 0;
}

/** 只留读文件的那些(断言里最常用的那个切片)。 */
export function readFileCalls(): string[] {
  return fsCalls.filter((c) => c.startsWith("readFile:")).map((c) => c.slice("readFile:".length));
}

export function statCalls(): string[] {
  return fsCalls.filter((c) => c.startsWith("stat:")).map((c) => c.slice("stat:".length));
}

export const readFile: typeof real.readFile = (path, options) => {
  fsCalls.push(`readFile:${String(path)}`);
  return (real.readFile as (...a: unknown[]) => unknown)(path, options) as never;
};

export const stat: typeof real.stat = (path, options) => {
  fsCalls.push(`stat:${String(path)}`);
  return (real.stat as (...a: unknown[]) => unknown)(path, options) as never;
};
