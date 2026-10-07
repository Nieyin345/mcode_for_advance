import { join } from "node:path";
/** Isolated disposable database root for this smoke; never falls back to user data. */
export function dataRoot(): string {
  const dir = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!dir) throw new Error("MCODE_SMOKE_DATA_ROOT must point at the smoke's temporary directory");
  return dir;
}

export const DATA_DB_FILENAME = "mcode.db";
export function migrateLegacyIntoDataRoot(): void {}

/** `initDb()` 走真 `dataRoot.ts` 的 `dbPath()` 安全网;无头脚本里没有旧 userData 老库,
 *  所以库就是临时数据根下的 mcode.db(该有的路径隔离仍由上面的 `dataRoot()` 保证)。 */
export function dbPath(): string {
  return join(dataRoot(), "mcode.db");
}
