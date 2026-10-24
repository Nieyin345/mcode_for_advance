/**
 * O3 —— 变异验证：把**被测资源**改坏，看对应判据真的红；再逐字节还原。
 *
 * ## 为什么必须是"改资源"而不是"改断言"
 *
 * 本卡的判据大量是"文件在不在 → 页面渲染不渲染"。这类判据最容易空过：
 * 六个 B 全绿可能只是"套件根本没看对地方"。所以每个变异都撤掉**证据源**：
 *
 *  | 变异 | 撤掉什么 | 期望红 |
 *  |---|---|---|
 *  | M1 | `apps/markdown/out/renderer/index.html` 改名 | `B-markdown` |
 *  | M2 | `apps/sheets/out/renderer/index.html` 改名 | `B-sheets` |
 *  | M3 | `availability.json` 的 `bundled` 改为 false | `A2`、`A4`（以及 B 全线） |
 *  | M4 | 内容断言的预期文本换成永不出现的串（`O3_MUTATE_TOKEN=1`） | 六个 `B-*` 全红 |
 *  | M5 | `availability.json` 的 `editorsBundled` 改为 false | **实测无变化** —— 见下 |
 *
 * ## M5 是卡的 §6.2 的前提，而实测它不成立
 *
 * 卡上写「把 `availability.json` 的 `editorsBundled` 改成 false → 第 2/3 条必须红」。
 * 实测（2026-10-24，产物 `release/win-unpacked`，**重启进程**后）：
 *
 *  - `capabilities.hosts` 六项**仍然全 true**（`cli.available` 也仍 true）；
 *  - 原因：`bundle` 分支的 `resolveGenofficeCliPath` 只检查 `format` 与 `bundled`；
 *    `editorsBundled` 只被**构建期**脚本（`stage-genoffice-resources.cjs` /
 *    `verify-genoffice-editors-after-pack.cjs` / `release-readiness` 检查）读，
 *    **运行时没有任何消费方**（`grep -rn editorsBundled apps/desktop/src packages/contracts/src` 零命中）。
 *
 * 所以 M5 记录为「前提不成立」而不是「判据坏了」：A3 仍然读文件断言字段为 true，
 * 它验的是**产物清单**；但它不能、也不该被当成"运行时会受影响"的证据。
 * 真正能红的对应变异是 M3（`bundled: false`）——那会让 CLI 解析失败、hosts 全 false。
 *
 * ## 还原纪律
 *
 * 每个变体：先备份**原始字节** → 改 → 跑套件 → 无论成败都还原 → 用
 * `Buffer.equals`（cmp 的等价物）核对逐字节一致。任何一步失败立即中止并报出。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const repo = resolve(desktop, "../..");
const unpacked = join(repo, "apps/desktop/release/win-unpacked");
const G = join(unpacked, "resources/genoffice");
const mainScript = join(suite, "main.mjs");
const evidenceRoot = join(repo, ".tmp/o3-packaged-u1/mutations");
mkdirSync(evidenceRoot, { recursive: true });

const MUTATE_EVIDENCE_MS = 6 * 60_000;
const results = [];

/** 跑一次套件，返回 { exit, tail, evidenceDir }。 */
function runSuite({ env = {}, evidenceName }) {
  const evidenceDir = join(evidenceRoot, evidenceName);
  rmSync(evidenceDir, { recursive: true, force: true });
  mkdirSync(evidenceDir, { recursive: true });
  const r = spawnSync(process.execPath, [mainScript], {
    cwd: desktop,
    encoding: "utf8",
    timeout: MUTATE_EVIDENCE_MS,
    env: { ...process.env, ...env, O3_EVIDENCE_DIR: evidenceDir },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { exit: r.status, out, evidenceDir, results: readResults(evidenceDir) };
}

function readResults(evidenceDir) {
  try { return JSON.parse(readFileSync(join(evidenceDir, "results.json"), "utf8")).results ?? []; }
  catch { return []; }
}

function statusOf(run, id) {
  return run.results.find((r) => r.id === id)?.status ?? "MISSING";
}

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${ok ? "" : "  ← " + JSON.stringify(detail).slice(0, 600)}`);
}

/** 改名一个 renderer index.html 的变体（M1/M2 共用）。 */
function rendererRenameVariant({ name, kind, expectRed }) {
  const index = join(G, `apps/${kind}/out/renderer/index.html`);
  const backup = index + ".o3-mutation";
  if (!existsSync(index)) throw new Error(`${name}: 找不到 ${index}`);
  const original = readFileSync(index);
  try {
    renameSync(index, backup);
    const run = runSuite({ evidenceName: name });
    check(`${name}: 套件必须红（exit=1）`, run.exit === 1, { exit: run.exit, tail: run.out.slice(-800) });
    check(`${name}: ${expectRed} 必须 FAIL`, statusOf(run, expectRed) === "FAIL", { results: run.results.map((r) => `${r.id}:${r.status}`) });
    // 对照：同一次跑里别的格式应仍然绿（证明红不是"整个 app 起不来"）。
    const others = ["B-docs", "B-sheets", "B-slides", "B-pdf", "B-markdown", "B-html"].filter((id) => id !== expectRed);
    const greenOthers = others.filter((id) => statusOf(run, id) === "PASS");
    check(`${name}: 其它五个格式仍 PASS（红是"这个格式没渲染"，不是 app 崩了）`,
      greenOthers.length === 5, { greenOthers, all: run.results.map((r) => `${r.id}:${r.status}`) });
    // 负控/正控（docs 自己的 C 段）不受影响。
    check(`${name}: 负控 C1/C3/C4 仍 PASS（docs 的链路未被这个变异波及）`,
      ["C1", "C3", "C4"].every((id) => statusOf(run, id) === "PASS"),
      { c: ["C1", "C3", "C4"].map((id) => `${id}:${statusOf(run, id)}`) });
  } finally {
    renameSync(backup, index);
    const restored = readFileSync(index);
    check(`${name}: 还原逐字节一致（Buffer.equals）`, restored.equals(original), { bytes: restored.length });
  }
}

function availabilityVariant({ name, field, value, expectRed }) {
  const file = join(G, "availability.json");
  const original = readFileSync(file);
  const info = JSON.parse(original.toString("utf8"));
  info[field] = value;
  try {
    writeFileSync(file, JSON.stringify(info), "utf8");
    const run = runSuite({ evidenceName: name });
    const reds = expectRed.map((id) => ({ id, status: statusOf(run, id) }));
    check(`${name}: 套件必须红（exit=1）`, run.exit === 1, { exit: run.exit, tail: run.out.slice(-800) });
    check(`${name}: ${expectRed.join("/")} 必须 FAIL`, reds.every((r) => r.status === "FAIL"), { reds, all: run.results.map((r) => `${r.id}:${r.status}`) });
    return run;
  } finally {
    writeFileSync(file, original);
    check(`${name}: 还原逐字节一致（Buffer.equals）`, readFileSync(file).equals(original), {});
  }
}

function main() {
  if (process.platform !== "win32") {
    console.log("O3 mutators: SKIP —— 只在 Windows 上验。");
    process.exit(0);
  }
  console.log("O3 变异验证（每个变体跑一次完整套件，共 5 次；约 8–10 分钟）\n");

  // M1/M2：两条**不同的加载路径**各打一次 —— docs 走 file://，原厂五家走
  // genoffice-app:// 协议。只打一家会漏掉"另一条路的 404 被当成成功"。
  rendererRenameVariant({ name: "M1-markdown-index-renamed", kind: "markdown", expectRed: "B-markdown" });
  rendererRenameVariant({ name: "M2-sheets-index-renamed", kind: "sheets", expectRed: "B-sheets" });

  // M3：bundled=false —— CLI 解析失败 → hosts 全 false、cli 不可用。
  // 注意这里会连带 B 全红（视图装配不了），这是**正确**的传播，不是过强。
  availabilityVariant({ name: "M3-bundled-false", field: "bundled", value: false, expectRed: ["A2", "A4"] });

  // M4：内容断言"恒假"变异 —— 预期文本换成永不出现的串。
  //
  // 期望：五个内容可读的格式（docs/slides/pdf/markdown/html）必须红；
  // **sheets 例外且必须保持绿** —— 它的 DOM 判据里根本没有夹具文本（生产页面
  // 没有可读单元格的面），内容证据在 E1（磁盘侧 CLI 读取）。这里如实记录这个
  // 边界，而不是把它写成"六个全红"来制造一条不存在的覆盖。
  // （第一版写的就是"六个全红"，实测 B-sheets PASS —— 那不是缺陷，是判据的真实
  // 边界；把它改成"红"只会让下一个人以为画布上有可读文本。）
  {
    const run = runSuite({ evidenceName: "M4-token-never-present", env: { O3_MUTATE_TOKEN: "1", O3_PROBE_TIMEOUT_MS: "12000" } });
    check("M4: 套件必须红（exit=1）", run.exit === 1, { exit: run.exit, tail: run.out.slice(-800) });
    const contentKinds = ["B-docs", "B-slides", "B-pdf", "B-markdown", "B-html"];
    check("M4: 五个内容可读的格式全部 FAIL（内容判据真的挂在夹具文本上）",
      contentKinds.every((id) => statusOf(run, id) === "FAIL"),
      { reds: contentKinds.map((id) => `${id}:${statusOf(run, id)}`) });
    check("M4: B-sheets 保持 PASS（它的 DOM 判据不含夹具文本；内容证据在 E1）",
      statusOf(run, "B-sheets") === "PASS",
      { sheets: statusOf(run, "B-sheets"), note: "sheets 的内容只在磁盘层可验，见 kinds.mjs 的 sheets case 注释" });
    check("M4: A1–A5 仍 PASS（红不是环境崩了）",
      ["A1", "A2", "A3", "A4", "A5"].every((id) => statusOf(run, id) === "PASS"),
      { a: ["A1", "A2", "A3", "A4", "A5"].map((id) => `${id}:${statusOf(run, id)}`) });
    // C4 本身也是内容断言（正控 docs 正文是第三份夹具），token 变异下必须跟着红；
    // C1–C3 不是内容断言（只验"失败/还原"），必须仍绿。这一组区分很重要：
    // 如果 C1–C3 也红了，说明 token 变异污染了非内容路径，判据分层就不成立。
    check("M4: C4 FAIL（正控也是内容断言，跟着红）", statusOf(run, "C4") === "FAIL",
      { c4: statusOf(run, "C4") });
    check("M4: C1–C3 仍 PASS（非内容判据不受 token 变异影响）",
      ["C1", "C2", "C3"].every((id) => statusOf(run, id) === "PASS"),
      { c: ["C1", "C2", "C3"].map((id) => `${id}:${statusOf(run, id)}`) });
  }

  // M5：卡的 §6.2 前提 —— editorsBundled=false。实测**不改变**运行时能力。
  // 这个变体不期待红；它证明的是"卡上的前提不成立"，产出记在交付回报里。
  {
    const run = availabilityVariant({
      name: "M5-editorsBundled-false-premise", field: "editorsBundled", value: false,
      // 只期望 A3 红（A3 读的正是这个字段）；A2/A4 不该红 —— 若红了说明有别的
      // 消费方，卡的前提反而成立。用"记录事实"的方式表达，而不是断言。
      expectRed: ["A3"],
    });
    const a2 = statusOf(run, "A2");
    const a4 = statusOf(run, "A4");
    console.log(`\nM5 事实记录：A2(hosts)=${a2}  A4(cliPath)=${a4}`);
    console.log(
      a2 === "PASS" && a4 === "PASS"
        ? "  → 卡 §6.2 的前提不成立：editorsBundled 只被构建期脚本读取，运行时无消费方。已在交付回报中记录。"
        : "  → 注意：A2/A4 变红了，说明运行时确实读了 editorsBundled —— 与 spike 结论相反，需复查。");
    results.push({ name: "M5 premise recorded", ok: true, detail: { a2, a4 } });
  }

  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(evidenceRoot, "mutation-results.json"), JSON.stringify({ results }, null, 2), "utf8");
  console.log(`\nO3 变异：${results.length - failed.length}/${results.length} 判据成立（证据 ${evidenceRoot}）`);
  if (failed.length > 0) {
    console.log("O3 变异：FAIL");
    process.exit(1);
  }
  console.log("O3 变异：PASS");
}

main();
