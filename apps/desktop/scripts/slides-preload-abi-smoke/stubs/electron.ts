/** Isolated fake Electron bridge: use the *real* documentViewPreload module. */
type Invoke = (channel: string, payload: unknown) => unknown | Promise<unknown>;
const exposed = new Map<string, unknown>();
let impl: Invoke = () => { throw new Error("smoke IPC not configured"); };
const calls: Array<{ channel: string; payload: unknown }> = [];
export function setupInvoke(fn: Invoke): void { impl = fn; calls.length = 0; }
export function getCalls(): Array<{ channel: string; payload: unknown }> { return calls.slice(); }
export function getExposed(name: string): Record<string, (...args: any[]) => Promise<any>> {
  const api = exposed.get(name);
  if (!api) throw new Error("not exposed: " + name);
  return api as Record<string, (...args: any[]) => Promise<any>>;
}
export const contextBridge = {
  exposeInMainWorld: (name: string, api: unknown): void => { exposed.set(name, api); },
};
export const ipcRenderer = {
  invoke: async (channel: string, payload: unknown): Promise<unknown> => {
    calls.push({ channel, payload });
    return impl(channel, payload);
  },
  on: (_channel: string, _fn: unknown): void => {},
  removeListener: (_channel: string, _fn: unknown): void => {},
  send: (_channel: string, ..._args: unknown[]): void => {},
};
