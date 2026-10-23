/**
 * T46 —— 运行审批卡真 Electron U1。
 *
 * 复用 `../electron-u1/build.mjs`（真 Electron 启动器 + 旅程断言/证据骨架）与
 * 本卡的 `--prebuild`（把审批卡探针页打进 buildDir）。
 *
 * 用法：
 *   node apps/desktop/scripts/t46-approval-card-u1/run.mjs [--only=<journey>]
 *
 * 退出码与 electron-u1 一致（0 全绿 / 1 预期红 / 2 意外红）。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const args = process.argv.slice(2);
const passthrough = [];
for (const a of args) {
  if (a.startsWith("--only=")) passthrough.push(a);
  else throw Error(`Unknown option: ${a}`);
}

const r = spawnSync(process.execPath, [
  join(suite, "../electron-u1/build.mjs"),
  `--registry=${join(suite, "journeys/index.ts")}`,
  `--prebuild=${join(suite, "prebuild.mjs")}`,
  ...passthrough,
], { cwd: desktop, stdio: "inherit", env: process.env });
const status = r.status ?? 1;
console.log(`\nT46: 退出码 ${status}（期望 0）`);
if (status !== 0) console.error("T46: FAIL（证据保留在 .tmp/electron-u1/<时间戳>/）");
process.exit(status);
