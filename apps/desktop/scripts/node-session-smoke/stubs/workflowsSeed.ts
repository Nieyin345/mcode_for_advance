/**
 * `@main/workflows/seed.js` 的替身 —— 真的那个 import 了 `workflows/assets.ts` 与
 * **`workflows/searchScriptsAssets.ts`**,后者是二十几个 **Vite `?raw` 导入**的
 * `.py` / `LICENSE`。esbuild 不认那些后缀(连无后缀的 `LICENSE` 也没法配 loader),
 * 整条链会以 `No loader is configured for ".py" files` 挂在打包这一步。
 *
 * ⚠️ **这一刀必须切在 seed 上,不能切在 pluginManager 上。** `runner.ts` 直接
 * import 了 `@main/orchestration/library.js`(`getWorkflow`)→ `builtins.js`,而
 * `builtins.js` 自己就 import 了 `workflows/seed.js` 那一坨 `?raw`。只要还打真
 * `library.ts`,seed 就在链上。
 *
 * 这个 suite 不碰工作流脚本那套(它跑的是内存里现摆的一张图),所以这里给出
 * `runner.ts` 那一侧可能用到的最小面。
 */
export function ensureWorkflows(): void {
  /* 无头脚本里不落脚本 */
}
export function workflowsRoot(): string {
  return "";
}
export function scriptsDir(): string {
  return "";
}
export function scriptPath(name: string): string {
  return name;
}
