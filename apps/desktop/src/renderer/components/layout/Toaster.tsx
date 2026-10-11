/**
 * Toaster - renders the global in-app toast stack.
 *
 * Mounted once at the app root (App.tsx). Reads from the toast store and
 * renders a bottom-right stack of toast cards. A card whose toast carries a
 * sessionId exposes an explicit, focusable "open source session" button (the
 * card's primary action) plus a dismiss button — both real `<button>`s, never a
 * clickable div and never nested buttons. Toasts without a session render no
 * navigation affordance at all (no meaningless button).
 *
 * Toasts are fired from sessionStore.ingestEvent for background session
 * events when the window is focused (OS notifications are suppressed in that
 * case, so the toast is the user's only in-app signal beyond the badge).
 *
 * ## Keyboard / Escape (UI-002, UI-003)
 *
 * The stack is reachable with Tab. The card is a live region (`role="status"`
 * for info, `role="alert"` for warning/error). Escape is scoped to the
 * Toaster itself: pressing it while focus is inside a toast dismisses THAT
 * toast and stops propagation, so it never reaches other window-level Escape
 * listeners. There is no global "Escape clears every toast" handler (the old
 * one nuked sticky `duration=0` errors whenever any other overlay was closed) —
 * sticky toasts stay until the user explicitly dismisses them.
 */
import { useEffect } from "react";
import { useToastStore, type ToastItem, type ToastKind } from "@renderer/stores/toastStore.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import {
  IconInfoCircle,
  IconAlertTriangle,
  IconAlertCircle,
  IconX,
  IconArrowRight,
} from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** Per-kind visual config: icon + accent border color + live-region role.
 *  Errors/warnings announce assertively (`alert`); info is polite (`status`). */
const KIND_META: Record<ToastKind, { icon: typeof IconInfoCircle; accent: string; role: "status" | "alert" }> = {
  info: { icon: IconInfoCircle, accent: "border-l-accent", role: "status" },
  warning: { icon: IconAlertTriangle, accent: "border-l-yellow-500", role: "alert" },
  error: { icon: IconAlertCircle, accent: "border-l-danger", role: "alert" },
};

function ToastCard({ toast }: { toast: ToastItem }) {
  const { t } = useI18n();
  const dismiss = useToastStore((s) => s.dismiss);
  const openTab = useSessionStore((s) => s.openTab);
  const meta = KIND_META[toast.kind];
  const Icon = meta.icon;

  const openSource = () => {
    if (toast.sessionId) void openTab(toast.sessionId);
    dismiss(toast.id);
  };

  const body = (
    <>
      <div className="text-[13px] font-medium text-content">{toast.title}</div>
      {toast.body && (
        <div className="mt-0.5 truncate text-[12px] text-content-muted">{toast.body}</div>
      )}
    </>
  );

  return (
    <div
      data-toast-id={toast.id}
      role={meta.role}
      className={cn(
        "group pointer-events-auto flex w-80 items-start gap-2 rounded-md border border-edge border-l-2 bg-surface px-3 py-2.5 shadow-lg",
        "transition-colors",
        meta.accent,
      )}
    >
      <Icon
        size={16}
        className={cn(
          "mt-0.5 shrink-0",
          toast.kind === "error" ? "text-danger" : toast.kind === "warning" ? "text-yellow-500" : "text-accent",
        )}
      />
      {toast.sessionId ? (
        // Primary action = a real focusable button. There is a navigation
        // target, so make the whole text column open it (mouse convenience)
        // while staying keyboard-operable. The dismiss control is a SIBLING,
        // not nested inside this button.
        <button
          type="button"
          onClick={openSource}
          className="flex min-w-0 flex-1 items-start gap-2 rounded text-left outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent-strong focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          <div className="min-w-0 flex-1">{body}</div>
          <span className="mt-0.5 flex shrink-0 items-center gap-0.5 text-[11px] text-accent">
            <IconArrowRight size={12} />
            {t("layout.toastOpenSource")}
          </span>
        </button>
      ) : (
        // No session to navigate to -> no navigation affordance (no dead button).
        <div className="min-w-0 flex-1">{body}</div>
      )}
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        className={cn(
          "shrink-0 rounded p-0.5 text-content-subtle opacity-0 transition-opacity hover:bg-surface-hover hover:text-content",
          // Always reachable: visible on hover, and whenever any descendant of
          // this card (the close button itself) holds focus.
          "group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent-strong",
        )}
        aria-label={t("common.close")}
      >
        <IconX size={14} />
      </button>
    </div>
  );
}

/** The toast stack container. Mount once at the app root. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);

  // Escape is scoped to the Toaster subtree: only when focus is inside a
  // toast does it dismiss that toast, and it stops propagation so it never
  // leaks to other window-level Escape listeners. There is deliberately NO
  // window-level "clear all" — a blanket Escape used to wipe sticky
  // `duration=0` error toasts whenever any other dialog was closed (UI-003).
  useEffect(() => {
    if (toasts.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      const card = target?.closest?.("[data-toast-id]");
      const id = card?.getAttribute("data-toast-id");
      if (!id) return; // focus is not inside a toast -> leave it alone
      e.stopPropagation();
      useToastStore.getState().dismiss(id);
    };
    // Capture phase so the bubble-phase listeners some overlays register on
    // window never see an Escape that was meant for a focused toast.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toasts.length]);

  if (toasts.length === 0) return null;

  // Positioning (fixed bottom-right) is owned by the shared corner container
  // in App.tsx so this stack and the update notification card lay out in one
  // column instead of overlapping each other.
  return (
    <div className="flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}
