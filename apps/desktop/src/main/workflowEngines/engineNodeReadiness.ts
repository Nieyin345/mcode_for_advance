/**
 * ARC-006 Gate E: Node-RED must not execute a single third-party Node while its
 * approved executable ledger, crash backups, or revocation state is unresolved.
 *
 * Fail-closed means an ambiguous backup is left untouched and the caller blocks
 * engine start / new installation. This operation MUST run before engine spawn.
 */
import type { EngineNodeRegistry } from "./engineNodeRegistry.js";

export async function ensureEngineNodeReady(registry: EngineNodeRegistry): Promise<void> {
  // Verify durable approval state BEFORE any crash-recovery mutation. A broken
  // ledger must never prompt us to restore/delete executable node backups.
  const initial = await registry.readState();
  if (initial.kind === "corrupt") throw new Error(`节点清单不可读：${initial.reason}`);
  const crash = await registry.recoverCrashBackups();
  if (crash.blocked.length > 0) {
    throw new Error(`节点包崩溃恢复需人工核对：${crash.blocked.map((x) => `${x.name}: ${x.reason}`).join("；")}`);
  }
  const removed = await registry.recoverPendingRemovals();
  if (removed.failed.length > 0) {
    throw new Error(`撤销的节点包仍残留：${removed.failed.map((x) => `${x.name}: ${x.reason}`).join("；")}`);
  }
  const after = await registry.readState();
  if (after.kind === "corrupt") throw new Error(`节点清单不可读：${after.reason}`);
  // A previously existing approval ledger disappearing during recovery is
  // not equivalent to a fresh Node-RED installation. Do not quietly proceed
  // with an empty approval history, even if the current directory scanner
  // happens to find no plugins at this instant.
  if (initial.kind === "ok" && after.kind === "absent") {
    throw new Error("节点清单在恢复过程中消失，拒绝按新安装空清单启动");
  }
  if (initial.kind === "ok" && after.kind === "ok") {
    // The recovery routines may finish deleting pending-remove entries,
    // but never delete or re-authorize an already installed approval.
    // A concurrent writer that rewrites/deletes an installed row must not
    // silently turn this start preflight into a fresh empty ledger.
    for (const approved of initial.entries.filter((item) => item.state === "installed")) {
      const current = after.entries.find((item) => item.name === approved.name);
      if (current === undefined || JSON.stringify(current) !== JSON.stringify(approved)) {
        throw new Error(`已批准节点记录在预检过程中被替换或消失：${approved.name}`);
      }
    }
  }
  if (after.entries.some((item) => item.state === "pending-remove")) {
    throw new Error("节点卸载/撤权尚未完成，拒绝启动或安装新节点");
  }
  // 不能只相信登记时的 sha256。插件在批准后可能被磁盘篡改、删失或替换。
  // 主进程在 runtime.start / 真人安装下一包之前校验所有在册可执行体；
  // 缺文件或发生 IO 错误一律阻断，不偷偷覆盖清单来"修复"信任关系。
  const packages = await registry.verifyApprovedPackages();
  if (packages.blocked.length > 0) {
    throw new Error(`节点可执行体完整性/批准校验失败：${packages.blocked.map((x) => `${x.name}: ${x.reason}`).join("；")}`);
  }
  // 已登记插件完整不代表安全：Node-RED 还会从 node_modules 加载未登记的
  // node-red-contrib-*、带 node-red.nodes 的任意命名/npm scoped 社区节点。
  // 不能自动为这些盘上文件补批准，更不能删除用户旧文件；阻断并返回包名。
  const orphans = await registry.findUnregisteredNodePackages();
  if (orphans.blocked.length > 0) {
    throw new Error(`存在未登记/未批准的 Node-RED 可执行节点：${orphans.blocked.map((x) => `${x.name}: ${x.reason}`).join("；")}`);
  }
  // Package verification and orphan scanning are both asynchronous. Re-read
  // the exact approved snapshot after these operations: if another writer
  // removed/replaced it while we scanned, neither an earlier hash verification
  // nor a now-empty directory is authority to start executable nodes.
  const finalState = await registry.readState();
  if (finalState.kind === "corrupt" ||
      finalState.kind !== after.kind ||
      JSON.stringify(finalState.entries) !== JSON.stringify(after.entries)) {
    throw new Error("节点批准清单在完整性预检期间变动，拒绝启动并要求重新预检");
  }
}
