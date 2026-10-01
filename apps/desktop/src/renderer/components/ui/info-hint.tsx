/**
 * InfoHint —— 说明文字收进一个 ⓘ 图标:悬停 / 键盘聚焦 / 点击时弹出,平时不占版面。
 *
 * 设置页每一行、每个分组原来都把一两行说明直接铺在标题下面,一页下来满屏灰字,
 * 真正要找的开关反而被淹没(2026-10-02 用户:「一些提示能隐藏的就隐藏起来,放在
 * ui 上面也不美观」)。说明还在,只是按需出现。
 *
 * - 鼠标:悬停约 0.3 秒弹出(移到气泡上不会消失,里面的文字可以选中复制)。
 * - 触屏 / 不方便悬停:点一下打开,再点或点别处关闭。
 * - 键盘:Tab 聚焦即弹出。
 * - 字符串里的 `**粗体**` 会渲染成粗体(i18n 文案里沿用了这个写法);换行保留。
 */
import { useState, type ReactNode } from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconInfoCircle } from "@renderer/lib/icons.js";

function renderInline(text: string): ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  if (parts.length === 1) return text;
  return parts.map((p, i) => (i % 2 === 1 ? <strong key={i} className="font-semibold text-content">{p}</strong> : p));
}

export interface InfoHintProps {
  children: ReactNode;
  /** 图标尺寸,默认 13。 */
  size?: number;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  /** 读屏用的名字,默认「说明」。 */
  label?: string;
}

export function InfoHint({ children, size = 13, side = "top", className, label }: InfoHintProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <BaseTooltip.Root open={open} onOpenChange={setOpen}>
      <BaseTooltip.Trigger
        delay={280}
        // 点击由下面的 onClick 自己开关;不让 base-ui 在按下时先关一次(否则点了等于没点)。
        closeOnClick={false}
        type="button"
        aria-label={label ?? t("common.moreInfo")}
        onClick={(e) => {
          // 在 <label> / 可点的行里时,别把点击传给外层(否则会顺手拨动开关)。
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full align-middle text-content-subtle/70 outline-none transition-colors",
          "hover:text-content-muted focus-visible:text-content focus-visible:ring-1 focus-visible:ring-accent",
          className,
        )}
      >
        <IconInfoCircle size={size} stroke={1.75} />
      </BaseTooltip.Trigger>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-[70] outline-none">
          <BaseTooltip.Popup
            className={cn(
              "max-w-[340px] select-text whitespace-pre-line rounded-md border border-edge bg-surface px-3 py-2",
              "text-[12px] leading-relaxed text-content-muted shadow-lg",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "origin-[var(--transform-origin)] transition-[transform,opacity] duration-100",
            )}
          >
            {typeof children === "string" ? renderInline(children) : children}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

/** 字段名 + ⓘ:表单里的说明按需弹出,不在字段下面铺一段段灰字。 */
export function HintLabel({ hint, children, className }: { hint: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span>{children}</span>
      <InfoHint>{hint}</InfoHint>
    </span>
  );
}
