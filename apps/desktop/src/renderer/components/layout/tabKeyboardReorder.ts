/**
 * ARC-005: one keyboard implementation for session and file tab groups.
 *
 * Keep existing pointer/touch DnD and the real store actions; Alt+Left/Right
 * moves focus-owning tab one position *within its own group*. Plain arrows
 * are reserved for the shared TabBarChrome tablist's selection navigation.
 */
export function keyboardReorderTarget(key: string, from: number, length: number): number | null {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(length) ||
      from < 0 || length < 1 || from >= length) return null;
  const step = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
  if (step === 0) return null;
  const to = from + step;
  return to < 0 || to >= length ? null : to;
}

/** Structural subset of React.KeyboardEvent, kept free of React runtime. */
export interface TabReorderKeyEvent {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget;
  currentTarget: HTMLElement;
  nativeEvent: { isComposing: boolean; keyCode: number };
  preventDefault(): void;
  stopPropagation(): void;
}

/** Returns whether the key was consumed; never clicks/activates a tab. */
export function handleTabReorderKeyDown(
  event: TabReorderKeyEvent,
  onReorder: (key: string) => void,
): boolean {
  if (event.target !== event.currentTarget || !event.altKey || event.ctrlKey ||
      event.metaKey || event.shiftKey || event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return false;
  event.preventDefault();
  event.stopPropagation();
  onReorder(event.key);
  const tab = event.currentTarget;
  requestAnimationFrame(() => tab.scrollIntoView({ block: "nearest", inline: "nearest" }));
  return true;
}
