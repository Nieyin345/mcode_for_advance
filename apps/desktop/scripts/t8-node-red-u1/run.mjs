/**
 * T8 —— 运行 Node-RED 原生画布 U1 的入口脚本。
 *
 * 它**不复制** T16 的执行器：直接调 `../electron-u1/build.mjs` 并传：
 *  - `--registry=scripts/t8-node-red-u1/journeys/index.ts`（本套件的旅程注册表）；
 *  - `--esbuild=scripts/t8-node-red-u1/main-esbuild.mjs`（生产主进程的解析别名与
 *    构建期 stub：GenOffice vendor 快照不在本卡判据内）；
 *  - `--prebuild=scripts/t8-node-red-u1/prebuild.mjs`（生产文档视图 preload）。
 *
 * 用法（在 `apps/desktop` 下）：
 *   node scripts/t8-node-red-u1/run.mjs [--only=<journey>] [--mutation]
 *
 * ## 退出码（W22）
 *
 * 子进程（`build.mjs`）的退出码沿用 T16 三档语义：0 全绿 / 1 预期红 / 2 意外红；
 * 它自己还有 3 = 自检失败（故意失败旅程没按预期红 / 变异没生效）。**但这三档
 * 只描述「旅程的结论」—— 它区分不了「构建期崩溃」**：`build.mjs` 在 esbuild
 * 语法错误、`build.mjs` 自身断言失配这类情况下同样是未捕获异常、同样退出 1。
 * W5 实测撞上过：构建失败被本包装器读成 `T8: PASS`（假门禁）。
 *
 * 所以本文件在子进程里注入一份**完成探针**（`child-completion-probe.mjs`，
 * 经 `node --import`，不改 `build.mjs`），用「进程有没有自然走完」这一**事件**
 * （不是读产物推测）把四类情况分开：
 *
 *  | 情况 | 本脚本退出码 | 输出 |
 *  |---|---|---|
 *  | 正式旅程全绿 + 故意失败旅程按预期红（子进程退 1） | **0** | `T8: PASS` |
 *  | 子进程退 0 / 2 / 3（结论性结果，原样透传旧语义） | 1 / 2 / 3（同旧行为） | `T8: FAIL（…）` |
 *  | **构建失败**（esbuild 编译错误） | **4** | `T8: BUILD FAILED` |
 *  | **构建脚本崩溃**（未捕获异常 / `build.mjs` 找不到 / 没走完） | **5** | `T8: BUILD CRASHED（…哪一步）` |
 *  | **spawn 失败**（`status === null`：没起来或被信号杀掉） | **6** | `T8: SPAWN FAILED（根本没跑起来）` |
 *
 * 4/5/6 与子进程透传的 0–3 **不冲突** —— 这是选它们而不是卡面示例的 3/4/5
 * 的原因：`build.mjs` 的 3 已经是「自检失败」，若包装器也用 3 表示构建失败，
 * 两类事实又会共用一个数字。
 *
 * 「正常跑退 0、PASS 打印 T8: PASS」是旧行为，**保持不变**（W1/W2 的回写与
 * `--only` 调试口径依赖它；README 与 negative-control.sh 也按此读）。
 *
 * 变异验证（`--mutation`）：把 driver 的 `assertionStatus` 换成无条件 PASS 后重跑，
 * 全绿说明断言确实由它统一判定；与 T7 同一做法（见 `electron-u1/build.mjs`）。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyChildRun, WRAPPER_EXIT } from "./wrapper-verdict.mjs";

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

/** 完成探针的落盘目录（git 忽略；每次调用一个文件，保留作事后取证）。 */
const probeDir = join(desktop, ".tmp/t8-wrapper-probes");
mkdirSync(probeDir, { recursive: true });
const probeStamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-p${process.pid}`;
let probeSeq = 0;

/**
 * 跑一次子进程构建，并收集其**完成声明**。
 *
 * `spawnSync.status === null` 表示进程根本没有正常退出（ENOENT / 被信号终止）——
 * 旧代码用 `?? 1` 把它当成「预期红」，那是把失败读成成功（W22 §三）。
 * 这里原样保留 `status`/`signal`/`error` 交给 `classifyChildRun`（`wrapper-verdict.mjs`）。
 */
const run = (extra) => {
  probeSeq += 1;
  const probeFile = join(probeDir, `${probeStamp}-${probeSeq}.json`);
  const r = spawnSync(process.execPath, [
    "--import", pathToFileURL(join(suite, "child-completion-probe.mjs")).href,
    join(suite, "../electron-u1/build.mjs"),
    `--registry=${join(suite, "journeys/index.ts")}`,
    `--esbuild=${join(suite, "main-esbuild.mjs")}`,
    `--prebuild=${join(suite, "prebuild.mjs")}`,
    ...passthrough,
    ...extra,
  ], {
    cwd: desktop,
    stdio: "inherit",
    env: { ...process.env, T8_CHILD_PROBE_FILE: probeFile },
  });
  let probe = null;
  try { probe = JSON.parse(readFileSync(probeFile, "utf8")); } catch { probe = null; }
  return { status: r.status, signal: r.signal, error: r.error ?? null, probe, probeFile };
};

/** 「没跑完」三兄弟的退出码（定义在 wrapper-verdict.mjs，与判定逻辑同源）。 */
const EXIT_BUILD_FAILED = WRAPPER_EXIT.BUILD_FAILED;
const EXIT_BUILD_CRASHED = WRAPPER_EXIT.BUILD_CRASHED;
const EXIT_SPAWN_FAILED = WRAPPER_EXIT.SPAWN_FAILED;

/** 报告「没跑完」，并给出对应退出码。永不打印 PASS。 */
function reportIncomplete(where, c) {
  if (c.kind === "build-failed") {
    console.error(`\nT8: BUILD FAILED（${where}：构建期失败，不是任何旅程的结论）`);
    console.error(`T8: 证据保留在 .tmp/electron-u1/<时间戳>/；完成探针：.tmp/t8-wrapper-probes/`);
    process.exit(EXIT_BUILD_FAILED);
  }
  if (c.kind === "build-crashed") {
    console.error(`\nT8: BUILD CRASHED（${where}：构建脚本没走完）`);
    console.error(`T8: ${c.detail}`);
    process.exit(EXIT_BUILD_CRASHED);
  }
  console.error(`\nT8: SPAWN FAILED（${where}：${c.detail}）`);
  process.exit(EXIT_SPAWN_FAILED);
}

// 正常跑：子进程必须「自然走完」且退出码 1（唯一失败的是「故意失败」旅程、形态
// 符合预期）。「走完但退出码不是 1」沿用旧的三档判读（0 = 断言被旁路，2 = 意外
// 失败，3 = 自检失败）—— 那是结论性结果，不是构建问题。
const normal = run([]);
const normalClass = classifyChildRun(normal);
if (normalClass.kind !== "completed") reportIncomplete("正常跑", normalClass);
console.log(`\nT8: 正常跑退出码 ${normalClass.status}（期望 1 —— 正式旅程全绿，故意失败旅程按预期红）`);
if (normalClass.status !== 1) {
  console.error("T8: FAIL（期望 1；0 = 故意失败旅程变绿 = 断言被旁路，2 = 意外失败）");
  console.error("T8: 证据保留在 .tmp/electron-u1/<时间戳>/");
  process.exit(normalClass.status === 0 ? 1 : normalClass.status);
}
if (!mutation) {
  console.log("T8: PASS");
  process.exit(0);
}
// `--mutation`：driver 的 `assertionStatus` 被换成无条件 PASS。期望 **0** —— 故意失败
// 那条由红变绿（`build.mjs` 的变异自检核对翻转），正式旅程仍全绿。
const mut = run(["--mutation=unconditional-pass"]);
const mutClass = classifyChildRun(mut);
if (mutClass.kind !== "completed") reportIncomplete("变异跑", mutClass);
console.log(`T8: 变异跑退出码 ${mutClass.status}（期望 0 —— 故意失败旅程被旁路后变绿）`);
process.exit(mutClass.status === 0 ? 0 : 1);
