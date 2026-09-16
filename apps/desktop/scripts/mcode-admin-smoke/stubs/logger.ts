/**
 * `@main/lib/logger.js` 的替身 —— 真的那个 import 了 `electron`(日志文件写在
 * `app.getPath("userData")` 下)。**故意不静默**:把警告打到 stderr,这样一个"保存失败
 * 但脚本照样通过"的桩藏不住真正的失败(同 `scripts/hooks-smoke` 的那一份)。
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
