/** Only unrelated agent/provider and main-window bootstrap ports are replaced.
 * No fake module, workflow, scheduler, persistence or resource authorization. */
import { BrowserWindow } from "electron";
import { IPC } from "@contracts/ipc";
import type { RuntimeEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";
export const observedEvents: RuntimeEvent[] = [];
export const forbiddenCalls: string[] = [];
const listeners = new Set<(event: RuntimeEvent) => void>();
function forbidden(name: string): never { forbiddenCalls.push(name); throw new Error(`Forbidden model/provider call in module E2E: ${name}`); }
export function sendToRenderer(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(channel, ...args);
}
export const getMainWindow = (): BrowserWindow | null => BrowserWindow.getAllWindows()[0] ?? null;
export const hasLiveRendererWindow = (): boolean => getMainWindow() !== null;
export const updateTitleBarOverlay = (): void => {};
export const runtimeManager = {
  bindSession: (_session: Session): void => {},
  isBusy: (_id: string): boolean => false,
  isTurnEndHeld: (_id: string): boolean => false,
  subscribe: (listener: (event: RuntimeEvent) => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  emitExternal: (event: RuntimeEvent): void => {
    observedEvents.push(structuredClone(event));
    sendToRenderer(IPC.CLAUDE_EVENT, { channel: IPC.CLAUDE_EVENT, sessionId: event.sessionId, event });
    for (const listener of listeners) listener(event);
  },
  echoUserMessage: (): never => forbidden("echoUserMessage"),
  sendTurn: (): never => forbidden("sendTurn"),
  interrupt: (): never => forbidden("interrupt"),
  dispose: (_id: string): void => {},
  usageOf: (): undefined => undefined,
  transcriptOf: (): undefined => undefined,
};
export const providerRegistry = {
  list: (): [] => [],
  get: (): undefined => undefined,
};
export const probeProviderHealth = (): never => forbidden("probeProviderHealth");
