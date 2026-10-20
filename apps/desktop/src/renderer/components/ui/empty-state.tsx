/**
 * EmptyState — the "nothing here yet" block.
 *
 * Before this existed the empty state was re-invented in 19 files with
 * divergent copy, spacing and call-to-action placement
 * (`docs/planning/优化方向.md` §3.6 二). One component keeps them recognizable as the
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
      {/* 【ARC-005 V2】图标走 CDS 的次级文字色 + 14→24 的既定档位；空态是
          "安静的存在"，不抢主内容。颜色从 content-muted 提到 subtle 会太淡、
          提到 content 会太抢，保持 muted 但加一圈发丝底盘（上游空态同款）。 */}
      {Icon && (
        <span
          aria-hidden="true"
          className="mb-1.5 flex h-10 w-10 items-center justify-center rounded-full bg-surface-muted text-content-muted"
        >
          <Icon size={20} />
        </span>
      )}
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
