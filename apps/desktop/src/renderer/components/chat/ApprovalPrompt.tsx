import { useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button } from "@renderer/components/ui/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useApprovalArming } from "@renderer/hooks/useApprovalArming.js";
import { hasTopmostForeignDialog } from "@renderer/hooks/useFocusTrap.js";
import { toolSummary } from "./activityShared.js";
import { mcpApprovalVerdict } from "./mcpDecision.js";
import { APP_DANGER_APPROVAL_PREFIX } from "@contracts/appControl";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconCheck,
  IconX,
} from "@renderer/lib/icons.js";

/**
 * Composer-area tool-approval card.
 *
 * Rendered in-flow inside the composer's width-constrained column (see
 * ChatPane), directly above the input box - mirroring PlanApprovalPrompt.
 * Because it participates in the ChatPane's vertical flex layout (rather
 * than overlaying it absolutely), the card pushes the message stream up to
 * make room instead of covering the streaming data. The composer stays
 * visible below but is locked (`textareaLocked`) while a decision is
 * pending, so the user can't type a competing prompt.
 *
 * Styling mirrors QuestionPrompt: a single rounded, bordered, elevated
 * card on neutral surface tokens, with the `warning` (amber) token used
 * sparingly for the accent/attention elements (header label, tool-name
 * code, the "允许" primary button). Amber remains the semantic signal for
 * "needs your permission", but the frame is otherwise neutral so the card
 * reads cleanly in both light and dark themes. No violet/purple is used.
 *
 * Queuing: when several approval.request events arrive in quick succession
 * (e.g. the model wants to run three Bash commands in one turn), the store
 * keeps them in a queue and the head — index 0 — is what this card renders.
 * The header shows "n / total" only when total > 1 so a single approval
 * stays visually quiet.
 *
 * Keyboard / input protection (ARC-005): Esc denies. The card itself (not the
 * "允许" button) takes focus on mount and on every queue head shift, so a
 * stray Enter cannot approve. The "允许" button additionally stays disabled
 * for `APPROVAL_ARM_DELAY_MS` after the request appears (shared with the
 * engine node-install approval card via `useApprovalArming`) — double-clicks
 * and the Enter that was already in flight when the card rendered land on
 * nothing. Enter still activates "允许" once the user deliberately Tabs to it
 * and the delay has elapsed; that is explicit consent. This is one-shot —
 * when the queue shifts, this card unmounts and the next one re-arms.
 *
 * Focus ownership while a modal is open: the card must NOT pull focus out of
 * a modal above it (settings dialog, command palette, confirm dialog). Those
 * are Base UI dialogs, which do NOT emit `aria-modal="true"` (verified in
 * `useFocusTrap.ts`), so the guard reuses the shared
 * `hasTopmostForeignDialog` detector instead of a `[aria-modal="true"]`
 * attribute query that would never match.
 */
