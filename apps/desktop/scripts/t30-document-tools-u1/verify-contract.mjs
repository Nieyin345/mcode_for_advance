/**
 * T30 —— **契约自检**（不起 Electron，只验判定逻辑）。
 *
 * 它证明什么、不证明什么：
 *   - 证明：本套件注册表里 `deliberate-failure` 的 `expect`/`failBecause` 形状
 *     是对的 —— 把「全部 PASS」的假证据喂给**真** `verdict.ts` 时，它会按
 *     声明算 expected-failure；把同一条改成 PASS 后，它会翻成 all-pass。
 *     这正是 `build.mjs --mutation=unconditional-pass` 的判据来源。
 *   - 不证明：任何产品行为。产品链路要真 Electron（见 T30 卡与回写区）。
 *
 * 为什么需要它：T30 的产品旅程在 T40 修好前不具备「全绿」形态，所以
 * 「断言真的在判」不能靠它们的绿/红来证明。这个脚本把那条证据从运行时
 * 提前到静态阶段，且与 U1 骨架共用同一份判决代码（不另写一套）。
 *
 * 用法（在 apps/desktop 下）：node scripts/t30-document-tools-u1/verify-contract.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readdirSync } from "node:fs";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const repo = resolve(desktop, "../..");
process.chdir(desktop);

const pnpm = join(repo, "node_modules/.pnpm");
const pkgPath = (prefix, sub) => {
  const name = readdirSync(pnpm).filter((x) => x.startsWith(prefix)).sort().at(-1);
  if (!name) throw Error("Missing installed dependency " + prefix);
  return join(pnpm, name, "node_modules", sub);
};
const esbuildMod = await import(pathToFileURL(pkgPath("esbuild@", "esbuild/lib/main.js")).href);
const esbuild = esbuildMod.build ?? esbuildMod.default.build;

/**
 * 本脚本只需要旅程对象的 `expect` / `failBecause`，不需要执行器。
 * `driver/index.ts` 会 re-export `runner.ts`（它 `import "electron"`），所以在
 * 打包时把 `index.js` 换成只含**纯数据工厂 + 纯判定**的入口 —— 这正是
 * 「静态自检不拖进执行器」的意思。
 */
const driverShimPath = join(suite, "verify-contract.driver-shim.ts");
const driverShim = {
  name: "t30-driver-shim",
  setup(build) {
    build.onResolve({ filter: /\.\.\/\.\.\/electron-u1\/driver\/index\.js$|\/driver\/index\.js$/ },
      () => ({ path: driverShimPath }));
  },
};

