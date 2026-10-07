import { join } from "node:path";
let calls = 0;
export function dataRoot(): string {
  const root = process.env.P2_WORKFLOW_DATA_ROOT;
  if (!root) throw new Error("Isolated workflow data root is required");
  calls++;
  return root;
}
export function dataRootCalls(): number { return calls; }

/** `initDb()` 走真 `dataRoot.ts` 的 `dbPath()` 安全网;无头脚本里没有旧 userData 老库,
 *  所以库就是临时数据根下的 mcode.db(该有的路径隔离仍由上面的 `dataRoot()` 保证)。 */
export function dbPath(): string {
  return join(dataRoot(), "mcode.db");
}
