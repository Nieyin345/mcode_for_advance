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
import { fileURLToPath, pathToFileURL } from "node:url";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
// ⚠️ argv 只在**作为主模块**时解析。mutation.mjs 会 import 本文件；
// 模块级解析会把 mutation 自己的 `--only=2` 当成旅程选择器传给 build.mjs
// （实测：变异 2 直接死在 `--only=2 没有匹配到唯一旅程`）。
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const args = isMain ? process.argv.slice(2) : [];
const passthrough = [];
let variant = "accept-red";
/** `--classify-only`：只跑静态归类（不启动 Electron，~4s）——渲染端被别的会话
 *  改坏时，仍然能回答「下一张修复卡多大」这个问题。 */
let classifyOnly = false;
for (const value of args) {
  if (value === "--variant=accept-red") variant = "accept-red";
  else if (value === "--variant=expect-green") variant = "expect-green";
  else if (value.startsWith("--only=")) passthrough.push(value);
  else if (value === "--keep") passthrough.push(value);
  else if (value === "--classify-only") classifyOnly = true;
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
/**
 * ⚠️ 判定**只从 `expectations.ts` 读**，不在这里另写一份格式清单。
 *
 * 第一版这里硬编码了 `CONFLICT_EXPECTED = ["docs","sheets"]` /
 * `CONFLICT_MISSING = [...]`。于是有人（O10）翻 `expectations.ts` 里
 * 一格 `expectConflict` 时，run.mjs 的期望没跟着变 —— 那一格明明修好了、
 * 变成 all-pass，却被判「应 expected-failure」。**两份事实，一处改一处没改。**
 *
 * 现在：`expectConflict: true` → all-pass，`false` → （accept-red 下）
 * expected-failure /（expect-green 下）all-pass。分类的**唯一来源**是那张表。
 */
async function expectationsByKind() {
  const { buildTs } = await import("./esbuild-load.mjs");
  const built = await buildTs(join(suite, "expectations.ts"), join(suite, ".expectations.cjs"));
  const mod = await import(pathToFileURL(built).href + `?t=${Date.now()}`);
  return mod.EXPECTATIONS;
}

export function judge(run, mode, expectations) {
  const reasons = [];
  if (run.summary === null) {
    return { ok: false, reasons: [`构建/运行失败：${run.evidenceRoot === null ? "没有打印证据根" : `没有 suite-summary.json（${run.evidenceRoot}）`}—— 子进程退出码 ${run.exit}。这不是「预期红」，构建期崩溃同样退出 1。`] };
  }
  if (run.summary.counts.unexpectedFailure > 0) {
    reasons.push(`有 ${run.summary.counts.unexpectedFailure} 条意外失败（不是按 expectations.ts 预期的形态）`);
  }
  const byName = new Map(run.summary.journeys.map((j) => [j.name, j]));
  const onlySelected = passthrough.some((arg) => arg.startsWith("--only="));
  if (!expectations) {
    return { ok: false, reasons: ["内部错误：judge 没有拿到 expectations.ts（判定必须只来源于它）"] };
  }
  for (const [kind, exp] of Object.entries(expectations)) {
    const journey = byName.get(`o2-conflict-${kind}`);
    if (!journey) { if (!onlySelected) reasons.push(`缺少旅程 o2-conflict-${kind}（summary 里没有）`); continue; }
    const want = exp.expectConflict || mode === "expect-green" ? "all-pass" : "expected-failure";
    if (journey.expectation !== want) {
      const why = exp.expectConflict
        ? "生产链有版本校验（expectConflict: true）"
        : "生产链没有版本判据（expectConflict: false）";
      reasons.push(
        `o2-conflict-${kind} 应 ${want}（${why}），实际 ${journey.expectation}` +
        `${journey.failedStep ? `（失败于 ${journey.failedStep}）` : ""}—— ` +
        `修好了就翻 expectations.ts 的 expectConflict 并同步 provenance；红了就查 4a 的理由是不是变了`,
      );
    }
  }
  return { ok: reasons.length === 0, reasons };
}

if (isMain) {
  // ── 先做**静态归类**（不启动 Electron）──
  // 它回答「下一张修复卡多大」：docs=host-cas / sheets=vendor-own-guard /
  // slides·pdf·markdown·html=bypass。归类不成立（源码漂移）时整套直接红 ——
  // 后面所有运行时判据都建立在「哪条链没有版本校验」这个前提上。
  let classification;
  try {
    const { buildTs } = await import("./esbuild-load.mjs");
    const built = await buildTs(join(suite, "save-paths.ts"), join(suite, ".save-paths.cjs"));
    const mod = await import(pathToFileURL(built).href + `?t=${Date.now()}`);
    classification = mod.classifySavePaths();
  } catch (error) {
    console.error(`O2: 保存路径归类无法执行：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  console.log("保存路径归类（静态，决定修复卡规模）：");
  for (const row of classification.perFormat) console.log(`  ${row.format.padEnd(9)} ${row.klass}`);
  // ── expectations.ts 自身的自洽：expectConflict 与 provenance 不能互相矛盾 ──
  // 这个字段今晚抓到过一次「期望值写反」；它自己也会成为矛盾源（翻 true 却没改理由）。
  // 放在静态档：不启动 Electron，4 秒内给答案。
  {
    const exps = await expectationsByKind();
    const contradictions = Object.entries(exps)
      .filter(([, e]) => e.expectConflict && /没有版本比较|没有版本判据/.test(e.provenance))
      .map(([kind]) => kind);
    if (contradictions.length > 0) {
      console.error(`
O2: FAIL —— expectConflict=true 但 provenance 仍说「没有版本比较」：${contradictions.join(", ")}（两处必须同时改）`);
      process.exit(1);
    }
  }
  if (!classification.ok) {
    console.error(`O2: FAIL —— 保存路径归类与套件前提不一致：${classification.detail ?? ""}`);
    process.exit(1);
  }
  // ── 失败路径断言（纯 Node，不启动 Electron）──
  // `stagedAtomicWrite` 的「替换失败不删暂存」是唯一一条覆盖**失败路径**的判据；
  // 正常路径的套件永远看不到它。用 node:test 跑编译后的产物（同一条 esbuild 通路）。
  {
    const { buildTs } = await import("./esbuild-load.mjs");
    const testSrc = join(suite, "staged-write.test.ts");
    const testBuilt = await buildTs(testSrc, join(suite, ".staged-write.test.cjs"));
    const r = spawnSync(process.execPath, ["--test", testBuilt], { encoding: "utf8", cwd: desktop });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const passLine = /# pass (\d+)/.exec(out);
    const failLine = /# fail (\d+)/.exec(out);
    console.log(`失败路径断言（stagedAtomicWrite）：pass=${passLine?.[1] ?? "?"} fail=${failLine?.[1] ?? "?"}`);
    if ((r.status ?? 1) !== 0) {
      const lines = out.split(String.fromCharCode(10)).filter((l) => /^not ok|暂存|Expected|actual|expected/.test(l));
      console.error(lines.slice(0, 20).join(String.fromCharCode(10)));
      console.error("O2: FAIL —— stagedAtomicWrite 的失败路径断言没有通过");
      process.exit(1);
    }
  }
  // O11 checks the production Slides Save As IPC handler against an isolated
  // filesystem. Unlike the normal Save path, this handler has no opened target
  // revision; a failed streaming write must never leave a truncated output.
  {
    const { buildTs } = await import("./esbuild-load.mjs");
    const testBuilt = await buildTs(join(suite, "save-as.test.ts"), join(suite, ".save-as.test.cjs"));
    const r = spawnSync(process.execPath, ["--test", testBuilt], { encoding: "utf8", cwd: desktop });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const passLine = /# pass (\d+)/.exec(out);
    const failLine = /# fail (\d+)/.exec(out);
    console.log(`O11 另存为真实 handler 断言：pass=${passLine?.[1] ?? "?"} fail=${failLine?.[1] ?? "?"}`);
    if ((r.status ?? 1) !== 0) {
      console.error(out.split("\n").filter((line) => /not ok|error:|ERR_|Expected|actual|expected|location:/.test(line)).slice(0, 28).join("\n"));
      process.exit(1);
    }
  }
  if (classifyOnly) {
    console.log("O2: 归类及 Save As 失败保护通过（--classify-only：未跑 Electron）");
    process.exit(0);
  }

  const run = runSuite();
  const verdict = judge(run, variant, classification && (await expectationsByKind()));
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
