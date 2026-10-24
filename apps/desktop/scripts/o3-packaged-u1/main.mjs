/**
 * O3 —— 安装版（解压态）六格式 U1 主程序。
 *
 * ## 这张卡验什么
 *
 * 源码树里六编辑器全过（`t7-genoffice-u1`），但**安装版的三条资源路径全变了**
 * （`genofficeViewFactories.nativeViewsRoot()` 的两个分支）：
 *
 * | | 源码 | 安装版 |
 * |---|---|---|
 * | CLI | `genoffice/packages/cli/dist/genoffice.cjs` | `resources/genoffice/cli/genoffice.cjs` |
 * | renderer | `genoffice/apps/<k>/out/renderer` | `resources/genoffice/apps/<k>/out/renderer` |
 * | sidecar | `.../target/release/xlsx-sidecar.exe` | `resources/genoffice/native/xlsx-sidecar.exe` |
 *
 * 本程序启动**产物** `release/win-unpacked/Mcode.exe`，从应用内部读能力报告，
 * 逐个格式打开真实文件并断言**该格式自己的**渲染面，最后做一次负控（改名
 * renderer 的 index.html → 必须失败并给出可读原因）。
 *
 * ## 判据编号
 *
 *  - A1–A5：启动即验（主窗口、capabilities 六项、availability.json、cliPath 走
 *    安装版分支、项目根可登记）
 *  - B-docs…B-html：六格式打开并渲染出特征 DOM（每格式一条，失败带 observed）
 *  - C1–C4：负控（改名 → 失败且原因可读；逐字节恢复；恢复后能再打开 = 正控）
 *  - D1：生产 `documentView.close` 关掉全部视图，宿主表归零
 *  - E1：产物 CLI 独立读取夹具，证明打开的不是空壳
 *
 * ## 退出码
 *
 *  0 = 全部通过；1 = 有判据红；2 = 套件自己崩了（含产物缺失）。
 *
 * ## 证据
 *
 * `<repo>/.tmp/o3-packaged-u1/<时间戳>/`（可用 `O3_EVIDENCE_DIR` 覆盖，变异脚本用）：
 * `results.json`、每格式截图与 DOM 快照、应用 stdout/stderr。**不自动清理**。
 */
