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
import type { ComponentType, ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import type { TablerIconProps } from "@renderer/lib/icons.js";

export interface ErrorNoteProps {
  /** Optional bold first line (a translated "加载失败" style summary). */
  title?: ReactNode;
  /** The error body — usually `error.message`. */
  children: ReactNode;
  /** Optional slot for a retry / details control. */
  action?: ReactNode;
  className?: string;
  /**
   * `danger`（默认）= 出错了；`warning` = 没坏、但有东西没生效，用户该知道
   * （例如钩子文件里有一条读不懂、插件带的钩子不会被执行）。两种从前都是各面板
   * 手画的框，黄的那种至少三份、底色深浅还不一样。
   */
  tone?: "danger" | "warning";
  /** 行首的小图标（例如警告三角）。省略就不画。 */
  icon?: ComponentType<TablerIconProps>;
}

export function ErrorNote({
  title,
  children,
  action,
  className,
  tone = "danger",
  icon: Icon,
}: ErrorNoteProps) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      data-tone={tone}
      className={cn(
        "flex items-start gap-2 rounded border px-2.5 py-2 text-[0.7857em]",
        tone === "danger"
          ? "border-danger/30 bg-danger/5 text-danger"
          : "border-warning/40 bg-warning/10 text-warning",
        className,
      )}
    >
      {Icon && <Icon size={13} className="mt-0.5 shrink-0" />}
      <div className="min-w-0 flex-1 space-y-0.5">
        {title && <div className="font-medium">{title}</div>}
        <div className="break-words leading-relaxed">{children}</div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
