import type { ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { InfoHint } from "@renderer/components/ui/info-hint.js";

/** Fixed width of the control column in horizontal rows. All rows share the
 *  same slot so the controls line up as one visual column down the page —
 *  selects/inputs fill it (`w-full`), switches & steppers right-align inside
 *  it. Rows whose control doesn't fit (long button combos, color palettes)
 *  use `layout="vertical"` instead and own the full row width. */
const CONTROL_SLOT_WIDTH = 260;

/**
 * One setting = one row. Left side carries a title (+ optional description),
 * right side carries the control(s) inside a fixed-width slot so every row's
 * control starts at the same x. The parent container draws the row
 * separators (`divide-y divide-edge`) so this component stays a pure layout
 * shell — no borders of its own. Rows carry their own horizontal inset
 * (`px-4`) so content never touches the edges of the containing card.
 *
 * Control-slot conventions (horizontal layout):
 *  - Select / Input / Textarea: give them `w-full` so they fill the slot.
 *  - Switch / stepper / icon button: no extra classes — the slot right-aligns
 *    them (`justify-end`).
 *  - Select + trailing icon button combos: `flex-1 min-w-0` on the select.
 *
 * `htmlFor` (optional) makes the title label click-through to the control,
 * useful for native inputs like range/color. `controlAlign` lets the caller
 * vertically align the right column to the title (default) or to the whole
 * block (for multi-line descriptions).
 */
/** 说明怎么放:`hint` = 收进标题旁的 ⓘ(悬停 / 点击才显示);`inline` = 铺在标题下面。
 *  不传时:纯字符串走 `hint`(静态说明文字),其余 ReactNode 走 `inline`(多半是带状态 /
 *  数据的内容,比如 MCP 服务的命令行、模型下载进度 —— 这些得一眼看到)。 */
export type SettingDescMode = "hint" | "inline";

function RowHead({
  title,
  hint,
  desc,
  descExtra,
  descMode,
  htmlFor,
}: {
  title: ReactNode;
  hint?: ReactNode;
  desc?: ReactNode;
  descExtra?: ReactNode;
  descMode?: SettingDescMode;
  htmlFor?: string;
}) {
  const isLabel = !!htmlFor;
  const TitleTag = isLabel ? "label" : "div";
  const hasHint = hint !== undefined && hint !== null && hint !== "";
  // 显式给了 `hint` 时,desc 默认就铺开(那多半是"当前值"之类的状态行)。
  const defaultMode: SettingDescMode = hasHint || typeof desc !== "string" ? "inline" : "hint";
  const asHint = !hasHint && desc !== undefined && desc !== null && desc !== "" && (descMode ?? defaultMode) === "hint";
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <TitleTag {...(isLabel ? { htmlFor } : {})} className="text-[0.8571em] font-medium text-content">
          {title}
        </TitleTag>
        {hasHint && <InfoHint>{hint}</InfoHint>}
        {asHint && <InfoHint>{desc}</InfoHint>}
      </div>
      {!asHint && desc && <div className="mt-0.5 text-[0.7857em] leading-relaxed text-content-subtle">{desc}</div>}
      {descExtra && <div className="mt-0.5">{descExtra}</div>}
    </>
  );
}

export function SettingRow({
  title,
  hint,
  desc,
  descExtra,
  descMode,
  htmlFor,
  controlAlign = "center",
  layout = "horizontal",
  className,
  children,
}: {
  title: ReactNode;
  /** 静态说明,收进标题旁的 ⓘ。给了它时 `desc` 默认铺开(放状态 / 当前值)。 */
  hint?: ReactNode;
  desc?: ReactNode;
  /** Optional secondary line below `desc` (e.g. a faint hint). Always inline. */
  descExtra?: ReactNode;
  /** See {@link SettingDescMode}. */
  descMode?: SettingDescMode;
  htmlFor?: string;
  /** Vertical alignment of the right control column (horizontal layout only). */
  controlAlign?: "center" | "start";
  /** Layout direction: horizontal = side-by-side, vertical = stacked. */
  layout?: "horizontal" | "vertical";
  className?: string;
  children: ReactNode;
}) {
  const head = <RowHead title={title} hint={hint} desc={desc} descExtra={descExtra} descMode={descMode} htmlFor={htmlFor} />;

  if (layout === "vertical") {
    return (
      <div className={cn("flex flex-col gap-2 px-4 py-3", className)}>
        <div>{head}</div>
        <div className="w-full">{children}</div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-4 py-3",
        className,
      )}
    >
      <div className="min-w-0 flex-1">{head}</div>
      <div
        style={{ width: CONTROL_SLOT_WIDTH }}
        className={cn(
          "flex shrink-0 items-center justify-end gap-2",
          controlAlign === "start" ? "self-start" : "self-center",
        )}
      >
        {children}
      </div>
    </div>
  );
}
