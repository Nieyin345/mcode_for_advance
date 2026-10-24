/**
 * W24 —— 六个「共用 `../electron-u1/build.mjs` 的包装器」的**判定核心**。
 *
 * ## 它解决的问题（W22 在 `t8-node-red-u1` 上修过的那类病）
 *
 * `electron-u1/build.mjs` 在**构建期**崩溃时同样以 1 退出 —— 与「旅程按预期红」
 * 的退出码完全相同（T16 三档：0 全绿 / 1 预期红 / 2 意外红 / 3 自检失败）。
 * 旧包装器用 `r.status ?? 1` 把「没跑起来」读成 1，再按「预期红」翻译成 PASS
 * （`t30` 实测：esbuild 解析 `cpu-features.node` 失败，照样打印
 * `T30: PASS（未跑变异对照）`）。**这是假门禁。**
 *
 * ## 判据：读 `build.mjs` 落盘的 `suite-summary.json`，缺了就是没跑完
 *
 * `build.mjs` **只在全部旅程循环走完之后**才写 `suite-summary.json`
 *（`build.mjs` §6，所有提前 throw 的路径都在它之前）。所以「能读到一份可解析、
 * 结构完整的 summary」是「构建走完了」的**必要条件，不是推测**（与
 * `o2-conflict-u1-smoke` 已跑过的判据同源；本模块只是把它抽成真身，供六套复用）。
 *
 * ⚠️ **本模块只做 summary 一种判据。** `t8-node-red-u1` 用的是 W22 的完成探针
 *（`beforeExit` 事件），那是它自己的选择 —— **不要在同一套里混用两种**
 *（卡 §三）。t8 不 import 本文件。
 *
 * ## 退出码（与 W22 的 `WRAPPER_EXIT` 同值，跨套件一致）
 *
 * | kind | 含义 | 退出码 |
 * |---|---|---|
 * | `completed` | 构建走完，summary 可读 → 原样透传子进程的 `status`（0/1/2/3） | 0–3 |
 * | `build-failed` | 没跑完，且日志里有 esbuild 的失败标记（`X [ERROR]` / `Build failed with`） | **4** |
 * | `build-crashed` | 没跑完的其它一切（证据根都没打印、summary 缺失或不可解析、build.mjs 自身 throw…） | **5** |
 * | `spawn-failed` | `spawnSync.status === null`：进程根本没起来 / 被信号终止 | **6** |
 *
 * 4/5/6 不复用 0–3（`build.mjs` 的 3 已经是「自检失败」）。**降级方向安全**：
 * 即便 esbuild 改了文案、build-failed 退化成 build-crashed，也仍是「没跑完」，
 * 永远不会变成 0/1 那种「旅程结论」。
 *
 * ## 自检
 *
 *   node scripts/lib/electron-u1-verdict.mjs
 *
 * 覆盖四类 kind（含一次**真实**的 spawnSync ENOENT 测量与一次**真实**的
 * summary 文件读取），并钉住一条硬性质：**非 completed 永不映射到 0–3**。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** 「没跑完」三兄弟的退出码。0–3 留给子进程的旅程结论，不复用。 */
export const WRAPPER_EXIT = Object.freeze({
  BUILD_FAILED: 4,
  BUILD_CRASHED: 5,
  SPAWN_FAILED: 6,
});

/**
 * esbuild 失败的日志标记（两路冗余）：
 *  - `X [ERROR]` 是 esbuild 的渲染器打的（stderr）；
 *  - `Build failed with` / `Transform failed with` / `Context failed` 是它抛出的
 *    Error.message 前缀（`failureErrorWithLog` 的固定文案）。
 * 任一命中即 `build-failed`；都不中落入 `build-crashed`（仍是「没跑完」）。
 */
const ESBUILD_FAILURE_MARKERS = [/X \[ERROR\]/, /(Build|Transform|Context) failed\b/];

