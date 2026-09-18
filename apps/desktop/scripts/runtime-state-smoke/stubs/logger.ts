/**
 * `@main/lib/logger.js` 的替身 —— 真的那个 import 了 `electron`。
 *
 * **故意不静默**:日志打到 stderr。这份 smoke 故意喂坏存档来验"丢元素要警告",
 * 把警告吞掉的桩会让那几条断言变成没人作证。
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
