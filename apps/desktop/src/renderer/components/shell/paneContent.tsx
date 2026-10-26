/**
 * 【UI 重建】**把右栏面板按 id 单独渲染** —— 供 tile 复用。
 *
 * ## 为什么需要它
 *
 * 旧的 `RightPanel` 把「八个页签 + 一条图标轨 + 停靠手柄 + 宽屏开关」焊在一起。
 * 新壳的右侧是 Claude 的 tile 树，每个 tile 只要**面板本身**，不要那条轨。
 *
 * 本文件从 `RightPanel` 里把「id → 面板组件」这一层单独抽出来，
 * 两处共用同一份映射（硬规矩 2：共享实现只有一份）。
 *
 * ## 面板来源（与旧右栏完全一致，功能不变）
 *
 * | id | 组件 | 职责 |
 * |---|---|---|
 * | `files` | `FilesPanel` | 项目文件树 |
 * | `git` | `GitPanel` | 更改 / 历史 / 工作树 |
 * | `browser` | `BrowserPanel` | 内嵌浏览器 |
 * | `turns` | `TurnFlowPanel` | 每轮时间线 |
 * | `flow` | `WorkflowBoardPanel` | 工作流看板 + 侧聊 |
 * | `tasks` | `TaskListPanel` | 此刻在跑什么 |
 * | `taskcenter` | `TaskCenterPanel` | 持久任务表 |
 * | `preview` | `PreviewPanel` | 资料库条目预览 |
 *
 * ## 三条并行线的接入点
 *
 * - **Office**：`file` tile 渲染 GenOffice 原生编辑器（`GenofficeViewHostPane`）
 * - **工作流**：`flow` tile 渲染 `WorkflowBoardPanel`
 * - **扩展**：`ModuleViewDock` 作为独立 tile
 */
import { lazy, Suspense, type ReactNode } from "react";
import { FilesPanel } from "@renderer/components/ide/FilesPanel.js";
import { GitPanel } from "@renderer/components/ide/GitPanel.js";
import { BrowserPanel } from "@renderer/components/browser/BrowserPanel.js";
import { TurnFlowPanel } from "@renderer/components/ide/TurnFlowPanel.js";
import { TaskListPanel } from "@renderer/components/ide/TaskListPanel.js";
import { TaskCenterPanel } from "@renderer/components/ide/TaskCenterPanel.js";
import { WorkflowBoardPanel } from "@renderer/components/chat/WorkflowBoardPanel.js";
import { PreviewPanel } from "@renderer/components/library/PreviewPanel.js";
import { ModuleViewDock } from "@renderer/components/modules/ModuleContributions.js";

/** Claude 的 tile 类型 → Mcode 的面板。 */
export function renderPaneContent(tileId: string): ReactNode {
  switch (tileId) {
    case "file":
      return <FilesPanel />;
    case "diff":
      return <GitPanel />;
    case "preview":
      return <PreviewPanel />;
    case "artifact":
      return <TaskCenterPanel />;
    case "terminal":
      return <TerminalPaneLazy />;
    case "pr":
      return <TurnFlowPanel />;
    case "cr":
      return <TaskListPanel />;
    case "mcpapp":
      return <ModuleViewDock location="right" />;
    case "watercolor":
      return <WorkflowBoardPanel />;
    default:
      return null;
  }
}

/** 终端面板：与底部终端共用同一个组件（按项目分桶保活）。 */
const TerminalPanel = lazy(() =>
  import("@renderer/components/ide/TerminalPanel.js").then((m) => ({ default: m.TerminalPanel })),
);

function TerminalPaneLazy() {
  return (
    <Suspense fallback={null}>
      <TerminalPanel active />
    </Suspense>
  );
}

/** 内嵌浏览器（需要 `selected` 参数，单独一个壳）。 */
export function BrowserPane({ selected = true }: { selected?: boolean }) {
  return <BrowserPanel mode="sidebar" selected={selected} />;
}
