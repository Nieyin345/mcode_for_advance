/**
 * 【UI 重建】**Claude 外壳的装配层** —— 把现有 store 与组件接到 `ClaudeShell`。
 *
 * ## 它做什么
 *
 * 新的 `ClaudeShell` 只认「侧栏 / project 列 / thread 列 / 顶栏 / tile 渲染器」
 * 这几个槽位。本文件负责把这些槽位填上真实的 Mcode 组件：
 *
 * | 槽位 | 用什么填 | 为什么 |
 * |---|---|---|
 * | 侧栏 | 现有 `LeftBar` / `StreamSidebar` | 会话/项目数据都在 store 里，重写会丢业务 |
 * | project 列 | `ChatPane` 的空态（`EmptyThreadWelcome`） | Claude 的 project 列就是「这个项目里聊点什么」 |
 * | thread 列 | `ChatPane` | 消息流 + composer 已经是成熟实现 |
 * | 顶栏 | 现有 `Titlebar` | 按钮行为要保留（终端开关、右栏开关等） |
 * | tile | `RightPanel` 的各个页签内容 | 文件树 / Git / 终端 / 浏览器 / 文档视图 |
 *
 * ## 为什么不是「重写 ChatPane」
 *
 * `ChatPane` 3788 行，承载消息流、审批卡、输入框、工具卡、队列、附件、
 * 斜杠命令……重写它等于重写整个产品。**外观重做的对象是「外壳与布局」**，
 * 内部面板按 UI-04 挂进 Claude 的结构里，逐个迁移。
 *
 * ## 三块并行线的接入点
 *
 * Office / 扩展 / 工作流三条线各有自己的对话在做。它们的 UI 从这里接入：
 *  - **Office**：`renderTile("file")` 分支 + 文档 pane
 *  - **工作流**：`renderTile("preview")` 分支（看板）
 *  - **扩展**：右侧 rail 的扩展视图（`ModuleViewDock`）
 *
 * 每个分支都留了 `TODO(ui-rebuild/<line>)` 标记，三条线各自替换自己那一段，
 * 互不覆盖。
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useSessionStore, selectActiveEnvPath, isCenterShowingDocument } from "../../stores/sessionStore.js";
import { ClaudeShell } from "./ClaudeShell.js";
import { ClaudeSidebar, type ClaudeProjectGroup, type ClaudeSession } from "./ClaudeSidebar.js";
import { ClaudeTitlebar } from "./ClaudeTitlebar.js";
import { StreamSidebar } from "../layout/StreamSidebar.js";
import { LeftBar } from "../layout/LeftBar.js";
import { ChatPane } from "../chat/ChatPane.js";
import { BottomTerminalBar } from "../layout/BottomTerminalBar.js";
import { renderPaneContent } from "./paneContent.js";
import { resizeStack, type PaneTile, type PaneTileKind, type TileLayout } from "./paneTiles.js";
import { WorkspaceInertShell } from "./ClassicShell.js";

/** Claude 侧栏的固定宽（来自其产物：`--static-sidebar-width: 18rem` = 288px）。 */
const CLAUDE_SIDEBAR_PX = 288;

/** Monaco 编辑器：按需加载（它是渲染端最大的单块依赖之一）。
 *
 *  **不要在这里加 `key={filePath}`** —— `FileEditor` 自己维护
 *  `editorModelCache`，切文件时换 model 而不重挂；重挂会丢掉未保存草稿、
 *  Monaco 实例与滚动位置（真机套件 `arc005-pane-electron-smoke` 用
 * 「PTY/Monaco 节点身份不变」来守这件事）。 */
const FileEditorPane = lazy(() =>
  import("@renderer/components/ide/FileEditor.js").then((m) => ({ default: m.FileEditor })),
);

export interface ClaudeShellMountProps {
  leftOpen: boolean;
  leftBarMode: string;
  leftWidthPct: number;
  handleLeftResize: (deltaPx: number) => void;
  resetLeftWidthPct: () => void;
  setLeftOpen: (open: boolean) => void;
  rightOpen: boolean;
  setRightOpen: (open: boolean) => void;
  bottomTerminalOpen: boolean;
  setBottomTerminalOpen: (open: boolean) => void;
}

