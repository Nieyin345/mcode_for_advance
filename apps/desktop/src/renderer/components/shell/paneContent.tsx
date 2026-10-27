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
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { FilesPanel } from "@renderer/components/ide/FilesPanel.js";
import { GitPanel } from "@renderer/components/ide/GitPanel.js";
import { BrowserPanel } from "@renderer/components/browser/BrowserPanel.js";
import { TurnFlowPanel } from "@renderer/components/ide/TurnFlowPanel.js";
import { TaskListPanel } from "@renderer/components/ide/TaskListPanel.js";
import { TaskCenterPanel } from "@renderer/components/ide/TaskCenterPanel.js";
import { WorkflowBoardPanel } from "@renderer/components/chat/WorkflowBoardPanel.js";
import { PreviewPanel } from "@renderer/components/library/PreviewPanel.js";
import { SideChatPanel } from "@renderer/components/chat/SideChatPanel.js";
import { ClaudeProjectOverview } from "./ClaudeProjectOverview.js";

/** Claude 的 tile 类型 → Mcode 的面板。
 *
 * ## 三条线的接入位置
 *
 * | 线 | tile | 面板 |
 * |---|---|---|
 * | **Office** | `artifact`（文档产物）/ 文档停靠 | `GenofficeViewHostPane` |
 * | **扩展** | `mcpapp` | `ModuleViewDock`（扩展视图） |
 * | **工作流** | `watercolor` | `WorkflowBoardPanel`（Node-RED 看板） |
 *
 * 三条线各自替换自己那一格，互不覆盖。
 */
export function renderPaneContent(tileId: string): ReactNode {
  switch (tileId) {
    case "overview":
      // 【UI 重建 2026-10-27】Claude Code 模式的**项目概览**右栏
      // （Environment / Context / Connectors / Outputs / Changes 卡片堆）。
      // 真机截图就是这个形态；它是「没有选中具体能力时」的默认右栏。
      return <ClaudeProjectOverview />;
    case "file":
      return <FilesPanel />;
    case "diff":
      return <GitPanel />;
    case "preview":
      return <PreviewPanel />;
    case "artifact":
      // 【Office 线】文档产物：GenOffice 原生编辑器宿主。
      // 它需要 documentId，由 GenofficeViewHostPane 自己从 store 读当前文档。
      return <OfficePaneLazy />;
    case "terminal":
      return <TerminalPaneLazy />;
    case "pr":
      // 「此刻这台机器在跑什么」—— 与 Claude 的 PR 面板最接近的一层。
      return <TaskListPanel />;
    case "cr":
      // 任务中心（持久任务表 + 接受/退回）。Claude 的 `cr` 是「代码评审」，
      // Mcode 没有评审流，用最接近的「需要人处理的任务」接上。
      return <TaskCenterPanel />;
    case "mcpapp":
      /* 【UI 重建 2026-10-27】**修一条换壳时断掉的接线。**
       *
       * `browser` 页签经 `tileForTab` 映射到 `mcpapp`，而这一支此前 `return null`
       * —— 用户点「浏览器」页签得到一个**空壳**。而正确的 `BrowserPane`
       * （`mode="sidebar"` 的 `BrowserPanel`）就写在**本文件底部并导出**，
       * 从来没有被 `renderPaneContent` 调用过。
       *
       * 那个 `null` 的注释说的是「扩展贡献的视图没有渲染端面板」—— 那是
       * **另一个语义**（扩展视图）。`mcpapp` 这个 tile 名同时被当成
       * 「扩展视图」和「浏览器」用，是命名撞车；实际只有一个消费者
       * （`browser` 页签），按它接。 */
      return <BrowserPane />;
    case "watercolor":
      // 【工作流线】Node-RED / 工作流看板。
      return <WorkflowBoardPanel />;
    case "turns":
      // Mcode 自己新增的 tile 类型：每轮时间线。
      // 它不在 Claude 的原始类型集里，是这个仓库多出来的一类面板。
      return <TurnFlowPanel />;
    case "sidechat":
      // 【UI 重建 2026-10-27】Claude 的 `Show Side Chat`。
      //
      // `SideChatPanel` 的文件头第一行就写着「the right panel's quick ask
      // tab」—— 它**本来就是为右栏写的**，但换壳之后没有任何页签指向它。
      // 现在接上：`sidechat` 页签 → 这个 tile → 面板。
      return <SideChatPanel />;
    default:
      return null;
  }
}

/** 【Office 线】GenOffice 原生文档编辑器。
 *
 *  `GenofficeViewHostPane` 需要 `filePath`（要打开哪份文档）。右栏那边由
 *  `RightPanel` 从「停靠的文档」状态里传进去；新壳里从同一份 store 读，
 *  保证两条路径指向同一份数据（硬规矩 2）。 */
const GenofficeViewHostPane = lazy(() =>
  import("@renderer/components/ide/GenofficeViewHostPane.js").then((m) => ({
    default: m.GenofficeViewHostPane,
  })),
);

function OfficePaneLazy() {
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const activeFile = useSessionStore((s) =>
    activeProjectId ? s.ideActiveFileByProject[activeProjectId] ?? null : null,
  );
  if (!activeFile) return null;
  return (
    <Suspense fallback={null}>
      <GenofficeViewHostPane filePath={activeFile} active />
    </Suspense>
  );
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
