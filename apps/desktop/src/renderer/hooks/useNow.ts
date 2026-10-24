import { useSyncExternalStore } from "react";

/**
 * Global shared 1-second ticker for live-duration displays.
 *
 * The per-turn stat row (`TurnStatRow` in ChatPane) renders inside a
 * LegendList virtualized item. During streaming, delta flushes rebuild the
 * `renderItems` array on every frame, which can cause the list to recycle its
 * containers and remount `TurnStatRow` before a component-local `setInterval`
 * ever fires its first 1000ms tick - leaving the duration stuck at "<1s".
 *
 * Moving the clock to a single module-level interval that survives remounts
 * (via `useSyncExternalStore`) breaks that coupling: the timer runs once for
 * the whole app regardless of how the virtual list shuffles components, and it
 * auto-starts/stops with the first/last subscriber so it costs nothing when no
 * live turn is on screen.
 */

let currentTick = Date.now();
const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;

function startClock(): void {
  if (intervalId !== null) return;
  intervalId = setInterval(() => {
    currentTick = Date.now();
    for (const cb of listeners) cb();
  }, 1000);
}

function stopClock(): void {
  if (intervalId === null) return;
  clearInterval(intervalId);
  intervalId = null;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) startClock();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) stopClock();
  };
}

function getSnapshot(): number {
  return currentTick;
}

/** 只读一次的快照 —— **视觉基线专用**。
 *
 * `arc005-visual-baseline` 每拍一张图都要和基线逐字节比。而这个 hook 每 1 秒
 * 跳一次，跳的瞬间秒位重排，会让「没改过界面的场景」也报差异（实测：四处暗色
 * 场景各差 8px，灰度只差 1 —— 那是数字重排，不是任何改动）。
 *
 * 「每次都报差异」会训练人忽略 `compare.mjs` 的输出，那比不报更糟。所以让探针
 * 在截图前设 `window.__MCODE_FREEZE_CLOCK__ = <固定时间戳>`，这里读到就用它，
 * 不再启动 ticker。
 *
 * ⚠️ **只在基线的 WebContents 里设置**，正常运行时这个变量不存在，行为不变。 */
function frozenNow(): number | null {
  const v = (globalThis as { __MCODE_FREEZE_CLOCK__?: unknown }).__MCODE_FREEZE_CLOCK__;
  return typeof v === "number" ? v : null;
}

/** Re-render roughly once per second. Returns the current wall-clock ms.
 *  Only subscribe when a live (ongoing) turn is visible, so finished turns
 *  don't pay for an unnecessary tick. */
export function useNow(): number {
  const frozen = frozenNow();
  if (frozen !== null) return frozen;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
