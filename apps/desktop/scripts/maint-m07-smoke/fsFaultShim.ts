/**
 * 【MC-097 E1 故障注入夹具】—— `node:fs/promises` 的**转发壳**。
 *
 * 只在 `maint-m07-smoke/run.cjs` 里经 esbuild `--alias:node:fs/promises=...` 换掉真实的
 * `node:fs/promises`,让 `rename`(原子替换的提交步)或 `open`(临时文件创建步)按需失败 ——
 * 用来模拟「写临时文件 / rename 这一步崩了」。**没有设置故障开关时逐调用转发到真实实现**
 * (跨进程 / 正常写入用例照常走真 fs)。生产代码 `ipc/files.ts` **一行未改**;这不是第二套实现,
 * 只是把系统调用换成一个可控的替身。
 *
 * 为什么用 `node:` 前缀做 alias、壳里 import 裸名 `fs/promises`:壳自己若也走 `node:fs/promises`,
 * 会被同一条 alias 再换一次 → 自我递归(实测)。裸名 `fs/promises` 是同一模块但**不**被 alias 命中,
 * 于是壳里的 `real` 指向真实实现。
 */
import * as real from "fs/promises";

export interface FsFault {
  /** 命中则 `rename` 抛错(模拟 rename 阶段崩溃)。 */
  failRename?: (target: string) => boolean;
  /** 命中则 `open` 抛错(模拟临时文件创建阶段崩溃)。 */
  failOpen?: (path: string) => boolean;
}

export function setFsFault(f: FsFault | null): void {
  (globalThis as { __MCODE_FS_FAULT__?: FsFault | null }).__MCODE_FS_FAULT__ = f;
}
function fault(): FsFault | null {
  return (globalThis as { __MCODE_FS_FAULT__?: FsFault | null }).__MCODE_FS_FAULT__ ?? null;
}

export async function rename(oldPath: string | URL, newPath: string | URL): Promise<void> {
  const f = fault();
  if (f?.failRename?.(String(newPath))) {
    throw Object.assign(new Error(`E1 注入:rename 失败 ${String(newPath)}`), { code: "EIO" });
  }
  return real.rename(oldPath, newPath);
}

export function open(
  path: string | Buffer | URL,
  flags: string | number,
  mode?: string | number,
): Promise<unknown> {
  const f = fault();
  if (f?.failOpen?.(String(path))) {
    return Promise.reject(
      Object.assign(new Error(`E1 注入:open 失败 ${String(path)}`), { code: "EIO" }),
    );
  }
  return real.open(path as never, flags as never, mode as never) as unknown as Promise<unknown>;
}

export * from "fs/promises";
