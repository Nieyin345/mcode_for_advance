/** `@main/lib/logger.js` stub: prints to stderr, never touches Electron or userData. */
function emit(level: string, message: string): void {
  process.stderr.write(`[${level}] ${message}\n`);
}
export const log = {
  debug: (message: string) => emit("debug", message),
  info: (message: string) => emit("info", message),
  warn: (message: string) => emit("warn", message),
  error: (message: string) => emit("error", message),
};
