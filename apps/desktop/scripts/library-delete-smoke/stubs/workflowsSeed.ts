/**
 * `@main/workflows/seed.js` 的替身 —— 真的那个 import 了 `workflows/assets.ts` 与
 * **`workflows/searchScriptsAssets.ts`**,后者是二十几个 **Vite `?raw` 导入**的
 * `.py` / `LICENSE`(`import f11 from "./…/arxiv_atom.py?raw"`)。esbuild 不认那些
 * 后缀,整条链会以 `No loader is configured for ".py" files` 挂在打包这一步。
 *
 * ## 为什么可以换掉它
 *
 * `ipc/library.ts` 在注册时调 `ensureWorkflows()` —— 那一步是"把流程脚本写到
 * `<数据根>/workflows/scripts/`",与删除一个字都不沾。而 `registerLibraryHandlers`
 * 会真的被本套调用(删除 handler 是从那里注册出来的),所以那一步必须能过。
 *
 * ⚠️ **不是空实现**:它记下自己有没有被调到 —— `ipc/library.ts` 里那句
 * `ensureWorkflows()` 是本套唯一能看到它的地方,真被删掉了这里会立刻显形
 * (少了它,模型第一次要用脚本时路径不存在,而那看起来和"脚本写坏了"一模一样)。
 */
let calls = 0;

/** 被调到了几次 —— 断言用。 */
export function ensureWorkflowsCalls(): number {
  return calls;
}

export function ensureWorkflows(): void {
  calls += 1;
}
