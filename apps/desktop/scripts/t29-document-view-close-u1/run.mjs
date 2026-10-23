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
 * 退出码与 electron-u1 一致（0 全绿 / 1 预期红 / 2 意外红）。本套件**没有**
 * 故意失败旅程，正常跑期望 0；非零即真失败（证据保留在 `.tmp/electron-u1/`）。
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
  `--esbuild=${join(suite, "../t7-genoffice-u1/vendor-esbuild.mjs")}`,
  `--prebuild=${join(suite, "../t7-genoffice-u1/prebuild.mjs")}`,
  ...passthrough,
], { cwd: desktop, stdio: "inherit", env: process.env });
const status = r.status ?? 1;
console.log(`\nT29: 退出码 ${status}（期望 0）`);
if (status !== 0) {
  console.error("T29: FAIL（证据保留在 .tmp/electron-u1/<时间戳>/）");
}
process.exit(status);