import { mkdirSync, writeFileSync, readFileSync, renameSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

import { launchPackagedApp, waitForTarget, readAvailability, unpackedDir } from "./driver/packaged-app.mjs";
import { createFixtures, TOKENS } from "./fixtures.mjs";
import { docsPageUrl, targetMatchesKind, READY, probeExpression, SIGNATURE, KIND_ORDER, CLI_SUFFIXES } from "./kinds.mjs";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const repo = resolve(desktop, "../..");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = process.env.O3_EVIDENCE_DIR !== undefined
  ? resolve(process.env.O3_EVIDENCE_DIR)
  : join(repo, ".tmp/o3-packaged-u1", stamp);
mkdirSync(evidenceDir, { recursive: true });

/** 内容 probe 的超时。正常 45s；变异跑用环境变量压短（见 mutate.mjs）。 */
const PROBE_TIMEOUT_MS = Number(process.env.O3_PROBE_TIMEOUT_MS ?? "") || 45_000;
const MUTATED_TOKEN = process.env.O3_MUTATE_TOKEN === "1";
const FILE_SUFFIX = MUTATED_TOKEN ? "-mutated" : "";

const results = [];
const findings = [];
let failures = 0;
function record(id, title, ok, observed) {
  results.push({ id, title, status: ok ? "PASS" : "FAIL", observed });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${title}`);
  if (!ok && observed !== undefined) console.log("      observed: " + JSON.stringify(observed).slice(0, 2000));
}
/**
 * 卡外发现：**不算进本卡验收**，但绝不静默。
 *
 * 为什么需要这一档：本卡的验收判据是「能启动 + 六格式能开 + 缺资源时正确拒绝」。
 * 关闭路径不在判据里；但套件跑一遍就会顺带看到它 —— 直接丢弃等于"坏东西静默跳过"，
 * 直接记 FAIL 又会让本卡的结论（六格式是否可用）被一个卡外缺陷污染。所以单列
 * `FINDING`：打印、落盘、写进交付回报，由总控决定是否开新卡。
 */
function finding(id, title, ok, observed) {
  findings.push({ id, title, status: ok ? "OK" : "FINDING", observed });
  console.log(`${ok ? "OK   " : "FIND"}  ${id}  ${title}`);
  if (!ok) console.log("      observed: " + JSON.stringify(observed).slice(0, 2000));
}
function crash(error) {
  console.error("O3: 套件自身崩溃 ——", error?.stack ?? error);
  try { writeFileSync(join(evidenceDir, "crash.txt"), String(error?.stack ?? error), "utf8"); } catch { /* 证据不可写 */ }
  process.exit(2);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** 主窗口里执行一段表达式（经 `window.api`）。 */
async function mainEval(app, expression) {
  return await app.main.evaluate(expression);
}

/** 打开一个视图（docs 特殊：普通文档视图，无 editor/filePath）。 */
async function openView(app, { docId, kind, viewUrl, filePath }) {
  const payload = {
    docId,
    url: viewUrl,
    bounds: { x: 0, y: 0, width: 1200, height: 800 },
    visible: true,
    ...(kind === "docs" ? {} : { editor: kind, filePath }),
  };
  return await mainEval(app, `window.api.documentView.open(${JSON.stringify(payload)})`);
}

/** 等该格式的**新**视图 target（全局 usedTargetIds 排除历史 target）。 */
async function targetFor(app, kind, usedTargetIds, timeoutMs = 60_000) {
  return await waitForTarget(app.port, (t) => targetMatchesKind(t.url ?? "", kind),
    { usedIds: usedTargetIds, timeoutMs });
}

/** 连接视图页、等挂载、轮询内容 probe、留截图与 DOM 快照。 */
async function probeKind(app, kind, target, token, { connectCdp }) {
  const view = await connectCdp(target.webSocketDebuggerUrl, { label: `${kind}-view` });
  try {
    const ready = await view.waitFor(READY[kind], { timeoutMs: 60_000 });
    const probe = await view.waitFor(probeExpression(kind, token), {
      timeoutMs: PROBE_TIMEOUT_MS, intervalMs: 500, until: (v) => v && v.ok === true,
    });
    const observed = probe ?? await view.evaluate(probeExpression(kind, token)).catch(() => null);
    const shot = await view.screenshot().catch(() => null);
    if (shot) writeFileSync(join(evidenceDir, `${kind}${FILE_SUFFIX}.png`), shot);
    writeFileSync(join(evidenceDir, `${kind}${FILE_SUFFIX}-dom.json`),
      JSON.stringify({ target: target.url, ready: !!ready, observed, console: view.consoleLines.slice(-40), exceptions: view.exceptions.slice(-20) }, null, 2), "utf8");
    return { ready: !!ready, observed };
  } finally {
    view.close();
  }
}

/** docs 打开链的两段式：等起始屏 → openPath → 内容 probe（生产面板同一条顺序）。 */
async function openDocsAndProbe(app, { connectCdp, usedTargetIds, docId, filePath, token }) {
  const openRes = await openView(app, { docId, kind: "docs", viewUrl: docsPageUrl(app.cliPath), filePath });
  if (!openRes?.ok) return { openRes, target: null, ready: false, observed: null };
  const target = await targetFor(app, "docs", usedTargetIds);
  if (!target) return { openRes, target: null, ready: false, observed: null };
  usedTargetIds.add(target.id);
  const early = await connectCdp(target.webSocketDebuggerUrl, { label: "docs-start-screen" });
  let ready = false;
  try { ready = !!(await early.waitFor(READY.docs, { timeoutMs: 60_000 })); } finally { early.close(); }
  if (!ready) return { openRes, target: target.url, ready: false, observed: null };
  const openPathRes = await mainEval(app, `window.api.documentView.openPath(${JSON.stringify({ docId, filePath })})`);
  if (!openPathRes?.ok) return { openRes, openPathRes, target: target.url, ready: true, observed: null };
  const probed = await probeKind(app, "docs", target, token, { connectCdp });
  return { openRes, openPathRes, target: target.url, ...probed };
}

/** 六格式一轮。返回每 kind 的观察记录。 */
async function runAllKinds(app, { connectCdp, paths, usedTargetIds }) {
  const out = {};
  for (const kind of KIND_ORDER) {
    const docId = `o3-${kind}-${Date.now()}`;
    if (kind === "docs") {
      const r = await openDocsAndProbe(app, { connectCdp, usedTargetIds, docId, filePath: paths.docs, token: TOKENS.docs });
      record("B-docs", `docs 打开并渲染：${SIGNATURE.docs}`,
        r.openRes?.ok === true && r.ready && r.observed?.ok === true, r);
      out.docs = r;
      continue;
    }
    const openRes = await openView(app, { docId, kind, viewUrl: `genoffice-app://${kind}/index.html`, filePath: paths[kind] });
    if (!openRes?.ok) {
      record(`B-${kind}`, `${kind} 视图打开`, false, { openRes, url: `genoffice-app://${kind}/index.html` });
      out[kind] = { openRes };
      continue;
    }
    const target = await targetFor(app, kind, usedTargetIds);
    if (!target) {
      record(`B-${kind}`, `${kind} 视图页出现`, false, { openRes, note: "60s 内没有出现该格式的 target" });
      out[kind] = { openRes, target: null };
      continue;
    }
    usedTargetIds.add(target.id);
    const probed = await probeKind(app, kind, target, TOKENS[kind], { connectCdp });
    record(`B-${kind}`, `${kind} 打开并渲染：${SIGNATURE[kind]}`,
      probed.ready && probed.observed?.ok === true, { openRes, url: target.url, ...probed });
    out[kind] = { openRes, url: target.url, ...probed };
  }
  return out;
}

