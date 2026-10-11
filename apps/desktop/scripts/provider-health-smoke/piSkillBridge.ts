/** 假 piSkillBridge —— 换掉 PiAgentSdkProvider 的相对 import `./piSkillBridge.js`。 */
export async function buildPiSkillLoader(_opts: unknown): Promise<unknown> {
  return { reload: async () => {}, getSkills: () => ({ skills: [], diagnostics: [] }) };
}
export function rewriteSkillPrefix(t: string): string {
  return t;
}
export function createMntNormalizingReadTool(): unknown {
  return {};
}
export function wslToWindowsPath(p: string): string {
  return p;
}
