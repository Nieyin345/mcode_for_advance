/** 数据根换成 MCODE_SMOKE_DATA_ROOT;没设就抛(指错地方会拿空库盖真库)。 */
function root(): string {
  const r = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!r) throw new Error("resume-fault-smoke: MCODE_SMOKE_DATA_ROOT 未设置");
  return r;
}
export const dataRoot = root;
export const dbPath = () => root() + "/mcode.db";
export const migrateLegacyIntoDataRoot = () => {};
export const MCODE_DATA_ROOT = "";
export default root;
