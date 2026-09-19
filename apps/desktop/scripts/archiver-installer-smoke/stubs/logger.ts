/**
 * `@main/lib/logger.js` 的替身 —— 真的那个 import 了 `electron`(日志文件写在
 * `app.getPath("userData")` 里)。
 *
 * **故意不静默**:把日志原样打到 stderr 上。一个"保存失败但脚本照样通过"的桩会把真正
 * 的失败藏起来,而这一套的一半断言测的恰恰是"失败了有没有报出来"。
 *
 * (与 db-migrate-smoke 的那一份逐字相同。)
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
