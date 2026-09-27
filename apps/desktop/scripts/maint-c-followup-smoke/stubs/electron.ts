/** 与 library-delete-smoke/stubs/electron.ts 同形,只把 `shell.openPath` 换成记名替身。 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`maint-c-followup-smoke 不该走到 electron.${name}`);
  };
}
export const openedPaths: string[] = [];
export const shell = {
  openPath: async (p: string): Promise<string> => {
    openedPaths.push(p);
    return "";
  },
  openExternal: notHere("shell.openExternal"),
  showItemInFolder: notHere("shell.showItemInFolder"),
};
export const app = {
  getPath: notHere("app.getPath"),
  getAppPath: notHere("app.getAppPath"),
  isPackaged: false,
  on: notHere("app.on"),
};
export const nativeTheme = { shouldUseDarkColors: false };
export const ipcMain = { handle: notHere("electron.ipcMain.handle") };
export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };
