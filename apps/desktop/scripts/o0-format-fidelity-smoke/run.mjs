/**
 * O0 —— 六格式保真套件的启动器。
 *
 * **不复制** T16 的执行器：直接调 `../electron-u1/build.mjs`，与 T7 同一条
 * 装配（真 Electron + 真 WebContentsView + 真 vendor 视图工厂）。
 *
 * 用法（在 `apps/desktop` 下）：
 *   node scripts/o0-format-fidelity-smoke/run.mjs                   # 全量（六格式）
 *   node scripts/o0-format-fidelity-smoke/run.mjs --only=docx-fidelity
 *   node scripts/o0-format-fidelity-smoke/run.mjs --no-mutation     # 只跑正常
 *
 * 退出码与 T16 一致（0 全绿 / 1 预期红 / 2 意外红 / 3 自检失败）。
 *
 * ## 本套件的期望（与 T7 相同）
 *
 * 注册表里**没有**「故意失败」旅程，所以正常跑期望 0。断言是否真在判，由
 * `--mutation=unconditional-pass` 对照跑证明 —— 但本卡还要求更强的变异：
 * **删掉/挪走复杂部件后该条必须红**（见卡 §4 与回写区的变异记录）。
 * 那类变异作用于**样本文件**（`.tmp/` 里的副本），由 `mutate.mjs` 驱动，
 * 不走 build.mjs 的 mutation 开关（那个开关会把断言全部旁路，证明的是
 * 「断言在判」，不是「判据抓得到部件丢失」）。
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
    `--prebuild=${join(suite, "../t7-genoffice-u1/prebuild.mjs")}`,
    ...passthrough,
    ...extra,
  ], { cwd: desktop, stdio: "inherit", env: process.env });
  return r.status ?? 1;
};

const normal = run([]);
console.log(`\nO0: 正常跑退出码 ${normal}（期望 0 —— 六条保真旅程无故意失败）`);
if (normal !== 0) {
  console.error("O0: FAIL（证据保留在 .tmp/electron-u1/<时间戳>/）");
  process.exit(normal);
}
if (!mutation) {
  console.log("O0: PASS");
  process.exit(0);
}
// 可选变异对照：断言无条件通过后，正常跑也应是 0（本套件不靠「预期红」自检）。
// 本卡要求的「删部件要红」变异由 mutate.mjs 在样本文件上做（见文件头）。
const mut = run(["--mutation=unconditional-pass"]);
console.log(`O0: 变异跑退出码 ${mut}`);
process.exit(normal === 0 && mut === 0 ? 0 : 1);
