/**
 * Input — reusable text input component.
 *
 * Built on @base-ui/react Input primitive with consistent styling.
 *
 * @example
 *   <Input placeholder="Type here..." />
 *   <Input error placeholder="Invalid value" />
 */
import { forwardRef, useContext } from "react";
import { FieldLabelContext } from "./field-label-context.js";
import { Input as BaseInput } from "@base-ui/react/input";
import { cn } from "@renderer/lib/cn.js";

export interface InputProps
  extends React.ComponentPropsWithoutRef<typeof BaseInput> {
  /** Show error styling */
  error?: boolean;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, error, ...props }, ref) => {
    const fieldLabel = useContext(FieldLabelContext);
    return (
      <BaseInput
        ref={ref}
        className={cn(
          // 【ARC-005 V2】圆角走 CDS 控件档（--radius-btn-xs 6px），不再用 Tailwind
          // 裸 `rounded`(4px) —— 与按钮/Select/Tooltip 同一档。
          "min-w-0 w-full rounded-[var(--radius-btn-xs)] border border-edge bg-surface px-2.5 py-1.5 font-mono text-xs text-content placeholder:text-content-subtle outline-none transition-colors",
          "focus:border-accent",
          error && "border-danger focus:border-danger",
          className,
        )}
        {...props}
        aria-labelledby={props["aria-labelledby"] ?? (props["aria-label"] ? undefined : fieldLabel)}
      />
    );
  },
);

Input.displayName = "Input";

export { Input };
