/**
 * `@main/lib/mcpConfig.js` 的替身 —— 只给无头脚本用。
 *
 * 真的那一个在 import 期就求 `MCODE_CONFIG_DIR`(=`homedir()/.mcode`),`getMcpTruth()`
 * 还会读/写**用户真正的** `~/.mcode/.claude.json`(MCP 真相层迁移)。本套验的是记忆库与
 * Codex 供应商两条 IPC,**与 MCP 一点关系都没有** —— 让真的那个跑起来只会让这套的结果
 * 取决于这台机器上装过什么 MCP。
 *
 * 所以这里是**空库**:没有用户级服务器、没有迁移。`materializeConfigToml()` 只会因此
 * 少写几张 `[mcp_servers.*]` 表 —— 而本套的断言读的正是"只有供应商那几张表",空库让
 * 判据更干净。
 *
 * 没走到的成员一律**显式抛**。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`memory-codex-smoke 的 mcpConfig 桩没造 ${name}`);
  };
}

export async function getMcpTruth(): Promise<unknown> {
  return { userServers: {}, userDisabled: [] };
}

export async function ensureMcpTruthMigrated(): Promise<void> {
  /* 空库,没有要迁移的东西 */
}

/** 空表 —— 本套与 MCP 无关(见文件头)。 */
export async function readCliMcpSources(): Promise<unknown[]> {
  return [];
}

/* ── 纯函数:**语义照抄真的那一份**(见 `lib/mcpConfig.ts`),因为它们会经
   `CodexModelsStore.materializeConfigToml()` 影响 `config.toml` 的正文 ——
   走样了断言读到的就不是真实运行期那一份。 ── */

export function parseMcpConfig(raw: unknown): unknown | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw;
}

export function mcpServersOf(cfg: Record<string, unknown>): Record<string, unknown> {
  const v = cfg.mcpServers;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function describeMcpConfig(config: { type?: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> }): { kind: string; detail: string } {
  if (config.type === "http" || config.type === "sse") {
    return { kind: config.type, detail: config.url ?? "" };
  }
  const parts = [config.command ?? "", ...(config.args ?? [])];
  const envCount = config.env ? Object.keys(config.env).length : 0;
  return {
    kind: "stdio",
    detail: envCount > 0 ? `${parts.join(" ")} · ${envCount} 个环境变量` : parts.join(" "),
  };
}

export function getMcpManagement(): unknown {
  return { userServers: {}, userDisabled: {} };
}

export function saveMcpManagement(_state: unknown): void {
  throw new Error("memory-codex-smoke 的 mcpConfig 桩不该被写(本套与 MCP 无关)");
}

export const materializeClaudeMcpView = notHere("materializeClaudeMcpView");
export const materializeAllMcpViews = notHere("materializeAllMcpViews");
export const readUserClaudeJson = notHere("readUserClaudeJson");
export const writeUserClaudeJson = notHere("writeUserClaudeJson");
