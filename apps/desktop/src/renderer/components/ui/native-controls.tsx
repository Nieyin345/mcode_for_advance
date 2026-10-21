/**
 * NativeControls — CDS-styled wrappers for input kinds where native browser
 * semantics matter (checkboxes, color wells, and select/option lists).
 *
 * Never emulate native value/change/keyboard behavior here. Callers keep the
 * exact same controlled attributes and callbacks they had on native elements.
 * The shared layer only owns the geometry and keyboard-focus paint.
 */
import { forwardRef, useContext, type InputHTMLAttributes, type SelectHTMLAttributes } from "react";
import { cn } from "@renderer/lib/cn.js";
import { FieldLabelContext } from "./field-label-context.js";

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, ...props }, ref) => (
    <input
      {...props}
      ref={ref}
      type="checkbox"
      className={cn(
        "h-3.5 w-3.5 shrink-0 cursor-pointer rounded-[var(--radius-btn-xs)] accent-accent outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    />
  ),
);
Checkbox.displayName = "Checkbox";

export type NativeSelectProps = SelectHTMLAttributes<HTMLSelectElement>;
export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, ...props }, ref) => {
    const fieldLabel = useContext(FieldLabelContext);
    return (
      <select
        {...props}
        ref={ref}
        className={cn(
          "min-w-0 rounded-[var(--radius-btn-xs)] border border-edge bg-surface px-2.5 py-1.5 text-xs text-content outline-none transition-colors focus:border-accent",
          className,
        )}
        aria-labelledby={props["aria-labelledby"] ?? (props["aria-label"] ? undefined : fieldLabel)}
      />
    );
  },
);
NativeSelect.displayName = "NativeSelect";

type ColorInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;
export const ColorInput = forwardRef<HTMLInputElement, ColorInputProps>(
  ({ className, ...props }, ref) => (
    <input
      {...props}
      ref={ref}
      type="color"
      className={cn(
        "h-7 w-10 shrink-0 cursor-pointer rounded-[var(--radius-btn-xs)] border border-edge bg-transparent p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    />
  ),
);
ColorInput.displayName = "ColorInput";
