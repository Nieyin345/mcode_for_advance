/**
 * Card — generic bordered surface container.
 *
 * Groups content into a distinct "card" against a contrasting page background
 * (the settings page uses bg-surface-muted so these cards float on top).
 * Rows inside a card typically share hairline separators via the caller's
 * `divide-y divide-edge` (see the settings panels / SettingsSection).
 *
 * @example
 *   <Card className="divide-y divide-edge">
 *     <SettingRow title="…">…</SettingRow>
 *   </Card>
 */
import { cn } from "@renderer/lib/cn.js";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {}

export function Card({ className, ...props }: CardProps) {
  return (
    <div
      className={cn(
        // 【ARC-005】卡片档圆角走 --radius-card（上游 --radius-card ≈12px）；
        // sketch 主题在 styles.css 把该 token 指回手抖档，形状映射不丢。
        "rounded-[var(--radius-card)] border border-edge bg-surface",
        className,
      )}
      {...props}
    />
  );
}
