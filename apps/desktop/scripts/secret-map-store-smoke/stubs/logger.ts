/**
 * `@main/lib/logger.js` 的替身 —— **记录**而不是打印。
 *
 * `secret-map-store-smoke` 要断言的不是"返回了空表"(那可以靠静默达成),
 * 而是**"坏数据被上报了"**。所以这一份把每次调用收进一个全局数组,供脚本读。
 *
 * ⚠️ 记录放在 `globalThis` 上而不是 `export`:
 * 本套的 main.ts 会被 `tsc` 按**真模块**做类型检查,而真模块没有这些桩专有导出 ——
 * `export const records` 会报 TS2305。走全局就绕开了"桩比真模块多导出"这个类型冲突,
 * 同时脚本照样读得到。
 */
export interface LogRecord {
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

const KEY = "__mcodeSmokeLogs";
(globalThis as Record<string, unknown>)[KEY] = [] as LogRecord[];

function emit(level: LogRecord["level"], message: string): void {
  ((globalThis as Record<string, unknown>)[KEY] as LogRecord[]).push({ level, message });
  process.stderr.write(`[${level}] ${message}\n`);
}

export const log = {
  debug: (message: string) => emit("debug", message),
  info: (message: string) => emit("info", message),
  warn: (message: string) => emit("warn", message),
  error: (message: string) => emit("error", message),
};
