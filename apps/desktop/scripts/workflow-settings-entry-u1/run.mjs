/**
 * W26 —— 运行「设置 → 工作流 → 画布」U1 的入口脚本。
 *
 * 它**不复制** `electron-u1` 的执行器：直接调 `../electron-u1/build.mjs`，传
 *  - `--registry=scripts/workflow-settings-entry-u1/journeys/index.ts`；
 *  - `--esbuild=scripts/workflow-settings-entry-u1/main-esbuild.mjs`；
 *  - `--prebuild=scripts/workflow-settings-entry-u1/prebuild.mjs`。
 *
 * 用法（在 `apps/desktop` 下）：
 *   node scripts/workflow-settings-entry-u1/run.mjs [--only=<journey>] [--keep]
 *
 * ## 退出码（与 T7 同一套语义，复用 `../lib/electron-u1-verdict.mjs`）
 *
 * 本套件没有故意失败旅程，正常跑期望 **0**。子进程的 1 既可能是「旅程红」也可能
 * 是「构建期崩溃」—— 读 `build.mjs` 落盘的 `suite-summary.json` 区分：
 *
 * | 情况 | 退出码 |
 * |---|---|
 * | completed 0（全绿，期望） | 0 |
 * | completed 1/2/3（本套件无预期红 → 都是坏消息） | 原样透传 |
 * | 构建失败（esbuild） | 4 |
 * | 构建脚本崩溃 / 没走完 | 5 |
 * | spawn 失败 | 6 |
 *
 * 4/5/6 的选择理由见 `lib/electron-u1-verdict.mjs` 文件头（不复用 0–3）。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runElectronU1, classifyU1Run, reportIncompleteAndExit } from "../lib/electron-u1-verdict.mjs";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = join(suite, "../..");
const args = process.argv.slice(2);
const passthrough = [];
for (const a of args) {
  if (a.startsWith("--only=")) passthrough.push(a);
  else if (a === "--keep") passthrough.push(a);
  else throw Error(`Unknown option: ${a}`);
}

const run = (extra) => runElectronU1({
  suite,
  desktop,
  esbuild: join(suite, "main-esbuild.mjs"),
  prebuild: join(suite, "prebuild.mjs"),
  passthrough,
  extraArgs: extra,
});

const normal = run([]);
const normalClass = classifyU1Run(normal);
if (normalClass.kind !== "completed") reportIncompleteAndExit("W26", "正常跑", normalClass);
console.log(`\nW26: 正常跑退出码 ${normalClass.status}（期望 0 —— 本套件没有故意失败旅程）`);
if (normalClass.status !== 0) {
  console.error("W26: FAIL（证据保留在 .tmp/electron-u1/<时间戳>/）");
  process.exit(normalClass.status);
}
console.log("W26: PASS");
process.exit(0);
