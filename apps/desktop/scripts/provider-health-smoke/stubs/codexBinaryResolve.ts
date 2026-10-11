/** 假 `codexBinaryResolve` —— 让 Codex 的 healthCheck 走到 execFile 那条路。 */
export function resolveCodexBinaryPath(): string | null {
  return process.env["MCODE_SMOKE_CODEX_PATH"] || "C:/fake/codex.exe";
}
export function resolveBundledCodexBinaryPath(): string | null {
  return null;
}
export function codexVendorTriple(): string | null {
  return null;
}
