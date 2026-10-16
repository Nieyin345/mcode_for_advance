/**
 * 假 `codexBinaryResolve` —— 换掉 `CodexAgentSdkProvider` 的相对 import
 * `./codexBinaryResolve.js`（`--external:` + 铺同名文件）。
 *
 * provider 只把 `resolveCodexBinaryPath()` 的真值判一下（拿不到就「未安装」失败），
 * 然后把它交给 `CodexAppServerClient` —— 而本套的 client 桩**不 spawn 任何进程**。
 * 所以这里给一个不存在的假路径即可；**绝不能**让它去解析真二进制（本套不驱动真 Codex）。
 */
export function resolveCodexBinaryPath(): string | null {
  return "/fake/codex-smoke/codex.exe";
}

export function resolveBundledCodexBinaryPath(): string | null {
  return "/fake/codex-smoke/codex.exe";
}

export function codexVendorTriple(): string | null {
  return null;
}
