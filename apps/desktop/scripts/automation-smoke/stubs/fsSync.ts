/**
 * `node:fs` 的**记录式**替身 —— 只给 ARC-005「durable 落盘失败」红例用。
 * (与 `settings-import-backup-smoke/stubs/fsSync.ts` 同一手法,两份各自独立,互不 import。)
 *
 * `store/db.ts` 的 `writeSnapshot()` 走的是 `node:fs` 的**同步**原语(`openSync(staging,"wx")`
 * → `writeFileSync` → `fsyncSync` → `renameSync`)。要证明「**非 durable 写不留幻影行**」,
 * 得让这一步真的失败一次 —— 但那是 `commitNow()` / `persistNowOrThrow()` 内部,从测试外面够不着。
 *
 * 于是把 `openSync` 包一层:武装时,凡是目标名里含 **`.persist-`**(正是 `writeSnapshot` 的
 * staging 名 `${db}.persist-<pid>-<uuid>.tmp`)的排他创建一律抛 `EIO`,直到解除 ——
 * 于是 `commitNow()` 返回 `APPLIED_NOT_DURABLE`(`persistNowOrThrow` 则直接抛)。
 *
 * ⚠️ 只按 `.persist-` 过滤、不用"下一次 wx"那种一次性判断:调用之前还有后台的调度写盘
 * (`SettingRepo.set` 里的 `queueMicrotask` flush)会把一次性机会吃掉,注入就打偏了。
 * 其余名字原样转发真实现。
 */
export * from "fs";
import * as real from "fs";

const KEY = Symbol.for("mcode.smoke.automation.fsFail");
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
