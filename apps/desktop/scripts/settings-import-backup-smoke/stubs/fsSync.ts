/**
 * `node:fs` 的**记录式**替身 —— 只给 MC-025 的"durable 落盘失败"红例用。
 *
 * `store/db.ts` 的 `writeSnapshot()` 走的是 `node:fs` 的**同步**原语(`openSync(staging,"wx")`
 * → `writeFileSync` → `fsyncSync` → `renameSync`)。要证明"**提交后的 durable 落盘失败**
 * 不得被当成导入成功、不得广播",得让这一步真的失败一次 —— 但那是 `persist()` / `persistNowOrThrow()`
 * 内部,从测试外面够不着。
 *
 * 于是把 `openSync` 包一层:武装时,凡是目标名里含 **`.persist-`**(正是 `writeSnapshot` 的
 * staging 名 `${db}.persist-<pid>-<uuid>.tmp`,其它临时写盘不带这一段)的排他创建一律抛
 * `EIO`,直到解除 —— 于是那一次导入自己的 `persistNowOrThrow()` 必抛。
 *
 * ⚠️ 只按 `.persist-` 过滤、不用"下一次 wx"那种一次性判断:导入之前还有后台的调度写盘
 * (备份、`queueMicrotask` flush)会把一次性机会吃掉,注入就打偏了(实测)。按路径过滤 +
 * 持续生效才稳。其余名字原样转发真实现。
 */
export * from "fs";
import * as real from "fs";

const KEY = Symbol.for("mcode.smoke.settingsImport.fsFail");
const g = globalThis as unknown as Record<symbol, { armed: boolean }>;
function state(): { armed: boolean } {
  return (g[KEY] ??= { armed: false });
}

/** 武装:此后所有 `.persist-` staging 的排他创建(`openSync(x,"wx")`)抛 EIO,直到解除。 */
export function failNextExclusiveCreate(): void {
  state().armed = true;
}
export function disarmExclusiveCreate(): void {
  state().armed = false;
}

export function openSync(path: unknown, flags?: unknown, mode?: unknown): number {
  if (state().armed && typeof path === "string" && path.includes(".persist-") && (flags === "wx" || flags === "w")) {
    const err = new Error(`EIO: injected durable-write failure (${path})`) as NodeJS.ErrnoException;
    err.code = "EIO";
    throw err;
  }
  return (real.openSync as (...a: unknown[]) => number)(path, flags, mode);
}

