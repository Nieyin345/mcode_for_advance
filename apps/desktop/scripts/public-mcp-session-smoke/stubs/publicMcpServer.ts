let failStart = false;
let starts = 0;
let stops = 0;

export function configurePublicMcpExtras(): void {}
export function configurePublicMcpStore(): void {}
export function newSecret(): string { return "test-secret"; }
export function publicMcpStatus(): any { return { enabled: false, port: 0 }; }
export async function startPublicMcp(): Promise<void> {
  starts += 1;
  if (failStart) throw new Error("listen failed");
}
export function stopPublicMcp(): void { stops += 1; }
export function setStartFailure(value: boolean): void { failStart = value; }
export function serverCounts(): { starts: number; stops: number } { return { starts, stops }; }
export function resetServer(): void { failStart = false; starts = 0; stops = 0; }
export type PublicMcpStore = any;
export type PublicMcpStatus = any;
