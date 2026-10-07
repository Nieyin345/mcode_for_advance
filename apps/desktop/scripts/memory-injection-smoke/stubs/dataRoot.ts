import { join } from "node:path";
import { resolve } from 'node:path';
export function dataRoot(): string {
  const root = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!root || !process.env.MEMORY_INJECTION_ARTIFACTS || !resolve(root).startsWith(resolve(process.env.MEMORY_INJECTION_ARTIFACTS))) throw Error('An isolated memory test root is mandatory');
  return root;
}

/** `initDb()` 走真 `dataRoot.ts` 的 `dbPath()` 安全网;无头脚本里没有旧 userData 老库,
 *  所以库就是临时数据根下的 mcode.db(该有的路径隔离仍由上面的 `dataRoot()` 保证)。 */
export function dbPath(): string {
  return join(dataRoot(), "mcode.db");
}
