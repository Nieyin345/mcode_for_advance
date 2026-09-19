/**
 * `@main/lib/dataRoot.js` 的替身 —— 只给无头脚本用(抄 `run-store-smoke/stubs/dataRoot.ts`,
 * 只多出 `app.ts` 要的那三个成员)。
 *
 * 真的那一个 import 了 `electron`(`app.getPath("userData")` 读数据根指针),那是无头
 * 脚本给不出来的东西。这里只换掉数据根那几个函数,指向脚本自己建的临时目录。
 *
 * ⚠️ **绝不能让它指到用户真正的数据根。** 本套会建库、写 `settings` 行(记忆库落在
 * `<数据根>/memory`),而 `db.ts` 的 `initDb()` 在一个不存在的路径上会**新建一个空库**,
 * `SettingRepo.set` 内部又是 `persist()` —— **重写整个 `mcode.db`**。指错了就是拿一个
 * 空库盖掉用户的聊天记录。所以环境变量没设时**直接抛**,不回落到默认值。
 */
export function dataRoot(): string {
  const dir = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!dir) throw new Error("MCODE_SMOKE_DATA_ROOT 没设 —— 这个桩只给无头脚本用");
  return dir;
}

/** 与真的一致(`db.ts` 拿它拼库文件名)。 */
export const DATA_DB_FILENAME = "mcode.db";

/** 真的那个读 `app.getPath("userData")` 下的指针文件。无头脚本里没有指针,follow
 *  `dataRoot()`(同一份临时目录)。 */
export function dbPath(): string {
  return `${dataRoot()}/${DATA_DB_FILENAME}`;
}

/** 真那个写指针文件。无头脚本里**整棵树都在临时目录**,不需要搬迁,写成空操作 ——
 *  但**不静默**:真被调到会在这里留下一行 stderr。 */
export function setDataRoot(path: string): void {
  process.stderr.write(`[dataRoot-stub] setDataRoot(${path}) —— 无头脚本里是空操作\n`);
}

/** 真的那个整树复制。无头脚本里没有"搬家"这条业务,显式拒绝而不是假装成功。 */
export function copyDataRootTo(_target: string): string | null {
  return "memory-codex-smoke 的 dataRoot 桩不支持搬家(本套不验那条路)";
}

/** **空操作。** 真的那个把老位置(`%APPDATA%`)里的库和文献库搬进数据根,那是给从旧
 *  版本升上来的用户用的;这里的数据根是刚 `mktemp` 出来的,没有"老位置"可言。 */
export function migrateLegacyIntoDataRoot(): void {
  /* 无头脚本里没有可搬的东西 */
}
