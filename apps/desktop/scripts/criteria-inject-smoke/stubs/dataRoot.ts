/**
 * `@main/lib/dataRoot.js` 的替身 —— 只为无头脚本存在。
 *
 * 真的那一个 import 了 `electron`,无头脚本给不出来。指向脚本自己建的临时目录。
 *
 * ⚠️ **绝不能让它指到用户真正的数据根。** 这一套脚本会写设置表、写消息表,而
 * `db.ts` 的 `initDb()` 在一个不存在的路径上会**新建一个空库** —— 指错了就是拿一个
 * 空库盖掉用户的聊天记录。所以环境变量没设时**直接抛**,不回落到默认值。
 */
export function dataRoot(): string {
  const dir = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!dir) throw new Error("MCODE_SMOKE_DATA_ROOT 没设 —— 这个桩只给无头脚本用");
  return dir;
}

/** 与真的一致(`db.ts` 拿它拼库文件名)。 */
export const DATA_DB_FILENAME = "mcode.db";

/** 空操作 —— 无头脚本里没有"老位置"可搬。 */
export function migrateLegacyIntoDataRoot(): void {
  /* 无头脚本里没有可搬的东西 */
}
