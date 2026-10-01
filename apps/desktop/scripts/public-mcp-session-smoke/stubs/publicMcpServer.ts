let failStart = false;
let starts = 0;
let stops = 0;

let capturedStore: any = null;
let capturedExtras: any = null;
let secretSerial = 0;

export function configurePublicMcpExtras(next: any): void { capturedExtras = next; }
export function configurePublicMcpStore(next: any): void { capturedStore = next; }
/** 与真实实现同长度(64 位),否则项目链接那层会把它当坏密钥丢掉。 */
export function newSecret(): string {
  secretSerial += 1;
  return secretSerial.toString(16).padStart(64, "0");
}
export function storeForTest(): any { return capturedStore; }
export function extrasForTest(): any { return capturedExtras; }
export function publicMcpPort(): number { return 0; }
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
