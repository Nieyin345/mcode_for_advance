/**
 * 数据根桩：**没设环境变量就抛**。
 *
 * 别改成默默回落到默认值 —— 这一套真建库，`sql.js` 的 `db.export()` 重写整个
 * `mcode.db`，指错了就是拿空库盖掉用户的聊天记录。
 */
import { join } from "node:path";

export function dataRoot(): string {
  const root = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!root) throw new Error("MCODE_SMOKE_DATA_ROOT 未设置：本套会真建库，必须指向临时目录");
  return root;
}

/** `db.ts` 用这个算库文件路径。 */
export function dbPath(): string {
  return join(dataRoot(), "mcode.db");
}

/** 老库迁移 —— 无头套件里没有老目录可迁，是空操作。 */
export function migrateLegacyIntoDataRoot(): void {
  /* smoke 里没有 legacy 目录 */
}
