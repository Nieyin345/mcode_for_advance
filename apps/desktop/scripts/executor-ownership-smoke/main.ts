/** ARC-006 / MERGE-3: owner release failures must never be reported as success.
 * Pure in-memory fixture; no Electron, user DB, or engine process involved.
 */
import {
  ExecutorOwnershipRegistry,
  InMemoryExecutorOwnershipStore,
  type ExecutorOwnershipStore,
} from "@main/workflowEngines/executorOwnership.js";

let checks = 0;
let failures = 0;
function check(name: string, passed: boolean, detail?: unknown): void {
  checks++;
  if (passed) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name} — ${JSON.stringify(detail)}`); }
}

const backing = new InMemoryExecutorOwnershipStore();
let rejectRemove = true;
const store: ExecutorOwnershipStore = {
  get: (id) => backing.get(id),
  insert: (record) => backing.insert(record),
  remove: (id, owner) => rejectRemove ? false : backing.remove(id, owner),
  list: () => backing.list(),
};
const registry = new ExecutorOwnershipRegistry(store);
const flowId = "fictitious-ownership-rejection";
check("owner 初始为空", registry.executorOwnerOf(flowId) === null);
check("Mcode 首次 claim 成功", registry.claim(flowId, "mcode").ok === true);
check("其他 owner 不能释放", registry.release(flowId, "node-red").ok === false);
const failedRelease = registry.release(flowId, "mcode");
check("store.remove 返回 false 时 release 必须拒绝，不能谎报成功", !failedRelease.ok, failedRelease);
check("失败后 owner 仍是 mcode", registry.executorOwnerOf(flowId) === "mcode");
check("失败后 node-red 不能抢占", registry.claim(flowId, "node-red").ok === false);
rejectRemove = false;
check("store.remove 成功时 release 返回成功", registry.release(flowId, "mcode").ok === true);
check("真实释放后 owner 为空", registry.executorOwnerOf(flowId) === null);
check("释放后 node-red 可合法接管", registry.claim(flowId, "node-red").ok === true);
check("node-red 接管后 mcode 不能释放", registry.release(flowId, "mcode").ok === false);
check("最后保留 node-red ownership", registry.executorOwnerOf(flowId) === "node-red");
console.log(`executor-ownership-smoke: ${checks - failures}/${checks} 通过`);
if (failures !== 0) process.exitCode = 1;
