/**
 * Global in-app toast notification store.
 *
 * Fires toasts for background session events when the window IS focused (OS
 * notifications are suppressed in that case). The toast appears at the
 * bottom-right of the app, auto-dismisses after a timeout, and is clickable
 * to navigate to the source session.
 *
 * Toasts are fired from sessionStore.ingestEvent for non-active sessions:
 *  - blocking events (approval / question / plan approval) -> "warning" tone
 *  - turn completion -> "info" tone
 *  - errors -> "error" tone
 *  - background subagent completion -> "info" tone
 *
 * The Toaster component (components/layout/Toaster.tsx) reads this store and
 * renders the stack. Mounted once at the app root.
 */
import { create } from "zustand";

/** Visual severity of a toast. Drives the icon + left-border accent color. */
export type ToastKind = "info" | "warning" | "error";

/** A single toast entry in the stack. */
export interface ToastItem {
  /** Client-generated unique id (used as the React key + for dismissal). */
  id: string;
  /** Severity - drives icon + accent color. */
  kind: ToastKind;
  /** One-line title (bold). */
  title: string;
  /** Optional body text (muted, below the title). */
  body?: string;
  /** Session to navigate to on click. Absent for non-session toasts. */
  sessionId?: string;
  /**
   * 【UI-036】稳定**身份**键,用于去重。同一条事件/审批重发才应去重;两个**不同**的待审批
   * (如 B 会话的 Bash 1 与 Bash 2)是不同的身份,必须分别出现。从前只按 `title+sessionId`
   * 去重,而审批的 title 恒为「需要审批」,于是 2 秒内到达的第二个审批被误吞 —— 用户只看到
   * 一个,以为只有一个待办。由调用方给 `eventId`/`requestId`/`runId`;缺省退回 title+body
   * (仍比只看 title 精确)。
   */
  dedupeKey?: string;
  /** Auto-dismiss timeout in ms. 0 = sticky (must be clicked). Default 6000. */
  duration: number;
  /** Timestamp for dedup (same dedupeKey within 2s are collapsed). */
  createdAt: number;
}

interface ToastState {
  toasts: ToastItem[];
  /** Push a toast. Deduplicates by stable **identity** (dedupeKey ?? title+body +
   *  sessionId) within a 2s window so a burst of the SAME event doesn't stack,
   *  while **distinct** events (different approval requests) still each appear. */
  push: (opts: {
    kind: ToastKind;
    title: string;
    body?: string;
    sessionId?: string;
    dedupeKey?: string;
    duration?: number;
  }) => void;
  /** Remove a toast by id. */
  dismiss: (id: string) => void;
  /** Clear all toasts. */
  clear: () => void;
}

/** Module-level counter for unique ids (cheaper than crypto.randomUUID per
 *  toast). */
let idCounter = 0;
const nextId = () => `toast_${Date.now()}_${idCounter++}`;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: ({ kind, title, body, sessionId, dedupeKey, duration = 6000 }) => {
    const now = Date.now();
    // 【UI-036】去重身份 = `dedupeKey`(调用方给 eventId/requestId)或退回到 `title + body`。
    // **不能**只看 title+sessionId:审批的 title 恒为「需要审批」,于是同会话 2 秒内到达的
    // 第二个不同审批被误吞。同一条事件重发才去重;不同事件各出各的。
    const identity = dedupeKey ?? `${title}\u0000${body ?? ""}`;
    const existing = get().toasts;
    if (
      existing.some(
        (t) => t.sessionId === sessionId && (t.dedupeKey ?? `${t.title}\u0000${t.body ?? ""}`) === identity && now - t.createdAt < 2000,
      )
    ) {
      return;
    }
    const id = nextId();
    const item: ToastItem = { id, kind, title, body, sessionId, ...(dedupeKey !== undefined ? { dedupeKey } : {}), duration, createdAt: now };
    set((s) => ({ toasts: [...s.toasts, item] }));
    // Auto-dismiss after the timeout (unless duration is 0 = sticky).
    if (duration > 0) {
      setTimeout(() => {
        get().dismiss(id);
      }, duration);
    }
  },
  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  clear: () => set({ toasts: [] }),
}));