/**
 * 把 `leftWidthPct`（百分比）折算成 px，但**钳到 Claude 的 288px**。
 *
 * Claude 的侧栏是固定宽、可拖但不按百分比——因为它是「会话列表」，
 * 宽度跟窗口大小无关。旧 Mcode 用百分比（12%–40%），窗口一宽就变成 500px+，
 * 这正是「看起来不像」的一个直接来源。
 */
function sidebarWidthPx(pct: number): number {
  const win = typeof window === "undefined" ? 1440 : window.innerWidth;
  const px = (pct / 100) * win;
  return Math.round(Math.min(420, Math.max(240, px || CLAUDE_SIDEBAR_PX)));
}

export function ClaudeShellMount(props: ClaudeShellMountProps) {
  const leftBarMode = props.leftBarMode;
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const loadingMessages = useSessionStore((s) =>
    activeSessionId ? (s.loadingMessagesBySession[activeSessionId] ?? false) : false,
  );
  // 顶栏标题：有会话用会话标题，否则用当前项目名（Claude 的标题行就是这个语义）。
  const sessionTitle = useSessionStore((s) => {
    if (!activeSessionId) return null;
    const sess = s.sessions.find((x) => x.id === activeSessionId);
    return sess?.title ?? null;
  });
  const projectName = useSessionStore((s) => {
    const pid = s.activeProjectId;
    if (!pid) return null;
    return s.projects.find((p) => p.id === pid)?.name ?? null;
  });

  // 侧栏内容：Claude 形态（Pinned / Projects / Recents）。
  // 数据来自现有 store，**零业务改动** —— 只是换了一种摆法。
  //
  // **但保留 stream 模式的逃生口**：`leftBarMode === "stream"` 时仍渲染旧的
  // `StreamSidebar`。理由是它承载着「并行会话 + 运行状态」这一类特有信息
  // （`streamSessions` 是独立于 `sessions` 的一条数据源），直接换掉会丢功能。
  // 迁移完成后再删这个分支。
  const pinned = useSessionStore((s) => s.pinnedSessions);
  const projects = useSessionStore((s) => s.projects);
  const sessions = useSessionStore((s) => s.sessions);
  const runningBySession = useSessionStore((s) => s.runningBySession);
  const unreadBySession = useSessionStore((s) => s.unreadBySession);
  const turnErrorBySession = useSessionStore((s) => s.turnErrorBySession);
  const selectSession = useSessionStore((s) => s.selectSession);
  const startSession = useSessionStore((s) => s.startSession);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const setCommandPaletteOpen = useSessionStore((s) => s.setCommandPaletteOpen);

  const toRow = (sess: { id: string; title: string }): ClaudeSession => {
    // 侧栏只列 `kind === "chat"` 的会话 —— side（侧聊）/ node（工作流节点）/
    // automation（后台自动化）都是隐藏会话，Claude 的侧栏也不显示它们。
    const st = useSessionStore.getState();
    const full = st.sessions.find((x) => x.id === sess.id);
    return {
      id: sess.id,
      title: sess.title || "(未命名会话)",
      branch: full?.worktreePath ? full.worktreePath.split(/[\\/]/).pop() : undefined,
      running: !!st.runningBySession[sess.id],
      unread: st.unreadBySession[sess.id] ?? 0,
      failed: !!st.turnErrorBySession[sess.id],
      pinned: true,
    };
  };

  const visibleChats = sessions.filter((s) => s.kind === "chat");

  // 置顶：store 给的是 Session[]。
  const pinnedIds = new Set(pinned.map((s) => s.id));
  const pinnedRows: ClaudeSession[] = pinned
    .filter((s) => s.kind === "chat")
    .map((s) => toRow(s));

  // 项目分组：每个项目下挂它自己的会话（不含已置顶的，避免重复）。
  const projectGroups: ClaudeProjectGroup[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    sessions: visibleChats
      .filter((s) => s.projectId === p.id && !pinnedIds.has(s.id))
      .map((s) => {
        const row = toRow(s);
        return { ...row, pinned: false };
      }),
  }));

  // Recents：不属于任何项目的会话。
  const projectIds = new Set(projects.map((p) => p.id));
  const recentRows: ClaudeSession[] = visibleChats
    .filter((s) => !projectIds.has(s.projectId) && !pinnedIds.has(s.id))
    .slice(0, 30)
    .map((s) => ({ ...toRow(s), pinned: false }));

  // 【迁移期】`stream` 模式走 Claude 侧栏，但**并行会话数据**（streamSessions）
  // 仍由旧 StreamSidebar 承载 —— 这是一个独立数据源，ClaudeSidebar 还没接。
  // 有并行数据时用它，否则用新的 Claude 侧栏。
  const streamHasData = useSessionStore((s) => s.streamSessions.length > 0);

  const sidebar =
    // **tree 是用户显式选的「项目树」视图，尊重它。**
    leftBarMode === "tree" ? (
      <LeftBar />
    ) : // **并行会话数据存在时用旧 StreamSidebar** —— 它承载 `streamSessions`
    // 这条独立数据源（运行秒表、未合并标记），ClaudeSidebar 还没接。
    // 迁移完成、ClaudeSidebar 接上并行状态后删掉这个分支。
    streamHasData ? (
      <StreamSidebar />
    ) : (
      <ClaudeSidebar
        brand="Mcode"
        pinned={pinnedRows}
        projects={projectGroups}
        recents={recentRows}
        activeSessionId={activeSessionId}
        onSelectSession={(id) => void selectSession(id)}
        onNewSession={() => void startSession()}
        onSearch={() => setCommandPaletteOpen(true)}
        onOpenLibrary={() => {
          // 资料库挂在「右栏 pane」里（功能文档 UI-04 的挂载方式）。
          props.setRightOpen(true);
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        onCollapse={() => props.setLeftOpen(false)}
      />
    );

  // project 列：Claude 在这一列显示「这个项目的会话 + 起点卡片」。
  // Mcode 的 ChatPane 在没有会话时正好渲染 EmptyThreadWelcome，直接复用。
  const projectColumn = <ChatPane sessionId={null} isActive={!activeSessionId} />;

  /* 【UI 重建 2026-10-27】**中心区要能在「对话」和「编辑器」之间切换。**
   *
   * 旧壳里这是 `ClassicShell` 的 `content` 视图：在文件树里点一个文件，中心区
   * 换成 Monaco，再点对话页签换回来。换壳时这条路径**整条丢了** ——
   * 用户点文件只会把文件树的高亮挪一下，编辑器永远不出现。
   *
   * 判据用的是 `isCenterShowingDocument`（与旧壳同一个纯函数，硬规矩 2：
   * 共享实现只有一份），它已经把 displayMode / centerTabFocus / 活动文件
   * 三个条件都算进去了。
   *
   * 真机探针（`arc005-pane-electron-smoke`）就卡在这里：它要求「真实 Electron 里
   * 打开 model.txt 后存在 Monaco 实例」，而新壳此前的答案是没有。 */
  const showingDocument = useSessionStore(isCenterShowingDocument);
  const centerFilePath = useSessionStore((s) =>
    s.activeProjectId ? s.ideActiveFileByProject[s.activeProjectId] ?? null : null,
  );
  const centerProjectPath = useSessionStore((s) => {
    // 与 `FilesPanel` 用**同一个**选择器（硬规矩 2）：项目可能有 worktree 环境路径，
    // 编辑器里「相对路径」要对着实际工作树算，否则会显示成相对另一个根。
    const envPath = selectActiveEnvPath(s);
    if (envPath) return envPath;
    const pid = s.activeProjectId;
    return pid ? s.projects.find((p) => p.id === pid)?.path ?? null : null;
  });
  const setCenterTabFocus = useSessionStore((s) => s.setCenterTabFocus);

  /* ⚠️ 顺序很重要：**文档优先**。
   * 「中心区显示编辑器」的判据是 `isCenterShowingDocument`（它已经包含 displayMode /
   * centerTabFocus / 活动文件），与「有没有打开会话」无关 —— 用户在项目里直接打开
   * 一个文件时，即使还没选会话，也应该看到编辑器。
   * 写成 `!activeSessionId ? null : showingDocument ? ... : ...` 会让「零会话 +
   * 已开文件」落进 null，编辑器永远不出现（真机套件 fixture 正是这个组合）。 */
  const threadColumn = showingDocument && centerFilePath ? (
    /* 编辑器占满 thread 列。`filePath` 明确传入，**不要 key={filePath}**：
     * FileEditor 是常驻的、切文件只换 model（`editorModelCache`），
     * 每次重挂会卡顿并丢掉未保存草稿。 */
    <div className="flex min-h-0 flex-1 flex-col" data-cds-center-document="">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--m-border)] px-3">
        <button
          type="button"
          onClick={() => setCenterTabFocus("chat")}
          className="rounded-[var(--radius-btn-xs)] px-2 py-1 text-[var(--m-font-size-caption)] text-[var(--m-text-secondary)] hover:bg-[var(--m-fill-ghost-hover)] active:bg-[var(--m-fill-ghost-selected)]"
        >
          ← 对话
        </button>
        <span className="min-w-0 flex-1 truncate text-[var(--m-font-size-caption)] text-[var(--m-text-secondary)]">
          {centerFilePath.split(/[\\/]/).pop()}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense fallback={null}>
          {/* `FileEditor` 的 `projectPath` 是必填 string（它用来算相对路径）。
              进入这个分支的前提是 `centerFilePath` 非空，而那必然属于某个项目；
              但如果项目记录恰好被删（文件还在 store 里），`centerProjectPath`
              会是 null —— 这时传空串而不是崩，编辑器会退回显示绝对路径。 */}
          <FileEditorPane filePath={centerFilePath} projectPath={centerProjectPath ?? ""} />
        </Suspense>
      </div>
    </div>
  ) : activeSessionId ? (
    <ChatPane sessionId={activeSessionId} isActive />
  ) : null; // 零会话且没开文件 → project 列独占（Claude 的项目首页就是这样）

  // tile 布局：chat + 右侧那个由 `rightPanelTab` 决定的面板。
  //
  // **Claude 的右侧是「按需出现的 pane」**，Open 什么由当前上下文决定。
  // Mcode 的对应状态就是 `rightPanelTab`（文件/Git/浏览器/轮次/工作流/任务/
  // 任务中心/预览）—— 让新壳读同一个字段，功能与旧右栏一致，只是呈现换了。
  //
  // 映射：`rightPanelTab` → tile 类型（见 paneContent 的 switch）。
  const rightPanelTab = useSessionStore((s) => s.rightPanelTab);
  /* 【UI 重建 2026-10-27】**`rightDock` 必须接回来。**
   *
   * 这是用户可设的「右栏停在哪一侧」（设置里能把它挪到左边）。
   * 换壳时它掉了 —— 症状是设置在 Claude 壳下完全无效，而没有任何报错。
   * 新壳的模型是「tile 顺序即位置」，所以左停靠 = 把 aside 排在 chat **前**。
   * 这与旧壳的 `dockFlexOrder` 是同一个语义，只是表达方式不同。 */
  const rightDock = useSessionStore((s) => s.rightDock);
  // 【UI 重建 2026-10-27】换边走 store 的同一个 action（与设置里的「面板停靠」同源）。
  const setRightDock = useSessionStore((s) => s.setRightDock);
  const asideFirst = rightDock === "left";
  const tileForTab = (tab: string): PaneTileKind => {
    switch (tab) {
      case "git": return "diff";
      case "preview": return "preview";
      case "turns": return "turns";
      case "flow": return "watercolor";
      case "tasks": return "pr";
      case "taskcenter": return "cr";
      case "browser": return "mcpapp";
      default: return "file";
    }
  };
  // 放大某一格（Claude 的 expandedTile）：只记 id，不改树 ——
  // 退出放大时布局原样回来。
  /* 【UI 重建 2026-10-27】**顶栏的「右侧面板」开关必须真的生效。**
   *
   * 新壳的 tile 布局本来总是 `[chat, aside]` 两个格，`rightOpen`（顶栏菜单里
   * 那项开关、以及设置里的默认值）**没有任何作用** —— 关掉之后 panel 还在。
   * 真机套件 `arc005-pane-electron-smoke` 的 `COLLAPSED_COMPONENTS_PERSIST`
   * 就是抓这个的（它要求关掉后 `[data-cds-aside]` 带 `aria-hidden="true"`）。
   *
   * 关掉的方式**不是卸载**：把 aside 的 flex 归 0 并标 aria-hidden ——
   * 子树全程挂载，PTY/Monaco/草稿保活（与 terminal 塌高同一个做法）。 */
  const [expandedTile, setExpandedTile] = useState<string | null>(null);
  const [tileLayout, setTileLayout] = useState<TileLayout>((): TileLayout => {
    // 首帧就按 `rightDock` 排好 —— 用 effect 修正会让左停靠的用户看到一次闪动。
    const chatTile: PaneTile = { kind: "tile", tileId: "chat", flex: 1 };
    const asideTile: PaneTile = { kind: "tile", tileId: tileForTab(rightPanelTab), flex: 1 };
    return {
      version: 2,
      root: {
        kind: "stack",
        direction: "row",
        children: asideFirst ? [asideTile, chatTile] : [chatTile, asideTile],
      },
    };
  });
  /* `rightDock` 变化 → 把 aside 挪到 chat 的前面或后面。
   * 只重排，不改 flex —— 用户拖出来的分栏比例要保留。 */
  useEffect(() => {
    setTileLayout((prev) => {
      const root = prev.root;
      if (root.direction !== "row" || root.children.length !== 2) return prev;
      const [a, b] = root.children;
      if (a.kind !== "tile" || b.kind !== "tile") return prev;
      const chatIdx = a.tileId === "chat" ? 0 : b.tileId === "chat" ? 1 : -1;
      if (chatIdx < 0) return prev;
      const chat = chatIdx === 0 ? a : b;
      const aside = chatIdx === 0 ? b : a;
      const want = asideFirst ? [aside, chat] : [chat, aside];
      if (want[0] === root.children[0] && want[1] === root.children[1]) return prev;
      return { ...prev, root: { ...root, children: want } };
    });
  }, [asideFirst]);
  // 右栏页签变了 → 换 tile，但**保留用户拖出来的分栏比例**：
  // 只换 tileId，不动 flex；两个 tile 时按位置替换右侧那个。
  const prevTab = useRef(rightPanelTab);
  useEffect(() => {
    if (prevTab.current === rightPanelTab) return;
    prevTab.current = rightPanelTab;
    const want = tileForTab(rightPanelTab);
    setTileLayout((prev) => {
      const root = prev.root;
      if (root.direction !== "row" || root.children.length !== 2) return prev;
      const [a, b] = root.children;
      if (a.kind !== "tile" || b.kind !== "tile") return prev;
      if (a.tileId === "chat") {
        return { ...prev, root: { ...root, children: [a, { ...b, tileId: want }] } };
      }
      return { ...prev, root: { ...root, children: [{ ...a, tileId: want }, b] } };
    });
  }, [rightPanelTab]);

  return (
    <WorkspaceInertShell variant="workspace">
    <ClaudeShell
      sidebar={sidebar}
      projectColumn={projectColumn}
      threadColumn={threadColumn}
      titlebar={
        <ClaudeTitlebar
          title={sessionTitle ?? projectName ?? "Mcode"}
          subtitle={projectName ?? undefined}
          sidebarOpen={props.leftOpen}
          onToggleSidebar={() => props.setLeftOpen(true)}
          menuItems={[
            {
              id: "toggle-sidebar",
              label: props.leftOpen ? "隐藏侧栏" : "显示侧栏",
              checked: props.leftOpen,
              onSelect: () => props.setLeftOpen(!props.leftOpen),
            },
            {
              id: "toggle-terminal",
              label: "终端",
              checked: props.bottomTerminalOpen,
              onSelect: () => props.setBottomTerminalOpen(!props.bottomTerminalOpen),
            },
            {
              id: "toggle-panes",
              label: "右侧面板",
              checked: props.rightOpen,
              onSelect: () => props.setRightOpen(!props.rightOpen),
            },
          ]}
        />
      }
      bottomTerminal={<BottomTerminalBar active={props.bottomTerminalOpen} />}
      bottomTerminalOpen={props.bottomTerminalOpen}
      leftOpen={props.leftOpen}
      leftWidth={sidebarWidthPx(props.leftWidthPct)}
      tileLayout={tileLayout}
      isLoadingThread={!!loadingMessages}
      centerOccupied={showingDocument && !!centerFilePath}
      asideOpen={props.rightOpen}
      onMoveTile={() => setRightDock(rightDock === "left" ? "right" : "left")}
      onResizeTile={(_stack, a, na, b, nb) =>
        setTileLayout((prev) => resizeStack(prev, _stack, a, na, b, nb))}
      onExpandTile={setExpandedTile}
      expandedTile={expandedTile}
      renderTile={(tileId) => renderPaneContent(tileId)}
    />
    </WorkspaceInertShell>
  );
}
