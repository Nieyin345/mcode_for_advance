/**
 * Field — label + control + description/error, stacked.
 *
 * ⚠️ The shell is a `<div>`, deliberately NOT a `<label>`: a bare `<label>`
 * is an inline element, and inline elements report zero width/height for
 * layout — sizing children against it silently breaks (this exact trap is
 * called out in `docs/planning/优化方向.md` §3.6 二). Click-to-focus association is
 * done properly via `htmlFor` on the inner `<label>` instead.
 *
 * @example
 *   <Field label={t("settings.custom.nameLabel")} htmlFor="model-name" error={nameError}>
 *     <Input id="model-name" value={name} onChange={(e) => setName(e.target.value)} />
 *   </Field>
 */
import type { ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { InfoHint } from "./info-hint.js";

export interface FieldProps {
  /** Pre-translated label text. */
  label: ReactNode;
  /** id of the control inside — wires `<label htmlFor>` click-to-focus. */
  htmlFor?: string;
  /** Muted helper line under the control. */
  desc?: ReactNode;
  /** Validation error; replaces `desc` and turns the helper line red. */
  error?: ReactNode;
  /** Required asterisk on the label (visual only — validate in the caller). */
  required?: boolean;
  /** 说明收进标题旁的 ⓘ(悬停 / 点击弹出),不占版面。和 `desc` 二选一用。 */
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Field({
  label,
  htmlFor,
  desc,
  error,
  required,
  hint,
  className,
  children,
}: FieldProps) {
  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center gap-1.5">
        <label
          htmlFor={htmlFor}
          className="block text-[0.7857em] font-medium text-content"
        >
          {label}
          {required && (
            <span className="ml-0.5 text-danger" aria-hidden>
              *
            </span>
          )}
        </label>
        {hint !== undefined && hint !== null && hint !== "" && <InfoHint>{hint}</InfoHint>}
      </div>
      {children}
      {error ? (
        <p className="text-[0.7143em] leading-relaxed text-danger" role="alert">
          {error}
        </p>
      ) : desc ? (
        <p className="text-[0.7143em] leading-relaxed text-content-subtle">
          {desc}
        </p>
      ) : null}
    </div>
  );
}