/** 从 `build.mjs` 的输出里取证据根（它在建目录后立刻打印，早于任何构建步骤之后才可能崩的地方）。 */
export function evidenceRootFromLog(log) {
  if (typeof log !== "string") return null;
  const match = /U1 evidence:\s*(.+)/.exec(log);
  return match ? match[1].trim() : null;
}

/**
 * 读证据根下的 `suite-summary.json`。
 *
 * **结构校验不是形式主义**：`build.mjs` 的 summary 是它「走完全部旅程」的落盘
 * 声明；一份缺 `journeys` / `counts` 的文件说明它没写完整（半截 JSON 或未来的
 * 结构漂移）—— 那和「没有 summary」是同一类事实，不能拿它当旅程结论。
 */
export function loadSummary(evidenceRoot) {
  if (evidenceRoot === null) return null;
  const summaryPath = join(evidenceRoot, "suite-summary.json");
  if (!existsSync(summaryPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray(parsed.journeys) ||
    parsed.counts === null ||
    typeof parsed.counts !== "object" ||
    typeof parsed.counts.total !== "number" ||
    typeof parsed.counts.allPass !== "number" ||
    typeof parsed.counts.expectedFailure !== "number" ||
    typeof parsed.counts.unexpectedFailure !== "number"
  ) {
    return null;
  }
  return parsed;
}

/**
 * 解一段子进程输出（**原始字节**先原样回放，解析用这份解码文本）。
 *
 * 本仓库的环境事实：Windows 子进程输出是控制台代码页（中文机器 GBK）。
 * 所以不强行按 UTF-8 解码所有输出 —— 严格试 UTF-8，失败退回 GBK；再不行用
 * latin1（只用于解析 ASCII 标记 `U1 evidence:` / `X [ERROR]`，中文乱码不影响判据）。
 */
function decodeChildOutput(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      return buf.toString("latin1");
    }
  }
}

/**
 * 跑一次 `electron-u1/build.mjs`（同步），捕获输出并解析 summary。
 *
 * 与 o2 的做法同源：捕获子进程输出（需要从中解析证据根），跑完后**原样回放原始
 * 字节**给调用方（不把日志重新编码一遍，见上面的环境事实）。
 *
 * @param {{
 *   suite: string,                 // 套件目录绝对路径
 *   desktop: string,               // apps/desktop 绝对路径
 *   registry?: string,             // 默认 <suite>/journeys/index.ts
 *   esbuild?: string | null,       // 默认不传（与旧包装器逐字一致）
 *   prebuild?: string | null,
 *   passthrough?: string[],
 *   extraArgs?: string[],
 *   env?: Record<string, string>,
 *   timeoutMs?: number,
 * }} opts
 * @returns {{ status: number|null, signal: string|null, error: Error|null, evidenceRoot: string|null, summary: object|null, log: string }}
 */
export function runElectronU1({
  suite,
  desktop,
  registry = join(suite, "journeys/index.ts"),
  esbuild = null,
  prebuild = null,
  passthrough = [],
  extraArgs = [],
  env = {},
  timeoutMs = 30 * 60_000,
}) {
  const args = [join(suite, "../electron-u1/build.mjs"), `--registry=${registry}`];
  if (esbuild !== null) args.push(`--esbuild=${esbuild}`);
  if (prebuild !== null) args.push(`--prebuild=${prebuild}`);
  args.push(...passthrough, ...extraArgs);
  const result = spawnSync(process.execPath, args, {
    cwd: desktop,
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    env: { ...process.env, ...env },
  });
  const outBuf = result.stdout ?? Buffer.alloc(0);
  const errBuf = result.stderr ?? Buffer.alloc(0);
  // 原样回放原始字节（与 o2 同一条纪律：不吞子进程输出）。
  process.stdout.write(outBuf);
  if (errBuf.length > 0) process.stderr.write(errBuf);
  const log = decodeChildOutput(outBuf) + decodeChildOutput(errBuf);
  const evidenceRoot = evidenceRootFromLog(log);
  return {
    status: result.status,
    signal: result.signal ?? null,
    error: result.error ?? null,
    evidenceRoot,
    summary: loadSummary(evidenceRoot),
    log,
  };
}

