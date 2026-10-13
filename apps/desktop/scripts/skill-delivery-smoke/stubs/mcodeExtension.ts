/**
 * 假 `mcodeExtension` —— 换掉 `PiAgentSdkProvider` 的相对 import
 * `./mcodeExtension.js`(`--external:` + 铺同名文件)。本套件不验扩展的审批/路径守卫
 * 语义(那些由别的套件承担),这里只要一个满足 loader `extensionFactories` 形状的替身。
 */
export function createMcodeExtension(_opts: unknown): unknown {
  return { name: "mcode", factory: () => {} };
}
