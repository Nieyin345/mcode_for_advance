import { join } from "node:path";
/**
 * `@main/lib/dataRoot.js` 的替身 —— 只为无头脚本存在(与 run-store-smoke 那份逐字
 * 相同的取舍:**没设就抛**)。
 *
 * 本套的主体(安装 ripgrep)不建库也不写库,但 `ipc/rg.ts` 的 import 图经
 * `ipc/index` 之外仍会拖进 store 相关的东西,而 `db.ts` 在 `initDb()` 时会对一个不存在
 * 的路径**新建一个空库**。指向真数据根 = 拿空库盖掉用户的聊天记录(sql.js 的
 * `db.export()` 是重写整个 `mcode.db`)。所以这里不回落到任何默认值。
 */
export function dataRoot(): string {
  const dir = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!dir) throw new Error("MCODE_SMOKE_DATA_ROOT 没设 —— 这个桩只给无头脚本用");
  return dir;
}

/** 与真的一致(`db.ts` 拿它拼库文件名)。 */
export const DATA_DB_FILENAME = "mcode.db";

/** **空操作。** 真的那个把老位置里的库搬进数据根,这里的数据根是刚 mktemp 出来的。 */
export function migrateLegacyIntoDataRoot(): void {
  /* 无头脚本里没有可搬的东西 */
}

/** `initDb()` 走真 `dataRoot.ts` 的 `dbPath()` 安全网;无头脚本里没有旧 userData 老库,
 *  所以库就是临时数据根下的 mcode.db(该有的路径隔离仍由上面的 `dataRoot()` 保证)。 */
export function dbPath(): string {
  return join(dataRoot(), "mcode.db");
}
