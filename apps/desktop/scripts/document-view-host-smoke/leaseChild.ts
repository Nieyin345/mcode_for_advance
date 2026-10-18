/**
 * 【ARC-007】跨进程租约夹具 —— document-view-host-smoke 的**独立 OS 进程**。
 *
 * run.sh 把**同一份 `src/main/lib/osFileLease.ts`** 内联进本入口（esbuild
 * `--bundle`，与宿主 bundle 各自内联但来源是同一个文件）。租约的互斥事实在**磁盘**上
 * —— `<real>.mcode-lock` 用 `O_CREAT|O_EXCL` 抢占 —— 所以两个进程不需要共享模块
 * 实例，只需要同一套原语；这里用 import 保证"同一套"不是手抄的。
 *
 *   node leaseChild.mjs hold   <file> <ms>   抢租约、回一行 `held`、持满 ms 后释放
 *   node leaseChild.mjs probe  <file> <ms>   抢租约（等待上限 ms）、回 `acquired` 或 `busy`
 *
 * 父进程用法：`hold` 证明"另一 OS 进程持有同一路径的写租约"时，宿主的
 * `saveOpenedFile` 必须报 conflict（租约等待超时），而不是等它释放后再覆盖；
 * `probe` 反向证明 app 进程持有租约时独立进程真的抢不到（租约是跨进程事实）。
 */
import { acquireOsFileLease } from "../../src/main/lib/osFileLease.js";

const [, , mode, file, msRaw] = process.argv;
const ms = Number(msRaw);
if (!file || !Number.isFinite(ms)) {
  console.log(JSON.stringify({ ok: false, error: "usage: leaseChild.mjs <hold|probe> <file> <ms>" }));
  process.exit(2);
}

if (mode === "hold") {
  const release = await acquireOsFileLease(`${file}.mcode-lock`);
  // 先落这一行：父进程据此知道"租约已由另一个 OS 进程持有"。
  console.log("held");
  await new Promise((r) => setTimeout(r, ms));
  await release();
  console.log("released");
  process.exit(0);
}
if (mode === "probe") {
  try {
    const release = await acquireOsFileLease(`${file}.mcode-lock`, ms);
    await release();
    console.log("acquired");
  } catch (err) {
    console.log(/^FILE_VERSION_CONFLICT/.test(String((err as Error)?.message)) ? "busy" : `error: ${String(err)}`);
  }
  process.exit(0);
}
console.log(JSON.stringify({ ok: false, error: `unknown mode: ${mode}` }));
process.exit(2);
