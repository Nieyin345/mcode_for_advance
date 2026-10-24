/**
 * W22 —— 包装器（`run.mjs`）的**判定核心**：把一次子进程运行归到四类之一。
 *
 * 单独成一个模块，是为了让自检（本文件底部 `node wrapper-verdict.mjs`）能
 * **import 真身**而不是抄一份逻辑副本（CLAUDE.md 二十六）。
 *
 * ## 四类与包装器退出码
 *
 * | kind | 含义 | 包装器退出码 |
 * |---|---|---|
 * | `completed` | 子进程**自然走完**（完成探针的 `beforeExit` 触发） | 原样透传 `status`（0/1/2/3，T16 三档 + build.mjs 自检 3） |
 * | `build-failed` | 没走完，且未捕获异常是 **esbuild 的编译失败**（语法错误等） | `4` |
 * | `build-crashed` | 没走完的其它一切（build.mjs 自己 throw、选项拼错、探针没落盘…） | `5` |
 * | `spawn-failed` | `spawnSync.status === null`：进程根本没起来 / 被信号终止 | `6` |
 *
 * 4/5/6 是 W22 选的：`electron-u1/build.mjs` 的退出码已经用到 0/1/2 与 3
 * （自检失败，见其 `process.exitCode = 3`），卡面示例的 3/4/5 会与那个 3 撞车。
 *
 * ## 为什么 `completed` 是事件、不是猜测
 *
 * 子进程的退出码区分不了「旅程按预期红」（正常，退 1）与「构建期崩溃」（退 1）——
 * 这正是 W5 撞上的假门禁。但「进程有没有自然走完」区分得了：只有正常结束的
 * 进程才会触发 `beforeExit`（见 `child-completion-probe.mjs` 的三个事件分工）。
 * **这是直接记录，不是读产物推测过程。**
 *
 * ## esbuild 失败的识别（fail-closed）
 *
 * 两个信号，任一成立即算 `build-failed`：
 *  1. 结构标记 `crash.looksLikeEsbuild === true`（esbuild 在抛出的 Error 上挂了
 *     `.errors` 数组，这是它的 API 契约）；
 *  2. 消息以 `Build failed` / `Transform failed` / `Context failed` 开头
 *     （esbuild `failureErrorWithLog` 的固定文案）。
 *
 * 两个都不成立时落入 `build-crashed`。**降级方向是安全的**：即便未来 esbuild
 * 改了文案与结构，构建失败最坏也只是从 4 变 5 —— 仍是「没跑完」的明确信号，
 * 永远不会变成 0/1 那种「旅程结论」。
 *
 * ## 自检
 *
 *   node scripts/t8-node-red-u1/wrapper-verdict.mjs
 *
 * 覆盖全部 kind（含一次**真实**的 spawnSync ENOENT 测量），并钉住一条硬性质：
 * **非 completed 的 kind 永远不映射到 0-3**（「跑不了」不可能变成「过了」）。
 */
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** 包装器对「没跑完」三兄弟的退出码。0–3 留给子进程的旅程结论，不复用。 */
export const WRAPPER_EXIT = Object.freeze({
  BUILD_FAILED: 4,
  BUILD_CRASHED: 5,
  SPAWN_FAILED: 6,
});

/** esbuild `failureErrorWithLog` 的三种文案前缀（Build / Transform / Context）。 */
const ESBUILD_FAILURE = /^(Build|Transform|Context) failed\b/;

/**
 * @param {{ status: number|null, signal: string|null, error: (Error & {code?: string})|null, probe: {completed?: boolean, crash?: {name?: string, message?: string, looksLikeEsbuild?: boolean}|null}|null, probeFile?: string }} run
 * @returns {{ kind: "completed", status: number } | { kind: "build-failed"|"build-crashed"|"spawn-failed", detail: string }}
 */
export function classifyChildRun(run) {
  // 先判 status === null：进程没起来 / 被信号终止，探针必然没有有效完成声明。
  if (run.status === null) {
    const detail = run.error
      ? `根本没跑起来：${run.error.code ?? run.error.message}`
      : run.signal
        ? `进程被信号 ${run.signal} 终止，没有跑完`
        : "status === null 且没有 error/signal（异常形态）";
    return { kind: "spawn-failed", detail };
  }
  if (run.probe === null || typeof run.probe !== "object") {
    return {
      kind: "build-crashed",
      detail: `没有拿到完成探针的落盘结果（${run.probeFile ?? "路径未知"}）—— 无法证明构建走完了`,
    };
  }
  if (run.probe.completed !== true) {
    const crash = run.probe.crash ?? null;
    if (crash && (crash.looksLikeEsbuild === true || ESBUILD_FAILURE.test(String(crash.message ?? "")))) {
      return { kind: "build-failed", detail: `${crash.name ?? "Error"}: ${crash.message ?? ""}` };
    }
    return {
      kind: "build-crashed",
      detail: crash
        ? `${crash.name ?? "Error"}: ${crash.message ?? ""}`
        : "进程没有自然走完（可能是显式 process.exit）",
    };
  }
  return { kind: "completed", status: run.status };
}