/**
 * 把一次运行归到四类之一。**唯一的「走完了」判据是有可用的 summary**。
 *
 * @param {{ status: number|null, signal: string|null, error: Error|null, evidenceRoot: string|null, summary: object|null, log: string }} run
 * @returns {{ kind: "completed", status: number, summary: object } | { kind: "build-failed"|"build-crashed"|"spawn-failed", detail: string, exit: number }}
 */
export function classifyU1Run(run) {
  // 先判 status === null：进程没起来 / 被信号终止，summary 不可能有效。
  if (run.status === null) {
    const detail = run.error
      ? `根本没跑起来：${run.error.code ?? run.error.message}`
      : run.signal
        ? `进程被信号 ${run.signal} 终止，没有跑完`
        : "status === null 且没有 error/signal（异常形态）";
    return { kind: "spawn-failed", detail, exit: WRAPPER_EXIT.SPAWN_FAILED };
  }
  if (run.summary !== null) return { kind: "completed", status: run.status, summary: run.summary };
  // esbuild 标记先于「证据根缺失」判：失败发生在构建期时，证据根一般已打印（它是
  // `build.mjs` 的第 3 步）；反过来若两个信号同时在，esbuild 是更具体的那个。
  const looksEsbuild = ESBUILD_FAILURE_MARKERS.some((re) => re.test(String(run.log ?? "")));
  if (looksEsbuild) {
    return {
      kind: "build-failed",
      detail: `构建期失败（esbuild）${run.evidenceRoot === null ? "" : `，证据根 ${run.evidenceRoot} 下没有 suite-summary.json`} —— 子进程退出码 ${run.status}，那不是任何旅程的结论`,
      exit: WRAPPER_EXIT.BUILD_FAILED,
    };
  }
  if (run.evidenceRoot === null) {
    return {
      kind: "build-crashed",
      detail: `构建脚本没有打印证据根（退出码 ${run.status}）—— 它在构建启动前就崩了`,
      exit: WRAPPER_EXIT.BUILD_CRASHED,
    };
  }
  return {
    kind: "build-crashed",
    detail: `构建脚本没有走完（证据根 ${run.evidenceRoot} 下没有可用的 suite-summary.json，退出码 ${run.status}）`,
    exit: WRAPPER_EXIT.BUILD_CRASHED,
  };
}

/** 报告「没跑完」并退出。**永不打印 PASS。** 与 W22 的 `reportIncomplete` 同形。 */
export function reportIncompleteAndExit(tag, where, c) {
  if (c.kind === "build-failed") {
    console.error(`\n${tag}: BUILD FAILED（${where}：构建期失败，不是任何旅程的结论）`);
  } else if (c.kind === "build-crashed") {
    console.error(`\n${tag}: BUILD CRASHED（${where}：构建脚本没走完）`);
  } else {
    console.error(`\n${tag}: SPAWN FAILED（${where}：根本没跑起来）`);
  }
  console.error(`${tag}: ${c.detail}`);
  console.error(`${tag}: 证据保留在 .tmp/electron-u1/<时间戳>/（若已打印）`);
  process.exit(c.exit);
}

/* ──────────────────────────────── 自检 ──────────────────────────────── */

/** 构造「日志 + 证据根 + summary」三种真实形态的最小样本。 */
function syntheticCompleted(status, counts = { total: 2, allPass: 2, expectedFailure: 0, unexpectedFailure: 0 }) {
  return {
    status,
    signal: null,
    error: null,
    evidenceRoot: "/x/evidence",
    summary: { schema: 1, journeys: [{ name: "j" }], counts },
    log: "",
  };
}

/** 真实测量一次「二进制不存在」时 spawnSync 的返回形态（不手写这张形状）。 */
function liveMissingBinaryShape() {
  const missing = join(tmpdir(), "w24-definitely-missing-dir", "no-such-binary.exe");
  const r = spawnSync(missing, ["--nope"], { encoding: "utf8" });
  return { status: r.status, signal: r.signal, error: r.error ?? null, evidenceRoot: null, summary: null, log: "" };
}

