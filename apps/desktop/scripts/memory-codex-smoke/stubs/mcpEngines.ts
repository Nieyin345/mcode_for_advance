/**
 * `@main/lib/mcpEngines.js` 的替身 —— 只给无头脚本用。
 *
 * 真的那一个读/写 `<home>/.mcode/mcp-engines.json`(每个 MCP 服务器分配给哪几家引擎)。
 * 本套与 MCP 无关,用一份**内存里的空表**:没有任何服务器 → `deriveMcpEngineView` 返回
 * 空对象 → 生成的 `config.toml` 里只有供应商那几张表。
 *
 * `mcpEngineEnabled()` 的**语义照抄真的那一份**(见 `lib/mcpEngines.ts`):不在表里 =
 * 按引擎自己的默认值。照抄是必要的 —— 本套走的是 `CodexModelsStore.materializeConfigToml()`,
 * 它拿这三个函数的结果决定要不要把某个服务器写进 TOML;语义走样会让断言读到的
 * `config.toml` 和真实运行期不是同一份。
 */
import type { McpEnginesMap } from "@main/lib/mcpEngines.js";

export const MCP_ENGINES = ["claude", "codex"] as const;

let map: McpEnginesMap = {};

export function mcpEnginesPath(): string {
  return "/nonexistent/mcode-smoke/mcp-engines.json";
}

export function readMcpEnginesMap(): McpEnginesMap {
  return map;
}

export function writeMcpEnginesMap(next: McpEnginesMap): void {
  map = next;
}

export function mcpEngineEnabled(
  enginesMap: McpEnginesMap,
  name: string,
  engine: "claude" | "codex",
): boolean {
  const entry = enginesMap[name];
  if (!entry) return true; // 不在表里 = 没被关掉
  return entry[engine] !== false;
}

export function deriveMcpEngineView(
  state: { userServers?: Record<string, unknown>; userDisabled?: Record<string, unknown> },
  enginesMap: McpEnginesMap,
  engine: "claude" | "codex",
): Record<string, unknown> {
  const disabled = state.userDisabled ?? {};
  const out: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(state.userServers ?? {})) {
    if (name in disabled) continue;
    if (mcpEngineEnabled(enginesMap, name, engine)) out[name] = cfg;
  }
  return out;
}

export function setMcpEnginesEntry(
  map: McpEnginesMap,
  name: string,
  wanted: { claude: boolean; codex: boolean },
): McpEnginesMap {
  return { ...map, [name]: { ...wanted } };
}

export function applyUserMcpToggle(
  state: unknown,
  _name: string,
  _enabled: boolean,
): { ok: boolean; error?: string; state: unknown } {
  throw new Error("memory-codex-smoke 的 mcpEngines 桩不该被调(本套与 MCP 无关)");
}
