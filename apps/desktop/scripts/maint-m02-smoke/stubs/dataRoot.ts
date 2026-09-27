/** Isolated disposable database root for this smoke; never falls back to user data. */
export function dataRoot(): string {
  const dir = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!dir) throw new Error("MCODE_SMOKE_DATA_ROOT must point at the smoke's temporary directory");
  return dir;
}

export const DATA_DB_FILENAME = "mcode.db";
export function migrateLegacyIntoDataRoot(): void {}
