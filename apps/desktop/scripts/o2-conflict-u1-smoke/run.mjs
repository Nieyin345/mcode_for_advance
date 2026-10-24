/**
 * O2 —— 启动器。**不复制** T16 的执行器：直接调 `../electron-u1/build.mjs`，
 * 只传本套件的注册表与 T7 的 vendor 构建选项（与 T29/T30 同一形态）。
 *
 * 用法（在 `apps/desktop` 下）：
 *   node scripts/o2-conflict-u1-smoke/run.mjs                 # 全量（六格式）
 *   node scripts/o2-conflict-u1-smoke/run.mjs --only=o2-conflict-docs
 *   O2_MUTATION=hide-notice node scripts/o2-conflict-u1-smoke/run.mjs
 *
 * 退出码：0 = 本次运行的结论与 `expectations.ts` 一致（见下）；1 = 不一致或坏消息。
 *
 * ## ⚠️ 构建失败 ≠ 预期红（本文件第一版在这里栽过）
 *
 * `electron-u1/build.mjs` 在**构建期**崩溃时进程退出码也是 `1` —— 与「旅程按
 * 预期红」的退出码完全相同。第一版直接把 exit 1 读成「四个格式按预期红」并
 * 打印 PASS，而真实情况是 esbuild 连 `journeys.cjs` 都没打出来（一个模块路径
 * 写错）。**这是典型的假绿**（CLAUDE.md 十三/十六条：绿着，但它指的不是它
 * 声称的地方）。
 *
 * 所以本文件不再相信退出码，而是读 `build.mjs` 落盘的
 * `suite-summary.json`（`counts` 逐条分类）再下结论；**没有 summary 就是构建
 * 失败**，一律 FAIL。
 *
 * ## 「预期红」为什么算通过（卡 §四）
 *
 * 本卡是**取证**卡：结论就是「slides/pdf/markdown/html 的生产保存链没有版本
 * 判据，会静默覆盖」。这四个格式的 4a/4b 必须红，且红的原因必须**恰好**是
 * 「保存成功了」（`failBecause`）。`expectations.ts` 把这一判断写成了表；
 * 修好那四个格式之后把 `expectConflict` 翻成 `true`，同一个套件就变成六格
 * 必须全绿的回归网（`--variant=expect-green`）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
// ⚠️ argv 只在**作为主模块**时解析。mutation.mjs 会 import 本文件；
// 模块级解析会把 mutation 自己的 `--only=2` 当成旅程选择器传给 build.mjs
// （实测：变异 2 直接死在 `--only=2 没有匹配到唯一旅程`）。
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const args = isMain ? process.argv.slice(2) : [];
const passthrough = [];
let variant = "accept-red";
for (const value of args) {
  if (value === "--variant=accept-red") variant = "accept-red";
  else if (value === "--variant=expect-green") variant = "expect-green";
  else if (value.startsWith("--only=")) passthrough.push(value);
  else if (value === "--keep") passthrough.push(value);
  else throw new Error(`Unknown option: ${value}`);
}

/** @typedef {Object} SuiteRun
 * @property {number} exit
 * @property {string|null} evidenceRoot
 * @property {{ counts: { total: number; allPass: number; expectedFailure: number; unexpectedFailure: number }; journeys: Array<{ name: string; literalStatus: string; expectation: string; failedStep: string|null }> }|null} summary
 * @property {string} log
 */

/** 跑一次完整套件并解析 summary。`extraArgs` / `env` 给变异脚本用。 */
export function runSuite({ extraArgs = [], env = {} } = {}) {
  const result = spawnSync(process.execPath, [
    join(suite, "../electron-u1/build.mjs"),
    `--registry=${join(suite, "journeys/index.ts")}`,
    `--esbuild=${join(suite, "../t7-genoffice-u1/vendor-esbuild.mjs")}`,
    `--prebuild=${join(suite, "../t7-genoffice-u1/prebuild.mjs")}`,
    ...passthrough,
    ...extraArgs,
  ], {
    cwd: desktop,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30 * 60_000,
    env: { ...process.env, ...env },
  });
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // 边跑边把子进程输出转给调用方（变异脚本用 inherit 时会看到重复，可接受：
  // 这里必须拿到完整文本才能解析 summary 路径）。
  process.stdout.write(result.stdout ?? "");
  if (result.stderr) process.stderr.write(result.stderr);
  const match = /U1 evidence:\s+(.+)/.exec(log);
  const evidenceRoot = match ? match[1].trim() : null;
  let summary = null;
  if (evidenceRoot !== null) {
    const summaryPath = join(evidenceRoot, "suite-summary.json");
    if (existsSync(summaryPath)) {
      try { summary = JSON.parse(readFileSync(summaryPath, "utf8")); } catch { summary = null; }
    }
  }
  return { exit: result.status ?? 1, evidenceRoot, summary, log };
}

