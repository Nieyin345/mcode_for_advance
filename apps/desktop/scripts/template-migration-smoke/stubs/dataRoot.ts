/**
 * `@main/lib/dataRoot.js` 的替身 —— 只为无头脚本存在。
 *
 * 真的那一个 import 了 `electron`(`app.getPath("userData")` 读数据根指针),那是无头
 * 脚本给不出来的东西。这里只换掉 `dataRoot()`,指向 run.sh 里 `mktemp -d` 出来的目录。
 *
 * ⚠️ **绝不能让它指到用户真正的数据根。** 这一套会真的建库、写行、并且调
 * `SettingRepo.set`(内部就是 `persist()` = 把整个 `mcode.db` 重写一遍)。指错了就是
 * 拿一套夹具盖掉用户的聊天记录。所以环境变量没设时**直接抛**,不回落到默认值
 * (抄 run-store-smoke/stubs/dataRoot.ts;别把它改成默默回落)。
 */
export function dataRoot(): string {
  const dir = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!dir) throw new Error("MCODE_SMOKE_DATA_ROOT 没设 —— 这个桩只给无头脚本用");
  return dir;
}

/** 与真正那份逐字一致(`db.ts` 拿它拼库文件名)。 */
export const DATA_DB_FILENAME = "mcode.db";

/** 真的那个把老位置(`%APPDATA%`)里的东西搬进数据根,那是给升级用户用的;
 *  这里的数据根是刚 mktemp 出来的,没有"老位置"可言。 */
export function migrateLegacyIntoDataRoot(): void {
  /* 无头脚本里没有可搬的东西 */
}
