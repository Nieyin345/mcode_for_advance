/**
 * `@main/lib/codexModelsStore.js` 的替身。
 *
 * `mcpConfig.materializeAllMcpViews` 里那句 `await import(...)` 会被 esbuild 静态
 * 打进 bundle,而真那份要 electron。本套不验 codex 视图(那是真机验收的部分),
 * 所以给一个不做事的实现 —— 与真那份一样,它的失败本来就是 best-effort 吞掉的。
 */
export const CodexModelsStore = {
  async ensureConfigMaterialized(): Promise<void> {},
};

