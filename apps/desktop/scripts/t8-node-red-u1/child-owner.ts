/**
 * T8 —— 跨进程 owner 的**子进程入口**（由旅程用 `spawnSync(process.execPath, …)`
 * 以 electron-as-node 起一个**真实 OS 进程**）。
 *
 * 走与生产同一份 `FileExecutorOwnershipStore`（T4 的跨进程 CAS 就在它里面）；
 * 不重写机制、不碰用户数据（目录由父进程给的临时 engineDir）。
 *
 * 输出：**一行** JSON（最后一行）——
 *   `{ sameFlowClaim, freshClaim, freshReleased }`
 *
 *  - `sameFlowClaim`：同一个 flowId（父进程引擎正持有）在本进程 `insert` 必须为
 *    `false`（T4：至多一个 owner）；
 *  - `freshClaim`：一个从未登记过的 id 在本进程 `insert` 必须为 `true`；
 *  - `freshReleased`：按 owner 身份 `remove` 必须为 `true`（不把记录留成垃圾）。
 */
import { FileExecutorOwnershipStore } from "@main/workflowEngines/fileExecutorOwnershipStore.js";

const [engineDir, heldFlowId] = process.argv.slice(2);
if (!engineDir || !heldFlowId) {
  process.stdout.write(JSON.stringify({ error: "usage: child-owner.cjs <engineDir> <heldFlowId>" }) + "\n");
  process.exit(2);
}

const result: { sameFlowClaim: boolean; freshClaim: boolean; freshReleased: boolean } = {
  sameFlowClaim: true,
  freshClaim: false,
  freshReleased: false,
};
try {
  const store = new FileExecutorOwnershipStore(engineDir);
  // 同一个 flowId：引擎（父进程）已经持有 → 本次 insert 必须失败。
  result.sameFlowClaim = store.insert({ flowId: heldFlowId, owner: "mcode", reason: "T8 cross-process child" });
  // 新 id：并发/独立登记必须成功（T4：不同 id 不整表覆盖）。
  const freshId = `t8-fresh-${process.pid}-${Date.now()}`;
  result.freshClaim = store.insert({ flowId: freshId, owner: "mcode", reason: "T8 cross-process child fresh" });
  result.freshReleased = store.remove(freshId, "mcode");
} catch (err) {
  process.stdout.write(JSON.stringify({ ...result, error: err instanceof Error ? err.message : String(err) }) + "\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify(result) + "\n");
process.exit(0);
