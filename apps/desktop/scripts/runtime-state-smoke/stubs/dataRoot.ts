/**
 * `@main/lib/dataRoot.js` 的替身 —— 只为无头脚本存在。
 *
 * ⚠️ **绝不能让它指到用户真正的数据根。** `initDb()` 在一个不存在的路径上会**新建
 * 一个空库** —— 指错了就是拿一个空库盖掉用户的聊天记录。所以环境变量没设时**直接抛**。
 */
export function dataRoot(): string {
  const dir = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!dir) throw new Error("MCODE_SMOKE_DATA_ROOT 没设 —— 这个桩只给无头脚本用");
  return dir;
}

/** 与真的一致(`db.ts` 拿它拼库文件名)。 */
export const DATA_DB_FILENAME = "mcode.db";

/** 空操作 —— 临时数据根里没有可搬的老数据。 */
export function migrateLegacyIntoDataRoot(): void {
  /* 无头脚本里没有可搬的东西 */
}
