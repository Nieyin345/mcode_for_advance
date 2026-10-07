import { join } from "node:path";
/**
 * `@main/lib/dataRoot.js` 的替身 —— 只为无头脚本存在。
 *
 * 真的那一个 import 了 `electron`(`app.getPath("userData")` 读数据根指针),那是无头
 * 脚本给不出来的东西。这里返回脚本自己指定的临时目录,于是节点类型目录、代理档案目录
 * 全都落在临时目录下,**被测的那份代码一行都没改**(同 `scripts/hooks-smoke`)。
 */
export function dataRoot(): string {
  const dir = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!dir) throw new Error("MCODE_SMOKE_DATA_ROOT 没设 —— 这个桩只给无头脚本用");
  return dir;
}

/** `initDb()` 走真 `dataRoot.ts` 的 `dbPath()` 安全网;无头脚本里没有旧 userData 老库,
 *  所以库就是临时数据根下的 mcode.db(该有的路径隔离仍由上面的 `dataRoot()` 保证)。 */
export function dbPath(): string {
  return join(dataRoot(), "mcode.db");
}
