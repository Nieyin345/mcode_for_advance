/**
 * ErrorNote — inline, non-blocking error callout.
 *
 * The pattern already appears hand-rolled across panels (e.g.
 * CustomModelsPanel's `border-danger/30 bg-danger/5` paragraphs); this is
 * that exact look as one component, plus `role="alert"` so screen readers
 * announce it. For fatal/blocking failures use a Dialog — this is the
 * "request failed, panel still usable" tier.
 *
 * Strings arrive pre-translated; the optional `action` slot carries the
 * retry button so this component doesn't own any wording.
 *
 * @example
 *   {error && (
 *     <ErrorNote
 *       action={<Button size="sm" variant="ghost" onClick={refetch}>{t("common.retry")}</Button>}
 *     >
 *       {error.message}
 *     </ErrorNote>
 *   )}
 */
import type { ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";

export interface ErrorNoteProps {
  /** Optional bold first line (a translated "加载失败" style summary). */
  title?: ReactNode;
  /** The error body — usually `error.message`. */
  children: ReactNode;
  /** Optional slot for a retry / details control. */
  action?: ReactNode;
  className?: string;
}

export function ErrorNote({
  title,
  children,
  action,
  className,
}: ErrorNoteProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded border border-danger/30 bg-danger/5 px-2.5 py-2 text-[0.7857em] text-danger",
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        {title && <div className="font-medium">{title}</div>}
        <div className="break-words leading-relaxed">{children}</div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
