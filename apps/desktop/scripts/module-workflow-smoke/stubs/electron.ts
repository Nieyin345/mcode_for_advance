import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { Api } from "../../../src/preload/index.js";
type Handler = Parameters<IpcMain["handle"]>[1];
export const handlers = new Map<string, Handler>();
export const fakeIpcMain = {
  handle(channel: string, listener: Handler): void {
    if (handlers.has(channel)) throw new Error(`Duplicate channel: ${channel}`);
    handlers.set(channel, listener);
  },
} as IpcMain;
const exposed = new Map<string, unknown>();
export const contextBridge = { exposeInMainWorld: (name: string, value: unknown): void => { exposed.set(name, value); } };
export const ipcRenderer = {
  invoke: async (channel: string, input?: unknown): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Unregistered test IPC channel: ${channel}`);
    // Simulate the structured-clone transport, not a shared-object shortcut.
    return structuredClone(await handler({} as IpcMainInvokeEvent, structuredClone(input)));
  },
  on: (): never => { throw new Error("No subscriptions expected in this smoke"); },
  off: (): never => { throw new Error("No subscriptions expected in this smoke"); },
};
export const webUtils = { getPathForFile: (): never => { throw new Error("No dialogs in this smoke"); } };
export function preloadApi(): Api {
  if (!exposed.has("api")) throw new Error("The real preload did not expose its API");
  return exposed.get("api") as Api;
}
