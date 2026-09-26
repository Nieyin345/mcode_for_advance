/**
 * Badge — small status / count chip.
 *
 * One shared pill so panels stop hand-rolling their own status chips with
 * slightly different radii, paddings and colors. Variants map to the theme's
 * semantic colors (styles.css tokens) — never hardcode hex here; the
 * 90-processes-of-hardcoded-colors count (MCode-优化方向.md §3.6 二) is the
 * mess this exists to stop growing.
 *
 * @example
 *   <Badge variant="success">98/98</Badge>
 *   <Badge variant="danger">failed</Badge>
 *   <Badge>{count}</Badge>
 */
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@renderer/lib/cn.js";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.7143em] font-medium leading-none",
  {
    variants: {
      variant: {
        neutral: "border-edge bg-surface/70 text-content-subtle",
        accent: "border-accent/30 bg-accent/10 text-accent",
        success: "border-success/30 bg-success/10 text-success",
        warning: "border-warning/30 bg-warning/10 text-warning",
        danger: "border-danger/30 bg-danger/10 text-danger",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
