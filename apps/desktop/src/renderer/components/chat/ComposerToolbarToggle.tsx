import { useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconAdjustmentsHorizontal } from "@renderer/lib/icons.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { ComposerToolbar } from "./ComposerToolbar.js";

/**
 * Toggle entry for COLLAPSED composer hosts (the side-chat panel / phone
 * shell — ChatPane `chipsMode="collapsed"`).
 *
 * The main composer always shows the mini pill (see ComposerToolbar), but
 * hosts that are narrow at EVERY width skip the pill entirely: this single
 * toggle icon pops a panel hosting the *same* `ComposerToolbar` in its
 * `layout="row"` presentation — a vertical settings list where each control
 * is a full-width labelled row (field name left, current value right); each
 * dropdown cascades to the right of its row, or upward on phone-class
 * viewports (useNarrowViewport). Behaviour is identical to the pill's
 * segments (no duplicated logic); the vertical list is the usable shape
 * here precisely because horizontal space ran out, and labelled rows let
 * the user read the whole next-turn config (model / thinking / permission /
 * context) at a glance before opening anything.
 *
 * The popup deliberately uses `overflow-visible` so that nested portaled
 * menus can still render beyond the popup's box. Effort/Permission use
 * `Menu.Portal` and ContextRing uses a hover tooltip, so neither is affected.
 */
export function ComposerToolbarToggle({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  // The popup hosts the full chip row and is wider than a narrow/wide-mode
  // chat column, so it CAN extend over the browser's rect — suppress the
  // browser view while open, but only when the popup (measured via the ref)
  // actually reaches the browser's rect. See useSuppressBrowserView.
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  useSuppressBrowserView(open, popupRef);
  return (
    <span className="composer-chips-toggle min-w-0 shrink-0">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={
            <button
              type="button"
              title={t("chat.toolbarToggle")}
              aria-label={t("chat.toolbarToggle")}
            />
          }
          className={cn(
            "composer-chip inline-flex size-8 items-center justify-center rounded-[var(--radius-btn-md)] text-content-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            "cds-hover-ghost hover:text-content",
          )}
        >
          <IconAdjustmentsHorizontal size={18} />
        </Popover.Trigger>
        <Popover.Portal>
          {/* z on the POSITIONER (not just the popup): floating-ui positions
              it via transform, which creates a stacking context — a z-50 on
              the popup alone is trapped inside a z-auto positioner and loses
              to the center pane's z-10 (ThreePaneLayout's <main>). The chips
              popup is wider than the side-chat's right panel and overflows
              over the center pane, so without this the Model chip (leftmost)
              ends up underneath it and unclickable. Same convention as
              ui/select.tsx's Positioner wrapper. */}
          <Popover.Positioner side="top" align="start" className="z-50">
            <Popover.Popup
              ref={popupRef}
              className={cn(
                // overflow-visible: let portaled child menus escape the box.
                "z-50 max-w-[calc(100vw-16px)] overflow-visible rounded-[var(--radius-btn-xs)] border border-edge bg-surface p-1.5 shadow-[var(--shadow-popover)]",
                "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                "transition-[transform,opacity] duration-100",
              )}
            >
              {/* The popup keeps overflow visible for separately-portaled model,
                  effort and permission menus, while this inner container owns
                  vertical scrolling in short/docked chat panes. */}
              <div className="max-h-[calc(100dvh-28px)] min-w-0 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
                <ComposerToolbar sessionId={sessionId} layout="row" />
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </span>
  );
}
