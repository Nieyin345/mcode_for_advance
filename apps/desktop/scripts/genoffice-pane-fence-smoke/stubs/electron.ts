/** The security tests use fake IPC/dialog instances; module-level Electron exports only prevent loading real Electron. */
export const ipcMain = {}
export const dialog = {}
