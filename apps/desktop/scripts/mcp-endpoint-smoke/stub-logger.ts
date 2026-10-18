/**
 * `@main/lib/logger.js` 的内存替身(与 extension-bridge-smoke 同一份理由):
 * 真的那个 import `electron` 取 userData,而 electron 的 CJS 入口在 ESM bundle 里
 * 会炸在 `Dynamic require of "fs" is not supported`。
 */
type Level = "INFO" | "WARN" | "ERROR";

/**
 * 内存捕获环 —— stderr 照旧写(排错用),同时留一份给断言读。
 *
 * 为什么需要它:公网端点「受控保留的忙 owner 带凭据与资源计数」这条诊断**只有**一行
 * `log.warn`(没有别的可观察面),不捕获就只能靠人眼看日志 —— 断言不了"诊断真的可见、
 * 且带的是原凭据而不是 `?`"。
 */
const captured: string[] = [];

function write(level: Level, msg: string): void {
  const line = `[${level}] ${msg}`;
  captured.push(line);
  process.stderr.write(`[smoke] ${line}\n`);
}

/** 测试用:读到目前为止的全部日志行(按写入顺序)。 */
export function __capturedLogs(): readonly string[] {
  return captured;
}

/** 测试用:清空捕获环(每段断言从干净状态开始)。 */
export function __clearCapturedLogs(): void {
  captured.length = 0;
}

export const log = {
  info: (msg: string) => write("INFO", msg),
  warn: (msg: string) => write("WARN", msg),
  error: (msg: string) => write("ERROR", msg),
};