/**
 * `@main/lib/logger.js` 的替身 —— 真的那个 import 了 `electron`。
 *
 * **故意不静默**:原样打到 stderr。一个"保存失败却照样安静"的桩会把本套件要测的
 * 东西(写下去了没有)藏起来。
 */
function emit(level: string, message: string): void {
  process.stderr.write(`[${level}] ${message}\n`);
}

export const log = {
  debug: (message: string) => emit("debug", message),
  info: (message: string) => emit("info", message),
  warn: (message: string) => emit("warn", message),
  error: (message: string) => emit("error", message),
};

