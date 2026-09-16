/**
 * `@main/lib/dataRoot.js` 的替身 —— 只为无头脚本存在。
 *
 * 真的那一个 import 了 `electron`,无头脚本给不出来。模版那一层只用到 `dataRoot()`
 * 一个函数(见 `templates/store.ts` 的 `templatesRoot()`),所以这里就换掉它一个。
 *
 * ⚠️ **环境变量没设就抛,不回落到默认值。** 这一套脚本会往 `<根>/templates/` 里写
 * 夹具文件,落到用户真正的模版库上就是把他的东西盖了。
 */
export function dataRoot(): string {
  const dir = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!dir) throw new Error("MCODE_SMOKE_DATA_ROOT 没设 —— 这个桩只给无头脚本用");
  return dir;
}

/** `db.ts` 会 import 它(模版这一层用不到,但同一个包里带着,顺手给上免得将来炸)。 */
export const DATA_DB_FILENAME = "mcode.db";

/** 空操作:这里的数据根是刚建出来的,没有"老位置"可搬。 */
export function migrateLegacyIntoDataRoot(): void {
  /* 无头脚本里没有可搬的东西 */
}
