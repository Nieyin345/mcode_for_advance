/**
 * `sdkBinaryPath` 的替身 —— 换掉 `ClaudeAgentSdkProvider` 的相对 import
 * `./sdkBinaryPath.js`(`--alias` 不收相对名,故走 `--external:./sdkBinaryPath.js`
 * + 把它 esbuild 成同名文件铺在 bundle 旁边)。
 *
 * provider 在 startTurn 早期调 `resolveSdkBinaryPath()`,拿不到就抛「Claude 未安装」。
 * 本套件不验二进制,只验它交给 SDK 的 options.skills,所以给一个不存在的假路径字符串
 * (provider 只判真值,不 stat 它)。**绝不能**返回真二进制路径 —— 那会把本套件拖去
 * spawn 真进程打上游。
 */
export function resolveSdkBinaryPath(): string {
  return "/fake/claude-smoke/claude.exe";
}

export function resolveBundledSdkBinaryPath(): string {
  return "/fake/claude-smoke/claude.exe";
}
