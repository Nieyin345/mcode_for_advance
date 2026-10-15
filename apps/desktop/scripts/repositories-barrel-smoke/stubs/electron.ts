/**
 * `electron` 的替身 —— barrel 的依赖链（db.ts / sessionSchema.ts）会摸到它。
 *
 * 真被调到该抛的照样抛（比如真去建窗口），但 `app.getPath` 与 `safeStorage`
 * 要给一个能用的值：`db.ts` 顶层只拿它算数据根，而本套的数据根已被
 * `MCODE_SMOKE_DATA_ROOT` 接管（见 stubs/dataRoot.ts）。
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

export const app = {
  getPath: (_name: string) => join(tmpdir(), "mcode-repositories-barrel-smoke"),
  getAppPath: () => process.cwd(),
  isPackaged: false,
  on: () => undefined,
  whenReady: () => Promise.resolve(),
};
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => "",
  decryptString: () => "",
};
export const ipcMain = { handle: () => undefined };
