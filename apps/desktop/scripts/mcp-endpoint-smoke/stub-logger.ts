/**
 * `@main/lib/logger.js` 的内存替身(与 extension-bridge-smoke 同一份理由):
 * 真的那个 import `electron` 取 userData,而 electron 的 CJS 入口在 ESM bundle 里
 * 会炸在 `Dynamic require of "fs" is not supported`。
 */
type Level = "INFO" | "WARN" | "ERROR";

function write(level: Level, msg: string): void {
  process.stderr.write(`[smoke] [${level}] ${msg}\n`);
}

export const log = {
  info: (msg: string) => write("INFO", msg),
  warn: (msg: string) => write("WARN", msg),
  error: (msg: string) => write("ERROR", msg),
};