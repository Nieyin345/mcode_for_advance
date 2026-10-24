/**
 * `@main/lib/logger.js` 的替身 —— 只给 O4 的无头探针用。
 *
 * 真的那个 import 了 `electron`（日志落在 `app.getPath("userData")` 下），无头
 * 跑不起来。这一份把每条日志**记下来**（供断言「缺 on 时喊出来了没有」）并
 * 原样打到 stderr（失败现场可读）。
 *
 * ⚠️ 记录而不是吞掉：这套要验的恰好是「坏东西有没有被喊出来」，一个静默桩会让
 * 那条断言永远绿 —— 那是本仓库反复栽过的「判据退化成恒真」。
 */

export const capturedLogs: Array<{ level: string; message: string }> = [];

export function clearCapturedLogs(): void {
  capturedLogs.length = 0;
}

function emit(level: string, message: string): void {
  capturedLogs.push({ level, message });
  process.stderr.write(`[${level}] ${message}\n`);
}

export const log = {
  debug: (message: string) => emit("debug", message),
  info: (message: string) => emit("info", message),
  warn: (message: string) => emit("warn", message),
  error: (message: string) => emit("error", message),
};
