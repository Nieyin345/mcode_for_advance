import type { McpServerConfig } from "@contracts/ipc";

/** Renderer may see the names of env/header entries, never their values.
 * Empty strings in this editing view mean 'keep the stored value on save'. */
export function maskMcpConfig(config: McpServerConfig): McpServerConfig {
  // Imported/older records are not guaranteed to respect the transport
  // discriminant. Always scrub BOTH credential containers before exposing
  // an editing copy to the renderer; a shallow spread of an HTTP record with
  // stale env (or a stdio record with stale headers) otherwise leaks secrets.
  const masked = { ...config } as McpServerConfig & {
    headers?: Record<string, string>;
    env?: Record<string, string>;
  };
  if (masked.headers) {
    masked.headers = Object.fromEntries(Object.keys(masked.headers).map(key => [key, ""]));
  }
  if (masked.env) {
    masked.env = Object.fromEntries(Object.keys(masked.env).map(key => [key, ""]));
  }
  return masked;
}

/** Replace nonempty values, retain existing keys left blank, remove deleted
 * keys. Never carry a secret to a different command/URL or transport. */
export function mergeMcpSecretEdits(previous: McpServerConfig, next: McpServerConfig): McpServerConfig {
  const remote = next.type === "http" || next.type === "sse";
  const oldRemote = previous.type === "http" || previous.type === "sse";
  const oldSecrets = remote && oldRemote ? previous.headers : !remote && !oldRemote ? previous.env : undefined;
  const edits = remote ? next.headers : next.env;
  if (oldSecrets && edits && Object.keys(edits).some((key) => edits[key] === "" && Object.hasOwn(oldSecrets, key))) {
    // For stdio, the executable alone is not the target identity: "node"
    // with a different script argument or cwd may run wholly different code.
    // Blank (masked) env values cannot silently hand secrets to that code.
    const sameStdioTarget = !remote && !oldRemote
      && next.command === previous.command
      && JSON.stringify(next.args ?? []) === JSON.stringify(previous.args ?? [])
      && next["cwd"] === previous["cwd"];
    if (remote ? !oldRemote || next.url !== previous.url || next.type !== previous.type
      : !sameStdioTarget) {
      throw new Error("服务器地址、命令、参数或工作目录变更时，请重新填写原有密钥，或移除对应字段");
    }
  }
  const merged = edits && Object.fromEntries(Object.entries(edits).map(([key, value]) =>
    [key, value === "" && oldSecrets && Object.hasOwn(oldSecrets, key) ? oldSecrets[key] : value]));
  return remote ? { ...next, ...(merged ? { headers: merged } : {}) } : { ...next, ...(merged ? { env: merged } : {}) };
}
