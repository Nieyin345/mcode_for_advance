/**
 * W22 —— `run.mjs` 的**子进程完成探针**（经 `node --import` 注入，不改被探测脚本）。
 *
 * ## 它解决的问题
 *
 * `../electron-u1/build.mjs` 对**四种不同的情况**都可能退出 1（或非 0）：
 *
 *  | 情况 | 构建脚本长什么样 |
 *  |---|---|
 *  | 正常结果（旅程按声明红/绿，见 `driver/verdict.ts` 三档） | **自然走到进程结束**，`process.exitCode = 0/1/2` |
 *  | 构建失败（esbuild 抛错，如语法错误） | **未捕获异常**，进程以 1 退出 |
 *  | 构建脚本自身崩溃（读文件失败、断言失配…） | **未捕获异常**，进程以 1 退出 |
 *  | spawn 根本没跑起来（ENOENT / 被杀） | `spawnSync.status === null`，没有本探针输出 |
 *
 * **退出码区分不了前三种。** 但「进程有没有自然走完」区分得了：
 * 前三种里只有第一种会触发 `beforeExit`。所以 `run.mjs` 用这份探针的落盘结果
 * （`completed`）把「构建没跑完」与「旅程按预期红」分开 —— **直接记录事件，
 * 不靠读产物推测过程**（本卡的教训：代理指标会在没想到的输入上失效）。
 *
 * ## 三个事件的分工（Node 语义，2026-10-24 在本机 v22.21.1 实测，见卡回写）
 *
 *  - `beforeExit`：**只在事件循环自然排空时**触发。`process.exit()` 与未捕获异常
 *    都不会触发 —— 所以它恰好就是「构建脚本自然把话说完」的那个信号；
 *  - `uncaughtExceptionMonitor`：记录崩溃类型/消息（**不**吞异常、不改退出码，
 *    进程行为与没有本探针时完全一致）；
 *  - `exit`：最后一次写盘。此时同步写文件仍可用；写失败就**不写** —— 调用方
 *    拿不到完成声明会 fail-closed（当作没跑完），不会把「写不出证据」读成成功。
 *
 * ## 边界
 *
 * 只能经 `--import` 注入 **ESM** 入口（本套件的 `build.mjs` 是 ESM）。对 CJS
 * 入口 `--require` 形态需另写一份；本文件不假装覆盖那种情况。
 */
import { writeFileSync } from "node:fs";

const resultFile = process.env.T8_CHILD_PROBE_FILE;

if (resultFile) {
  let reachedNaturalEnd = false;
  let crash = null;

  process.on("beforeExit", () => {
    reachedNaturalEnd = true;
  });
  process.on("uncaughtExceptionMonitor", (err, origin) => {
    crash = {
      origin: String(origin),
      name: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
      // esbuild 的 API 契约：抛出的 Error 上挂 `.errors` 数组（`failureErrorWithLog`）。
      // 结构标记与文案判断互为冗余，见 wrapper-verdict.mjs 的「esbuild 失败的识别」。
      looksLikeEsbuild: err instanceof Error && Array.isArray(err.errors),
    };
  });
  process.on("exit", (code) => {
    try {
      writeFileSync(resultFile, JSON.stringify({ completed: reachedNaturalEnd, exitCode: code, crash }, null, 2));
    } catch {
      // 写不出结果 = 调用方拿不到完成声明；它会按「没跑完」处理（fail-closed）。
    }
  });
}