/** 分类用例之外、由同一次 selfcheck 一起跑的固定判据条数（文件读取 4 + 证据根解析 1 + 映射钉住 3 + 码区隔离 1）。改自检时同步改这里 —— 若不同步，「FAIL（x/y）」的分母会说谎。 */
const FILE_AND_MAPPING_CHECKS = 9;

function selfcheck() {
  const cases = [
    { name: "completed 0（全绿）", run: syntheticCompleted(0), kind: "completed" },
    { name: "completed 1（预期红）", run: syntheticCompleted(1), kind: "completed" },
    { name: "completed 2（意外红）", run: syntheticCompleted(2), kind: "completed" },
    { name: "completed 3（build.mjs 自检失败）", run: syntheticCompleted(3), kind: "completed" },
    {
      name: "esbuild 失败（X [ERROR]，无 summary）",
      run: {
        status: 1, signal: null, error: null, evidenceRoot: "/x/evidence", summary: null,
        log: "U1 evidence: /x/evidence\nX [ERROR] Could not resolve \"../build/Release/cpufeatures.node\"\n",
      },
      kind: "build-failed",
    },
    {
      name: "esbuild 失败（Error.message 文案，无 summary）",
      run: {
        status: 1, signal: null, error: null, evidenceRoot: "/x/evidence", summary: null,
        log: "U1 evidence: /x/evidence\nError: Build failed with 1 error:\n",
      },
      kind: "build-failed",
    },
    {
      name: "build.mjs 自身崩溃（有证据根、无 summary、无 esbuild 标记）",
      run: { status: 1, signal: null, error: null, evidenceRoot: "/x/evidence", summary: null, log: "U1 evidence: /x/evidence\nError: Unknown option: --keep\n" },
      kind: "build-crashed",
    },
    {
      name: "证据根都没打印（构建启动前就崩）",
      run: { status: 1, signal: null, error: null, evidenceRoot: null, summary: null, log: "Error: Unknown option: --keep\n" },
      kind: "build-crashed",
    },
    { name: "spawn ENOENT（真实测量）", run: liveMissingBinaryShape(), kind: "spawn-failed" },
    { name: "被信号终止", run: { status: null, signal: "SIGTERM", error: null, evidenceRoot: null, summary: null, log: "" }, kind: "spawn-failed" },
  ];

  const failures = [];
  for (const c of cases) {
    const got = classifyU1Run(c.run);
    if (got.kind !== c.kind) failures.push(`${c.name}：期望 ${c.kind}，实际 ${got.kind}（${got.detail ?? "status=" + got.status}）`);
  }

  // 硬性质 1：没跑完 ≠ 过了。任何非 completed 的 kind 只许映射到 4/5/6，绝不许碰 0–3。
  const exitFor = { "build-failed": WRAPPER_EXIT.BUILD_FAILED, "build-crashed": WRAPPER_EXIT.BUILD_CRASHED, "spawn-failed": WRAPPER_EXIT.SPAWN_FAILED };
  for (const k of ["build-failed", "build-crashed", "spawn-failed"]) {
    if (!exitFor[k]) failures.push(`WRAPPER_EXIT 缺少 ${k}`);
    else if ([0, 1, 2, 3].includes(exitFor[k])) failures.push(`${k} 映射到了旅程结论码 ${exitFor[k]} —— 会与「过了 / 预期红」共用一个数字`);
  }
  // 硬性质 2：completed 直接透传 status，本模块不得重映射。
  const passthrough = classifyU1Run(syntheticCompleted(1));
  if (passthrough.kind !== "completed" || passthrough.status !== 1) failures.push("completed 没有原样透传 status（旧语义被改）");
  // 硬性质 3：**分类 → 退出码**的映射本身要被钉住（CLAUDE.md：判据依赖「不同的码代表
  // 不同事实」时，要有一条断言钉住「这些码确实不同」）。只看 WRAPPER_EXIT 常量不够 ——
  // 有人把 classifyU1Run 里的 exit 改成 WRAPPER_EXIT.COMPLETED 之类的同值，常量检查发现不了。
  const exitOf = {
    "build-failed": classifyU1Run({ status: 1, signal: null, error: null, evidenceRoot: "/x", summary: null, log: "U1 evidence: /x\nX [ERROR] boom\n" }),
    "build-crashed": classifyU1Run({ status: 1, signal: null, error: null, evidenceRoot: null, summary: null, log: "" }),
    "spawn-failed": classifyU1Run(liveMissingBinaryShape()),
  };
  const seen = new Map();
  for (const [kind, got] of Object.entries(exitOf)) {
    if (got.kind !== kind) failures.push(`映射钉住用例「${kind}」分类成了 ${got.kind}`);
    else if (got.exit !== WRAPPER_EXIT[kind.toUpperCase().replace("-", "_")]) failures.push(`${kind} 的退出码 ${got.exit} 与 WRAPPER_EXIT 不一致`);
    else if (seen.has(got.exit)) failures.push(`${kind} 的退出码 ${got.exit} 与 ${seen.get(got.exit)} 相同 —— 两种事实共用一个数字`);
    else seen.set(got.exit, kind);
  }
  // 另一面：completed 的 status 不许与任何「没跑完」码撞车（否则消费方仍分不清）。
  for (const [kind, got] of Object.entries(exitOf)) {
    if (got.kind === "completed") continue;
    if ([0, 1, 2, 3].includes(got.exit)) failures.push(`${kind} 的退出码落进旅程结论区 0–3（${got.exit}）`);
  }

  // 真实文件：summary 能读回来；同目录没有 summary 时是 null。
  const dir = mkdtempSync(join(tmpdir(), "w24-verdict-"));
  const realSummary = { schema: 1, mutation: null, evidenceRoot: dir, buildDir: "/b", journeys: [], counts: { total: 0, allPass: 0, expectedFailure: 0, unexpectedFailure: 0 } };
  writeFileSync(join(dir, "suite-summary.json"), JSON.stringify(realSummary));
  if (loadSummary(dir) === null) failures.push("真实 summary 文件读不回来（loadSummary 返回 null）");
  const emptyDir = mkdtempSync(join(tmpdir(), "w24-verdict-empty-"));
  if (loadSummary(emptyDir) !== null) failures.push("空目录被读出了 summary —— 缺 summary 的判据失效");
  writeFileSync(join(emptyDir, "suite-summary.json"), "{ 半截 JSON");
  if (loadSummary(emptyDir) !== null) failures.push("半截 JSON 被当成了可用 summary");
  writeFileSync(join(emptyDir, "suite-summary.json"), JSON.stringify({ schema: 1, journeys: "not-an-array" }));
  if (loadSummary(emptyDir) !== null) failures.push("结构不完整的 summary 被当成了可用 summary");

  // 正控：evidenceRootFromLog 从真实日志形状里取得到路径（否则上面的 「无证据根」分支会恒真）。
  const root = evidenceRootFromLog("U1 evidence: C:\\repo\\.tmp\\electron-u1\\2026-10-24T15-33-06-569Z\nU1 build:    C:\\tmp\\b\n");
  if (root !== "C:\\repo\\.tmp\\electron-u1\\2026-10-24T15-33-06-569Z") failures.push(`evidenceRootFromLog 取错：${root}`);

  if (failures.length > 0) {
    console.error(`W24 electron-u1-verdict selfcheck: FAIL（${cases.length + FILE_AND_MAPPING_CHECKS - failures.length}/${cases.length + FILE_AND_MAPPING_CHECKS}）`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`W24 electron-u1-verdict selfcheck: PASS（${cases.length} 条分类 + ${FILE_AND_MAPPING_CHECKS} 条文件/解析/映射判据；含一次真实 ENOENT 测量）`);
  process.exit(0);
}

const isMain = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) selfcheck();
