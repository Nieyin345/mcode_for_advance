// Fail closed if a wiring regression tries to execute a real shell or model helper.
export function spawnRun(..._args: unknown[]): never {
  throw new Error("This module workflow smoke must not launch external code");
}
// 【MC-073】`codeRunner` 现在也 import 这个常量(逐行预算)。桩要提供同名导出,否则
// esbuild 会因缺导出而打包失败 —— 值不影响(真 spawnRun 在这套里从不被调)。
export const MAX_LINE_BYTES = 1 * 1024 * 1024;
