/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * ## 为什么换掉整个包,而不是一个个 `@main/xxx.js` 去堵
 *
 * 这一套故意走**真的那条 IPC**:`@main/ipc/usage.js` / `@main/ipc/outputStyle.js`。
 * 而 `outputStyle.ts` 经 `outputStyleConfig.js` → `@main/store/db.js` 拖进 sql.js,
 * `usage.ts` 经 `usageStats.js` → `secretStore.js` 拖进 `safeStorage` —— 两边都会碰到
 * `electron` 这个包本身。顺着 alias 一个个堵会变成打地鼠,而每漏一个报出来的都是
 * "找不到模块 electron" / "Cannot determine intended module format",看起来和"被测
 * 代码坏了"一模一样。
 *
 * 换掉整个包更窄也更准。本套要验的两条通路都是**只读聚合**,一行 Electron API 都不该
 * 走到。
 *
 * ⚠️ **不是空实现**:一律**显式抛**。真被调到了要立刻显形,而不是安静地返回 undefined
 * 让断言去猜(同 `library-delete-smoke/stubs/electron.ts` 的取舍)。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(
      `settings-panel-smoke 不该走到 electron.${name}(这两条通路都是只读聚合,不碰 Electron)`,
    );
  };
}

export const app = {
  getPath: notHere("app.getPath"),
  getAppPath: notHere("app.getAppPath"),
  isPackaged: false,
  on: notHere("app.on"),
  whenReady: notHere("app.whenReady"),
};

export const shell = {
  openPath: notHere("shell.openPath"),
  openExternal: notHere("shell.openExternal"),
  showItemInFolder: notHere("shell.showItemInFolder"),
};

export const nativeTheme = { shouldUseDarkColors: false };

/**
 * ⚠️ **唯独这个不能抛。**
 *
 * `secretStore.ts` 的 `listPublic()`(被 `usageStats.ts` 用来把 `customModelId` 翻成
 * 用户看得见的那条厂商名)会走 `encrypt`/`decrypt` → `safeStorage.isEncryptionAvailable()`。
 * 这是**被测代码的正常路径**,不是"不该走到的地方"。
 *
 * 这里刻意模仿**没有系统钥匙串的机器**(`isEncryptionAvailable() === false`):那时
 * `secretStore` 按官方指引退回明文 base64 并打一条警告,功能照常 —— 于是"厂商名解析"
 * 这件事在无头环境里是可断言的。`encryptString`/`decryptString` 仍然抛:真走到说明
 * `isEncryptionAvailable` 那句话被改了,那时应当立刻显形,而不是拿一个假密钥继续跑。
 */
export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: notHere("safeStorage.encryptString"),
  decryptString: notHere("safeStorage.decryptString"),
};

/** 本套自己造了一个 `ipcMain`(记名替身,从它身上取 handler),这个**一定不该**被用到。 */
export const ipcMain = { handle: notHere("electron.ipcMain.handle") };

export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };
