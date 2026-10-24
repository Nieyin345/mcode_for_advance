/**
 * O4 —— 旅程的 `launch.setup` 出口，单独成文件让旅程文件**不静态 import `setup.ts`**。
 *
 * `setup.ts` 顶层 `require("genoffice:docx-engine")`（夹具生成用）。把 setup 的
 * 加载推迟到这个模块的 `setup()` 调用时刻（此时已在 Electron 主进程里），
 * 普通 Node（`build.mjs` 读旅程名）那一侧永远不会碰 vendor 的 require。
 */
import type { U1SetupContext, U1SetupResult } from "../electron-u1/driver/index.js";

export async function o4LaunchSetup(ctx: U1SetupContext): Promise<U1SetupResult> {
  const { o4DocsSetup } = await import("./setup.js");
  return o4DocsSetup(ctx);
}
