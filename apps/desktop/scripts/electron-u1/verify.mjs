/**
 * T16 —— 两趟（正常 / 变异）的**机器判据**。run.sh 只负责按顺序跑与传参；
 * 这里的每条判据独立打印 PASS/FAIL，任一失败整体非零退出。
 *
 * 为什么判据要单独一个文件：`run.sh` 里的 here-doc + python 在多行输出时容易
 * 吞错误码；JS 里每条 check 都能看到实际值。
 */
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) throw Error(`missing --${name}`);
  return argv[i + 1];
};

const normalSummaryPath = opt("normal-summary");
const mutationSummaryPath = opt("mutation-summary");
const normalRc = Number(opt("normal-rc"));
const mutationRc = Number(opt("mutation-rc"));
const mutationFlag = Number(opt("mutation-flag")); // 变异日志里 "U1 MUTATION ACTIVE" 出现次数
const outPath = opt("out");

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const normal = read(normalSummaryPath);
const mutation = read(mutationSummaryPath);

let failures = 0;
const checks = [];
const check = (name, cond, detail) => {
  const c = { name, status: cond ? "PASS" : "FAIL", ...(cond ? {} : { detail }) };
  checks.push(c);
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};
const journey = (suite, name) => suite.journeys.find((j) => j.name === name) ?? null;

// ── 判据 1：两趟的退出码 ────────────────────────────────────────────────
check("正常跑退出码为 1（预期红）", normalRc === 1, { actual: normalRc });
check("变异跑退出码为 0（断言被旁路后全绿）", mutationRc === 0, { actual: mutationRc });
check("变异日志里确实打出了 MUTATION ACTIVE 标记", mutationFlag >= 1, { actual: mutationFlag });

// ── 判据 2：旅程 1 纯 UI 全 PASS ────────────────────────────────────────
const j1 = journey(normal, "ui-project-switch");
check("journey 1 (ui-project-switch) 存在", !!j1);
if (j1) {
  check("journey 1 正常跑所有步骤 PASS", j1.expectation === "all-pass", j1);
  check("journey 1 证据步数 ≥ 15", j1.steps >= 15, { steps: j1.steps });
}
const j1r = j1 ? read(`${j1.evidenceDir}/journey-result.json`) : null;
if (j1r) {
  const shots = j1r.steps.filter((s) => s.screenshot);
  check("journey 1 至少两张截图（initial / after）", shots.length >= 2, { shots: shots.length });
  const changed = j1r.steps.find((s) => s.action.startsWith("assertScreenshotChanged"));
  check("journey 1 两帧截图确实不同（visual 断言生效）", !!changed && changed.status === "PASS", changed);
  const clickStep = j1r.steps.find((s) => s.action.startsWith("click [data-testid=workspace-sidebar] button"));
  check("journey 1 有真实鼠标点击步骤且坐标非零", !!clickStep && clickStep.status === "PASS" && clickStep.observed && clickStep.observed.x > 0, clickStep ?? null);
}

// ── 判据 3：旅程 2 文件副作用 + 真重开 ─────────────────────────────────
const j2 = journey(normal, "file-save-relaunch-persistence");
check("journey 2 (file-save-relaunch-persistence) 存在", !!j2);
if (j2) {
  check("journey 2 正常跑所有步骤 PASS", j2.expectation === "all-pass", j2);
  check("journey 2 真的重开过进程（generations ≥ 2）", j2.generations >= 2, { generations: j2.generations });
  const pids = j2.pids ?? [];
  check("journey 2 每一代 PID 都不同", pids.length === new Set(pids).size && pids.length >= 2, { pids });
  const j2r = read(`${j2.evidenceDir}/journey-result.json`);
  const sideEffectSteps = j2r.steps.filter((s) => s.kind === "sideEffect" && s.status === "PASS");
  check("journey 2 磁盘副作用断言全部 PASS", sideEffectSteps.length >= 5, { passed: sideEffectSteps.length });
  const persistAfterReopen = j2r.steps.find((s) => s.step === "doc-still-beta-after-reopen");
  check("journey 2 在重开后断言到持久化", !!persistAfterReopen && persistAfterReopen.status === "PASS", persistAfterReopen ?? null);
  const reopenCheck = j2r.steps.find((s) => s.step === "db-reopen-project-row");
  check("journey 2 重开后数据库里的项目行还在（真持久化自检）", !!reopenCheck && reopenCheck.status === "PASS", reopenCheck ?? null);
  check("journey 2 有保存后的截图证据", j2r.steps.some((s) => s.screenshot), null);
}

// ── 判据 4：旅程 3 故意失败 + 证据落盘 ─────────────────────────────────
const j3 = journey(normal, "deliberate-failure");
check("journey 3 (deliberate-failure) 存在", !!j3);
if (j3) {
  check("journey 3 的字面结果是 FAIL", j3.literalStatus === "FAIL", j3);
  check("journey 3 按声明算预期失败", j3.expectation === "expected-failure", j3);
  check("journey 3 失败在指定步骤", j3.failedStep === "assert-missing-element", { failedStep: j3.failedStep });
  const j3r = read(`${j3.evidenceDir}/journey-result.json`);
  const failed = j3r.steps.find((s) => s.status === "FAIL");
  check("journey 3 失败步骤有截图证据", !!failed && !!failed.screenshot, failed ?? null);
  check("journey 3 失败步骤有 DOM 快照证据", !!failed && !!failed.domSnapshot, failed ? { dom: failed.domSnapshot } : null);
  if (failed && failed.screenshot) {
    const p = `${j3.evidenceDir}/${failed.screenshot}`;
    let size = -1;
    try { size = readFileSync(p).length; } catch { size = -1; }
    check("journey 3 失败截图文件真实存在且非空", size > 0, { path: p, size });
  }
}

// ── 判据 5：变异前后 deliberate-failure 的翻转 ──────────────────────────
const m3 = journey(mutation, "deliberate-failure");
check("变异跑里 deliberate-failure 存在", !!m3);
if (m3 && j3) {
  check("变异后 deliberate-failure 由 FAIL 翻成 PASS", j3.literalStatus === "FAIL" && m3.literalStatus === "PASS", { normal: j3.literalStatus, mutation: m3.literalStatus });
  check("变异后不再有任何预期失败旅程", mutation.counts.expectedFailure === 0, { expectedFailure: mutation.counts.expectedFailure });
  check("正常跑恰好一条预期失败旅程", normal.counts.expectedFailure === 1, { expectedFailure: normal.counts.expectedFailure });
  check("两趟都没有意外失败旅程", normal.counts.unexpectedFailure === 0 && mutation.counts.unexpectedFailure === 0, {
    normalUnexpected: normal.counts.unexpectedFailure,
    mutationUnexpected: mutation.counts.unexpectedFailure,
  });
}
// 变异跑里 journey 1/2 仍必须全绿（证明变异只影响"判定"，没把旅程弄崩）
for (const name of ["ui-project-switch", "file-save-relaunch-persistence"]) {
  const mj = journey(mutation, name);
  check(`变异跑 ${name} 仍 all-pass`, !!mj && mj.expectation === "all-pass", mj ?? null);
}

const verdict = { schema: 1, failures, checks };
writeFileSync(outPath, JSON.stringify(verdict, null, 2));
console.log(`verify: ${checks.length - failures}/${checks.length} 判据通过`);
process.exit(failures === 0 ? 0 : 1);
