/**
 * `@main/lib/logger.js` 的替身 —— 真的那个 import 了 `electron`(日志文件写在
 * `app.getPath("userData")` 下)。
 *
 * **故意不静默**:把日志原样打到 stderr 上。一个"保存失败但脚本照样通过"的桩会把真正
 * 的失败藏起来,而这套脚本测的恰恰是"写下去了没有"。
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
