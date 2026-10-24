/**
 * T30 —— 启动器。**不复制** T16 的执行器：直接调 `../electron-u1/build.mjs`，
 * 只传本套件的注册表与构建选项（与 T7 的 `run.mjs` 同一形态）。
 *
 * 用法（在 `apps/desktop` 下）：
 *   node scripts/t30-document-tools-u1/run.mjs                 # 全量（正常 + 变异对照）
 *   node scripts/t30-document-tools-u1/run.mjs --only=docs-tool-roundtrip-wired
 *   node scripts/t30-document-tools-u1/run.mjs --no-mutation   # 只跑正常
 *
 * ## 退出码（W24 重写）
 *
 * 子进程（`build.mjs`）的 0/1/2/3 只描述**旅程的结论**；它在**构建期**崩溃时
 * 同样是 1 退出 —— 而旧版本把 1 读成「预期红」并打印 `T30: PASS（未跑变异对照）`。
 * 2026-10-24 W24 实测复现：esbuild 解析 `cpu-features.node` 失败（构建期），
 * 旧包装器仍退出 0。**这是假门禁。**
 *
 * 现在判定不再信退出码，而是读 `build.mjs` 落盘的 `suite-summary.json`
 *（详见 `../lib/electron-u1-verdict.mjs` 的文件头）：
 *
 * | 情况 | 本脚本退出码 | 输出 |
 * |---|---|---|
 * | 正常跑 completed 且 status ∈ {0,1}（0 全绿 / 1 预期红） | 0 | `T30: PASS…` |
 * | 正常跑 completed 但 status ∈ {2,3}（意外红 / 自检失败） | 原样透传 2/3 | `T30: FAIL…` |
 * | **构建失败**（esbuild 编译错误） | **4** | `T30: BUILD FAILED` |
 * | **构建脚本崩溃**（build.mjs 自己 throw / summary 缺失） | **5** | `T30: BUILD CRASHED` |
 * | **spawn 失败**（`status === null`） | **6** | `T30: SPAWN FAILED` |
 * | 变异跑 completed 且 status 0 | 0 | — |
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runElectronU1, classifyU1Run, reportIncompleteAndExit } from "../lib/electron-u1-verdict.mjs";

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

const run = (extra) => runElectronU1({
  suite,
  desktop,
  esbuild: join(suite, "vendor-esbuild.mjs"),
  // 复用 T7 的 prebuild：把**生产的** `documentViewPreload.ts` 编到 buildDir，
  // 与发行布局同形（`DocumentViewHost.resolveViewPreload()` 从 `__dirname` 取它）。
  prebuild: join(suite, "../t7-genoffice-u1/prebuild.mjs"),
  passthrough,
  extraArgs: extra,
});

const normal = run([]);
const normalClass = classifyU1Run(normal);
if (normalClass.kind !== "completed") reportIncompleteAndExit("T30", "正常跑", normalClass);
console.log(`\nT30: 正常跑退出码 ${normalClass.status}`);
// 正常跑允许 0（全绿）或 1（预期红）—— 两者都不代表失败；2/3 才是坏消息。
if (normalClass.status !== 0 && normalClass.status !== 1) {
  console.error("T30: FAIL（意外红 / 自检失败）—— 证据保留在 .tmp/electron-u1/<时间戳>/");
  process.exit(normalClass.status);
}
if (!mutation) {
  console.log("T30: PASS（未跑变异对照）");
  process.exit(0);
}
// 变异对照：断言被无条件放行后，`deliberate-failure` 必须不再是 expected-failure。
const mutated = run(["--mutation=unconditional-pass"]);
const mutClass = classifyU1Run(mutated);
if (mutClass.kind !== "completed") reportIncompleteAndExit("T30", "变异跑", mutClass);
console.log(`T30: 变异跑退出码 ${mutClass.status}（期望 0：连 deliberate-failure 都变绿）`);
process.exit(mutClass.status === 0 ? 0 : 1);
