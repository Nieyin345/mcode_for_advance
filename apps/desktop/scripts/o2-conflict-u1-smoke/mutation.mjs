/**
 * O2 —— **变异验证**（卡 §五 的三条，各自要能独立地红）。
 *
 * ## 为什么不能只看「正常跑绿」
 *
 * 「套件全绿」只在它真的指过目标时才有意义（CLAUDE.md 十三）。这里的三个
 * 变异各撤掉**一条判据的证据源**，看对应的那一条是否变红、且其它条仍绿：
 *
 * | # | 变异 | 撤掉什么 | 预期红 | 预期仍绿 |
 * |---|---|---|---|---|
 * | 1 | `strip-revision`（源码） | docs 的版本比较（`documentViewHost.ts`） | docs 的 4a + 4b | docs 的 4c、负控 #5；其它格式不受影响 |
 * | 2 | `hide-notice`（运行时） | 页面上的提示元素（注入 CSS 让它们不可见） | docs 的 4c（以及本来就该红的四个格式的 4c） | **docs/sheets 的 4a、4b 与负控 #5** |
 * | 3 | `negative-conflict`（运行时） | 「没人动过 → 保存成功」的前提（保存前改盘） | docs/sheets 的负控 #5 | — |
 *
 * 第 2 条是卡点名最关键的：它证明 4c 验的是「用户看得见」，不是「host 返回了」。
 * 证据源分开（4a 读 IPC 回包 / 4b 读磁盘 / 4c 读 DOM）就是为了这个 ——
 * 如果三条写成一件事，删 DOM 时三条一起红，就分不清「拦住了但没提示」与
 * 「根本没拦住」。
 *
 * ## 第 1 条为什么改源码、第 2/3 条为什么不改
 *
 * 1 撤的是**产品主进程**的判据（`saveOpenedFile` 里的 `current !== expected`）——
 * 那是真代码，必须改源码并在 finally 里逐字节还原（与 `t29-document-view-close-u1/
 * mutate-t29.mjs` 同一纪律）。
 * 2/3 撤的是**页面/时机**：提示元素长在六个 vendor 渲染端构建产物里（改源码要
 * 重建六份 renderer），而「保存前改盘」本来就是运行时动作。它们经 `O2_MUTATION`
 * 环境变量注入，不改任何产品源码。
 *
 * 用法（在 `apps/desktop` 下）：
 *   node scripts/o2-conflict-u1-smoke/mutation.mjs                 # 三条全跑
 *   node scripts/o2-conflict-u1-smoke/mutation.mjs --only=2
 *
 * 退出码：0 = 三条都按预期变色；1 = 有变异没被抓到 / 红错了地方。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runSuite } from "./run.mjs";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");

const args = process.argv.slice(2);
const only = new Set(args.filter((a) => a.startsWith("--only=")).map((a) => a.slice("--only=".length)));
const want = (n) => only.size === 0 || only.has(n);

/**
 * 整跑六条（不是 `--only`）：变异要同时看「该红的红了」与「不该红的没红」，
 * 而且整跑才能暴露变异对其它格式的副作用。每条 ~25-40s，一轮 ~3 分钟。
 */
function runAll(env = {}) {
  return runSuite({ env });
}

function journeyOf(run, name) {
  if (run.summary === null) return null;
  return run.summary.journeys.find((j) => j.name === name) ?? null;
}

/** 从证据里读某一步的结果（runSuite 的 summary 只给第一失败步，不足以核对矩阵）。 */
function stepsOf(run, kind) {
  if (run.evidenceRoot === null) return null;
  try {
    const file = join(run.evidenceRoot, `o2-conflict-${kind}`, "journey-result.json");
    return JSON.parse(readFileSync(file, "utf8")).steps;
  } catch { return null; }
}

function stepStatus(run, kind, step) {
  const steps = stepsOf(run, kind);
  if (steps === null) return "MISSING";
  const found = steps.find((s) => s.step === step);
  return found ? found.status : "MISSING";
}

/** 读 `4-conflict-criteria` 里某一条判据（4a/4b/4c）的 ok 标志 —— 三条在同一步里
 *  各带一个标志（拆成三步会被 runner 的 fail-fast 吞掉后面的证据）。 */
function criterion(run, kind, key) {
  const steps = stepsOf(run, kind);
  if (steps === null) return "MISSING";
  const combined = steps.find((s) => s.step === "4-conflict-criteria");
  if (!combined) return "MISSING";
  const verdicts = combined.observed;
  if (!verdicts || typeof verdicts !== "object" || !(key in verdicts)) return "MISSING";
  return verdicts[key]?.ok === true ? "PASS" : "FAIL";
}

/* ─────────────────────────── 变异 1：撤掉 docs 的版本比较 ─────────────────────────── */

const HOST_SOURCE = join(desktop, "src/main/document/documentViewHost.ts");
const REVISION_NEEDLE = "        if (current !== expected) {";

