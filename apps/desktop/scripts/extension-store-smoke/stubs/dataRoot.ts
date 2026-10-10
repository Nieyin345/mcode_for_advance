/**
 * `@main/lib/dataRoot.js` 的替身 —— 只为无头脚本存在。
 *
 * 真的那个 import 了 `electron`(`app.getPath("userData")` 读数据根指针)。这里只换掉
 * `dataRoot()`,指向脚本自己建的临时目录。
 *
 * ⚠️ **绝不能让它指到用户真正的数据根。** 这套脚本会往 `<数据根>/extensions/` 下写文件,
 * 指错了就是往用户的真实数据根里塞目录。所以环境变量没设时**直接抛**,不回落到默认值。
 */
export function dataRoot(): string {
  const dir = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!dir) throw new Error("MCODE_SMOKE_DATA_ROOT 没设 —— 这个桩只给无头脚本用");
  return dir;
}

export const DATA_DB_FILENAME = "mcode.db";
