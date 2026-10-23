/**
 * 【T91】子进程探针：跑**真实的** `adoptMarkdownFile`，看它会不会崩。
 *
 * ## 为什么必须是子进程
 *
 * `fs.cpSync` 在 Node 22 + Windows + 非 ASCII 路径下是 **native fast-fail**：
 * 进程直接死，`try/catch`、`process.on('exit')` 全部接不住。同进程断言会和被测
 * 对象一起消失，套件连「我失败了」都报不出来 —— 和 T90 同一个理由。
 *
 * ## 为什么调产品函数而不是复制一份 `cpSync`
 *
 * 本卡要证明的是「`adoptMarkdown.ts` 的那两处已经不会崩」。直接写
 * `fs.cpSync(from, to)` 测的是 Node，不是我们的代码。
 *
 * ## 退出码
 *
 * - `0` —— 调用返回了（成功或可捕获的 `{ok:false}`），`PROBE_RESULT:` 行说明是哪种；
 * - `1` —— 抛了可捕获的异常（不是崩溃）；
 * - 其它（`0xC0000409` / `0xC0000005`）—— **native 崩溃**，父进程据此判定。
 */
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [itemId, sourcePath, mode] = process.argv.slice(2);
if (!itemId || !sourcePath) {
  console.error("用法：probe.mjs <itemId> <sourcePath> [mode]");
  process.exit(2);
}

// `mode === "deny-dest"`：把暂存目标所在目录设成不可写，验「失败时老包没动」那条承诺。
// ⚠️ `chmodSync` 在 Windows 上**对目录基本无效**——所以本探针会如实报告「复制成功了」，
// 那条断言就会红，不会假绿。真正需要确定性失败时由父进程用 `icacls` 注入。
if (mode === "deny-dest") {
  const stageParent = join(process.env.MCODE_SMOKE_DATA_ROOT!, "library", "markdown", "imported");
  try {
    mkdirSync(stageParent, { recursive: true });
    chmodSync(stageParent, 0o500);
  } catch (error) {
    console.log(`PROBE_RESULT:setup-failed:${error instanceof Error ? error.message : String(error)}`);
    process.exit(0);
  }
}

try {
  // 子进程是**独立进程** —— 父进程的 db 连接不共享。`LibraryRepo.get` 要求已 initDb。
  const { initDb } = await import("@main/store/db.js");
  await initDb();
  const { adoptMarkdownFile } = await import("../../src/main/library/adoptMarkdown.js");
  const result = adoptMarkdownFile(itemId, sourcePath);
  console.log(`PROBE_RESULT:${JSON.stringify({
    ok: result.ok,
    error: result.ok ? null : result.error,
    relPath: result.relPath,
    imageCount: result.imageCount,
    missing: result.missing,
  })}`);
  process.exit(0);
} catch (error) {
  console.log(`PROBE_RESULT:threw:${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
