/**
 * `@main/lib/dataRoot.js` 的替身 —— 只为这套无头脚本存在(与 db-migrate-smoke 的
 * 同名桩一致;各套件各自持有自己的桩,互不修改对方的文件)。
 *
 * ⚠️ **绝不能指到用户真正的数据根。** 本套件会建库、写行、删行,而 `initDb()` 在
 * 不存在的路径上会新建一个空库 —— 指错了就是拿空库盖掉用户的聊天记录。所以环境
 * 变量没设时**直接抛**,不回落到默认值。
 */
import { join } from "node:path";

export function dataRoot(): string {
  const dir = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!dir) throw new Error("MCODE_SMOKE_DATA_ROOT 没设 —— 这个桩只给无头脚本用");
  return dir;
}

/** 与真的一致(`db.ts` 拿它拼库文件名)。 */
export const DATA_DB_FILENAME = "mcode.db";

/** 空操作:临时数据根没有"老位置"可搬。 */
export function migrateLegacyIntoDataRoot(): void {
  /* 无头脚本里没有可搬的东西 */
}

/** `initDb()` 现在走真 `dataRoot.ts` 的 `dbPath()` 安全网。无头脚本里没有
 *  旧版 userData 老库,所以直接就是临时数据根下的 mcode.db。 */
export function dbPath(): string {
  return join(dataRoot(), DATA_DB_FILENAME);
}

