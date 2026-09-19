/**
 * `@main/workflows/seed.js` 的替身 —— 与 library-delete-smoke / library-mcp-smoke 那份
 * 同款、同源(导出面照抄真模块:`workflowsRoot` / `scriptsDir` / `scriptPath` /
 * `ensureWorkflows`)。
 *
 * ## 为什么必须换它
 *
 * 真的那个 import 了 `workflows/assets.ts` 与 **`workflows/searchScriptsAssets.ts`**,
 * 后者是二十几个 **Vite `?raw` 导入**的 `.py` / `LICENSE`(`import f11 from
 * "./…/arxiv_atom.py?raw"`)。esbuild 不认那些后缀,整条链会以
 * `No loader is configured for ".py" files` 挂在打包这一步 —— 而报出来的样子和
 * "被测代码坏了"一模一样。
 *
 * ## 本套为什么会被拖到它
 *
 * `mobileRpc.ts` 的 import 图(`ipc/library.ts` / `orchestration/runner.js`)会拉到它。
 * 本套一次都不写流程脚本,但 import 图要过得去。
 *
 * ⚠️ 三个路径函数**返回真的临时目录下的路径**(数据根由 stubs/dataRoot.ts 钉住),
 * 不返回 `""`:调用方拿到空串会拼出相对路径,而"相对当前目录"在无头产物里是
 * `apps/desktop` —— 那正是"指向不该碰的地方"的形状。
 */
import { join } from "node:path";
import { dataRoot } from "@main/lib/dataRoot.js";

let calls = 0;

/** 被调到了几次 —— 本套**不该**走到它(没有一条路由在起服务时写流程脚本)。 */
export function ensureWorkflowsCalls(): number {
  return calls;
}

export function workflowsRoot(): string {
  return join(dataRoot(), "workflows");
}

export function scriptsDir(): string {
  return join(workflowsRoot(), "scripts");
}

export function scriptPath(name: string): string {
  return join(scriptsDir(), name);
}

export function ensureWorkflows(): void {
  calls += 1;
}
