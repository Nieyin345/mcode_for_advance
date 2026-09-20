/**
 * `@main/lib/dataRoot.js` 的替身 —— 只为无头脚本存在。
 *
 * 真的那一个 import 了 `electron`(`app.getPath("userData")`),无头脚本给不出来。
 * 这里把数据根换成 `$MCODE_SMOKE_DATA_ROOT`(`run.sh` 用 `mktemp -d` 建的目录,跑完就删)。
 *
 * ⚠️ **没设就抛,不回落到默认值。** 这一套会真的建库、写行,而 `initDb()` 在路径不存在时
 * 会**新建一个空库** —— 指错了就是拿空库盖掉用户的聊天记录。
 *
 * (与 `scripts/run-store-smoke/stubs/dataRoot.ts` 同款,这里另存一份是为了本套自包含;
 *  那一套的文件不许改。)
 */
export function dataRoot(): string {
  const dir = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!dir) throw new Error("MCODE_SMOKE_DATA_ROOT 没设 —— 这个桩只给无头脚本用");
  return dir;
}

/** 与真的一致(`db.ts` 拿它拼库文件名)。 */
export const DATA_DB_FILENAME = "mcode.db";

/** **空操作。** 真的那个搬老位置里的库;这里的数据根是刚 `mktemp` 出来的。 */
export function migrateLegacyIntoDataRoot(): void {
  /* 无头脚本里没有可搬的东西 */
}
