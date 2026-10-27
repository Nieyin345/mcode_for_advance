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

  const setRightPanelTab = useSessionStore((s) => s.setRightPanelTab);

  /* 【UI 重建 2026-10-28】侧栏顶部 `←` `→` 与底部账号行要的数据。
   *
   * ⚠️ 全部**从 store 派生**，不新增状态：
   *   - `navBackByProject` / `navForwardByProject` 是既有的导航栈，
   *     用**当前项目**的桶（和浏览器的前进后退同一个概念）；
   *   - `activeProviderName` 是当前引擎名 —— 它是 Claude 那截「· Gateway」
   *     的语义对应物（「你连的是哪个后端」）。
   *
   * 第一版这里写了 `canGoBack` / `accountName` 两个**不存在的**变量，
   * 是凭印象写的。tsc 当场报错才去查 store —— 又一次「猜字段名」。 */
  const navCanGoBack = useSessionStore((s) => {
    const pid = s.activeProjectId;
    return pid ? (s.navBackByProject[pid]?.length ?? 0) > 0 : false;
  });
  const navCanGoForward = useSessionStore((s) => {
    const pid = s.activeProjectId;
    return pid ? (s.navForwardByProject[pid]?.length ?? 0) > 0 : false;
  });
  const navBack = useSessionStore((s) => s.navigateBack);
  const navForward = useSessionStore((s) => s.navigateForward);
  /* 当前引擎名 —— 与 `ChatPane:744` 用**同一份**派生（硬规矩 2）：
   * `providers.find(id)` 的 `displayName`，缺了退回 id。 */
  const activeProviderName = useSessionStore((s) => {
    const p = s.providers.find((x) => x.id === s.providerId);
    return p?.displayName ?? s.providerId ?? "";
  });

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
        /* 【UI 重建 2026-10-28】分组标题的 `⑂`：在该项目下开一个**分支工作树**
         * 新建会话。
         *
         * 底层能力早就存在（`session.create` 的 `envMode:"worktree"` +
         * `wtStyle:"branch"`，意图先行、首次发送时才物化 —— 所以点了不发送
         * 不会留下空工作树）。这里只是补渲染端入口。
         *
         * ⚠️ 必须**显式传 projectId**，不能靠 `startSession()` 的
         * 「缺省用 activeProjectId」—— 用户点的可能是另一个分组。 */
        onNewSessionInWorktree={(projectId) =>
          void startSession(projectId, { envMode: "worktree", wtStyle: "branch" })}
        onSearch={() => setCommandPaletteOpen(true)}
        onOpenLibrary={() => {
          // 资料库挂在「右栏 pane」里（功能文档 UI-04 的挂载方式）。
          props.setRightOpen(true);
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        onCollapse={() => props.setLeftOpen(false)}
        /* 【UI 重建 2026-10-28】顶部图标行与底部账号行的接线。
         *
         * 全部读现有 store，没有新增状态：
         *   - `panesOpen`  = `props.rightOpen`（顶栏的「右侧面板」开关同源）
         *   - `canGoBack`  = store 的 nav 栈是否有上一条
         *   - 账号行右侧的 `· Gateway` 只有设置里真配了后端时才显示 ——
         *     没配就不显示那一截，不伪造一个「Gateway」。 */
        panesOpen={props.rightOpen}
        onTogglePanes={() => props.setRightOpen(!props.rightOpen)}
        canGoBack={navCanGoBack}
        canGoForward={navCanGoForward}
        onBack={() => navBack()}
        onForward={() => navForward()}
        /* 账号行的两截各是什么（**不伪造**）：
         *   - 左边：Mcode 没有「登录账号」这个概念，用品牌名；
         *   - `· 右侧`：Claude 那里是网关名。Mcode 的对应物是**当前引擎**
         *     （Claude Code / Pi / Codex / 网页模型）—— 那确实是「你连的是哪个
         *     后端」，与 Claude 的 Gateway 同一个语义位置。
         *   没有可用引擎名时**整截不显示**，而不是写一个占位的 "Gateway"。 */
        accountSubtitle={activeProviderName || undefined}
        onOpenAccountMenu={() => setSettingsOpen(true)}
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
  // 【UI 重建 2026-10-27】顶栏的 pane 开关要用它。与 `⋯` 菜单、设置页
  // 走的是**同一个** store action，不是各写一份。
  const asideFirst = rightDock === "left";
  const tileForTab = (tab: string): PaneTileKind => {
    switch (tab) {
      // 【UI 重建 2026-10-27】默认右栏是项目概览。**必须显式列出来** ——
      // `default` 是 `file`，而 `overview` 一旦漏了就会静默落进文件树
      // （改了 store 默认值却「看不到变化」的经典形态）。
      case "overview": return "overview";
      // 【UI 重建 2026-10-27】`files` 此前**没有显式 case**，靠
      // `default: return "file"` 兜底 —— 它碰巧是对的（default 恰好是 file），
      // 但那是巧合不是设计：把 default 改成别的，文件页签会**静默**跳到
      // 另一个面板，而没有任何东西会红。`claude-shell-smoke` 的
      // 「Claude 能力页签必须有显式映射」那条断言就是抓这个的。
      case "files": return "file";
      case "git": return "diff";
      case "preview": return "preview";
      case "turns": return "turns";
      case "flow": return "watercolor";
      case "tasks": return "pr";
      case "taskcenter": return "cr";
      // 【UI 重建 2026-10-28】**浏览器与扩展视图拆成两个 tile。**
      //
      // 此前 `browser` 映射到 `mcpapp`，而 `mcpapp` 的原义是「扩展贡献的视图」。
      // 两者共用一个 tile，接哪个另一个就断 —— 事实是接成浏览器之后，
      // **扩展视图在右栏彻底没有入口了**。
      // 现在：`browser` 页签 → `browser` tile → `BrowserPane`；
      //       `mcpapp` 保留给扩展视图（`ExtensionViewsPane`）。
      case "browser": return "browser";
      // 【UI 重建 2026-10-28】两个「能渲染但没入口」的死格。
      case "extensions": return "mcpapp";
      case "canvas": return "canvas";
      // 【UI 重建 2026-10-27】Claude 六项能力里的两项，此前没有页签能切到：
      //   - `terminal`：`paneContent` 的 `case "terminal"` 早就写好了，
      //     可达路径是**零** —— 终端只在底部横条。
      //   - `sidechat`：`SideChatPanel` 文件头自称「right panel's quick ask tab」，
      //     同样没有任何页签指向它。
      case "terminal": return "terminal";
      case "sidechat": return "sidechat";
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

  /** 顶栏 pane 开关的统一动作：**toggle 语义**。
   *
   * 与 Claude 一致 —— 点已显示的那个 pane 会收起右栏，不是「什么都不做」。
   * 实现里没有本地状态：`rightOpen` 从 store 读、`setRightPanelTab` 也是
   * store action，所以顶栏 / `⋯` 菜单 / 设置三处永远同步。
   *
   * ⚠️ 顺序要紧：**先判「是不是同一个 pane」再判开关**。反过来的话，
   * 「右栏关着但 tab 已经是 terminal」时点终端会走 `!rightOpen` 分支去展开，
   * 而用户看到的是「点了没反应」（因为 tab 本来就对）。 */
  const pickRightTab = (tab: string) => {
    if (props.rightOpen && rightPanelTab === tab) {
      props.setRightOpen(false);
      return;
    }
    if (rightPanelTab !== tab) setRightPanelTab(tab as never);
    props.setRightOpen(true);
  };

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
          /* 【UI 重建 2026-10-27】顶栏的 pane 开关行（Claude 的真实形态）。
           *
           * 顺序照真机截图的图标行：概览 → 终端 → 预览 → 文件。
           * 每个按钮做两件事，**与 `⋯` 菜单走同一个 store action**：
           *   - 该 pane 已显示 → 再点收起右栏（Claude 的 toggle 语义）；
           *   - 该 pane 未显示 → 切到它并展开右栏。
           *
           * 都是读 `rightPanelTab` / `rightOpen` 派生，没有本地状态 ——
           * 顶栏与菜单不会各记一份而分叉（硬规矩 2）。 */
          paneToggles={[
            {
              id: "overview",
              label: "概览",
              icon: <OverviewIcon />,
              active: props.rightOpen && rightPanelTab === "overview",
              onSelect: () => pickRightTab("overview"),
            },
            {
              id: "terminal",
              label: "终端",
              icon: <TerminalIcon />,
              active: props.rightOpen && rightPanelTab === "terminal",
              onSelect: () => pickRightTab("terminal"),
            },
            /* 【UI 重建 2026-10-28】截图里终端之后还有**第四个图标**：
             * 一个方框内加号（`⊞`）—— 语义是「在这个会话里再开一个 pane」。
             * 之前整个漏掉了，五格变成四格。
             *
             * Mcode 的对应动作：开一个**侧聊** pane（与 Claude 的
             * 「新开一格」最接近，且是真实存在的能力）。 */
            {
              id: "new-pane",
              label: "新建侧聊",
              icon: <AddPaneIcon />,
              active: false,
              onSelect: () => pickRightTab("sidechat"),
            },
            {
              id: "preview",
              label: "预览",
              icon: <PreviewIcon />,
              active: props.rightOpen && rightPanelTab === "preview",
              onSelect: () => pickRightTab("preview"),
            },
            {
              id: "files",
              label: "文件",
              icon: <FilesIcon />,
              active: props.rightOpen && rightPanelTab === "files",
              onSelect: () => pickRightTab("files"),
            },
          ]}
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

/* ───────── 顶栏 pane 开关的图标（Phosphor 形，1.5 描边）─────────
 *
 * 真机截图里这一排是**线性图标、约 1.5px 描边、16 视框**。Mcode 已有
 * `lib/icons.tsx`（Tabler 那一套），但那批是 24 视框、2px 描边，摆在 28px
 * 按钮里偏粗。这里按 Phosphor 的几何手写四个 —— 与 `ClaudeSidebar` 的
 * `ChevronRight` 同一个做法（未装 @phosphor-icons，形状照抄）。
 */

/** 概览：清单（截图里第一个、激活态那个）。 */
function OverviewIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.6 6.2h.01M4.6 8.4h.01M4.6 10.6h.01M7 6.2h4.4M7 8.4h4.4M7 10.6h2.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** 终端：`>_`（截图第二个）。 */
function TerminalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3.2 5.2 5.8 8l-2.6 2.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.6 11.2h5.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** 新建 pane：方框内加号（截图第三个，`⊞`）。 */
function AddPaneIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="2.6" width="12" height="10.8" rx="1.8" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 5.9v4.2M5.9 8h4.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** 预览：播放三角（截图第四个）。 */function PreviewIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M5.5 3.8 12 8l-6.5 4.2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** 文件：文件夹（截图第五个）。 */
function FilesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.8 4.4c0-.7.5-1.2 1.2-1.2h3l1.4 1.6h5.6c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V4.4Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