async function mutation1() {
  const original = readFileSync(HOST_SOURCE);
  const text = original.toString("utf8");
  const count = text.split(REVISION_NEEDLE).length - 1;
  if (count !== 1) throw new Error(`变异 1：变异点不唯一（出现 ${count} 次）—— 源码变了，先更新 needle`);
  // 让版本比较恒为「一致」：冲突分支永远不进，保存照写。
  const mutated = Buffer.from(text.replace(REVISION_NEEDLE, "        if (false && current !== expected) {"));
  if (mutated.equals(original)) throw new Error("变异 1：替换没有改变文件");
  let run = null;
  try {
    writeFileSync(HOST_SOURCE, mutated);
    if (!readFileSync(HOST_SOURCE).equals(mutated)) throw new Error("变异 1：变异没有落盘");
    run = runAll();
  } finally {
    // 逐字节还原；期间有别的写者动过就拒绝覆盖并报错（与 t29 同一纪律）。
    if (!readFileSync(HOST_SOURCE).equals(mutated)) {
      throw new Error("变异 1：变异期间有别的写者改了源码，拒绝覆盖 —— 请人工核对 documentViewHost.ts");
    }
    writeFileSync(HOST_SOURCE, original);
    if (!readFileSync(HOST_SOURCE).equals(original)) throw new Error("变异 1：还原后字节不一致");
  }
  const docs4a = criterion(run, "docs", "4a");
  const docs4b = criterion(run, "docs", "4b");
  const docs4c = criterion(run, "docs", "4c");
  const docsNegative = stepStatus(run, "docs", "negative-save-succeeds");
  const sheets4a = criterion(run, "sheets", "4a");
  const ok = docs4a === "FAIL" && docs4b === "FAIL" && docsNegative === "PASS" && sheets4a === "PASS";
  return {
    ok,
    observed: { docs4a, docs4b, docs4c, docsNegative, sheets4a, evidence: run.evidenceRoot },
    detail: ok
      ? undefined
      : `变异 1 预期 docs 4a/4b 红、docs 负控与 sheets 4a 仍绿；实际 ${JSON.stringify({ docs4a, docs4b, docsNegative, sheets4a })}`,
  };
}

/* ─────────────────────────── 变异 2：提示元素不可见 ─────────────────────────── */

async function mutation2() {
  const run = runAll({ O2_MUTATION: "hide-notice" });
  const docs4a = criterion(run, "docs", "4a");
  const docs4b = criterion(run, "docs", "4b");
  const docs4c = criterion(run, "docs", "4c");
  const docsNegative = stepStatus(run, "docs", "negative-save-succeeds");
  const sheets4a = criterion(run, "sheets", "4a");
  const sheets4b = criterion(run, "sheets", "4b");
  const sheets4c = criterion(run, "sheets", "4c");
  // ★ 这一条的全部价值：4c 红，4a/4b 仍绿。
  const ok = docs4a === "PASS" && docs4b === "PASS" && docs4c === "FAIL" &&
    docsNegative === "PASS" && sheets4a === "PASS" && sheets4b === "PASS" && sheets4c === "FAIL";
  return {
    ok,
    observed: { docs4a, docs4b, docs4c, docsNegative, sheets4a, sheets4b, sheets4c, evidence: run.evidenceRoot },
    detail: ok
      ? undefined
      : `变异 2 预期「只有 4c 红」：docs 4a=${docs4a} 4b=${docs4b} 4c=${docs4c}，sheets 4a=${sheets4a} 4b=${sheets4b} 4c=${sheets4c}（期望 4a/4b 全 PASS、4c 全 FAIL）`,
  };
}

/* ─────────────────────────── 变异 3：负控前改盘 ─────────────────────────── */

async function mutation3() {
  const run = runAll({ O2_MUTATION: "negative-conflict" });
  const docsNegative = stepStatus(run, "docs", "negative-save-succeeds");
  const sheetsNegative = stepStatus(run, "sheets", "negative-save-succeeds");
  const ok = docsNegative === "FAIL" && sheetsNegative === "FAIL";
  return {
    ok,
    observed: { docsNegative, sheetsNegative, evidence: run.evidenceRoot },
    detail: ok ? undefined : `变异 3 预期负控 #5 红：docs=${docsNegative} sheets=${sheetsNegative}`,
  };
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

const results = [];
if (want("1")) {
  console.log("\n=== 变异 1：撤掉 docs 的版本比较（源码变异 + 逐字节还原）===");
  results.push(["1 strip-revision", await mutation1()]);
}
if (want("2")) {
  console.log("\n=== 变异 2：让冲突提示不可见（运行时注入 CSS）===");
  results.push(["2 hide-notice", await mutation2()]);
}
if (want("3")) {
  console.log("\n=== 变异 3：负控保存前改盘 ===");
  results.push(["3 negative-conflict", await mutation3()]);
}

let failed = 0;
for (const [name, result] of results) {
  if (result.ok) {
    console.log(`MUTATION ${name}: CAUGHT — ${JSON.stringify(result.observed)}`);
  } else {
    failed += 1;
    console.error(`MUTATION ${name}: NOT CAUGHT — ${result.detail}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
