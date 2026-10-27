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
 * | `flow` | `WorkflowBoardPanel` | 工作流**运行看板** + 侧聊 |
 * | `tasks` | `TaskListPanel` | 此刻在跑什么 |
 * | `taskcenter` | `TaskCenterPanel` | 持久任务表 |
 * | `preview` | `PreviewPanel` | 资料库条目预览 |
 *
 * ## 三条并行线各自落在哪一格（2026-10-28 定稿）
 *
 * | 线 | 页签 | tile | 面板 | 为什么是这里 |
 * |---|---|---|---|---|
 * | **Office** | `files`（打开文档后） | `artifact` | `GenofficeViewHostPane` | 文档产物 = 原厂编辑器宿主 |
 * | **扩展** | `extensions` | `mcpapp` | `ExtensionViewsPane` | `mcpapp` 的**原义**就是「扩展贡献的视图」 |
 * | **工作流** | `flow` | `watercolor` | `WorkflowBoardPanel`（运行看板） | 看板回答「跑到哪一格」 |
 * | **工作流** | `canvas` | `canvas` | `EngineRuntimePanel`（Node-RED 原厂画布） | 画布回答「图长什么样」 |
 *
 * **`browser` 页签不再借 `mcpapp`。** 曾经它被接到 `mcpapp` 上（因为那一支当时
 * `return null`，用户点浏览器得到空壳），代价是扩展视图永久失去入口 ——
 * 一个 tile 名同时被两个消费者索取，接谁都会让另一个断线。现在浏览器有自己的
 * `browser` tile，`mcpapp` 归还给扩展。
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
import { ExtensionViewsPane } from "@renderer/components/modules/ExtensionViewsPane.js";
import { hostedPaneContent } from "@renderer/components/layout/paneLayout.js";
import { ClaudeProjectOverview } from "./ClaudeProjectOverview.js";

/** Claude 的 tile 类型 → Mcode 的面板。
 *
 * ## 三条线的接入位置
 *
 * | 线 | tile | 面板 |
 * |---|---|---|
 * | **Office** | `artifact` | `GenofficeViewHostPane`（原厂编辑器宿主） |
 * | **扩展** | `mcpapp` | `ExtensionViewsPane`（扩展视图 + 管理入口） |
 * | **工作流** | `watercolor` | `WorkflowBoardPanel`（运行看板） |
 * | **工作流** | `canvas` | `EngineRuntimePanel`（Node-RED 原厂画布） |
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
      /* 【扩展线】扩展贡献的视图（VS Code `contributes.views` 那一类）。
       *
       * 这一支曾长期 `return null`，后来被 `browser` 页签借用（那时它 `null` 是
       * 用户点浏览器拿到空壳的直接原因）。**借用的代价是扩展视图没有入口** ——
       * 用户装完扩展，在当前外壳里找不到它。
       *
       * 现在归还本义：`browser` 有自己的 tile（见上面的文件头），这里接
       * `ExtensionViewsPane` —— 它把**已运行的扩展视图**列出来并内嵌进来，
       * 没有可显示的视图时给出「去哪装/怎么启动」的明确出口，不是一块空白。 */
      return <ExtensionViewsPane />;
    case "watercolor":
      // 【工作流线】**运行看板** —— 这张图跑到哪一格、哪几个分身还在干活。
      return <WorkflowBoardPanel />;
    case "canvas":
      // 【工作流线】**画布** —— Node-RED 原厂编辑器（WF-01 写的「右栏也可停靠」）。
      // 与上面那个看板是两个面板：看板看进度，画布改图。
      return <CanvasPaneLazy />;
    case "browser":
      // 【UI 重建 2026-10-28】**浏览器有了自己的 tile。**
      // 它此前借 `mcpapp`，现在拆开（否则 `mcpapp` 一接扩展视图，浏览器就断）。
      return <BrowserPane />;
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
 *  ## 读哪一个文档：先看「停靠」，再退回「活动文件」
 *
 *  有**两条**会把文档送进右栏的路径，它们的来源不同，必须都接住：
 *
 *  1. **停靠（`paneLayout` 的 `document` 内容）** —— `handoffOfficeToMcode`
 *     干的：用户在 Office 工具栏点「交给 Mcode AI」，文档停靠到右栏、中心列
 *     让回对话。旧壳 `RightPanel` 直接读 `pinnedDoc` 渲染。
 *  2. **活动文件** —— 用户从文件树打开一份文档，中心列归编辑器（`FileEditor`），
 *     右栏此时没有被要求显示它。这里**退回**到活动文件只是为了让 `artifact`
 *     页签不空着。
 *
 *  ⚠️ **这两条在旧壳里是互斥的**：`pinnedDoc` 非空时，内置页签整块被 `hidden`
 *  盖住（`RightPanel` 里 `pinnedDoc || pinnedFlow ? "hidden"`）。新壳换壳时
 *  **只接了第 2 条**，于是「交给 Mcode AI」之后文档从界面上消失了 ——
 *  `paneLayout` 里明明记着它，但没有任何东西读那份记录。
 *
 *  ⚠️ 判据用 `hostedPaneContent`（与旧壳**同一个**纯函数），不在这里手写
 *  「找 id 为 right 的那条 placement」—— 面板停左边时记录挂在另一条 placement 上，
 *  手写的那版会在用户把面板停到左边时静默读到空（硬规矩 2）。
 */
const GenofficeViewHostPane = lazy(() =>
  import("@renderer/components/ide/GenofficeViewHostPane.js").then((m) => ({
    default: m.GenofficeViewHostPane,
  })),
);

function OfficePaneLazy() {
  /* 停靠的文档优先。`hostedPaneContent` 是旧壳用的同一个函数 ——
   * 它把「面板停哪一侧」「内容挂在谁的 placement 上」都算好了。 */
  const dockedDoc = useSessionStore((s) => {
    const content = s.paneLayout ? hostedPaneContent(s.paneLayout) : undefined;
    return content?.kind === "document" ? content.documentId : null;
  });
  const activeFile = useSessionStore((s) => {
    const pid = s.activeProjectId;
    return pid ? s.ideActiveFileByProject[pid] ?? null : null;
  });
  const filePath = dockedDoc ?? activeFile;
  if (!filePath) return null;
  return (
    <Suspense fallback={null}>
      <GenofficeViewHostPane filePath={filePath} active />
    </Suspense>
  );
}

/** 【工作流线】Node-RED 原厂画布。
 *
 *  `EngineRuntimePanel` 自己管「哪个引擎、起没起、视图往哪开」；这里只给它
 *  `editorOnly`（不画设置页的引擎清单 —— 那一层属于设置页）与 `active`。
 *  `engineId` 不传：由它自己取唯一的 Node-RED 引擎（与设置页同一个默认）。 */
const EngineRuntimePanel = lazy(() =>
  import("@renderer/components/settings/workflows/EngineRuntimePanel.js").then((m) => ({
    default: m.EngineRuntimePanel,
  })),
);

function CanvasPaneLazy() {
  return (
    <Suspense fallback={null}>
      <EngineRuntimePanel editorOnly />
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
