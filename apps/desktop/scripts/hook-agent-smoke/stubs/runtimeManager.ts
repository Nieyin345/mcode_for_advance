import type { Session } from "@contracts/session";
export const sent: Array<{ session: Session; prompt: string; cwd: string }> = [];
export const bound: string[] = [];
const listeners: Array<(event: unknown) => void> = [];
export const runtimeManager = {
  bindSession(session: Session) { bound.push(session.id); },
  async sendTurn(session: Session, args: { prompt: string; cwd: string }) {
    sent.push({ session, prompt: args.prompt, cwd: args.cwd });
    return { isRunning: () => false };
  },
  subscribe(fn: (event: unknown) => void) {
    listeners.push(fn);
    return () => { const at = listeners.indexOf(fn); if (at >= 0) listeners.splice(at, 1); };
  },
  isTurnEndHeld(_id: string) { return false; },
  emit(event: unknown) { for (const fn of listeners.slice()) fn(event); },
};