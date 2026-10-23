/**
 * T8 —— 运行 Node-RED 原生画布 U1 的入口脚本。
 *
 * 它**不复制** T16 的执行器：直接调 `../electron-u1/build.mjs` 并传：
 *  - `--registry=scripts/t8-node-red-u1/journeys/index.ts`（本套件的旅程注册表）；
 *  - `--esbuild=scripts/t8-node-red-u1/main-esbuild.mjs`（生产主进程的解析别名与
 *    构建期 stub：GenOffice vendor 快照不在本卡判据内）；
 *  - `--prebuild=scripts/t8-node-red-u1/prebuild.mjs`（生产文档视图 preload）。
 *
 * 用法（在 `apps/desktop` 下）：
 *   node scripts/t8-node-red-u1/run.mjs [--only=<journey>] [--no-mutation]
 *
 * 退出码与 T16 一致（0 全绿 / 1 预期红 / 2 意外红）。本套件**没有**故意失败
 * 旅程，所以正常跑的期望是 **0**；非零就是真失败（并保留证据现场）。
 *
 * 变异验证（`--mutation`）：把 driver 的 `assertionStatus` 换成无条件 PASS 后重跑，
 * 全绿说明断言确实由它统一判定；与 T7 同一做法（见 `electron-u1/build.mjs`）。
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
    `--esbuild=${join(suite, "main-esbuild.mjs")}`,
    `--prebuild=${join(suite, "prebuild.mjs")}`,
    ...passthrough,
    ...extra,
  ], { cwd: desktop, stdio: "inherit", env: process.env });
  return r.status ?? 1;
};

// T16 的三档退出码：0 = 全部按声明通过；1 = 唯一失败的是「故意失败」旅程且形态符合
// 预期（**注册表里有它时的正常结果**）；2 = 意外失败。本套件注册表**有**一条
// `node-red-deliberate-failure`（骨架自检 + 变异翻转点），所以正常跑的期望是 **1**。
const normal = run([]);
console.log(`\nT8: 正常跑退出码 ${normal}（期望 1 —— 正式旅程全绿，故意失败旅程按预期红）`);
if (normal !== 1) {
  console.error("T8: FAIL（期望 1；0 = 故意失败旅程变绿 = 断言被旁路，2 = 意外失败）");
  console.error("T8: 证据保留在 .tmp/electron-u1/<时间戳>/");
  process.exit(normal === 0 ? 1 : normal);
}
if (!mutation) {
  console.log("T8: PASS");
  process.exit(0);
}
// `--mutation`：driver 的 `assertionStatus` 被换成无条件 PASS。期望 **0** —— 故意失败
// 那条由红变绿（`build.mjs` 的变异自检核对翻转），正式旅程仍全绿。
const mut = run(["--mutation=unconditional-pass"]);
console.log(`T8: 变异跑退出码 ${mut}（期望 0 —— 故意失败旅程被旁路后变绿）`);
process.exit(mut === 0 ? 0 : 1);
