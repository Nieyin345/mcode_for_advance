/**
 * `@main/lib/logger.js` 的替身 —— 真的那个 import 了 `electron`(日志文件写在
 * `app.getPath("userData")` 下)。
 *
 * ## 在 run-store-smoke 那份之上多一件事:把日志**记下来**
 *
 * 那一份只把日志打到 stderr。本套要多验一条:`ipc/monitoring.ts` 的
 * `lookupWorkflowId` catch 里那句 `log.warn` **真的发出去了没有** ——
 * "吞掉一个错误但留了一行日志"与"静默吞掉"在 stderr 上看起来一样,
 * 只有把 `log.warn` 的调用记下来才断得出。
 *
 * 记完照旧打 stderr(`log()` 里那一步),失败时人的第一线索仍然是它。
 */
export const lines: Array<{ level: string; message: string }> = [];

function emit(level: string, message: string): void {
  lines.push({ level, message });
  try {
    process.stderr.write(`[${level}] ${message}\n`);
  } catch {
    /* stderr 可能已断(EPIPE)—— 这一份只要记下来就够了 */
  }
}

export const log = {
  debug: (message: string) => emit("debug", message),
  info: (message: string) => emit("info", message),
  warn: (message: string) => emit("warn", message),
  error: (message: string) => emit("error", message),
};
