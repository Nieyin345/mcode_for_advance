/**
 * `@main/window.js` 的替身 —— 只替掉窗口本身,广播**必须**留痕。
 *
 * `lib/sessionSync.ts` 那条「手机端列表刷不刷新」的断言就压在这里。
 */
export const sent: Array<{ channel: string; args: unknown[] }> = [];

export function resetSent(): void {
  sent.length = 0;
}

export function sentChannels(): string[] {
  return sent.map((s) => s.channel);
}

/** 某一类事件的载荷(桌面端这一路)。 */
export function eventsOfType(type: string): Array<Record<string, unknown>> {
  return sent
    .flatMap((s) => s.args)
    .filter(
      (a): a is { event: { type: string } } =>
        typeof a === "object" && a !== null && "event" in a && (a as { event: unknown }).event !== null,
    )
    .filter((a) => a.event.type === type)
    .map((a) => a.event as unknown as Record<string, unknown>);
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  sent.push({ channel, args });
}

export function getMainWindow(): null {
  return null;
}

/** This shared fixture never creates a window, so there is no live renderer.
 * Keep the production window-readiness API available without bypassing its gate. */
export function hasLiveRendererWindow(): boolean {
  return false;
}

export function createMainWindow(): never {
  throw new Error("projects-ipc-smoke: 不该建窗口");
}

export function updateTitleBarOverlay(): void {
  /* 无头环境里没有窗口 */
}