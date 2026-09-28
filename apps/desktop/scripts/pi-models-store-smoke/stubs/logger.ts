/**
 * `@main/lib/logger.js` 的替身 —— 真的那个 import 了 `electron`(日志文件写在
 * `app.getPath("userData")` 下)。
 *
 * 钩子的存放层只用它报一句"写不进去",所以这里只需要 `warn` 存在。**故意不静默**:把
 * 警告打到 stderr 上,这样脚本里看得见 —— 一个"保存失败但脚本照样通过"的桩会把真正
 * 的失败藏起来。
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