/**
 * 判定一次运行是否符合 `expectations.ts` 的结论。
 *
 * - 缺 summary → FAIL（构建期崩溃，不是测试结果）；
 * - 任何 unexpected-failure → FAIL；
 * - accept-red：docs/sheets 必须 all-pass，另外四个必须 expected-failure
 *   （逐条按名字核对，不是只看计数）；
 * - expect-green：全部 all-pass。
 *
 * `--only=` 跑单条时 summary 里只有那一条 —— 只核对**跑到的**旅程，缺的那几条
 * 不算错（否则 `--only` 永远红，调试就没法用）。`--only` 连一条都没匹配上时
 * build.mjs 自己会抛错，不会走到这里。
 */
const CONFLICT_EXPECTED = ["docs", "sheets"];
const CONFLICT_MISSING = ["slides", "pdf", "markdown", "html"];

export function judge(run, mode) {
  const reasons = [];
  if (run.summary === null) {
    return { ok: false, reasons: [`构建/运行失败：${run.evidenceRoot === null ? "没有打印证据根" : `没有 suite-summary.json（${run.evidenceRoot}）`}—— 子进程退出码 ${run.exit}。这不是「预期红」，构建期崩溃同样退出 1。`] };
  }
  if (run.summary.counts.unexpectedFailure > 0) {
    reasons.push(`有 ${run.summary.counts.unexpectedFailure} 条意外失败（不是按 expectations.ts 预期的形态）`);
  }
  const byName = new Map(run.summary.journeys.map((j) => [j.name, j]));
  const onlySelected = passthrough.some((arg) => arg.startsWith("--only="));
  for (const kind of CONFLICT_EXPECTED) {
    const journey = byName.get(`o2-conflict-${kind}`);
    if (!journey) { if (!onlySelected) reasons.push(`缺少旅程 o2-conflict-${kind}（summary 里没有）`); continue; }
    if (journey.expectation !== "all-pass") {
      reasons.push(`o2-conflict-${kind} 应 all-pass（生产链有版本判据），实际 ${journey.expectation}${journey.failedStep ? `（失败于 ${journey.failedStep}）` : ""}`);
    }
  }
  for (const kind of CONFLICT_MISSING) {
    const journey = byName.get(`o2-conflict-${kind}`);
    if (!journey) { if (!onlySelected) reasons.push(`缺少旅程 o2-conflict-${kind}（summary 里没有）`); continue; }
    if (mode === "accept-red") {
      if (journey.expectation !== "expected-failure") {
        reasons.push(`o2-conflict-${kind} 应 expected-failure（${kind} 生产链没有版本判据），实际 ${journey.expectation}${journey.failedStep ? `（失败于 ${journey.failedStep}）` : ""}—— 缺口被修好了就更新 expectations.ts，或者 4a 红的理由变了`);
      }
    } else if (journey.expectation !== "all-pass") {
      reasons.push(`[expect-green] o2-conflict-${kind} 不是 all-pass（实际 ${journey.expectation}${journey.failedStep ? `，失败于 ${journey.failedStep}` : ""}）`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

if (isMain) {
  const run = runSuite();
  const verdict = judge(run, variant);
  if (run.summary !== null) {
    for (const j of run.summary.journeys) {
      console.log(`  ${j.name}: literal=${j.literalStatus} expectation=${j.expectation}${j.failedStep ? ` (failed at ${j.failedStep})` : ""}`);
    }
  }
  if (verdict.ok) {
    console.log(`\nO2: PASS（${variant}）—— ${variant === "accept-red" ? "docs/sheets 拦住冲突；slides/pdf/markdown/html 按预期被静默覆盖" : "六格全绿"}`);
    process.exit(0);
  }
  console.error(`\nO2: FAIL（${variant}）`);
  for (const reason of verdict.reasons) console.error(`  - ${reason}`);
  if (run.evidenceRoot !== null) console.error(`  证据：${run.evidenceRoot}`);
  process.exit(1);
}
