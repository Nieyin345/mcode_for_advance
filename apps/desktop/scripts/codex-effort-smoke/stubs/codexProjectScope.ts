/**
 * `codexProjectScope` 的替身 —— 换掉 `CodexAgentSdkProvider` 的相对 import
 * `./codexProjectScope.js`（`--external:` + 铺同名文件）。本套不验项目 MCP 作用域
 * （那条由别的套件承担），只要满足 provider import 图的两个具名导出。
 */
export function codexInlineServer(): string | null {
  return null;
}

export async function codexProjectScopeArgs(_opts: unknown): Promise<string[]> {
  return [];
}
