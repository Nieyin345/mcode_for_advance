/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * 被测的 `secretMapStore.ts` 本身**不碰 electron**；会碰的是它的消费方
 * `secretStore.ts`（顶层 `import { safeStorage } from "electron"`）。
 * 本套只需要那个 `isEncryptionAvailable`，其余一律**显式抛** ——
 * 真被调到了要立刻显形，而不是安静地返回 undefined 让断言去猜。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`secret-map-store-smoke 不该走到 electron.${name} —— 需要它就该在这里补桩`);
  };
}

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: notHere("safeStorage.encryptString"),
  decryptString: notHere("safeStorage.decryptString"),
};

export const app = {
  getPath: notHere("app.getPath"),
  isPackaged: false,
};

export const ipcMain = { handle: notHere("electron.ipcMain.handle") };