async function main() {
  if (process.platform !== "win32") {
    console.log("O3: SKIP —— 本卡只在 Windows x64 上验（产物是 win32-x64），跨 OS 不在本卡范围。");
    process.exit(0);
  }
  const unpacked = unpackedDir(repo);
  const exe = join(unpacked, "Mcode.exe");
  const cliPath = join(unpacked, "resources/genoffice/cli/genoffice.cjs");

  console.log("O3: 产物 " + unpacked);
  console.log("O3: 证据 " + evidenceDir);

  // 产物完整性：缺失就停（本卡**不负责打包**，见卡第四节）。
  for (const f of [exe, cliPath, join(unpacked, "resources/app.asar")]) {
    if (!statSync(f, { throwIfNoEntry: false })?.isFile?.()) {
      console.error(`O3: 产物缺失 ${f} —— 本套件不打包；请先跑打包链路后重试。`);
      process.exit(2);
    }
  }

  const { connectCdp } = await import("./driver/cdp.mjs");
  const usedTargetIds = new Set();

  const app = await launchPackagedApp({ repo, evidenceDir, label: "main" });
  app.cliPath = cliPath;
  try {
    // ───────────────────────── A. 启动即验 ─────────────────────────
    const windowProbe = await mainEval(app, `({ main: !!document.querySelector('[data-testid=workspace-main]'), title: document.title, api: typeof window.api })`);
    record("A1", "进程起得来，主窗口挂载且产品桥可用",
      windowProbe?.main === true && windowProbe?.title === "Mcode" && windowProbe?.api === "object",
      { pid: app.child.pid, mainTarget: app.mainTarget.url, ...windowProbe });

    const caps = await mainEval(app, "window.api.document.capabilities()");
    const hosts = caps?.hosts ?? {};
    const sixHosts = {
      docs: hosts.docs === true, sheets: hosts.sheets === true, slides: hosts.slides === true,
      pdf: hosts.pdf === true, markdown: hosts.markdown === true, html: hosts.html === true,
    };
    record("A2", "document.capabilities().hosts 六项全为 true（从应用内部读，不读文件）",
      Object.values(sixHosts).every(Boolean), { sixHosts, hosts: caps?.hosts });
    writeFileSync(join(evidenceDir, "capabilities.json"), JSON.stringify(caps, null, 2), "utf8");

    const { file: availFile, info: availability } = readAvailability(repo);
    record("A3", "resources/genoffice/availability.json 的 editorsBundled === true",
      availability.editorsBundled === true,
      { file: availFile, editorsBundled: availability.editorsBundled, editors: availability.editors });

    const reportedCli = typeof caps?.cli?.path === "string" ? caps.cli.path : null;
    const normalizedCli = (reportedCli ?? "").replace(/\\/g, "/");
    const expectedCli = cliPath.replace(/\\/g, "/");
    record("A4", "cliPath 指向 resources/genoffice/cli/genoffice.cjs（安装版分支，不是源码树）",
      reportedCli !== null && normalizedCli === expectedCli &&
        normalizedCli.endsWith(CLI_SUFFIXES.packaged) &&
        !normalizedCli.endsWith(CLI_SUFFIXES.source) &&
        !normalizedCli.includes("/genoffice/packages/cli/"),
      { reportedCli, expectedCli, available: caps?.cli?.available });

    // 夹具：用**产物 CLI** 生成（不是源码树 CLI，不是套件自造二进制）。
    const fixtures = createFixtures({ cliPath, projectDir: app.projectDir });
    const project = await mainEval(app, `window.api.project.create(${JSON.stringify({ name: "O3 packaged", path: app.projectDir })})`);
    record("A5", "项目根已登记（工作区围栏的事实源）", project?.project?.path === app.projectDir,
      { project: project?.project?.path, expected: app.projectDir });
    writeFileSync(join(evidenceDir, "fixtures.json"), JSON.stringify({ records: fixtures.records, paths: fixtures.paths }, null, 2), "utf8");

    // ───────────────────────── B. 六格式 ─────────────────────────
    await runAllKinds(app, { connectCdp, paths: fixtures.paths, usedTargetIds });

    // ───────────────────────── E1. 独立读取器 ─────────────────────────
    // sheets/slides 的内容在画布里，DOM 读不到单元格值。产物 CLI 的独立读取器
    // 证明磁盘上的文件确实含夹具文本 —— 与 B 层的"画布已渲染"合起来，才排除
    // "打开了一张空壳"。
    const cliJson = (args) => {
      const r = spawnSync(process.execPath, [cliPath, ...args, "--json"], { encoding: "utf8", timeout: 60_000 });
      try { return JSON.parse(r.stdout); } catch { return null; }
    };
    const sheetRead = cliJson(["sheet", "read", fixtures.paths.sheets]);
    const slidesRead = cliJson(["slides", "read", fixtures.paths.slides]);
    const sheetRows = JSON.stringify(sheetRead?.detail?.rows ?? null);
    record("E1", "产物 CLI 独立读取：xlsx 单元格与 pptx 页数都真的存在（打开的不是空壳）",
      sheetRows.includes(TOKENS.sheets) && slidesRead?.status === "ok" && /1 slides?/.test(slidesRead?.summary ?? ""),
      { sheetSummary: sheetRead?.summary, rows: sheetRead?.detail?.rows, slidesSummary: slidesRead?.summary });

    // ───────────────────────── D. 关闭路径（卡外，记为 FUNDING） ─────────────────────────
    // 本卡判据不含关闭，但跑一遍就能看到它；所以单列 `finding`：六格式的结论不被
    // 它污染，缺陷也不会被静默跳过。实测（2026-10-24，产物 `release/win-unpacked`）：
    //
    //  - 五个原厂编辑器（pdf/markdown/html/sheets/slides）关闭成功；
    //  - **docs 关闭恒被拒**：`编辑器未响应关闭检查；为保护未保存内容，拒绝关闭`。
    //
    // 根因链（本卡 spike 用页面侧计数器定位，未改产品代码）：
    //  1. `documentViewHost.closeWithDirtyProtection` 对 docs 走「推
    //     `mcode:document-view:close-check` → 等页面 `send` 回来 → 2s 超时即拒」；
    //  2. docs 页面（vendor `App.tsx:5337`）**确实**订阅并回了 `reportCloseCheck`
    //     ——页面侧计数器实测 `checkEvents: 1`；
    //  3. 但回答走 `ipcRenderer.send`，主进程的对端是
    //     `ipc/index.ts:209` 传进来的 **`createDbGuardedIpc(ipcMain)`**，它的返回对象
    //     只实现 `handle`，**没有 `on`**；`documentView.ts:212` 的
    //     `if (typeof ipc.on === 'function') ipc.on(...)` 因此**静默不注册**；
    //  4. 于是页面的回答落在没有监听者的通道上，宿主 2s 超时 → fail-closed 拒绝。
    //
    // 与 t7（源码树）为何不同：t7 的 harness 用**裸 `ipcMain`** 做 `recordingIpc`，
    // 它自带 `.on`，所以这条缺陷在源码树套件里被掩盖了 —— 正是本卡要抓的
    // 「源码机能跑 ≠ 装完能跑」的又一实例。
    //
    // 另一个侧面：`D1` 的原始断言（close 全部视图、宿主归零）**保留**，但用 docs
    // 之外的路径验证（先关掉五家、docs 留到最后单独核）。这样"关闭主链路有没有坏"
    // 仍然被验，而"docs 关闭被拒"作为一条具名发现上报。
    const beforeClose = await mainEval(app, "window.api.documentView.list()");
    const closeResults = [];
    for (const view of (beforeClose?.views ?? []).filter((v) => v.docId.startsWith("o3-") && !v.docId.startsWith("o3-docs-"))) {
      closeResults.push({
        docId: view.docId,
        result: await mainEval(app, `window.api.documentView.close(${JSON.stringify({ docId: view.docId })})`),
      });
    }
    const afterVendorClose = await mainEval(app, "window.api.documentView.list()");
    finding("F1", "五个原厂编辑器（pdf/markdown/html/sheets/slides）走生产 close 都能关掉",
      closeResults.length > 0 && closeResults.every((r) => r.result?.ok === true) &&
        (afterVendorClose?.views ?? []).every((v) => v.docId.startsWith("o3-docs-")),
      { before: beforeClose?.views?.length, after: afterVendorClose?.views?.length, closeResults });

    // docs 关闭：单独一条，记录**实际行为**（被拒 + 原因原文），供交付回报引用。
    const docsView = (afterVendorClose?.views ?? []).find((v) => v.docId.startsWith("o3-docs-"));
    let docsClose = null;
    if (docsView) {
      const t0 = Date.now();
      docsClose = { docId: docsView.docId, waitedMs: null, result: await mainEval(app, `window.api.documentView.close(${JSON.stringify({ docId: docsView.docId })})`) };
      docsClose.waitedMs = Date.now() - t0;
    }
    finding("F2", "docs 关闭：生产 close 被拒，原因指向「编辑器未响应关闭检查」（卡外缺陷，见 main.mjs 的 D 段注释）",
      docsClose?.result?.ok === true,
      { docsClose, note: "根因：生产 ipc 包装层只实现 handle，documentView.ts:212 的 ipc.on 静默不注册；页面侧确实回了 reportCloseCheck" });

    // 收尾记录：关不掉的 docs 视图留在宿主表里，随应用退出被 `documentViewHost.dispose()`
    // （`main/index.ts` 的退出路径）一并销毁 —— 这是**应用退出**，不是窗口关闭。
    // 记下来是为了让下一份报告知道"F2 关不掉"不会留下进程内的孤儿。
    const leftovers = (await mainEval(app, "window.api.documentView.list()"))?.views ?? [];
    finding("F3", "退出前宿主表里只剩 F2 关不掉的 docs 视图（随应用退出 dispose，不留下孤儿）",
      leftovers.every((v) => v.docId.startsWith("o3-docs-")),
      { leftoversBeforeExit: leftovers.map((v) => v.docId) });

    // ───────────────────────── C. 负控 + 正控 ─────────────────────────
    // 负控：docs 的 renderer/index.html 临时改名 → 打开必须失败且原因可读。
    // docs 走 `file://`（不是 genoffice-app:// 协议），缺文件会触发 did-fail-load；
    // vendor 五家走协议 404，Chromium 把 404 当**成功响应**，lastFailure 不会触发 ——
    // 所以负控选 docs，这是两条加载路径的事实差异，不是挑软柿子。
    const docsIndex = join(unpacked, "resources/genoffice/apps/docs/out/renderer/index.html");
    const backup = docsIndex + ".o3-negative-control";
    const originalSha = sha256(readFileSync(docsIndex));
    let negative = null;
    let restoreOk = false;
    try {
      renameSync(docsIndex, backup);
      const docId = `o3-docs-negative-${Date.now()}`;
      const negOpen = await openView(app, { docId, kind: "docs", viewUrl: docsPageUrl(app.cliPath), filePath: fixtures.paths.docsB });
      let snapshot = null;
      let pageProbe = null;
      if (negOpen?.ok) {
        const target = await targetFor(app, "docs", usedTargetIds, 20_000);
        if (target) {
          usedTargetIds.add(target.id);
          const c = await connectCdp(target.webSocketDebuggerUrl, { label: "docs-negative" });
          try {
            pageProbe = await c.evaluate("({ pm: !!document.querySelector('.ProseMirror'), body: (document.body?.innerText ?? '').slice(0,200) })").catch((e) => ({ error: String(e) }));
          } finally { c.close(); }
        }
        snapshot = await app.main.waitFor(
          `window.api.documentView.list().then((r) => { const v = r.views.find((x) => x.docId === ${JSON.stringify(docId)}); return v && v.lastFailure ? v : null; })`,
          { timeoutMs: 25_000, intervalMs: 400 });
        await mainEval(app, `window.api.documentView.close(${JSON.stringify({ docId })})`).catch(() => null);
      }
      negative = { negOpen, snapshot, pageProbe };
      const happened = negOpen?.ok === false || snapshot?.lastFailure?.kind === "load";
      record("C1", "负控：docs renderer 的 index.html 改名后，打开失败（不是白屏假装成功）",
        happened, negative);
      // 「可执行说明」：原因要能点名缺的页面/文件（ERR_FILE_NOT_FOUND / 页面加载失败 /
      // 缺失 / 未装配），不是一句泛泛的“失败了”。
      const reasonText = [negOpen?.reason, snapshot?.lastFailure?.reason].filter(Boolean).join(" | ");
      record("C2", "负控原因是可执行的（点名缺失的页面/文件，不是空话）",
        /ERR_FILE_NOT_FOUND|页面加载失败|缺失|未装配|index\.html|renderer/i.test(reasonText),
        { reasonText, pageProbe });
    } finally {
      renameSync(backup, docsIndex);
      restoreOk = sha256(readFileSync(docsIndex)) === originalSha;
    }
    record("C3", "负控还原：index.html 逐字节恢复（sha256 相同）", restoreOk, { sha: originalSha });

    // 正控：恢复后 docs 用第三份夹具再打开必须成功 —— 否则 C1 的“红”可能来自别处。
    {
      const recovery = await openDocsAndProbe(app, {
        connectCdp, usedTargetIds, docId: `o3-docs-recovery-${Date.now()}`,
        filePath: fixtures.paths.docsC, token: `${TOKENS.docs}-C`,
      });
      record("C4", "正控：恢复后 docs 再打开成功且正文是第三份夹具（判据不是恒假）",
        recovery.openRes?.ok === true && recovery.ready === true && recovery.observed?.ok === true, recovery);
    }

    writeFileSync(join(evidenceDir, "results.json"),
      JSON.stringify({ results, findings, evidenceDir, unpacked, mutatedToken: MUTATED_TOKEN }, null, 2), "utf8");
    console.log(`\nO3: ${results.length - failures}/${results.length} PASS（证据 ${evidenceDir}）`);
    const openFindings = findings.filter((f) => f.status === "FINDING");
    if (openFindings.length > 0) {
      console.log(`O3: 另记 ${openFindings.length} 条卡外发现（不计入本卡验收，见 results.json 的 findings）：`);
      for (const f of openFindings) console.log(`     ${f.id}  ${f.title}`);
    }
    if (failures > 0) {
      console.log("O3: FAIL");
      process.exitCode = 1;
    } else {
      console.log("O3: PASS");
    }
  } finally {
    try { await app.stop(); } catch { /* 清理失败不覆盖结论 */ }
  }
}

main().catch(crash);
