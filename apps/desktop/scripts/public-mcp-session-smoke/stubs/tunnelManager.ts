let stops = 0;
export function disposeTunnel(): void {}
export function startTunnel(): void {}
export function stopTunnel(): void { stops += 1; }
export function tunnelStatus(): any { return { phase: "stopped", url: null, error: null }; }
export function tunnelStops(): number { return stops; }
export function resetTunnel(): void { stops = 0; }
