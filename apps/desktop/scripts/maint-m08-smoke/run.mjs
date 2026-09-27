/**
 * MAINT-2026-08 / M08 独占冒烟 —— **终端与代码/命令执行**。
 *
 * ## 为什么另起一套(而不是扩旧的三套)
 *
 * 旧的三套各钉一块:`terminal-smoke` 管终端(shell 解析 / PTY 生命期 / IPC 文案,含真 PTY)、
 * `command-runner-smoke` 管**命令节点**、`code-electron-smoke` 只钉「Electron 里跑 node
 * 代码节点」的四种终局状态。**代码节点的其余三种语言(python / shell / powershell)一条都
 * 没验过**,而它们恰恰是这一层最容易和「用户环境」耦上的地方:
 *
 *   - 代码先写进 `os.tmpdir()` 下的临时文件,再按语言拼解释器与参数形状;
 *   - 临时目录是**用户环境决定的** —— `C:\Users\John Smith\AppData\Local\Temp` 这种带空格的
 *     用户名在 Windows 上遍地都是。拼出来的命令行只要被**重新解析一次**,脚本就跑不起来,
 *     而用户看到的是一句和代码毫无关系的 cmd 报错。
 *
 * ## 它是什么形状
 *
 * 用 esbuild 把**生产源码**直接打包进来调用(不复制算法、不注入假 spawn,跑真进程):
 *   - `main/orchestration/codeRunner.ts`  —— 代码节点本体
 *   - `main/terminal/envRefresh.ts`       —— PTY 环境(环境变量泄漏那一维)
 *   - `packages/contracts/src/nodeType.ts` —— 协议前缀等常量(判据不写死)
 *
 * ## 隔离
 *
 * 所有夹具都落在本套自己的**临时根**里(`.tmp/maint-m08-XXXX/`),不碰用户库、模型与项目文件;
 * 代码节点自己的临时文件由它自己删,本套只核对它有没有删干净。退出前只清本套起的进程。
 *
 * ## 它不验什么(诚实清单)
 *
 *  - 渲染端(xterm / 节点面板)一行都不验;
 *  - `lib/spawnRun.ts` / `lib/outBuf.ts`(命令节点与代码节点共用的那层:杀进程树、按字节
 *    收尾、编码判定)不在本套的判据里,它们有自己的套件 —— 本套只在**端到端行为**上依赖它;
 *  - 终端 shell 解析与 PTY 生命期不重复(`terminal-smoke` 已覆盖);
 *  - 临时路径里含 `&` 这一类**残余限制**只记录、不断言(见 observations.json 与报告)。
 *
 * Run: scripts/maint-m08-smoke/run.sh
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(source, "../..");
const repo = resolve(desktop, "../..");

/* ────────────────────────── 账本与证据目录 ────────────────────────── */

mkdirSync(join(desktop, ".tmp"), { recursive: true });
const evidence = mkdtempSync(join(desktop, ".tmp", "maint-m08-"));
const build = join(evidence, "build");
const lines = [];
const checks = [];
let failed = 0;

function check(name, cond, detail) {
  const pass = cond === true;
  checks.push(pass ? { name, pass } : { name, pass, detail });
  const line = `${pass ? "PASS" : "FAIL"} ${name}${pass || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`;
  lines.push(line);
  console.log(line);
  if (!pass) failed += 1;
}

