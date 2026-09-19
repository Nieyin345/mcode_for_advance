/**
 * `@main/mobile/MobileEventBus.js` 的替身。
 *
 * `lib/sessionSync.ts` 的每一次广播都同时走两条:`sendToRenderer`(桌面端,那个在
 * `window.ts` 桩里记)和 `mobileEventBus.broadcast`(手机端 SSE)。这一套两条都要留痕
 * —— 「删项目之后手机端还挂着那几条会话」正是这一套要抓的形状之一。
 */
import type { RuntimeEvent } from "@contracts/runtime";

/** 手机端收到的每一帧,按顺序。 */
export const mobileEvents: RuntimeEvent[] = [];

export function resetMobileEvents(): void {
  mobileEvents.length = 0;
}

export const mobileEventBus = {
  broadcast(e: RuntimeEvent): void {
    mobileEvents.push(e);
  },
  subscribe(): () => void {
    return () => {};
  },
};
