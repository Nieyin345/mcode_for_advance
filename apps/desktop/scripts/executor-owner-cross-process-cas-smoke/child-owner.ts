/**
 * T4 跨进程 owner CAS 的**子进程入口** —— 由 `main.ts` 用
 * `spawn(process.execPath, [child.mjs, mode, ...])` 各起一个**真实 OS 进程**。
 *
 * 走的是与生产同一份 `FileExecutorOwnershipStore`（不重写机制），目录全部是
 * `mktemp` 出来的临时目录。输出一行 JSON 到 stdout，供父进程断言。
 */
import { FileExecutorOwnershipStore } from "@main/workflowEngines/fileExecutorOwnershipStore.js";
import { withOsFileLeaseSync } from "@main/lib/osFileLease.js";
import { join } from "node:path";
import type { ExecutorOwner } from "@main/workflowEngines/executorOwnership.js";

function reply(value: unknown): never {
  process.stdout.write(JSON.stringify(value) + "\n");
  process.exit(0);
}

const [mode, dir = "", flowId = "", owner = "mcode", atRaw = "0", bootAtRaw = "0"] = process.argv.slice(2);
const at = Number(atRaw);
const bootAt = Number(bootAtRaw);

/** 自旋到统一时刻，把多个进程的写窗口压到同一毫秒附近。 */
function waitUntil(t: number): void {
  if (!Number.isFinite(t) || t <= 0) return;
  while (Date.now() < t) { /* spin */ }
}

try {
  switch (mode) {
    // 立即构造 store，等到 `at` 再 insert。
    case "insert": {
      const store = new FileExecutorOwnershipStore(dir);
      waitUntil(at);
      const result = store.insert({ flowId, owner: owner as ExecutorOwner, reason: "t4-smoke " + process.pid });
      reply({ result, records: store.list() });
    }
    // 先构造（拿到空/旧快照），等 `at` 再 insert —— 模拟"启动后各自登记"。
    case "boot-then-insert": {
      const store = new FileExecutorOwnershipStore(dir);
      waitUntil(at);
      const result = store.insert({ flowId, owner: owner as ExecutorOwner, reason: "t4-smoke " + process.pid });
      reply({ result, records: store.list() });
    }
    // 等到 `bootAt` 才构造 —— 与另一进程的 insert 正面相撞，验证启动对账不覆盖新记录。
    case "delayed-boot": {
      waitUntil(bootAt);
      const store = new FileExecutorOwnershipStore(dir);
      reply({ result: true, records: store.list() });
    }
    case "remove": {
      const store = new FileExecutorOwnershipStore(dir);
      waitUntil(at);
      const result = store.remove(flowId, owner as ExecutorOwner);
      reply({ result, records: store.list() });
    }
    // 崩溃注入：进程拿到**生产同一把**租约后原地等，父进程随后 SIGKILL。
    // 锁文件留在盘上，里面是已死 pid —— 下一个进程必须能回收并继续。
    // `flowId` 槽在这里是**锁定的目标文件**（缺省 `executor-ownership.json`）。
    case "hold-lease-until-killed": {
      const target = join(dir, flowId || "executor-ownership.json");
      withOsFileLeaseSync(target, () => {
        process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, target }) + "\n");
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) { /* 等待被杀 */ }
      });
      reply({ ready: false, error: "hold expired without kill" });
    }
    default:
      reply({ error: "unknown mode " + mode });
  }
} catch (err) {
  reply({ result: false, error: err instanceof Error ? err.message : String(err) });
}
