/**
 * `@main/lib/logger.js` 的替身 —— 真的那个 import 了 `electron`(日志写在
 * `app.getPath("userData")` 下)。
 *
 * **故意不静默**:原样打到 stderr。这个套件测的就是"读出来的是什么",一个把失败吞掉的
 * 桩会把真正的坏掉藏起来。
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
