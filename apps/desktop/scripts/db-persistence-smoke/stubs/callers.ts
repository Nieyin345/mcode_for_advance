/** No Electron, files, real settings or quit: dependencies for caller tests. */
import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";

export const calls: string[] = [];
export const messages: MessageBoxOptions[] = [];
export const observers = new Set<(error: Error) => void>();
export const state = {
  locale: "en", flushError: false, closeError: false, copyError: false,
  dialogThrows: false, dialogRejects: false,
};
const responses: Array<(result: MessageBoxReturnValue) => void> = [];
export function respond(response: number): void {
  const resolve = responses.shift();
  if (!resolve) throw new Error("no pending mock dialog");
  resolve({ response, checkboxChecked: false });
}
export function reset(): void {
  if (responses.length) throw new Error("previous mock dialog was not settled");
  calls.length = 0;
  messages.length = 0;
  Object.assign(state, { locale: "en", flushError: false, closeError: false, copyError: false, dialogThrows: false, dialogRejects: false });
}
export const dialog = {
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
    messages.push(options);
    if (state.dialogThrows) throw new Error("native dialog synchronous failure");
    if (state.dialogRejects) return Promise.reject(new Error("native dialog asynchronous failure"));
    return new Promise((resolve) => responses.push(resolve));
  },
};
export const log = { info() {}, warn() {}, error() { calls.push("log-error"); } };
export const SettingRepo = { get: () => state.locale };
export function onDbPersistenceError(listener: (error: Error) => void): () => void {
  observers.add(listener);
  return () => { observers.delete(listener); };
}
export function flushDb(): void {
  calls.push("flush");
  if (state.flushError) throw new Error("injected flush failure");
}
export function closeDb(): void {
  calls.push("close");
  if (state.closeError) throw new Error("injected close failure");
}
export const dataRoot = () => "/isolated-source";
export const dbPath = () => "/isolated-source/mcode.db";
export const libraryRoot = () => "/isolated-source/library";
export const templatesRoot = () => "/isolated-source/templates";
export function copyDataRootTo(_path: string): string | null {
  calls.push("copy");
  return state.copyError ? "injected copy failure" : null;
}
export function setDataRoot(_path: string): void { calls.push("publish-root"); }
export const app = {
  getVersion: () => "0.0.0-smoke",
  relaunch: () => { calls.push("relaunch"); },
  exit: (_code: number) => { calls.push("exit"); },
};
