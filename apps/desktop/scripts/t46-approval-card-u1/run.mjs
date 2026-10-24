/**
 * T46 —— 运行审批卡真 Electron U1。
 *
 * 复用 `../electron-u1/build.mjs`（真 Electron 启动器 + 旅程断言/证据骨架）与
 * 本卡的 `--prebuild`（把审批卡探针页打进 buildDir）。
 *
 * 用法：
 *   node apps/desktop/scripts/t46-approval-card-u1/run.mjs [--only=<journey>]
 *
 * ## 退出码（W24）
 *
 * 本套件**没有**故意失败旅程，正常跑期望 0。子进程的 1 既可能是「旅程预期红」
 * 也可能是「构建期崩溃」—— 判定改为读 `build.mjs` 落盘的 `suite-summary.json`
 *（见 `../lib/electron-u1-verdict.mjs`）：
 *
 * | 情况 | 本脚本退出码 |
 * |---|---|
 * | completed 0（期望） | 0 |
 * | completed 1/2/3（本套件无预期红旅程 → 都是坏消息） | 原样透传 |
 * | **构建失败** | **4**（`T46: BUILD FAILED`） |
 * | **构建脚本崩溃** | **5**（`T46: BUILD CRASHED`） |
 * | **spawn 失败** | **6**（`T46: SPAWN FAILED`） |
 *
 * `mutate-t46.mjs` 要求撤掉守卫后 `(r.status ?? 1) === 2` —— completed 分支
 * 原样透传 status，那条判据不受影响；构建失败现在退 4/5，裸 `?? 1` 在它那里
 * 也不会再把「没跑起来」读成 2。
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
  prebuild: join(suite, "prebuild.mjs"),
  passthrough,
});
const runClass = classifyU1Run(run);
if (runClass.kind !== "completed") reportIncompleteAndExit("T46", "正常跑", runClass);
const status = runClass.status;
console.log(`\nT46: 退出码 ${status}（期望 0）`);
if (status !== 0) console.error("T46: FAIL（证据保留在 .tmp/electron-u1/<时间戳>/）");
process.exit(status);