/* ──────────────────────────────── 自检 ──────────────────────────────── */

/** 真实测量一次「二进制不存在」时 spawnSync 的返回形态（不手写这张形状）。 */
function liveMissingBinaryShape() {
  const missing = join(tmpdir(), "w22-definitely-missing-dir", "no-such-binary.exe");
  const r = spawnSync(missing, ["--nope"], { encoding: "utf8" });
  return { status: r.status, signal: r.signal, error: r.error ?? null, probe: null, probeFile: "(live ENOENT)" };
}

function selfcheck() {
  const incompleteKinds = ["build-failed", "build-crashed", "spawn-failed"];
  const cases = [
    { name: "completed 0（全绿）", run: { status: 0, signal: null, error: null, probe: { completed: true, exitCode: 0, crash: null } }, kind: "completed" },
    { name: "completed 1（预期红，正常跑）", run: { status: 1, signal: null, error: null, probe: { completed: true, exitCode: 1, crash: null } }, kind: "completed" },
    { name: "completed 2（意外红）", run: { status: 2, signal: null, error: null, probe: { completed: true, exitCode: 2, crash: null } }, kind: "completed" },
    { name: "completed 3（build.mjs 自检失败）", run: { status: 3, signal: null, error: null, probe: { completed: true, exitCode: 3, crash: null } }, kind: "completed" },
    {
      name: "esbuild 失败（按固定文案）",
      run: { status: 1, signal: null, error: null, probe: { completed: false, exitCode: 1, crash: { name: "Error", message: "Build failed with 1 error: fixtures.ts:1:1: ERROR: Unterminated string literal" } } },
      kind: "build-failed",
    },
    {
      name: "esbuild 失败（按结构标记 .errors，文案无关）",
      run: { status: 1, signal: null, error: null, probe: { completed: false, exitCode: 1, crash: { name: "Error", message: "wording may change", looksLikeEsbuild: true } } },
      kind: "build-failed",
    },
    {
      name: "build.mjs 自身崩溃（如选项拼错）",
      run: { status: 1, signal: null, error: null, probe: { completed: false, exitCode: 1, crash: { name: "Error", message: "Unknown option: --keep" } } },
      kind: "build-crashed",
    },
    {
      name: "探针没落盘（无法证明走完）",
      run: { status: 1, signal: null, error: null, probe: null, probeFile: "/x/y.json" },
      kind: "build-crashed",
    },
    {
      name: "显式 process.exit（beforeExit 不触发）",
      run: { status: 3, signal: null, error: null, probe: { completed: false, exitCode: 3, crash: null } },
      kind: "build-crashed",
    },
    { name: "spawn ENOENT（真实测量）", run: liveMissingBinaryShape(), kind: "spawn-failed" },
    { name: "被信号终止", run: { status: null, signal: "SIGTERM", error: null, probe: null }, kind: "spawn-failed" },
  ];

  const failures = [];
  for (const c of cases) {
    const got = classifyChildRun(c.run);
    if (got.kind !== c.kind) failures.push(`${c.name}：期望 ${c.kind}，实际 ${got.kind}（${got.detail ?? "status=" + got.status}）`);
  }

  // 硬性质：没跑完 ≠ 过了。任何非 completed 的 kind 只许映射到 4/5/6，绝不许碰 0–3。
  const exitFor = { "build-failed": WRAPPER_EXIT.BUILD_FAILED, "build-crashed": WRAPPER_EXIT.BUILD_CRASHED, "spawn-failed": WRAPPER_EXIT.SPAWN_FAILED };
  for (const k of incompleteKinds) {
    if (!exitFor[k]) failures.push(`WRAPPER_EXIT 缺少 ${k}`);
    else if ([0, 1, 2, 3].includes(exitFor[k])) failures.push(`${k} 映射到了旅程结论码 ${exitFor[k]} —— 会与「过了 / 预期红」共用一个数字`);
  }
  // 另一面：completed 直接透传 status，包装器不得重映射（旧语义保持）。
  const passthrough = classifyChildRun({ status: 1, signal: null, error: null, probe: { completed: true } });
  if (passthrough.kind !== "completed" || passthrough.status !== 1) failures.push("completed 没有原样透传 status（旧语义被改）");

  if (failures.length > 0) {
    console.error(`W22 wrapper-verdict selfcheck: FAIL（${cases.length - failures.length}/${cases.length}）`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`W22 wrapper-verdict selfcheck: PASS（${cases.length}/${cases.length}；含一次真实 ENOENT 测量）`);
  process.exit(0);
}

const isMain = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) selfcheck();
