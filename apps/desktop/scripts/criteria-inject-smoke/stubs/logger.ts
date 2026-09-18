/**
 * `@main/lib/logger.js` 的替身 —— 真的那个 import 了 `electron`。
 *
 * **故意不静默**:把日志原样打到 stderr 上。注入逻辑里所有"读不到就跳过"的兜底都会
 * 走这里,静默的桩会把真正的失败藏起来。
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
