/**
 * 【ARC-005 V2】**CDS 分段控件** —— 复用 `open-claude-ui` 的
 * `code-examples/SegmentedControl.tsx`（MIT，REA 对 Claude 桌面端的取证）。
 *
 * 上游规范（逐条）：
 *  - 轨道 `padding: 1px`，滑块 `top/bottom: 1px`、圆角 `calc(radius - 1px)`；
 *  - 滑块位置是**纯几何**：`left = 1px + i*(100% - 2px)/n`，宽度 `(100% - 2px)/n`；
 *  - 磁吸时序 120ms `cubic-bezier(.32,.72,0,1)`；
 *  - 双层弥散投影：`inset 0 0 0 .5px` 发丝 + 两层柔和阴影；
 *  - 容器查询：2 项 ≤180px、3 项 ≤254px 时折叠未激活项文字（只留图标）。
 *
 * 与上游的差异（有意）：
 *  - 不引入 framer-motion（本仓无此依赖）。静默使用纯 CSS 几何滑块，
 *    过渡由 transform/left/width 的 120ms 完成 —— 视觉与上游的非 motion 分支一致；
 *  - 颜色接 Mcode 语义 token（surface/content/edge），不写 `neutral-*`；
 *  - `role="tablist"` + `role="tab"` 与上游一致；键盘左右键切换由本组件补
 *    （上游示例没写，但桌面端必须可用）。
 */
import { useCallback, useId, useRef, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";

export interface SegmentedItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  badge?: string | number;
  /** 悬停提示。分段控件把文字折叠成图标时（窄容器），title 是唯一还能
   *  说明这一项是什么的线索。 */
  title?: string;
}

export interface SegmentedProps {
  items: Array<string | SegmentedItem>;
  value: string;
  onChange: (id: string) => void;
  size?: "sm" | "md";
  className?: string;
  /** 无障碍名（必填：读屏只说"标签页"没有意义）。 */
  label: string;
}

function normalize(items: Array<string | SegmentedItem>): SegmentedItem[] {
  return items.map((it, i) =>
    typeof it === "string" ? { id: String(i), label: it } : it,
  );
}

export function Segmented({ items, value, onChange, size = "md", className, label }: SegmentedProps) {
  const tabs = normalize(items);
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === value));
  const listRef = useRef<HTMLDivElement>(null);
  const ids = useId();

  // 键盘：左右方向键在项间移动（上游没有实现；桌面端 tablist 的标准行为）。
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const delta = e.key === "ArrowRight" ? 1 : -1;
      const next = (activeIndex + delta + tabs.length) % tabs.length;
      onChange(tabs[next].id);
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      buttons?.[next]?.focus();
    },
    [activeIndex, onChange, tabs],
  );

  const isSmall = size === "sm";
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      data-cds-segmented={tabs.length}
      onKeyDown={onKeyDown}
      className={cn(
        "relative flex select-none items-stretch rounded-full p-px transition-colors",
        isSmall ? "h-7 text-code" : "h-8 text-code",
        className,
      )}
      style={{
        backgroundColor: "rgb(var(--surface-muted))",
        containerType: "inline-size",
        boxShadow: "inset 0 0 0 0.5px rgb(var(--edge) / 0.55)",
      }}
    >
      {/* 纯几何滑块（上游非 motion 分支）。activeIndex 变化时 left/width 过渡 120ms。 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-px top-px rounded-full bg-surface transition-[left,width] duration-[120ms] ease-[cubic-bezier(0.32,0.72,0,1)] will-change-[left,width]"
        style={{
          left: `calc(1px + ${activeIndex} * (100% - 2px) / ${tabs.length})`,
          width: `calc((100% - 2px) / ${tabs.length})`,
          boxShadow:
            "inset 0 0 0 0.5px rgb(var(--edge) / 0.5), 0 1px 2px rgb(0 0 0 / 0.06), 0 2px 6px -1px rgb(0 0 0 / 0.05)",
        }}
      />
      {tabs.map((tab, idx) => {
        const active = idx === activeIndex;
        return (
          <button
            key={tab.id}
            id={`${ids}-${idx}`}
            type="button"
            role="tab"
            aria-selected={active}
            title={tab.title}
            tabIndex={active ? 0 : -1}
            data-active={active ? "" : undefined}
            onClick={() => onChange(tab.id)}
            className={cn(
              "relative z-10 flex h-full flex-1 items-center justify-center gap-1.5 truncate rounded-full px-3 transition-colors",
              active
                ? "font-medium text-content"
                : "font-normal text-content-muted hover:text-content",
            )}
          >
            {tab.icon && <span className="flex shrink-0 items-center justify-center text-current">{tab.icon}</span>}
            {/* 容器查询折叠：与上游同一断点（2 项 180px / 3 项 254px）。 */}
            <span
              className={cn(
                "truncate",
                tabs.length === 2
                  ? "@[max-width:180px]:hidden"
                  : tabs.length === 3
                    ? "@[max-width:254px]:hidden"
                    : undefined,
              )}
            >
              {tab.label}
            </span>
            {tab.badge !== undefined && (
              <span className="ml-0.5 rounded-full bg-content/10 px-1.5 py-px font-mono text-[10px] leading-tight tabular-nums">
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
