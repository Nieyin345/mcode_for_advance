/**
 * 【T90】子进程探针：**跑真实的 `dataRoot.ts` 的 `cpSync` 那两行**，看它会不会崩。
 *
 * ## 为什么不直接写 `fs.cpSync(from, to, …)`
 *
 * 那样测的是 Node，不是我们的代码 —— 而本卡要证明的是「`dataRoot.ts` 的那两处
 * 已经不会崩」。所以这里通过 `MCODE_T90_PROBE` 让真的模块走到 `copyDataRootTo`
 * 的复制分支，**调用链与产品完全一致**。
 *
 * 探针只做三件事：
 *   1. 设好 electron 桩要的 `userData` / `home`；
 *   2. 调 `copyDataRootTo(to)`；
 *   3. 把结果写进 stdout 的 `PROBE_RESULT:` 行（父进程读它）。
 *
 * ## 退出码约定
 *
 * - `0` —— 复制成功（或返回了可捕获的错误）；
 * - `1` —— 抛了可捕获的异常（**不是崩溃**，正常行为）；
 * - 其它（如 `3221226505`）—— **native 崩溃，进程被系统杀掉**。父进程据此判定。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error("用法：probe.mjs <from> <to>");
  process.exit(2);
}

// electron 桩（`--alias:electron=…`）从这两个环境变量取路径，见 stubs/electron.ts。
process.env.MCODE_T90_USER_DATA = join(from, "..", ".fake-userdata");
process.env.MCODE_T90_HOME = join(from, "..", ".fake-home");
mkdirSync(process.env.MCODE_T90_USER_DATA, { recursive: true });
mkdirSync(process.env.MCODE_T90_HOME, { recursive: true });

// 指针文件指向 `from` 的父目录加上固定名，这样 `dataRoot()` 返回 from。
// 直接写 from 本身：`dataRoot()` = 指针里的 root。
writeFileSync(
  join(process.env.MCODE_T90_USER_DATA, "data-root.json"),
  JSON.stringify({ root: from }),
  "utf8",
);

try {
  const { copyDataRootTo } = await import("../../src/main/lib/dataRoot.js");
  const error = copyDataRootTo(to);
  // `copyDataRootTo` 把失败**当成返回值**而不是异常 —— 那是它的契约。
  console.log(`PROBE_RESULT:${error === null ? "ok" : `err:${error}`}`);
  process.exit(0);
} catch (error) {
  // 可捕获的异常：清晰报告，退出码 1（与 native 崩溃区分）。
  console.log(`PROBE_RESULT:threw:${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