const out = mkdtempSync(join(tmpdir(), "t30-contract-"));
const bundle = join(out, "verdict.mjs");
try {
  // verdict.ts 是零 Electron / 零 IO 的纯判定逻辑 —— 单独打包即可直接调。
  await esbuild({
    entryPoints: [join(suite, "../electron-u1/driver/verdict.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    tsconfig: join(desktop, "tsconfig.json"),
    absWorkingDir: desktop,
    outfile: bundle,
    logLevel: "error",
  });
  const { classifyJourney, literalStatus, suiteExitCode, hasDeliberateFailureJourney } =
    await import(pathToFileURL(bundle).href);

  let failures = 0;
  let total = 0;
  const check = (name, condition, detail) => {
    total++;
    if (condition) console.log(`  ok   ${name}`);
    else {
      failures++;
      console.error(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    }
  };

  // 注册表：与 journeys/index.ts 同源（名字 + expect）。
  const registry = [
    { name: "docs-tool-roundtrip-production", expect: "pass" },
    { name: "docs-tool-roundtrip-wired", expect: "pass" },
    { name: "sheets-tool-call", expect: "pass" },
    { name: "deliberate-failure", expect: "fail" },
  ];

  const evidence = (journey, statuses) =>
    statuses.map((status, index) => ({
      journey,
      step: index === 0 ? "open-missing-view" : "assert-missing-view",
      action: index === 0 ? "run" : "run 断言",
      assertion: index === 0 ? null : "run 断言",
      kind: index === 0 ? "action" : "sideEffect",
      status,
      screenshot: null,
      domSnapshot: null,
      at: new Date().toISOString(),
      pid: 1,
      generation: 1,
    }));

  const deliberate = registry.find((j) => j.name === "deliberate-failure");
  // ⚠️ 必须读**真旅程对象**的 failBecause，不能在脚本里再抄一份 ——
  // 抄一份的话，把 deliberate-failure.ts 改坏这里仍然全绿（实测过：假绿）。
  const journeyBundle = join(out, "deliberate.mjs");
  await esbuild({
    entryPoints: [join(suite, "journeys/deliberate-failure.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    tsconfig: join(desktop, "tsconfig.json"),
    absWorkingDir: desktop,
    outfile: journeyBundle,
    logLevel: "error",
    ...(await import(pathToFileURL(join(suite, "vendor-esbuild.mjs")).href)).options,
    // driver 的 `runner.ts` 会 `import { app, BrowserWindow } from "electron"`；
    // 本脚本只需要 `steps.ts` 的纯数据工厂与旅程对象的 `expect`/`failBecause`，
    // 所以把 electron 换成空壳（`import "electron"` 在 node 里解析不到）。
    plugins: [driverShim],
  });
  const realJourney = (await import(pathToFileURL(journeyBundle).href)).deliberateFailure;
  const journeyObj = { expect: realJourney.expect, failBecause: realJourney.failBecause };

  console.log("\n1. 注册表形状");
  check("正好一条 expect:\"fail\" 的自检旅程", hasDeliberateFailureJourney([...registry, journeyObj].slice(-1)) === true);
  check("产品旅程都是 expect:\"pass\"", registry.filter((j) => j.name !== "deliberate-failure").every((j) => j.expect === "pass"));

  console.log("\n2. 正常跑：deliberate-failure 必须按预期红");
  {
    const items = evidence("deliberate-failure", ["PASS", "FAIL"]);
    check("字面结果是 FAIL", literalStatus(items) === "FAIL");
    const verdict = classifyJourney(journeyObj, items);
    check("按声明算 expected-failure", verdict.expectation === "expected-failure", verdict);
  }

  console.log("\n3. 变异跑：断言被无条件放行后必须翻绿");
  {
    const items = evidence("deliberate-failure", ["PASS", "PASS"]);
    const verdict = classifyJourney(journeyObj, items);
    check("字面结果变 PASS", literalStatus(items) === "PASS");
    check("expect:\"fail\" 却全绿 → 报 all-pass（这就是变异生效的证据）",
      verdict.expectation === "all-pass", verdict);
    check("判定理由点名「断言可能被旁路」", /旁路/.test(verdict.reason ?? ""), verdict.reason);
  }

  console.log("\n4. 套件退出码语义");
  {
    const normal = registry.map((j) => ({
      journey: j.name === "deliberate-failure" ? journeyObj : j,
      evidence: evidence(j.name, j.name === "deliberate-failure" ? ["PASS", "FAIL"] : ["PASS", "PASS"]),
    }));
    check("正常跑退出码 = 1（预期红）", suiteExitCode(normal).code === 1, suiteExitCode(normal));

    const mutated = registry.map((j) => ({
      journey: j.name === "deliberate-failure" ? journeyObj : j,
      evidence: evidence(j.name, ["PASS", "PASS"]),
    }));
    check("变异跑退出码 = 0（全绿）", suiteExitCode(mutated).code === 0, suiteExitCode(mutated));

    // 产品旅程红 → 必须是 2（意外红），不是被 deliberate 的 1 掩盖。
    const productRed = registry.map((j) => ({
      journey: j.name === "deliberate-failure" ? journeyObj : j,
      evidence: evidence(j.name, j.name === "deliberate-failure" ? ["PASS", "FAIL"] : j.name === "docs-tool-roundtrip-production" ? ["PASS", "FAIL"] : ["PASS", "PASS"]),
    }));
    check("产品旅程红 → 退出码 = 2（意外红），不被预期红掩盖", suiteExitCode(productRed).code === 2, suiteExitCode(productRed));
  }

  console.log("\n5. failBecause 必须真的在判（三条反例都不得算「预期红」）");
  {
    // 5a. 失败落在别的步骤，但前置动作步骤仍在 —— failBecause 必须拒绝。
    const wrongStep = evidence("deliberate-failure", ["PASS", "FAIL"]).map((e) =>
      e.status === "FAIL" ? { ...e, step: "some-other-step" } : e,
    );
    const verdictA = classifyJourney(journeyObj, wrongStep);
    check("失败落在别的步骤 → unexpected-failure", verdictA.expectation === "unexpected-failure", verdictA);

    // 5b. 失败步骤名对，但**没有**前置动作 PASS —— 也必须拒绝。
    const noPrelude = evidence("deliberate-failure", ["PASS", "FAIL"]).map((e) =>
      e.step === "open-missing-view" ? { ...e, step: "renamed-prelude" } : e,
    );
    const verdictB = classifyJourney(journeyObj, noPrelude);
    check("缺前置动作 PASS → unexpected-failure", verdictB.expectation === "unexpected-failure", verdictB);

    // 5c. 失败于第一个动作步骤（不是断言步骤）—— 必须拒绝。
    const actionFailed = evidence("deliberate-failure", ["FAIL", "PASS"]);
    const verdictC = classifyJourney(journeyObj, actionFailed);
    check("动作步骤先红 → unexpected-failure（不能当成断言在判）", verdictC.expectation === "unexpected-failure", verdictC);
  }

  console.log(`\nverify-contract: ${total - failures}/${total} 判据通过`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  try { rmSync(out, { recursive: true, force: true }); } catch { /* 清理失败不改变结果 */ }
}
void writeFileSync;
