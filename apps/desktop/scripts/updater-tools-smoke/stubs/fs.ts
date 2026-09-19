/**
 * `node:fs` 的替身 —— **透明代理**,只拦一个调用:`rename`(异步版)。
 *
 * ## 为什么要拦它
 *
 * `installPandoc` / `installLatex` 有一段结构是:
 *
 *     rmSync(destDir, {recursive:true, force:true});   // 先清掉旧的
 *     mkdirSync(join(root, tool), {recursive:true});
 *     await rename(contentDir, destDir);               // 再搬进去
 *
 * 暂存在 `os.tmpdir()`(通常在 C:),落点在 `<userData>/tools`(用户可能配在别的
 * 盘)。**跨卷 rename 会抛 `EXDEV`** —— 实测确认过。那一刻磁盘上的状态是:旧的
 * 版本目录已经删了、新的还没搬进来,也就是**这一项彻底没了**,而错误信息是
 * `EXDEV: cross-device link not permitted, rename ...`,用户看不懂。
 *
 * 本套要能把这段**明确地**测出来(而不是"看运气,取决于用户的盘怎么分的"),所以
 * 这个桩给一个开关:打开之后所有跨目录的 `rename` 都抛 `EXDEV`,模拟"暂存与落点
 * 不在同一个卷"。
 *
 * ## 其余一律原样转发
 *
 * 这不是"把 fs 换掉",是"给一个调用装一个开关"。所有别的导出逐字转给真的
 * `node:fs` —— 于是真建目录、真写文件、真删,断言验的是真的磁盘状态。
 */
import { createRequire } from "node:module";

const real = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");

/** 打开之后,`rename` 一律抛 `EXDEV`(模拟暂存盘与安装盘不是同一个卷)。 */
export const state = { forceExdev: false };

export function setForceExdev(on: boolean): void {
  state.forceExdev = on;
}

/** 被拦下来的 rename 调用,断言用。 */
export const renameCalls: Array<{ from: string; to: string }> = [];

export function resetRenameCalls(): void {
  renameCalls.length = 0;
}

/* ── 原样转发 ──
 * 用显式的再导出而不是 `export * from`,是因为 `node:fs` 是 CJS 且带 getter,
 * 命名再导出对 esbuild 更确定(而且要拦的那一个必须是本地函数)。 */
export const existsSync = real.existsSync;
export const readdirSync = real.readdirSync;
export const statSync = real.statSync;
export const mkdirSync = real.mkdirSync;
export const writeFileSync = real.writeFileSync;
export const readFileSync = real.readFileSync;
export const rmSync = real.rmSync;
export const chmodSync = real.chmodSync;
export const createWriteStream = real.createWriteStream;
export const copyFileSync = real.copyFileSync;
export const mkdtempSync = real.mkdtempSync;
export const unlinkSync = real.unlinkSync;

/** 同步 rename:原样转发(被测代码用的是异步那个)。 */
export const renameSync = real.renameSync;

/** 异步 `rename` —— 这一支是本文件存在的唯一理由。
 *
 *  ⚠️ 同一个函数被**两条入口**用到:`node:fs` 的 callback 版,和 `node:fs/promises`
 *  的 promise 版(`toolInstall.ts` 用的是后者,`await rename(from, to)`)。两条都
 *  走这里,开关只有一份 —— 不然"打开 EXDEV"对其中一条不生效,而断言会以为测过了。
 */
export function rename(from: string, to: string): Promise<void>;
export function rename(from: string, to: string, cb: (err: NodeJS.ErrnoException | null) => void): void;
export function rename(
  from: string,
  to: string,
  cb?: (err: NodeJS.ErrnoException | null) => void,
): Promise<void> | void {
  renameCalls.push({ from, to });
  if (!state.forceExdev) {
    if (cb) return real.rename(from, to, cb);
    return real.promises.rename(from, to);
  }
  const err = Object.assign(
    new Error(`EXDEV: cross-device link not permitted, rename '${from}' -> '${to}'`),
    { code: "EXDEV", errno: -4037, syscall: "rename", path: from, dest: to },
  ) as NodeJS.ErrnoException;
  if (cb) {
    queueMicrotask(() => cb(err));
    return;
  }
  return Promise.reject(err);
}

/** `node:fs/promises` 那边还要 `readdir`(`contentRoot` 用它列暂存目录)。 */
export const readdir = real.promises.readdir;

/** `node:fs` 的 `promises` 属性 —— 也得是拦过的那个,不然有人从这儿绕过去。 */
export const promises = { ...real.promises, rename, readdir };

/** `node:fs/promises` 的其它成员,原样转发。 */
export const fsPromisesRest = {
  stat: real.promises.stat,
  mkdir: real.promises.mkdir,
  rm: real.promises.rm,
  readFile: real.promises.readFile,
  writeFile: real.promises.writeFile,
  copyFile: real.promises.copyFile,
  access: real.promises.access,
};
