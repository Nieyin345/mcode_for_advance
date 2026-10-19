const stored = new Map<string, string>();
export const SettingRepo = {
  get(key: string): string | null { return stored.get(key) ?? null; },
  set(key: string, value: string): void { stored.set(key, value); },
};
export function reset(): void { stored.clear(); }
export async function awaitDb(): Promise<void> {}
export function encrypt(value: string): string { return "encrypted:" + value; }
export function decrypt(value: string): string { return value.replace(/^encrypted:/, ""); }
export const log = { info(_text: string): void {}, warn(_text: string): void {}, error(_text: string): void {} };
export function createTunnelManager(_name: string) {
  return {
    status() { return { phase: "stopped", error: null }; },
    start(_port: number, _allowRemote: boolean, _opts: unknown) {},
    stop() {},
    dispose() {},
  };
}
export function getMobileServer() { return { port: 34783 }; }
