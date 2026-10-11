/** 假 mcodeExtension —— 换掉 PiAgentSdkProvider 的相对 import `./mcodeExtension.js`。 */
export function createMcodeExtension(_opts: unknown): unknown {
  return { name: "mcode", factory: () => {} };
}
