/**
 * Dependency-free error text for cleanup hooks, installation approvals, and
 * IPC error handlers. An extension may throw any JS value, including an object
 * whose toString/message getter throws or a multi-megabyte string.
 *
 * This leaf must not import Electron, zod, logger, or any plugin runtime.
 */
export const MAX_SAFE_ERROR_MESSAGE = 1024;

export function safeErrorMessage(err: unknown): string {
  try {
    const value: unknown = err instanceof Error ? err.message : String(err);
    if (typeof value !== "string" || !value) return "未知错误";
    return value.length <= MAX_SAFE_ERROR_MESSAGE
      ? value
      : value.slice(0, MAX_SAFE_ERROR_MESSAGE - 1) + "…";
  } catch {
    return "未知错误";
  }
}
