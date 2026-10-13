/**
 * 【MC-097 跨进程租约夹具】—— 一个**独立 OS 进程**的租约持有/抢占者。
 *
 * 由 `main.ts` 用 `spawn(process.execPath, [child-lease.mjs, lockPath, mode, waitMs])` 起。
 * 走的是与生产**同一份** `lib/osFileLease.ts` 的 `acquireOsFileLease`(不重写机制)。
 *
 * `mode`:
 *   - `acquire-once` —— 用 `waitMs` 试抢锁:抢到就打印 `{acquired:true}` 并**立即释放**退出;
 *                      抢不到(他人持有到超时)打印 `{acquired:false,error:"FILE_VERSION_CONFLICT…"}`。
 *                      用来断言「父进程持锁时,另一个真进程**被拒**」。
 *   - `hold`         —— 抢到锁后**持有不释放**(打印 `{acquired:true,pid}`),进程保持存活等待被
 *                      **真 SIGKILL**。租约由「锁文件存在」表示,进程猝死会把它留在盘上,由下一个
 *                      写者的陈旧租约回收逻辑处置(见 osFileLease.ts 的 `leaseOwnerAlive`)。
 *
 * 输出一行 JSON 到 stdout:`{"acquired":true}` / `{"acquired":true,"pid":N}` /
 * `{"acquired":false,"error":"..."}`。
 */
import { acquireOsFileLease } from "@main/lib/osFileLease.js";

const [lockPath, mode, waitMsStr] = process.argv.slice(2);
if (!lockPath || !mode) {
  process.stdout.write(JSON.stringify({ acquired: false, error: "用法: child-lease <lockPath> <mode> [waitMs]" }) + "\n");
  process.exit(2);
}
const waitMs = Number.parseInt(waitMsStr ?? "", 10) || 5_000;

async function main(): Promise<void> {
  if (mode === "hold") {
    const release = await acquireOsFileLease(lockPath, waitMs);
    process.stdout.write(JSON.stringify({ acquired: true, pid: process.pid }) + "\n");
    // 持有:不释放、不退出 —— 等父进程 SIGKILL。release 只是显式留着(租约由文件存在表示,
    // 不会被 GC 自动释放),保持事件循环存活直到被杀。
    void release;
    setInterval(() => {}, 1_000);
    return;
  }
  // acquire-once
  try {
    const release = await acquireOsFileLease(lockPath, waitMs);
    process.stdout.write(JSON.stringify({ acquired: true }) + "\n");
    await release();
  } catch (e) {
    process.stdout.write(JSON.stringify({ acquired: false, error: String((e as Error)?.message ?? e) }) + "\n");
  }
  process.exit(0);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ acquired: false, error: String(e) }) + "\n");
  process.exit(1);
});
