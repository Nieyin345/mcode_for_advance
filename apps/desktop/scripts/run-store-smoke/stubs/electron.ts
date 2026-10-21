/**
 * Shared Electron substitute for headless, database-backed smoke suites.
 *
 * Only userData has a real equivalent (the isolated smoke data root). Every
 * unrelated Electron entry point fails loudly rather than making a test pass
 * against a fabricated Electron behaviour.
 */
function unavailable(api: string): (...args: unknown[]) => never {
  return () => { throw new Error(`headless smoke must not call electron.${api}`); };
}

function smokeRoot(): string {
  const root = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!root) throw new Error("MCODE_SMOKE_DATA_ROOT unset; refusing to access real Electron userData");
  return root;
}

export const app = {
  getPath: (key: string): string => {
    if (key === "userData") return smokeRoot();
    throw new Error(`headless smoke cannot resolve electron.app.getPath(${key})`);
  },
  getAppPath: unavailable("app.getAppPath"),
  isPackaged: false,
  on: unavailable("app.on"),
  whenReady: unavailable("app.whenReady"),
  quit: unavailable("app.quit"),
};

export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: unavailable("safeStorage.encryptString"),
  decryptString: unavailable("safeStorage.decryptString"),
};
export const nativeTheme = { shouldUseDarkColors: false, on: unavailable("nativeTheme.on") };
export const BrowserWindow = { getAllWindows: unavailable("BrowserWindow.getAllWindows") };
export const shell = {
  openPath: unavailable("shell.openPath"),
  openExternal: unavailable("shell.openExternal"),
  showItemInFolder: unavailable("shell.showItemInFolder"),
};
export const session = { fromPartition: unavailable("session.fromPartition"), defaultSession: unavailable("session.defaultSession") };
export const protocol = {
  registerSchemesAsPrivileged: unavailable("protocol.registerSchemesAsPrivileged"),
  handle: unavailable("protocol.handle"),
};
export const net = { fetch: unavailable("net.fetch") };
export const ipcMain = { handle: unavailable("ipcMain.handle") };
export const dialog = {
  showSaveDialog: unavailable("dialog.showSaveDialog"),
  showOpenDialog: unavailable("dialog.showOpenDialog"),
};
export class WebContentsView {
  constructor() { unavailable("new WebContentsView")(); }
}
