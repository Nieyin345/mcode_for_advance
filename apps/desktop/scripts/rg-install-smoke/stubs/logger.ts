/**
 * `@main/lib/logger.js` 的替身 —— 真的那个 import 了 `electron`。
 *
 * **故意不静默**,理由同 run-store-smoke 那一份:一个"失败了但脚本照样绿"的桩会把
 * 真正的失败藏起来。这套里 `rg.install` / `rg.status` 的失败**本来就该**返回给界面,
 * 所以走到这里的每一行日志都值得打出来看一眼(打到 stderr,不污染断言输出)。
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
