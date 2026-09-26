/**
 * EmptyState — the "nothing here yet" block.
 *
 * Before this existed the empty state was re-invented in 19 files with
 * divergent copy, spacing and call-to-action placement
 * (MCode-优化方向.md §3.6 二). One component keeps them recognizable as the
 * same app: muted icon, one-line title, optional explanation, optional CTA.
 *
 * All strings arrive pre-translated via props — the i18n rule (zh dictionary
 * is the MessageId source) lives with the caller, not here.
 *
 * @example
 *   <EmptyState
 *     icon={IconPlug}
 *     title={t("settings.plugins.empty")}
 *     desc={t("settings.plugins.emptyDesc")}
 *     action={<Button size="sm" onClick={onAdd}>{t("settings.plugins.add")}</Button>}
 *   />
 */
import type { ComponentType, ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import type { TablerIconProps } from "@renderer/lib/icons.js";

export interface EmptyStateProps {
  icon?: ComponentType<TablerIconProps>;
  /** One short line: what would live here. */
  title: ReactNode;
  /** Optional second line: why it's empty / what to do about it. */
  desc?: ReactNode;
  /** Optional call-to-action, usually a small Button. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  desc,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      data-empty-state=""
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center",
        className,
      )}
    >
      {Icon && <Icon size={24} className="mb-1 text-content-muted" />}
      <div className="text-[0.8571em] font-medium text-content-subtle">
        {title}
      </div>
      {desc && (
        <p className="max-w-96 text-[0.7857em] leading-relaxed text-content-muted">
          {desc}
        </p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
