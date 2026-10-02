/**
 * Spinner / Skeleton — shared loading placeholders.
 *
 * Two shapes for two situations:
 * - `Spinner`: an action is in flight and the surrounding layout already
 *   exists (button labels, list headers, inline refresh).
 * - `Skeleton`: the layout itself is still loading — render one gray block
 *   per future row/card so the panel doesn't jump when data lands.
 *
 * Added for the "loading 状态各管各的" cleanup (`docs/planning/优化方向.md` §3.6 二):
 * SkillsPanel / McpPanel each hand-rolled ~6 loading indicators while
 * PluginsPanel / HooksPanel had none at all — their panels sat blank during
 * load. New panels should reach for these instead of drawing their own.
 *
 * @example
 *   {loading ? <Spinner size="xs" /> : <IconRefresh size={14} />}
 *   {loading && <Skeleton className="h-16" />}
 */
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@renderer/lib/cn.js";

const spinnerVariants = cva(
  // Ring spinner: hairline circle with one accent quadrant. Pure CSS — no
  // icon dependency, so it can't drift out of sync with the icon set.
  "inline-block animate-spin rounded-full border-2 border-edge border-t-accent",
  {
    variants: {
      size: {
        xs: "h-3 w-3",
        sm: "h-4 w-4",
        md: "h-6 w-6",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

export interface SpinnerProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof spinnerVariants> {
  /** Accessible label. Pass a pre-translated string — the i18n rule
   *  (no hardcoded user-visible text) lives with the caller. */
  label?: string;
}

export function Spinner({ className, size, label, ...props }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(spinnerVariants({ size }), className)}
      {...props}
    />
  );
}

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {}

/** Pulsing placeholder block. Size it with className (`h-16`, `w-40`, …). */
export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-md bg-surface-muted", className)}
      {...props}
    />
  );
}

/**
 * 一整块区域在等数据时的那一行：转圈 + 一句话，居中。
 *
 * 设置页里原来手写了七八份（`IconLoader2 size={14} className="animate-spin"` 加一个
 * `t("…loading")`），字号有 0.85em 的、有 0.7857em 的，上下留白各不相同。
 * 列表的骨架还没有形状可画时用它；有形状（列表行、卡片）时用 `Skeleton`。
 * 文案由调用方传进来（已翻译），这里不持有任何措辞。
 */
export function LoadingNote({ label, className }: { label: React.ReactNode; className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-center justify-center gap-2 px-4 py-8 text-[0.7857em] text-content-subtle",
        className,
      )}
    >
      <Spinner size="xs" aria-hidden />
      {label}
    </div>
  );
}
