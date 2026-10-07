import { join } from "node:path";
export function dataRoot(): string {
  if (!process.env.M31_TEST_DATA_ROOT) throw Error('M31 isolated data root is required');
  return process.env.M31_TEST_DATA_ROOT;
}

/** `initDb()` 走真 `dataRoot.ts` 的 `dbPath()` 安全网;无头脚本里没有旧 userData 老库,
 *  所以库就是临时数据根下的 mcode.db(该有的路径隔离仍由上面的 `dataRoot()` 保证)。 */
export function dbPath(): string {
  return join(dataRoot(), "mcode.db");
}
