/**
 * `@main/lib/logger.js` 的替身 —— 真的那个 import 了 `electron`(日志写在 `userData` 下)。
 *
 * **故意不静默**:原样打到 stderr。这套测的是"节点跑的时候到底发了什么",日志恰好是
 * 排查同一条问题的第一手材料,静音掉了反而看不见。
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
