type Handler = (...args: unknown[]) => void;
export const calls: Array<{ channel: string; args: unknown[] }> = [];
export const listeners = new Map<string, Handler[]>();
export const exposed = new Map<string, unknown>();
export const replies = new Map<string, unknown>();
export const ipcRenderer = {
  invoke: async (channel: string, ...args: unknown[]) => {
    calls.push({ channel, args });
    return replies.get(channel);
  },
  send: (channel: string, ...args: unknown[]) => { calls.push({ channel, args }); },
  sendSync: (channel: string, ...args: unknown[]) => { calls.push({ channel, args }); return true }, 
  on: (channel: string, listener: Handler) => {
    listeners.set(channel, [...(listeners.get(channel) || []), listener]);
  },
  removeListener: (channel: string, listener: Handler) => {
    listeners.set(channel, (listeners.get(channel) || []).filter((x) => x !== listener));
  },
};
export const app = { getSystemLocale: () => 'ja-JP', getPath: (_key: string) => process.env.MCODE_SMOKE_DATA_ROOT || '.' };
export const session = { defaultSession: { removeWordFromSpellCheckerDictionary: (_word: string) => true } };
export const contextBridge = { exposeInMainWorld: (name: string, api: unknown) => exposed.set(name, api) };