export function ApprovalPrompt({
  providerName,
  active = true,
  toolName,
  input,
  description,
  queuePosition,
  queueTotal,
  onDecide,
}: {
  providerName: string;
  /** Only the visible chat may acquire focus or handle keyboard decisions. */
  active?: boolean;
  toolName: string;
  input: unknown;
  description?: string;
  /** 1-based index of this card in the queue. */
  queuePosition: number;
  /** Total cards in the queue; 1 means "no queue" (chip stays quiet). */
  queueTotal: number;
  /** granted=true → allow (with `always` if checked); granted=false → deny. */
  onDecide: (granted: boolean, always?: boolean) => void;
}) {
  const { t } = useI18n();
  const settingsOpen = useSessionStore((s) => s.settingsOpen);
  const promptActive = active && !settingsOpen;
  const [open, setOpen] = useState(false);
  const [always, setAlways] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  // 「允许」开卡后短延迟才可点（ARC-005 输入保护，与节点安装审批卡共用一份）。
  const allowArmed = useApprovalArming(queuePosition);

  // One-line hint via the shared toolSummary (activityShared) so the user sees what
  // the tool is about without expanding.
  const summary = toolSummary(toolName, input, t);
  // mcode-app 的高风险操作每次都要本人点:不给「始终允许」(主进程那头也不认)。
  const allowAlways = !toolName.startsWith(APP_DANGER_APPROVAL_PREFIX);
  const isMcp = toolName.startsWith("mcp__");

  // Focus the CARD, never the "允许" button (ARC-005): with focus on the
  // alertdialog itself, a stray Enter has no action to activate. Also bring
  // the whole card into view in case the queue scrolled it out.
  // Yield to any modal already open above this card: Base UI popups carry
  // role=dialog but never aria-modal=true, so the shared detector — the same
  // one useFocusTrap uses — is the one predicate that actually sees them.
  useEffect(() => {
    if (!promptActive || !cardRef.current?.getClientRects().length ||
        hasTopmostForeignDialog(cardRef.current)) return;
    cardRef.current.focus({ preventScroll: true });
    cardRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [promptActive, toolName, queuePosition]);

  // Keyboard decisions are local to this card, never document-wide:
  // hidden keep-alive sessions must not consume another session's Escape.
  const decide = (granted: boolean) => {
    if (!promptActive) return;
    onDecide(granted, granted && allowAlways ? always : undefined);
  };

  // Rendered in-flow above the composer (see ChatPane). `mb-2` lifts the card
  // off the input box below so the rounded corners + shadow read as a floating
  // card, mirroring PlanApprovalPrompt.
  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (!promptActive || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 ||
            !e.currentTarget.contains(e.target as Node)) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          decide(false);
        }
      }}
      role="alertdialog"
      aria-label={t("chat.approval.aria", { provider: providerName })}
      className={cn(
        "mb-2 min-w-0 max-h-[min(65vh,540px)] overflow-y-auto rounded-[var(--radius-dialog)] border border-edge-input bg-surface px-3.5 py-3 text-xs text-content shadow-[var(--shadow-popover)]",
        "animate-[qa-sheet-in_140ms_ease-out]",
      )}
    >
      {/* Header */}
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <IconAlertTriangle size={14} className="shrink-0 text-warning" />
          <span className="font-semibold text-warning">
            {t("chat.approval.title", { provider: providerName })}
          </span>
          {queueTotal > 1 && (
            <span
              className="rounded-full border border-warning/60 bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-warning"
              title={t("chat.approval.queueTitle", { n: queueTotal - queuePosition })}
            >
              {queuePosition} / {queueTotal}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            "inline-flex min-h-8 items-center gap-1 rounded-[var(--radius-btn-xs)] px-2 py-0.5 text-[10px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            "cds-hover-ghost text-content-muted hover:text-content",
          )}
          title={open ? t("chat.approval.collapseTitle") : t("chat.approval.expandTitle")}
        >
          <IconChevronDown
            size={12}
            className={cn("transition-transform", open && "rotate-180")}
          />
          {open ? t("chat.approval.collapse") : t("chat.approval.details")}
        </button>
      </div>

      {/* Tool name + summary */}
      <div className="mb-2.5 min-w-0 rounded-[var(--radius-btn-xs)] border border-edge bg-surface-muted/40 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <code className="rounded bg-warning/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-warning">
            {toolName}
          </code>
          {summary && (
            <span className="line-clamp-2 break-all text-content-muted">{summary}</span>
          )}
        </div>
        {description && <div className="mt-1 text-[11px] text-content-muted">{description}</div>}
      </div>

      {/* Expandable input */}
      {open && (
        <div className="mb-2.5">
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-content-subtle">{t("chatStream.tool.input")}</div>
          <pre className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-btn-xs)] bg-surface-muted/60 p-2 text-[11px] text-content-muted">
            {safeStringify(input)}
          </pre>
        </div>
      )}

      {/* Footer: always-allow checkbox + buttons. Stays on a single row at
          the bottom of the card. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-edge pt-2.5">
        {allowAlways && !isMcp ? (
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-content-muted">
            <input
              type="checkbox"
              checked={always}
              onChange={(e) => setAlways(e.target.checked)}
              className="h-3 w-3 cursor-pointer accent-warning"
            />
            {t("chat.approval.alwaysAllow", { tool: toolName })}
          </label>
        ) : (
          <span className="text-[11px] text-warning">{isMcp ? toolName.split("__")[1] : t("chat.approval.everyTime")}</span>
        )}
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => decide(false)}
            title={t("chat.approval.denyTitle")}
          >
            <IconX size={12} />
            {t("chat.approval.deny")}
          </Button>
          {/* The REA three-decision MCP array routes to the existing, armed
              approval queue callback: no optimistic execution or local allow
              cache. Unsafe tools never acquire an always-allow action. */}
          {isMcp && allowAlways && (
            <button
              type="button"
              disabled={!allowArmed}
              onClick={() => {
                if (!promptActive || !allowArmed) return;
                const verdict = mcpApprovalVerdict("always_allow");
                onDecide(verdict.granted, verdict.always);
              }}
              className="cds-hover-ghost inline-flex min-h-8 items-center rounded-[var(--radius-btn-xs)] px-2 py-1 text-[11px] font-medium text-content-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
              title={t("chat.approval.alwaysAllow", { tool: toolName })}
            >
              {t("chat.approval.alwaysAllow", { tool: toolName })}
            </button>
          )}
          {/* Primary confirm action uses the warning token (amber) to keep the
              "permission grant" semantic distinct from QuestionPrompt's green
              submit — the Button component has no warning variant, so this is
              a single purpose-built button rather than <Button variant>. */}
          <button
            type="button"
            onClick={() => {
              if (isMcp) {
                if (!promptActive || !allowArmed) return;
                const verdict = mcpApprovalVerdict("allow_once");
                onDecide(verdict.granted, verdict.always);
              } else decide(true);
            }}
            disabled={!allowArmed}
            aria-disabled={!allowArmed}
            title={t("chat.approval.allowTitle")}
            className={cn(
              "inline-flex min-h-8 items-center gap-1 rounded-[var(--radius-btn-xs)] px-2.5 text-[11px] font-medium transition-colors",
              "bg-warning text-surface hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-warning/50",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <IconCheck size={12} />
            {t("chat.approval.allow")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────── helpers ──────────────────────────── */


function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
