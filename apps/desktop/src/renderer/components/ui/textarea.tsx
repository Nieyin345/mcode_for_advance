/**
 * Textarea — shared multiline field for settings and long-form editors.
 *
 * Native textarea behavior is intentionally preserved (composition events,
 * selection, resize, refs); only the default CDS surface / radius / focus
 * geometry is centralized. Callers can override dimensions and typography.
 */
import { forwardRef, useContext, type TextareaHTMLAttributes } from "react";
import { cn } from "@renderer/lib/cn.js";
import { FieldLabelContext } from "./field-label-context.js";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, ...props }, ref) => {
    const fieldLabel = useContext(FieldLabelContext);
    return (
      <textarea
        ref={ref}
        className={cn(
          "min-w-0 w-full rounded-[var(--radius-btn-xs)] border border-edge bg-surface px-2.5 py-1.5 font-mono text-code text-content placeholder:text-content-subtle outline-none transition-colors focus:border-accent",
          error && "border-danger focus:border-danger",
          className,
        )}
        {...props}
        aria-labelledby={props["aria-labelledby"] ?? (props["aria-label"] ? undefined : fieldLabel)}
      />
    );
  },
);
Textarea.displayName = "Textarea";
