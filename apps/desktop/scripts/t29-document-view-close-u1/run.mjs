/**
 * T29 —— 运行「原厂四编辑器真的能关」的真 Electron U1 套件。
 *
 * 直接复用 `../electron-u1/build.mjs`（真 Electron 启动器 + 旅程断言/证据骨架）
 * 与 `../t7-genoffice-u1/{vendor-esbuild,prebuild}.mjs`（vendor 主进程打包别名、
 * 生产 `documentViewPreload` 产物）——不复制执行器。
 *
 * 用法：
 *   node apps/desktop/scripts/t29-document-view-close-u1/run.mjs [--only=<journey>]
 *
 * ## 退出码（W24）
 *
 * 本套件**没有**故意失败旅程，正常跑期望 0；非零即真失败。但子进程的 1 既可能是
 * 「旅程预期红」也可能是「构建期崩溃」—— 判定改为读 `build.mjs` 落盘的
 * `suite-summary.json`（见 `../lib/electron-u1-verdict.mjs`）：
 *
 * | 情况 | 本脚本退出码 |
 * |---|---|
 * | completed 0（期望） | 0 |
 * | completed 1/2/3（本套件无预期红旅程 → 都是坏消息） | 原样透传 |
 * | **构建失败** | **4**（`T29: BUILD FAILED`） |
 * | **构建脚本崩溃** | **5**（`T29: BUILD CRASHED`） |
 * | **spawn 失败** | **6**（`T29: SPAWN FAILED`） |
 *
 * `mutate-t29.mjs` 要求旅程「意外失败」时 exit === 2 —— `classifyU1Run` 的
 * completed 分支原样透传 status，所以那条判据不受影响。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runElectronU1, classifyU1Run, reportIncompleteAndExit } from "../lib/electron-u1-verdict.mjs";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const args = process.argv.slice(2);
const passthrough = [];
for (const a of args) {
  if (a.startsWith("--only=")) passthrough.push(a);
  else throw Error(`Unknown option: ${a}`);
}

const run = runElectronU1({
  suite,
  desktop,
  esbuild: join(suite, "../t7-genoffice-u1/vendor-esbuild.mjs"),
  prebuild: join(suite, "../t7-genoffice-u1/prebuild.mjs"),
  passthrough,
});
const runClass = classifyU1Run(run);
if (runClass.kind !== "completed") reportIncompleteAndExit("T29", "正常跑", runClass);
const status = runClass.status;
console.log(`\nT29: 退出码 ${status}（期望 0）`);
if (status !== 0) {
  console.error("T29: FAIL（证据保留在 .tmp/electron-u1/<时间戳>/）");
}
process.exit(status);
