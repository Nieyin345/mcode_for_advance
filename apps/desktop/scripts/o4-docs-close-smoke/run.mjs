/**
 * O4 —— 真 Electron 段启动器：`electron-u1/build.mjs --registry=<本套旅程表>`。
 *
 * 不复制 T16 的执行器（与 T7 / T29 / O0 同一条纪律）。
 *
 * ## 入口约定（与卡 §三 / §六一致）
 *
 *  - 正常跑：主判据（生产装配路径上 docs 关闭）必须全绿 → 退出码 0。
 *  - 修复前：`close-succeeds-within-2s` 必红 → 退出码 2（意外红）。这不是变异，
 *    是**缺陷本态** —— 套件在修复前红过，才说明它指在缺陷上。
 *  - `--mutate`：跑 `mutators.mjs`（三个变异，见那张文件头）。
 *
 * ## vendor 缺失
 *
 * 主判据必须真 Electron + 真 docs 页（卡 §2.1）。vendor 快照没构建时本段
 * **如实失败（exit 2）**，不假装跳过 —— 主判据没跑，绿就是假的。
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { missingVendorArtifacts } from "./vendor-esbuild.mjs";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const repo = resolve(desktop, "../..");

if (process.argv.includes("--mutate")) {
  const r = spawnSync(process.execPath, [join(suite, "mutators.mjs")], {
    cwd: desktop,
    stdio: "inherit",
    env: process.env,
  });
  process.exit(r.status ?? 1);
}

const missing = missingVendorArtifacts(repo);
if (missing.length > 0) {
  console.error("O4: vendor 快照未就绪（主判据必须真 Electron + 真 docs 页，不能跳过）：");
  for (const rel of missing) console.error("  - " + rel);
  process.exit(2);
}

const r = spawnSync(process.execPath, [
  join(suite, "../electron-u1/build.mjs"),
  `--registry=${join(suite, "journeys/index.ts")}`,
  `--esbuild=${join(suite, "vendor-esbuild.mjs")}`,
  `--prebuild=${join(suite, "../t7-genoffice-u1/prebuild.mjs")}`,
], { cwd: desktop, stdio: "inherit", env: process.env });

const status = r.status ?? 1;
console.log(`\nO4: 真 Electron 段退出码 ${status}（期望 0 —— 本套件没有故意失败旅程）`);
if (status !== 0) {
  console.error("O4: FAIL（证据保留在 .tmp/electron-u1/<时间戳>/）");
}
process.exit(status);