function record(name, value) {
  writeFileSync(join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/* ────────────────────────── 打包生产源码 ────────────────────────── */

const pnpm = join(repo, "node_modules", ".pnpm");
const esbuildDir = readdirSync(pnpm).filter((n) => n.startsWith("esbuild@")).sort().at(-1);
if (!esbuildDir) throw new Error("需要仓库里已安装的 esbuild(不下载依赖)");
const esbuild = await import(pathToFileURL(join(pnpm, esbuildDir, "node_modules/esbuild/lib/main.js")).href);

const entries = [
  "apps/desktop/src/main/orchestration/codeRunner.ts",
  "apps/desktop/src/main/terminal/envRefresh.ts",
  "packages/contracts/src/nodeType.ts",
];
mkdirSync(build, { recursive: true });
for (const entry of entries) {
  // 一个入口一次打包。多入口 + outdir 时 esbuild 会把相对路径摊成
  // `build/apps/desktop/src/...` 的目录树;这里要的是**可预测的平铺文件名**。
  await esbuild.build({
    entryPoints: [join(repo, entry)],
    outfile: join(build, entry.split("/").pop().replace(/\.ts$/, ".js")),
    bundle: true,
    platform: "node",
    format: "esm",
    tsconfig: join(desktop, "tsconfig.json"),
    absWorkingDir: desktop,
    logLevel: "error",
    external: ["electron"],
  });
}

const sources = {};
for (const entry of entries) {
  sources[entry] = createHash("sha256").update(readFileSync(join(repo, entry))).digest("hex");
}
record("inputs.json", {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  node: process.version,
  esbuild: esbuildDir,
  sources,
});

const { runCodeNode } = await import(pathToFileURL(join(build, "codeRunner.js")).href);
const { buildTerminalEnv } = await import(pathToFileURL(join(build, "envRefresh.js")).href);
const contract = await import(pathToFileURL(join(build, "nodeType.js")).href);
const PREFIX = contract.NODE_STDOUT_PROTOCOL_PREFIX;
check("协议前缀来自契约本身(判据不写死)", typeof PREFIX === "string" && PREFIX.length > 0, PREFIX);

/* ────────────────────────── 夹具:两个临时根 ────────────────────────── */

/** 普通根(对照)与**带空格**的根(这一套要钉的那条路径)。 */
const plainRoot = join(evidence, "plain-root");
const spacedRoot = join(evidence, "spaced root with 中文");
const ampersandRoot = join(evidence, "ampersand-&-root");
for (const root of [plainRoot, spacedRoot, ampersandRoot]) mkdirSync(root, { recursive: true });

const savedTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
function useTempRoot(root) {
  // `os.tmpdir()` 在调用时读这几个变量,所以代码节点会把临时文件写进这里。
  process.env.TEMP = root;
  process.env.TMP = root;
  process.env.TMPDIR = root;
}
function restoreTemp() {
  for (const key of ["TEMP", "TMP", "TMPDIR"]) {
    const value = savedTemp[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const signal = () => new AbortController().signal;
const text = (outcome) => String(outcome?.outputs?.stdout ?? "");

/* ────────────────────────── 1. PTY 环境(环境变量泄漏那一维) ────────────────────────── */

{
  const keep = "M08_SENTINEL_KEEP";
  process.env[keep] = "keep-me";
  process.env.CLAUDE_CONFIG_DIR = process.platform === "win32" ? "C:\\mcode-m08-sentinel" : "/tmp/mcode-m08-sentinel";
  const built = await buildTerminalEnv();
  const keys = Object.keys(built.env);
  const upper = keys.map((k) => k.toUpperCase());
  delete process.env[keep];
  delete process.env.CLAUDE_CONFIG_DIR;

  check("PTY 环境里没有 CLAUDE_CONFIG_DIR(用户手敲的 shell 不该被指到 Mcode 的数据根)", !upper.includes("CLAUDE_CONFIG_DIR"), keys.filter((k) => k.toUpperCase().includes("CLAUDE")));
  check("别的继承变量照常带着(不是整份丢掉)", built.env[keep] === "keep-me", built.env[keep]);
  const pathKey = keys.find((k) => k.toUpperCase() === "PATH");
  check("PATH 还在(否则终端里什么工具都找不到)", pathKey !== undefined && String(built.env[pathKey]).length > 0, pathKey);
  check("注册表刷新有明确结论(数字或 null,不会静默变成 undefined)", built.registryVarsApplied === null || typeof built.registryVarsApplied === "number", built.registryVarsApplied);
  record("pty-env.json", { registryVarsApplied: built.registryVarsApplied, keys: keys.length, hasClaudeConfigDir: upper.includes("CLAUDE_CONFIG_DIR") });
}

/* ────────────────────────── 2. 代码节点:普通临时根(对照) ────────────────────────── */

useTempRoot(plainRoot);

const SHELL_ECHO = "@echo off\r\necho MARK-SHELL\r\necho SCRIPT %~f0\r\n";
const PY_ECHO = "import sys, json\nprint('PY-' + str(json.loads(sys.stdin.readline())['marker']))\nprint('FILE ' + __file__)\n";
const NODE_ECHO = "let all = '';\nfor await (const c of process.stdin) all += c;\nconsole.log('NODE-' + JSON.parse(all).marker);\nconsole.log('FILE ' + process.argv[1]);\n";

{
  const shellPlain = await runCodeNode({ code: SHELL_ECHO, language: "shell", timeoutMs: 15000, cwd: evidence, signal: signal() });
  check("shell 语言:临时路径**不带空格**时脚本被真的执行(对照)", shellPlain.status === "success" && text(shellPlain).includes("MARK-SHELL"), shellPlain);
  check("shell 语言:脚本自己报出的路径落在本次的临时根里(夹具不是空跑)", text(shellPlain).includes(plainRoot), text(shellPlain));

  const pyPlain = await runCodeNode({ code: PY_ECHO, language: "python", input: { marker: "in-1" }, timeoutMs: 15000, cwd: evidence, signal: signal() });
  check("python:stdin 上拿得到注入的 JSON(marker 原样落到代码里)", pyPlain.status === "success" && text(pyPlain).includes("PY-in-1"), pyPlain);
  check("python:脚本路径落在本次的临时根里(夹具不是空跑)", text(pyPlain).includes(plainRoot), text(pyPlain));

  const nodePlain = await runCodeNode({ code: NODE_ECHO, language: "node", input: { marker: "n-1" }, timeoutMs: 15000, cwd: evidence, signal: signal() });
  check("node:同一份 stdin 契约在 node 上成立", nodePlain.status === "success" && text(nodePlain).includes("NODE-n-1"), nodePlain);

  if (process.platform === "win32") {
    const psPlain = await runCodeNode({ code: "Write-Output 'MARK-PS'\n", language: "powershell", timeoutMs: 20000, cwd: evidence, signal: signal() });
    check("powershell:语言分支能起来并回读输出", psPlain.status === "success" && text(psPlain).includes("MARK-PS"), psPlain);
  }
}

/* ────────────────────────── 3. 代码节点:产出契约(协议行 / 截尾 / 非零 / 超时 / 中止) ────────────────────────── */

{
  const progress = [];
  const protocolCode =
    "import json\n" +
    `print('${PREFIX}progress {"percent": 42, "message": "half"}')\n` +
    `print('${PREFIX}result {"summary": "proto-summary", "outputs": {"k": "v"}}')\n` +
    "print('after-protocol')\n";
  const out = await runCodeNode({ code: protocolCode, language: "python", timeoutMs: 15000, cwd: evidence, signal: signal(), onProgress: (p) => progress.push(p) });
  check("协议行是**即时**上报的(progress 回调收到 percent/message)", progress.some((p) => p?.percent === 42 && p?.message === "half"), progress);
  check("result 的 summary / outputs 进了产出", out.status === "success" && out.summary === "proto-summary" && out.outputs?.k === "v", out);
  check("协议行不进输出尾部(剩下的才是给人看的输出)", text(out).trim() === "after-protocol", text(out));

  const flood = await runCodeNode({ code: "import sys\nsys.stdout.write('M' * 20000 + 'TAIL-MARK')\n", language: "python", timeoutMs: 15000, cwd: evidence, signal: signal() });
  check("超长输出只留尾部(上限之内,且结尾是最后写的那段)", flood.status === "success" && text(flood).length <= 16_000 && text(flood).endsWith("TAIL-MARK"), text(flood).length);
  check("stderr 与 stdout 分开(代码节点是两个产出变量)", flood.outputs?.stderr === "", flood.outputs?.stderr);

  const nonzero = await runCodeNode({ code: "import sys\nsys.stderr.write('boom-stderr\\n')\nsys.exit(7)\n", language: "python", timeoutMs: 15000, cwd: evidence, signal: signal() });
  check("python 非零退出码算失败,stderr 进错误(代码节点与命令节点相反的那条规矩)", nonzero.status === "failed" && nonzero.outputs?.exitCode === 7 && String(nonzero.error).includes("boom-stderr"), nonzero);

  const timed = await runCodeNode({ code: "import time\ntime.sleep(5)\nprint('never')\n", language: "python", timeoutMs: 700, cwd: evidence, signal: signal() });
  check("超时被杀是失败,错误里说得清是超时", timed.status === "failed" && String(timed.error).includes("700"), timed.error);

  const abort = new AbortController();
  const pending = runCodeNode({ code: "import time\ntime.sleep(5)\n", language: "python", timeoutMs: 20000, cwd: evidence, signal: abort.signal });
  await new Promise((r) => setTimeout(r, 600));
  abort.abort();
  const cancelled = await pending;
  check("中止是 cancelled(不是 failed —— 是人让它停的)", cancelled.status === "cancelled", cancelled);
}

/* ────────────────────────── 4. 代码节点:临时目录**含空格**(本套的核心) ────────────────────────── */

useTempRoot(spacedRoot);

{
  const shellSpaced = await runCodeNode({ code: SHELL_ECHO, language: "shell", timeoutMs: 15000, cwd: evidence, signal: signal() });
  check(
    "shell 语言:临时目录含空格时脚本**仍然被执行**(用户名叫「John Smith」就命中这条)",
    shellSpaced.status === "success" && text(shellSpaced).includes("MARK-SHELL"),
    shellSpaced,
  );
  check("shell 语言:脚本报出的路径确实落在**带空格**的那个根里(证明空格夹具真的生效)", text(shellSpaced).includes(spacedRoot), text(shellSpaced));

  const pySpaced = await runCodeNode({ code: PY_ECHO, language: "python", input: { marker: "sp-1" }, timeoutMs: 15000, cwd: evidence, signal: signal() });
  check("python:同一条带空格路径不受影响(对照 —— 只有 cmd 那一支被重新解析)", pySpaced.status === "success" && text(pySpaced).includes("PY-sp-1") && text(pySpaced).includes(spacedRoot), pySpaced);

  const nodeSpaced = await runCodeNode({ code: NODE_ECHO, language: "node", input: { marker: "n-sp" }, timeoutMs: 15000, cwd: evidence, signal: signal() });
  check("node:同上(对照)", nodeSpaced.status === "success" && text(nodeSpaced).includes("NODE-n-sp"), nodeSpaced);
}

/* ────────────────────────── 5. 代码节点:临时文件必须被清掉 ────────────────────────── */

for (const [label, root] of [["普通根", plainRoot], ["带空格根", spacedRoot]]) {
  const leftovers = readdirSync(root).filter((n) => n.startsWith("mcode-code-"));
  check(`跑完之后它自己的临时目录清干净了(${label})`, leftovers.length === 0, leftovers);
}

/* ────────────────────────── 6. 残余限制:只记录,不断言 ────────────────────────── */

{
  useTempRoot(ampersandRoot);
  const amp = await runCodeNode({ code: SHELL_ECHO, language: "shell", timeoutMs: 15000, cwd: evidence, signal: signal() });
  record("observations.json", {
    note: "临时路径里含控制字符(& 等)时 cmd 的引号保留规则不成立 —— 现状与修后都跑不起来。只记录,不作为判据。",
    ampersandRoot,
    shellStatus: amp.status,
    shellError: amp.error ?? null,
    shellStdout: text(amp),
  });
  console.log(`NOTE 含 & 的临时路径:status=${amp.status}(残余限制,见 observations.json)`);
}

restoreTemp();

/* ────────────────────────── 收尾:证据与退出码 ────────────────────────── */

const summary = { total: checks.length, passed: checks.length - failed, failed, evidence, finishedAt: new Date().toISOString() };
record("checks.json", checks);
record("result.json", summary);
lines.push(`${summary.passed}/${summary.total} passed${failed === 0 ? "" : ` — ${failed} FAILED`}`);
writeFileSync(join(evidence, "output.log"), `${lines.join("\n")}\n`, "utf8");
console.log(`\n${summary.passed}/${summary.total} passed${failed === 0 ? "" : ` — ${failed} FAILED`}`);
console.log(`M08 evidence: ${evidence}`);
process.exit(failed === 0 ? 0 : 1);
