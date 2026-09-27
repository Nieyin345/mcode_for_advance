/** Pure helpers for narrowing Codex's process-wide config to one Mcode turn. */

export interface CodexMcpInventoryEntry {
  name: string;
  /** Present only for MCP servers contributed by an enabled plugin. */
  pluginName?: string;
}

/** Empty/absent is StartTurnRequest's unrestricted form. A non-empty list is
 * exact and also gates Mcode's built-in browser dynamic tools. */
export function codexTurnAllowsMcpServer(
  serverName: string,
  mcpServerNames?: readonly string[],
): boolean {
  return !mcpServerNames?.length || mcpServerNames.includes(serverName);
}

/** Quote one segment of a Codex `-c` dotted path when it is not a TOML bare key. */
function configKeySegment(value: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

/**
 * Build process-local Codex CLI overrides that disable MCP servers excluded
 * by this turn's explicit MCP/plugin allowlists. Empty/absent allowlists mean
 * unrestricted, matching StartTurnRequest's contract.
 */
export function codexMcpDisableArgs(
  inventory: readonly CodexMcpInventoryEntry[],
  mcpServerNames?: readonly string[],
  pluginNames?: readonly string[],
): string[] {
  const mcpAllow = mcpServerNames?.length ? new Set(mcpServerNames) : null;
  const pluginAllow = pluginNames?.length ? new Set(pluginNames) : null;
  if (!mcpAllow && !pluginAllow) return [];

  const seen = new Set<string>();
  const disabled: string[] = [];
  for (const entry of inventory) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    const excludedByMcp = mcpAllow !== null && !mcpAllow.has(entry.name);
    const excludedByPlugin =
      pluginAllow !== null && entry.pluginName !== undefined && !pluginAllow.has(entry.pluginName);
    if (excludedByMcp || excludedByPlugin) disabled.push(entry.name);
  }

  return disabled.flatMap((name) => ["-c", `mcp_servers.${configKeySegment(name)}.enabled=false`]);
}
