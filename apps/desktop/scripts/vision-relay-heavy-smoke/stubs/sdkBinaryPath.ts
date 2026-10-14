/**
 * `@main/providers/claude-sdk/sdkBinaryPath.js` 的替身 —— 只给 `vision-relay-heavy-smoke` 用。
 * 真那份要查受管运行时根(launcher 目录),本套的 SDK 是桩不 spawn 二进制,回 undefined 即可
 * (`describeImage` 会因此不设 `pathToClaudeCodeExecutable` —— 那正是"没管好二进制路径"的诚实形态)。
 */
export function resolveSdkBinaryPath(): string | undefined {
  return undefined;
}
