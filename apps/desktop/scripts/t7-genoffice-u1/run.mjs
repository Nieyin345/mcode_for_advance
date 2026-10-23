/**
 * T7 —— 运行六编辑器 U1 的入口脚本。
 *
 * 它**不复制** T16 的执行器：直接调 `../electron-u1/build.mjs` 并传两个附加项：
 *  - `--registry=scripts/t7-genoffice-u1/journeys/index.ts`（本套件的旅程注册表）；
 *  - `--esbuild=scripts/t7-genoffice-u1/vendor-esbuild.mjs`（vendor 主进程的
 *    解析选项：包别名、`?raw`、wasm/字体 loader）。
 *
 * 用法：
 *   node apps/desktop/scripts/t7-genoffice-u1/run.mjs [--only=<journey>] [--no-mutation]
 *
 * 退出码与 T16 一致（0 全绿 / 1 预期红 / 2 意外红）。本套件**没有**故意失败
 * 旅程，所以正常跑的期望是 **0**；非零就是真失败（并保留证据现场）。
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const args = process.argv.slice(2);
const passthrough = [];
let mutation = false;
for (const a of args) {
  if (a === "--mutation") mutation = true;
  else if (a.startsWith("--only=")) passthrough.push(a);
  else if (a === "--keep") passthrough.push(a);
  else throw Error(`Unknown option: ${a}`);
}

const run = (extra) => {
  const r = spawnSync(process.execPath, [
    join(suite, "../electron-u1/build.mjs"),
    `--registry=${join(suite, "journeys/index.ts")}`,
    `--esbuild=${join(suite, "vendor-esbuild.mjs")}`,
    `--prebuild=${join(suite, "prebuild.mjs")}`,
    ...passthrough,
    ...extra,
  ], { cwd: desktop, stdio: "inherit", env: process.env });
  return r.status ?? 1;
};

const normal = run([]);
console.log(`\nT7: 正常跑退出码 ${normal}（期望 0 —— 本套件没有故意失败旅程）`);
if (normal !== 0) {
  console.error("T7: FAIL（证据保留在 .tmp/electron-u1/<时间戳>/）");
  process.exit(normal);
}
if (!mutation) {
  console.log("T7: PASS");
  process.exit(0);
}
// 可选变异：断言无条件通过后，正常跑也应是 0（本套件不靠「预期红」自检）。
// 变异验证在本套件里另有专门脚本（verify.mjs），这里只跑一次供人工比对。
const mut = run(["--mutation=unconditional-pass"]);
console.log(`T7: 变异跑退出码 ${mut}`);
process.exit(normal === 0 && mut === 0 ? 0 : 1);
