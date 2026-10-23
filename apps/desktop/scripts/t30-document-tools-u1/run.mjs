/**
 * T30 —— 启动器。**不复制** T16 的执行器：直接调 `../electron-u1/build.mjs`，
 * 只传本套件的注册表与构建选项（与 T7 的 `run.mjs` 同一形态）。
 *
 * 用法（在 `apps/desktop` 下）：
 *   node scripts/t30-document-tools-u1/run.mjs                 # 全量（正常 + 变异对照）
 *   node scripts/t30-document-tools-u1/run.mjs --only=docs-tool-roundtrip-wired
 *   node scripts/t30-document-tools-u1/run.mjs --no-mutation   # 只跑正常
 *
 * 退出码与 T16 一致（0 全绿 / 1 预期红 / 2 意外红 / 3 自检失败）。
 *
 * ## 本套件的期望（重要）
 *
 * 注册表里**有**一条 `expect:"fail"` 的 `deliberate-failure`，所以：
 *   - 正常跑：期望**至少**出现一次「预期失败」（退出码 1），其余旅程各自按声明；
 *   - 变异跑（`--mutation=unconditional-pass`）：`deliberate-failure` 必须由红转绿
 *     （退出码 0，或至少不再有 expected-failure）。
 *
 * `docs-tool-roundtrip-production` 在 T40 修复前会红 —— 那是**设计中的红**
 * （它断言的是「生产装配没有接登记簿时，renderer-only 工具被拒绝」，而这条
 * 断言本身就是证据）。所以它不标 `expect:"fail"`：T40 修好后它会**变绿**
 * （拒绝仍成立，但原因变成「请求表里没声明」—— 见回写区）。
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");

const args = process.argv.slice(2);
const passthrough = [];
let mutation = true;
for (const value of args) {
  if (value === "--mutation") mutation = true;
  else if (value === "--no-mutation") mutation = false;
  else if (value.startsWith("--only=")) passthrough.push(value);
  else if (value === "--keep") passthrough.push(value);
  else throw new Error(`Unknown option: ${value}`);
}

const run = (extra) => {
  const result = spawnSync(process.execPath, [
    join(suite, "../electron-u1/build.mjs"),
    `--registry=${join(suite, "journeys/index.ts")}`,
    `--esbuild=${join(suite, "vendor-esbuild.mjs")}`,
    // 复用 T7 的 prebuild：把**生产的** `documentViewPreload.ts` 编到 buildDir，
    // 与发行布局同形（`DocumentViewHost.resolveViewPreload()` 从 `__dirname` 取它）。
    `--prebuild=${join(suite, "../t7-genoffice-u1/prebuild.mjs")}`,
    ...passthrough,
    ...extra,
  ], { cwd: desktop, stdio: "inherit", env: process.env });
  return result.status ?? 1;
};

const normal = run([]);
console.log(`\nT30: 正常跑退出码 ${normal}`);
// 正常跑允许 0（全绿）或 1（预期红）—— 两者都不代表失败；2/3 才是坏消息。
if (normal !== 0 && normal !== 1) {
  console.error("T30: FAIL（意外红 / 自检失败）—— 证据保留在 .tmp/electron-u1/<时间戳>/");
  process.exit(normal);
}
if (!mutation) {
  console.log("T30: PASS（未跑变异对照）");
  process.exit(0);
}
// 变异对照：断言被无条件放行后，`deliberate-failure` 必须不再是 expected-failure。
const mutated = run(["--mutation=unconditional-pass"]);
console.log(`T30: 变异跑退出码 ${mutated}（期望 0：连 deliberate-failure 都变绿）`);
process.exit(mutated === 0 ? 0 : 1);
