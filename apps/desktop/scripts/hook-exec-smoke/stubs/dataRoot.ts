/**
 * `@main/lib/dataRoot.js` 的替身 —— 只为无头脚本存在。
 *
 * 真的那一个 import 了 `electron`(`app.getPath("userData")` 读数据根指针),那是无头
 * 脚本给不出来的东西。钩子的存放层只用到 `dataRoot()` 一个函数,所以这里就换掉这一个
 * 函数:返回脚本自己指定的临时目录。
 *
 * 用 `--alias:@main/lib/dataRoot.js=...` 换进来(见 run.sh)。**被测的那份代码一行都
 * 没改** —— 换掉的只是它脚下的文件系统根。
 */
export function dataRoot(): string {
  const dir = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!dir) throw new Error("MCODE_SMOKE_DATA_ROOT 没设 —— 这个桩只给无头脚本用");
  return dir;
}
