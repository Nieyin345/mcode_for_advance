/**
 * T7 —— 运行六编辑器 U1 的入口脚本。
 *
 * 它**不复制** T16 的执行器：直接调 `../electron-u1/build.mjs` 并传两个附加项：
 *  - `--registry=scripts/t7-genoffice-u1/journeys/index.ts`（本套件的旅程注册表）；
 *  - `--esbuild=scripts/t7-genoffice-u1/vendor-esbuild.mjs`（vendor 主进程的
 *    解析选项：包别名、`?raw`、wasm/字体 loader）；
 *  - `--prebuild=scripts/t7-genoffice-u1/prebuild.mjs`（生产文档视图 preload）。
 *
 * 用法：
 *   node apps/desktop/scripts/t7-genoffice-u1/run.mjs [--only=<journey>] [--no-mutation]
 *
 * ## 退出码（W24）
 *
 * 本套件**没有**故意失败旅程，正常跑期望 0；非零就是真失败。
 * 但子进程的 1 既可能是「旅程预期红」也可能是「构建期崩溃」——
 * 所以判定改为读 `build.mjs` 落盘的 `suite-summary.json`
 *（见 `../lib/electron-u1-verdict.mjs`）：
 *
 * | 情况 | 本脚本退出码 |
 * |---|---|
 * | completed 0（全绿，期望） | 0 |
 * | completed 1/2/3（本套件无预期红旅程 → 都是坏消息） | 原样透传 |
 * | **构建失败** | **4**（`T7: BUILD FAILED`） |
 * | **构建脚本崩溃** | **5**（`T7: BUILD CRASHED`） |
 * | **spawn 失败** | **6**（`T7: SPAWN FAILED`） |
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runElectronU1, classifyU1Run, reportIncompleteAndExit } from "../lib/electron-u1-verdict.mjs";

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

const run = (extra) => runElectronU1({
  suite,
  desktop,
  esbuild: join(suite, "vendor-esbuild.mjs"),
  prebuild: join(suite, "prebuild.mjs"),
  passthrough,
  extraArgs: extra,
});

const normal = run([]);
const normalClass = classifyU1Run(normal);
if (normalClass.kind !== "completed") reportIncompleteAndExit("T7", "正常跑", normalClass);
console.log(`\nT7: 正常跑退出码 ${normalClass.status}（期望 0 —— 本套件没有故意失败旅程）`);
if (normalClass.status !== 0) {
  console.error("T7: FAIL（证据保留在 .tmp/electron-u1/<时间戳>/）");
  process.exit(normalClass.status);
}
if (!mutation) {
  console.log("T7: PASS");
  process.exit(0);
}
// 可选变异：断言无条件通过后，正常跑也应是 0（本套件不靠「预期红」自检）。
// 变异验证在本套件里另有专门脚本（verify.mjs），这里只跑一次供人工比对。
const mut = run(["--mutation=unconditional-pass"]);
const mutClass = classifyU1Run(mut);
if (mutClass.kind !== "completed") reportIncompleteAndExit("T7", "变异跑", mutClass);
console.log(`T7: 变异跑退出码 ${mutClass.status}`);
process.exit(mutClass.status === 0 ? 0 : 1);
