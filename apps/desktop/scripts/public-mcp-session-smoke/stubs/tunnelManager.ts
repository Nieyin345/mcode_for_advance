let stops = 0;
let phase = "stopped";
let calls: { port: number; config: any }[] = [];
export function disposeTunnel(): void {}
export function startTunnel(port: number, _restart?: boolean, config?: any): void { calls.push({ port, config }); phase = "ready"; }
export function stopTunnel(): void { stops += 1; phase = "stopped"; }
export function tunnelStatus(): any { return { phase, url: null, error: null }; }
export function tunnelStops(): number { return stops; }
export function tunnelCalls(): typeof calls { return calls; }
export function resetTunnel(): void { stops = 0; phase = "stopped"; calls = []; }
