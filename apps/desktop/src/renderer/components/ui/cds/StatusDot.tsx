/**
 * 【ARC-005 V2】**CDS 状态指示灯** —— 直接复用 `open-claude-ui` 的
 * `code-examples/StatusIndicators.tsx`（MIT，REA 逆向产物）的几何与动效，
 * 只把颜色从上游的 `--cds-*` 换成 Mcode 已有的语义 token（品牌色已切陶土橙，
 * 与上游同族）。
 *
 * 上游规范（逐条来自反编译取证）：
 *  - 6px 圆点；
 *  - `ready` 实心填充、`running` 1.2s `ease-in-out` 呼吸闪烁、
 *    `error` 用 danger、`clay` 3.0s 呼吸（scale 0.86→1、brightness 0.96→1.06）；
 *  - 动效在 `prefers-reduced-motion` 与 `[data-reduce-motion="true"]` 下停止
 *    （Mcode 的总闸是属性，见 styles.css）。
 *
 * 为什么单独成文件而不是散回各面板：Mcode 现有至少四处各画各的状态点
 * （侧栏会话行、工具卡、引擎面板、审批卡），尺寸/动画各不相同。这里收成一份，
 * 与上游保持同一套物理参数。
 */
import { cn } from "@renderer/lib/cn.js";

export type StatusDotKind = "ready" | "running" | "error" | "clay";

/** 状态点本身（不带文字）。`label` 只进 aria-label，视觉上不可见。 */
export function StatusDot({
  kind = "ready",
  label,
  className,
}: {
  kind?: StatusDotKind;
  label?: string;
  className?: string;
}) {
  return (
    <span
      data-cds-status-dot={kind}
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      className={cn("cds-status-dot", className)}
    />
  );
}

/** 状态点 + 一行文字（侧栏会话行、工具卡标题旁用）。 */
export function StatusLine({
  kind = "ready",
  label,
  className,
}: {
  kind?: StatusDotKind;
  label: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex select-none items-center gap-2", className)}>
      <StatusDot kind={kind} />
      <span>{label}</span>
    </span>
  );
}
