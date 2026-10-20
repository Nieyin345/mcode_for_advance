/**
 * Tooltip — reusable hover/focus tooltip built on @base-ui/react/tooltip.
 *
 * Compound API mirrors Dialog/Select:
 *   <Tooltip.Root>
 *     <Tooltip.Trigger>...</Tooltip.Trigger>
 *     <Tooltip.Portal>
 *       <Tooltip.Positioner>
 *         <Tooltip.Popup>content</Tooltip.Popup>
 *       </Tooltip.Positioner>
 *     </Tooltip.Portal>
 *   </Tooltip.Root>
 *
 * For non-button anchors, pass `render={<span />}` (or any element) to
 * Tooltip.Trigger so it doesn't force a <button>.
 */
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { cn } from "@renderer/lib/cn.js";

/* ───────── Root ───────── */

export type TooltipRootProps = React.ComponentPropsWithoutRef<typeof BaseTooltip.Root>;

function TooltipRoot(props: TooltipRootProps) {
  return <BaseTooltip.Root {...props} />;
}

/* ───────── Provider (optional app-level defaults) ───────── */

export type TooltipProviderProps = React.ComponentPropsWithoutRef<typeof BaseTooltip.Provider>;

function TooltipProvider(props: TooltipProviderProps) {
  return <BaseTooltip.Provider {...props} />;
}

/* ───────── Trigger ───────── */

export type TooltipTriggerProps = React.ComponentPropsWithoutRef<typeof BaseTooltip.Trigger>;

function TooltipTrigger({ className, delay = 280, ...props }: TooltipTriggerProps) {
  return (
    <BaseTooltip.Trigger
      delay={delay}
      className={cn("inline-flex items-center outline-none", className)}
      {...props}
    />
  );
}

/* ───────── Portal ───────── */

function TooltipPortal(
  props: React.ComponentPropsWithoutRef<typeof BaseTooltip.Portal>,
) {
  return <BaseTooltip.Portal {...props} />;
}

/* ───────── Positioner ───────── */

export type TooltipPositionerProps = React.ComponentPropsWithoutRef<
  typeof BaseTooltip.Positioner
>;

function TooltipPositioner({
  className,
  side = "top",
  sideOffset = 6,
  ...props
}: TooltipPositionerProps) {
  return (
    <BaseTooltip.Positioner
      side={side}
      sideOffset={sideOffset}
      className={cn("z-[60] outline-none", className)}
      {...props}
    />
  );
}

/* ───────── Popup ───────── */

export type TooltipPopupProps = React.ComponentPropsWithoutRef<typeof BaseTooltip.Popup>;

function TooltipPopup({ className, ...props }: TooltipPopupProps) {
  return (
    <BaseTooltip.Popup
      className={cn(
        // 【ARC-005 V2】圆角走 CDS 小控件档（--radius-btn-xs 6px），阴影走
        // 上游 popover 档（--shadow-popover，含发丝内环），与菜单/下拉一致。
        "max-w-xs rounded-[var(--radius-btn-xs)] border border-edge bg-surface px-2.5 py-2 text-[11px] text-content shadow-[var(--shadow-popover)]",
        "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
        "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
        // 【ARC-005】揭示时长/曲线读动效词表（--dur-snap「揭示」档 + --ease-out），
        // 不写裸毫秒类（Tailwind 扫描全文，注释里也别写旧类名）。
        "origin-[var(--transform-origin)] transition-[transform,opacity] duration-[var(--dur-snap)] ease-[var(--ease-out)]",
        className,
      )}
      {...props}
    />
  );
}

export const Tooltip = {
  Root: TooltipRoot,
  Provider: TooltipProvider,
  Trigger: TooltipTrigger,
  Portal: TooltipPortal,
  Positioner: TooltipPositioner,
  Popup: TooltipPopup,
};
