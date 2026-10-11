/**
 * 无头 smoke 的 electron 桩 —— 两个 provider 的 import 图会一路碰到 electron
 * (dataRoot / secretStore / browser / NotificationManager…)。这里给够所有被 import 到的
 * 具名导出,让 bundle 能加载;本套件不驱动任何 electron 行为。
 */
class Emitter {
  on() {}
  once() {}
  off() {}
  removeListener() {}
  addListener() {}
  emit() {}
  setMaxListeners() {
    return this;
  }
}

export const app = {
  getPath: () => process.env.MCODE_SMOKE_DATA_ROOT || "/tmp/mcode-fake",
  getAppPath: () => "/tmp/mcode-fake",
  getVersion: () => "0.0.0",
  isPackaged: false,
  on: () => {},
  once: () => {},
  whenReady: () => Promise.resolve(),
  getName: () => "mcode",
  quit: () => {},
  relaunch: () => {},
  setPath: () => {},
  getLocale: () => "en",
  getSystemLocale: () => "en",
  commandLine: { appendSwitch: () => {} },
  requestSingleInstanceLock: () => true,
};

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString(),
  setUsePlainTextEncryption: () => {},
};

export const ipcMain = new (class {
  handle() {}
  on() {}
  once() {}
  removeHandler() {}
})();

export const shell = {
  openExternal: async () => {},
  openPath: async () => {},
  showItemInFolder: () => {},
};

export const session = { defaultSession: {}, fromPartition: () => ({}) };

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true }),
  showMessageBox: async () => ({ response: 0 }),
};

export const clipboard = {
  writeText: () => {},
  readText: () => "",
  writeImage: () => {},
  readImage: () => ({}),
};

export const nativeImage = {
  createFromPath: () => ({ isEmpty: () => true }),
  createFromDataURL: () => ({ isEmpty: () => true }),
};

export const nativeTheme = { shouldUseDarkColors: false, on: () => {}, themeSource: "system" };

export const protocol = { handle: () => {}, registerSchemesAsPrivileged: () => {} };

export const Notification = class {
  static isSupported() {
    return false;
  }
  show() {}
  on() {}
};

export const ClipboardItem = class {};

export const WebContentsView = class {
  constructor() {
    (this as unknown as { webContents: object }).webContents = {
      on: () => {},
      setWindowOpenHandler: () => {},
      session: {},
    };
  }
};

export const BrowserWindow = class extends Emitter {
  constructor() {
    super();
    (this as unknown as { webContents: object }).webContents = new Emitter();
  }
  static getAllWindows() {
    return [];
  }
  static fromWebContents() {
    return null;
  }
};

export const Menu = class {
  static setApplicationMenu() {}
  static buildFromTemplate() {
    return {};
  }
};

export const utilityProcess = {
  fork: () => ({ on: () => {}, postMessage: () => {}, kill: () => {} }),
};

export const screen = {
  getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }),
};

export default {
  app,
  safeStorage,
  ipcMain,
  shell,
  session,
  dialog,
  clipboard,
  nativeImage,
  nativeTheme,
  protocol,
  Notification,
  ClipboardItem,
  BrowserWindow,
  Menu,
  WebContentsView,
  utilityProcess,
  screen,
};
