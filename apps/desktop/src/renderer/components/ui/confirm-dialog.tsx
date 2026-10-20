/**
 * ConfirmDialog - reusable confirmation modal built on the Dialog primitive.
 *
 * Replaces native `confirm()` calls with an in-app dialog. The dialog is
 * controlled (`open` + `onOpenChange`) so callers manage the pending state.
 * Use `danger` to render the confirm button with the destructive variant.
 *
 * ## Async completion / failure protocol (UI-001)
 *
 * `onConfirm` may return `void`, a plain value, a promise, or an
 * `OperationResult`-shaped object (`{ ok: boolean; error?: string }`). The
 * dialog awaits it and derives the outcome from the caller — it never invents
 * a success:
 *
 *  - while the promise is pending the confirm button is disabled and shows a
 *    busy state, so a second click cannot fire the command twice;
 *  - if it resolves to `{ ok: false }` or **rejects**, the dialog stays open
 *    and surfaces the error inline (the main-process result is the authority —
 *    see ARC-009 OperationResult);
 *  - on resolve (or `{ ok: true }`) the dialog closes.
 *
 * A plain synchronous `onConfirm: () => void` keeps working unchanged.
 *
 * @example
 *   <ConfirmDialog
 *     open={pending != null}
 *     title="删除项目"
 *     description="此操作不可恢复。"
 *     confirmText="删除"
 *     danger
 *     onOpenChange={(open) => { if (!open) setPending(null); }}
 *     onConfirm={async () => {
 *       const res = await remove();   // { ok, error? }
 *       return res;                   // reject/`{ok:false}` keeps the dialog open
 *     }}
 *   />
 */
import { useEffect, useRef, useState } from "react";
import { IconAlertTriangle } from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button } from "./button.js";
import { Dialog } from "./dialog.js";
import { ErrorNote } from "./error-note.js";
import { Spinner } from "./spinner.js";

/** What `onConfirm` may resolve to. A rejection is the other failure signal. */
export type ConfirmResult =
  | void
  | { ok?: boolean; error?: string }
  | unknown;

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** Render the confirm button with the destructive (danger) variant. */
  danger?: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Run the confirmed action. May be sync or async. Rejecting (or resolving to
   * `{ ok: false }`) keeps the dialog open and shows the failure; resolving
   * closes it. A busy state is shown and the confirm button is disabled while a
   * returned promise is pending.
   */
  onConfirm: () => Promise<ConfirmResult> | ConfirmResult;
}

/** Pull a human-readable message out of any thrown / returned failure value. */
function failureMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && "error" in value) {
    const err = (value as { error?: unknown }).error;
    if (typeof err === "string" && err) return err;
  }
  return fallback;
}

/**
 * Whether a window-level Escape should close the surface that owns it.
 *
 * Shared "topmost overlay owns Escape" policy (UI-005). Surfaces that
 * themselves open nested overlays (e.g. the settings page, which hosts the
 * MCP/Plugins/Skills confirm dialogs) call this before closing on Escape, so
 * the *same* Escape that dismisses a modal does not also tear down the surface
 * underneath it. Base UI dialogs do not stop propagation of the Escape they
 * handle, so this predicate — not propagation — is what layers them.
 *
 *  - `defaultPrevented`: a lower layer already handled it (base-ui calls
 *    `preventDefault()`) -> do not also close.
 *  - a mounted `[role=dialog|alertdialog]`: a modal is open above -> it owns
 *    Escape, so the surface must not close.
 *
 * Exported so a regression test can drive it against a real DOM.
 */
export function escapeClosesSettings(e: { defaultPrevented: boolean }): boolean {
  if (e.defaultPrevented) return false;
  if (typeof document !== "undefined" && document.querySelector('[role="dialog"], [role="alertdialog"]')) {
    return false;
  }
  return true;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmText,
  cancelText,
  danger = false,
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
  // Button labels default to the shared dictionary (callers may override with
  // a context-specific verb, e.g. 删除/恢复). Resolved here rather than via
  // parameter defaults so the labels follow the live locale.
  const { t } = useI18n();
  const confirmLabel = confirmText ?? t("common.confirm");
  const cancelLabel = cancelText ?? t("common.cancel");

  // In-flight + failure state for the async contract. Reset each time the
  // dialog opens so a previous failure/`pending` never leaks into a fresh use.
  // The ref is the SYNCHRONOUS guard: the `pending` React state only lands on
  // the next render, so two clicks in the same tick would both pass a state
  // check — the ref flips before the first await, closing that window.
  //
  // 【UI-001】`openGenRef` is the **generation** of the current open episode.
  // A confirm action may still be in flight when the user cancels and reopens
  // the dialog; when that stale promise settles it must **not** close (or
  // surface an error on) the *new* dialog. `handleConfirm` captures the
  // generation at click time and only acts on the UI if it is still current.
  const inFlightRef = useRef(false);
  const openGenRef = useRef(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      openGenRef.current += 1; // a fresh open = a fresh generation
      inFlightRef.current = false;
      setPending(false);
      setError(null);
    }
  }, [open]);

  const handleConfirm = async () => {
    if (inFlightRef.current) return; // no double-submit while the action is in flight
    inFlightRef.current = true;
    const gen = openGenRef.current; // the episode this click belongs to
    // True while THIS click's episode is still the live one. A stale promise
    // (user cancelled + reopened) makes this false, so it stops touching the UI.
    const stillCurrent = () => openGenRef.current === gen;
    setError(null);
    setPending(true);
    try {
      const result = await onConfirm();
      if (!stillCurrent()) return; // stale: a newer dialog owns the UI now
      // The backend truth (OperationResult / ARC-009) decides success. An
      // explicit `{ ok: false }` keeps the dialog open rather than pretending
      // the action succeeded.
      if (result && typeof result === "object" && "ok" in result && (result as { ok?: boolean }).ok === false) {
        setError(failureMessage(result, t("common.error")));
        return;
      }
      onOpenChange(false);
    } catch (err) {
      // A rejected promise means the action failed - keep the dialog open and
      // surface the error instead of closing and pretending success.
      if (!stillCurrent()) return; // stale: don't push this error onto the new dialog
      setError(failureMessage(err, t("common.error")));
    } finally {
      // Only the live episode may clear its own in-flight/pending state — a
      // stale finally must not un-gate a *new* click that is already running.
      if (stillCurrent()) {
        inFlightRef.current = false;
        setPending(false);
      }
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-[360px] max-w-[90vw] p-4">
          <div className="flex items-start gap-3">
            <span
              className={cn(
                "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                danger ? "bg-danger/10 text-danger" : "bg-surface-hover text-content-muted",
              )}
            >
              <IconAlertTriangle size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description className="mt-1">{description}</Dialog.Description>
            </div>
          </div>
          {error !== null && (
            <ErrorNote className="mt-3" icon={IconAlertTriangle}>
              {error}
            </ErrorNote>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {cancelLabel}
            </Button>
            <Button
              variant={danger ? "danger" : "primary"}
              size="sm"
              disabled={pending}
              onClick={() => void handleConfirm()}
            >
              {pending && <Spinner size="xs" aria-hidden className="mr-1" />}
              {confirmLabel}
            </Button>
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
