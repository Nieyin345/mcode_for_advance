/**
 * 工作流面板里那种小圆角标签(「内置」「已修改」「插件」…)。
 *
 * ## 为什么单独一个文件
 *
 * 「已修改」这一个状态在**同一个屏幕上出现两次**(左边列表那一行 + 右边编辑器的
 * 标题行),节点类型那边还有一枚来源标签。三处各写一遍同样的三个 class,调色时
 * 落下一处不会报错 —— 它会变成"同一件事在两个地方长得不一样",看起来像渲染 bug。
 *
 * ## tone 而不是颜色
 *
 * 三个 tone 各有各的语义,选哪个由**这枚标签在说什么**决定,不由设计决定:
 *
 * - `accent` —— 用户自己造成的变化(「已修改」);
 * - `info`   —— 随应用发布的东西(「内置」);
 * - `muted`  —— 既不是突出也不是警告的来源标记(本地 / 已生效)。
 *
 * ⚠️ `ui/index.ts` 里没有通用的 Badge,这一枚只管工作流面板 —— 别的面板要用的
 * 时候应该先把它挪进 `ui/`,而不是再抄一份(见 `SkillsPanel` 的 `SourceBadge`)。
 */
import type { ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";

export type WorkflowBadgeTone = "accent" | "info" | "muted";

const TONE_CLS: Record<WorkflowBadgeTone, string> = {
  accent: "bg-accent/12 text-accent",
  info: "bg-info/12 text-info",
  muted: "bg-surface-hover text-content-subtle",
};

export function WorkflowBadge({
  tone,
  children,
}: {
  tone: WorkflowBadgeTone;
  children: ReactNode;
}) {
  return (
    <span className={cn("shrink-0 rounded px-1 text-[9px] leading-tight", TONE_CLS[tone])}>
      {children}
    </span>
  );
}
