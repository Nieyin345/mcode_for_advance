/**
 * T01 / ARC-005 U1. Real App + real Electron capturePage; fixtures go through
 * the real Zustand store, never by fabricating DOM or generated screenshots.
 * Screens requiring unavailable live services are recorded as data-missing.
 */
import { BrowserWindow, nativeTheme, ipcMain, app } from "electron";
import { join } from "node:path";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ARC005_MEASURE_SELECTORS,
  ARC005_PROBE_TARGETS,
  buildSceneAssertionScript,
  inspectVisualProbeTarget,
} from "./probe-assertions.js";

const SCREENS = [
  ["empty", "初始空会话"], ["messages", "已有消息"],
  ["long-chat", "长会话虚拟化压力"],
  ["tab-overflow", "会话标签溢出与焦点"],
  ["tools", "工具运行中/完成/失败"], ["approval", "权限审批"],
  ["diff", "代码/文件 Diff"], ["sidechat", "侧聊"],
  ["terminal", "终端"], ["editor", "文件编辑"],
  ["preview", "预览"], ["parallel", "并行会话侧栏"],
  ["projects", "项目切换"], ["settings", "设置菜单"],
  ["narrow-window", "窗口缩窄"],
  // 【T136】下列四个是我们**独有**的界面（Claude 没有）。加进基线之后，
  // 后续任何 UI 改动都有「改前」可对照 —— 这四个此前从未被拍过。
  ["files-pane", "右栏文件树"],
  ["git-pane", "右栏 Git 面板"],
  ["taskcenter", "任务中心"],
  ["workflow-board", "工作流看板"],
  // 【UI 重建 2026-10-27】Claude Code 模式的**项目概览**右栏
  // （Environment / Context / Connectors / Outputs / Changes 卡片堆）。
  // 它是右栏的新默认形态；没有这一格，改那张面板没有任何画面对照。
  ["overview-pane", "右栏项目概览"],
  // 【UI 重建 2026-10-27】Claude 六项能力里此前**没有页签能切到**的两项：
  // 终端只在底部横条、`SideChatPanel` 自称右栏页签却没人挂。
  // 这两格拍的是「右栏里它们真的画出来了」。
  ["terminal-pane", "右栏终端"],
  ["sidechat-pane", "右栏侧聊"],
] as const;
const CONDITIONS = [
  { id: "light", width: 1280, height: 800, dark: false },
  { id: "dark", width: 1280, height: 800, dark: true },
  { id: "narrow", width: 1024, height: 640, dark: false },
] as const;
// Optional targeted U1 run for rapid UI iteration. Default remains the full
// 19 × 3 real-Electron evidence matrix. Unknown screen IDs are rejected.
const selectedScreens = process.env.ARC005_VISUAL_SCENES?.split(",").filter(Boolean);
const selectedConditions = process.env.ARC005_VISUAL_CONDITIONS?.split(",").filter(Boolean);
if (selectedScreens?.some(id => !SCREENS.some(([screen]) => screen === id))) {
  throw Error("Unknown ARC005_VISUAL_SCENES selection");
}
if (selectedConditions?.some(id => !CONDITIONS.some(c => c.id === id))) {
  throw Error("Unknown ARC005_VISUAL_CONDITIONS selection");
}
const captureScreens = selectedScreens ? SCREENS.filter(([id]) => selectedScreens.includes(id)) : SCREENS;
const captureConditions = selectedConditions ? CONDITIONS.filter(c => selectedConditions.includes(c.id)) : CONDITIONS;
if (!captureScreens.length || !captureConditions.length) throw Error("Empty ARC005 visual selection");
/** Explicit exemptions for fixture scenes that CANNOT prove rendered UI.
 * Currently empty: sidechat now mounts the real RightPanel → WorkflowBoardPanel
 * → SideChatPanel, and exercises actual child-session selection using isolated
 * API/store rows. Real workflow execution/IPC remains outside this visual U1. */
const KNOWN_UNCAPTURED = new Map<string, string>([
  /* 【UI 重建 2026-10-27】`tab-overflow` 测的是**中心区的会话页签溢出**
   *（`[data-ui-center-pane] [role='tablist']` 里 32+ 个会话页签）。
   *
   * 那个组件是 `UnifiedTabsBar`，只被 `ClassicShell` 渲染；换 Claude 壳之后
   * 它不再挂载 —— Claude 的会话列表在左栏，中心区没有会话页签条。
   * 所以这一格**按设计拍不出内容**，不是回归。
   *
   * **不删场景**：留着的是「这个能力不存在了」的记录。哪天要把多会话页签
   * 加回中心区，把这条删掉，断言会立刻告诉你新实现是否满足 32 页签溢出。 */
  ["tab-overflow", "Claude 壳的会话列表在左栏，中心区没有会话页签条（UnifiedTabsBar 仅 ClassicShell 渲染）"],
]);
const SELECTORS = ARC005_MEASURE_SELECTORS;
const TOKENS = [
 "--surface", "--surface-muted", "--surface-hover", "--content",
 "--content-muted", "--content-subtle", "--edge", "--panel-edge",
 "--radius-panel", "--composer-radius", "--radius-bubble", "--radius-control",
 "--radius-btn-xs", "--radius-btn-md", "--radius-dialog", "--radius-code",
 "--dur-fast", "--dur-snap", "--dur-base", "--dur-sheet", "--dur-slow",
 "--ease-out", "--ease-snap", "--ease-overshoot",
];
type Row = { screen: string; title: string; condition: string; file: string; status: "CAPTURED" | "DATA_MISSING"; reason?: string; probe?: unknown };

export async function runArc005VisualProbe(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  // Two real, isolated text file versions. The renderer itself computes the
  // diff through production lineDiff + DiffView; never hard-code diff rows.
  const beforePath = join(dir, "v1.ts");
  const afterPath = join(dir, "v2.ts");
  writeFileSync(beforePath, "export const state = 'before';\nexport const value = 1;\n");
  writeFileSync(afterPath, "export const state = 'after';\nexport const value = 2;\n");
  const diffBefore = readFileSync(beforePath, "utf8");
  const diffAfter = readFileSync(afterPath, "utf8");
  const results: Row[] = [];
  const errors: string[] = [];
  const stamp = (row: Row) => {
    results.push(row);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(results, null, 2));
  };
  ipcMain.handle("theme:get", () => ({ theme: "light", effective: nativeTheme.shouldUseDarkColors ? "dark" : "light" }));
  ipcMain.handle("theme:set", () => ({ theme: "light", effective: nativeTheme.shouldUseDarkColors ? "dark" : "light" }));
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1024, minHeight: 640,
    show: true, opacity: 0, x: -10000, y: -10000,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false, preload: join(dir, "bridge.cjs"),
    },
  });
  const wc = win.webContents;
  wc.on('console-message', (_event, level, message) => { if (level >= 2) console.log('RENDERER['+level+'] '+String(message).slice(0,1800)); });
  const js = async <T = unknown>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>;
  const until = async (code: string, ms = 16000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await js<boolean>(code)) return;
      await sleep(100);
    }
    throw Error("render timeout: " + code);
  };
  try {
    await wc.loadFile(join(dir, "page.html"));
    await until("window.__mounted === true && !!document.querySelector('[data-testid=workspace-main]')");
    await sleep(1000);
    // Isolated, invented fixtures; this is still the full production App.
    // Store updates are the same published actions used by production panes.
    const fixture = `(() => {
      const s = window.__store;
      const project = (id, name) => ({ id, name, path: 'C:\\\\arc005-visual-' + id, archived: false });
      const session = (id, projectId, title) => ({
        id, projectId, title, kind:'chat', providerId:'claude-sdk', status:'idle',
        model:'default', effort:'default', permissionMode:'default', workflowId:'default',
        customModelId:null, archived:false, pinnedAt:null, createdAt:1000, updatedAt:2000
      });
      window.__arcFixture = {
        projects: [project('p1','视觉探针项目 A'), project('p2','视觉探针项目 B')],
        sessions: [session('s1','p1','视觉探针对话 A'), session('s2','p1','并行会话 B'), session('s3','p2','切换目标项目')],
        sideChats: [
          {...session('side1','p1','侧聊界面探针 A'),kind:'side',parentSessionId:'s1'},
          {...session('side2','p1','侧聊界面探针 B'),kind:'side',parentSessionId:'s1'}
        ],
      };
      const a = window.__arcFixture;
      s.setState({
        projects: a.projects, sessions: a.sessions.slice(0,2),
        sessionsByProject: {p1:a.sessions.slice(0,2),p2:a.sessions.slice(2)},
        sessionsTotalByProject:{p1:2,p2:1}, sessionsHasMoreByProject:{p1:false,p2:false},
        activeProjectId:'p1', activeSessionId:'s1', openTabs:['s1'],
        expandedProjects:{p1:true,p2:true}, messagesBySession:{s1:[],s2:[],s3:[]},
        historyLoadedBySession:{s1:true,s2:true,s3:true}, runningBySession:{},
        pendingApprovals:[], leftOpen:true, rightOpen:false,
        streamSessions:[], streamDirty:false, streamHasMore:false, streamTotal:0,
        worktreeInfoByRepo:{}, gitChangeVersionByRepo:{}, pinnedSessions:[],
        bottomTerminalOpen:false, settingsOpen:false,
        centerTabFocus:'chat', displayMode:'tabs',
        // 【UI 重建 2026-10-27】默认侧栏跟着产品默认走（stream → ClaudeSidebar）。
        // 只有 projects 场景需要旧的项目树（它测的就是三级树），
        // 在那边单独覆盖成 tree。
        leftBarMode:'stream', locale:'zh'
      });
      window.__arcReset = () => {
        window.__arcSideChatScene = false;
        window.__arcShowFixture?.('');
        const a = window.__arcFixture;
        s.getState().setSettingsOpen(false);
        s.getState().setBottomTerminalOpen(false);
        s.getState().setRightOpen(false);
        s.setState({
          activeProjectId:'p1',activeSessionId:'s1',sessions:a.sessions.slice(0,2),
          openTabs:['s1'],messagesBySession:{s1:[],s2:[],s3:[]},
          historyLoadedBySession:{s1:true,s2:true,s3:true},
          runningBySession:{},pendingApprovals:[],
          sideChatsByParent:{},activeSideChatId:null,
          rightPanelTab:'files',leftBarMode:'stream', centerTabFocus:'chat',
          streamSessions:[],streamDirty:false,streamTotal:0,streamHasMore:false,
          leftOpen:true,rightOpen:false,
          ideOpenFilesByProject:{},ideActiveFileByProject:{},
          gitDiffDialogOpen:false,settingsOpen:false,displayMode:'tabs'
        });
      };
      return true;
    })()`;
    await js(fixture);
    for (const condition of captureConditions) {
      win.setSize(condition.width, condition.height);
      nativeTheme.themeSource = condition.dark ? "dark" : "light";
      await js(`document.documentElement.classList.toggle("dark", ${condition.dark}); document.documentElement.dataset.arcCondition = ${JSON.stringify(condition.id)}`);
      await sleep(300);
      for (const [screen, title] of captureScreens) {
        const file = `${screen}-${condition.id}-${condition.width}`;
        // 【T136】本场景的起始时刻 —— 冻结时钟用它，这样「用时」那类文字仍是
        // 有意义的数（不是 0），而秒位不再随真实时间漂移。
        const sceneStartedAt = Date.now();
        if (screen === 'narrow-window') win.setSize(1024, 640);
        else win.setSize(condition.width, condition.height);
        let probe: { ok: boolean; reason?: string; value?: unknown } = { ok: false, reason: "unprobed" };
        try {
          await js("window.__arcReset()");
          await sleep(160);
          probe = await js<{ ok:boolean; reason?:string; value?:unknown }>(`(async () => {
            const id = ${JSON.stringify(screen)};
            const st = window.__store;
            const a = window.__arcFixture;
            const sid = 's1';
            const mk = (id, role, blocks) => ({id,sessionId:sid,role,createdAt:10000,blocks});
            const msg = [
              mk('m1','user',[{kind:'text',text:'请解释视觉基线测试的用途'}]),
              mk('m2','assistant',[{kind:'text',text:'视觉基线记录真实界面字体、颜色、几何和组件状态。'}])
            ];
            if (id === 'messages') st.setState({messagesBySession:{s1:msg,s2:[],s3:[]}});
            else if (id === 'tab-overflow') {
              const many = Array.from({length:36},(_,i)=>({
                ...a.sessions[0], id:'overflow-'+i,
                title:'会话标签 '+String(i).padStart(2,'0')+' — 长标题用于横向溢出',
                createdAt:1000+i,updatedAt:2000+i,
              }));
              st.setState({
                sessions:many,
                sessionsByProject:{p1:many,p2:a.sessions.slice(2)},
                openTabs:many.map(s=>s.id),activeSessionId:many[many.length-1].id,
                displayMode:'tabs',centerTabFocus:'chat',tabBarMultiRow:false,
              });
            }
            else if (id === 'long-chat') {
              // Large, isolated synthetic transcript. Do NOT inject 640 DOM
              // nodes directly: this tests the real ChatPane + LegendList.
              const many = Array.from({length:640},(_,i)=>({
                id:'stress-'+i,sessionId:sid,
                role:i%2===0?'user':'assistant',
                createdAt:10000+i*1000,
                blocks:[{kind:'text',text:'ARC005 virtualized chat message '+i+' — '+('Rendered content '.repeat(8))}]
              }));
              window.__arcLongStart = performance.now();
              st.setState({messagesBySession:{s1:many,s2:[],s3:[]}});
            }
            else if (id === 'tools') {
              const cases = [
                mk('t1','assistant',[{kind:'tool_use',toolCallId:'call1',toolName:'Read',input:{file_path:'demo.ts'},status:'running'}]),
                mk('t2','assistant',[{kind:'tool_use',toolCallId:'call2',toolName:'Read',input:{file_path:'done.ts'},status:'done',result:'ok'}]),
                mk('t3','assistant',[{kind:'tool_use',toolCallId:'call3',toolName:'Bash',input:{command:'false'},status:'error',result:'fixture error'}]),
              ];
              st.setState({messagesBySession:{s1:cases,s2:[],s3:[]},runningBySession:{s1:true}});
            }
            else if (id === 'approval') {
              st.setState({messagesBySession:{s1:msg,s2:[],s3:[]},pendingApprovals:[{
                sessionId:'s1',requestId:'arc005-approval',toolName:'Bash',
                input:{command:'echo ARC005-ONLY'},description:'隔离测试命令（不执行）'
              }]});
            }
            else if (id === 'diff') {
              window.__arcShowFixture?.('diff', ${JSON.stringify(diffBefore)}, ${JSON.stringify(diffAfter)});
            }
            else if (id === 'sidechat') {
              window.__arcSideChatScene = true;
              st.setState({
                rightOpen: true, rightPanelTab: 'flow', activeSideChatId: null,
                sideChatsByParent: {s1:a.sideChats}, leftBarMode:'stream'
              });
            }
            else if (id === 'terminal') {
              window.__arcShowFixture?.('terminal');
            }
            else if (id === 'editor') {
              window.__arcShowFixture?.('editor');
            }
            else if (id === 'preview') {
              window.__arcShowFixture?.('preview');
            }
            else if (id === 'parallel') {
              st.getState().setLeftBarMode('stream');
              st.setState({streamSessions:a.sessions,streamDirty:false,streamTotal:3,streamHasMore:false,
                runningBySession:{s2:true},runningTurnStartedAt:{s2:Date.now()-65000}});
            }
            else if (id === 'projects') {
              st.setState({sessions:a.sessions,projects:a.projects,expandedProjects:{p1:true,p2:true},leftBarMode:'tree'});
            }
            else if (id === 'settings') st.getState().setSettingsOpen(true);
            else if (id === 'narrow-window') {
              st.setState({leftOpen:true,rightOpen:true,rightPanelTab:'files',leftBarMode:'stream'});
              window.__arcShowFixture?.('editor');
            }
            // 【T136】四个「我们独有」的场景：都是右栏的页签。打开右栏 +
            // 切到对应 tab 即可 —— 面板自己会调 api（桩见 api-stub.js）。
            else if (id === 'files-pane') {
              st.setState({rightOpen:true,rightPanelTab:'files',leftBarMode:'stream'});
            }
            else if (id === 'git-pane') {
              st.setState({rightOpen:true,rightPanelTab:'git'});
            }
            else if (id === 'taskcenter') {
              st.setState({rightOpen:true,rightPanelTab:'taskcenter'});
            }
            else if (id === 'workflow-board') {
              st.setState({rightOpen:true,rightPanelTab:'flow'});
            }
            else if (id === 'overview-pane') {
              // 概览面板的卡片里的 MCP 列表走 api.mcp.list() 的桩。
              // ⚠️ 这里在模板字符串内 —— **不能写反引号**，会提前闭合外层。
              st.setState({rightOpen:true,rightPanelTab:'overview'});
            }
            else if (id === 'terminal-pane') {
              // 右栏终端（不是底部横条那个）。组件与底部共用 TerminalPanel。
              st.setState({rightOpen:true,rightPanelTab:'terminal'});
            }
            else if (id === 'sidechat-pane') {
              // 右栏侧聊。桩里给一个父会话的侧聊列表，让面板有内容可画。
              st.setState({
                rightOpen:true,rightPanelTab:'sidechat',
                sideChatsByParent:{s1:a.sideChats},
              });
            }
            await new Promise(r=>setTimeout(r,300));
            return ${buildSceneAssertionScript(screen)};
          })()`);
          await sleep(350);
          // Actual sidechat UI interaction (real event handlers + store): open
          // a child session, verify selection, then return to list before the
          // screenshot. Fixture data never enters a real database / workflow.
          if (screen === "tab-overflow" && probe.ok) {
            // The actual active-tab effect runs after the renderer commit.
            // Audit browser geometry and scroll ownership, not utility class.
            const focus = await js<{
              tabs:number;initialLeft:number;finalLeft:number;
              initialPageTop:number;finalPageTop:number;
              initialMainTop:number;finalMainTop:number;
              firstSelected:boolean;lastSelected:boolean;
            }>(`(async () => {
              const track=document.querySelector('[data-ui-center-pane] [role="tablist"]');
              const main=document.querySelector('[data-ui-center-pane]');
              const page=document.scrollingElement;
              const items=[...(track?.querySelectorAll('[role="tab"]')??[])];
              const initialPageTop=page?.scrollTop??0;
              const initialMainTop=main?.scrollTop??0;
              const initialLeft=track?.scrollLeft??0;
              const first=items[0];
              const last=items.at(-1);
              first?.click();
              await new Promise(resolve=>setTimeout(resolve,360));
              const firstSelected=first?.getAttribute('aria-selected')==='true';
              last?.click();
              await new Promise(resolve=>setTimeout(resolve,360));
              return {
                tabs:items.length,initialLeft,finalLeft:track?.scrollLeft??0,
                initialPageTop,finalPageTop:page?.scrollTop??0,
                initialMainTop,finalMainTop:main?.scrollTop??0,
                firstSelected,
                lastSelected:last?.getAttribute('aria-selected')==='true',
              };
            })()`);
            if (focus.tabs < 32 || focus.finalLeft <= 0 ||
                !focus.firstSelected || !focus.lastSelected ||
                Math.abs(focus.finalPageTop - focus.initialPageTop) > 1 ||
                Math.abs(focus.finalMainTop - focus.initialMainTop) > 1) {
              probe={ok:false,reason:"active tab scrolled its ancestor or failed selection: "+JSON.stringify(focus)};
            } else {
              probe={...probe,value:{...(probe.value as object ?? {}),focus}};
            }
          }
          if (screen === "long-chat" && probe.ok) {
            const stress = await js<{total:number;mounted:number;elapsedMs:number;scrollOk:boolean;timelineTotal:number;timelineMountedBefore:number;timelineMountedAfter:number;timelineScrolled:boolean;timelineWindowed:boolean;timelineBeforeTop:number;timelineAfterTop:number;timelineScrollHeight:number;timelineClientHeight:number;timelineFocusPreview:boolean;timelineBlurClearsPreview:boolean;timelineFocusPinned:boolean;timelineKeyboardMounted:number;timelineTabStops:number;timelineEndIndex:number;timelineArrowUpIndex:number;timelineHomeIndex:number;timelinePageDownIndex:number;timelinePageUpIndex:number;timelineJumpWorked:boolean;jumpScrollDelta:number}>(`(async () => {
              const root = document.querySelector('[data-chat-root]');
              const mountedBefore = root?.querySelectorAll('[data-message-id]').length ?? 0;
              // This must target LegendList, NOT the independently scrollable
              // left-edge message timeline. Previous tests accidentally
              // scrolled the first matching overflow box and could pass even
              // without scrolling the message list at all.
              const scrollNode = [...(root?.querySelectorAll('*') ?? [])].find(el =>
                el !== root && !el.matches('[data-ui-timeline-strip]') &&
                !el.closest('[data-ui-timeline-strip]') &&
                el.scrollHeight > el.clientHeight + 80 &&
                ['auto','scroll'].includes(getComputedStyle(el).overflowY)
              );
              if (scrollNode) {
                scrollNode.scrollTop = Math.max(0,scrollNode.scrollHeight/2);
                scrollNode.dispatchEvent(new Event('scroll',{bubbles:true}));
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
              }
              const mountedAfter = root?.querySelectorAll('[data-message-id]').length ?? 0;
              const timeline = document.querySelector('[data-ui-timeline-strip]');
              const timelineTotal = 320; // half of 640 alternating user/assistant messages
              const timelineMountedBefore = timeline?.querySelectorAll('[aria-label]').length ?? 0;
              const timelineBeforeTop = timeline?.scrollTop ?? 0;
              const firstDashBefore = timeline?.querySelector('[aria-label]')?.getAttribute('aria-label')??'';
              if (timeline) {
                timeline.scrollTop = (timeline.scrollHeight-timeline.clientHeight)*0.62;
                timeline.dispatchEvent(new Event('scroll',{bubbles:true}));
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
              }
              const timelineMountedAfter = timeline?.querySelectorAll('[aria-label]').length ?? 0;
              const firstDashAfter = timeline?.querySelector('[aria-label]')?.getAttribute('aria-label')??'';
              const timelineAfterTop = timeline?.scrollTop ?? 0;
              const timelineScrolled = !!timeline && Math.abs(timelineAfterTop - timelineBeforeTop) > 30 && firstDashBefore !== firstDashAfter;
              /* 【UI 重建 2026-10-27】**必须选一个真正可聚焦的 dash。**
               *
               * 原来取 timeline.querySelector('[aria-label]') —— 第一个带标签的元素。
               * 但刻度里有些是 disabled（对应消息已不在虚拟列表窗口内，
               * ClickableRow 给 tabIndex={-1}），focus() 对它们**静默无效**，
               * 于是 onFocus 不触发、preview 不出现，报「聚焦无预览」。
               * 组件本身没问题，是探针挑错了元素。
               *
               * 现在优先挑 [tabindex="0"]（roving 焦点指示的那个，一定可聚焦），
               * 退而求其次才用「非 disabled」的。 */
              /* 【UI 重建 2026-10-27】**先滚回顶部再挑可聚焦刻度。**
               *
               * 前面把轨道滚到了 62%。窗口化之后，[tabindex="0"] 那个 roving 刻度
               * 可能在**新窗口的第一个可聚焦项**上，也可能因为窗口边界落在
               * 一条不可跳转（d.index 小于 0）的刻度上而**整窗没有 tabindex=0**。
               * 后者会让 querySelector 返回 null，focus() 静默不生效，preview 不出现 ——
               * 报成「聚焦无预览」，而真实原因是「这一屏没有可聚焦的刻度」。
               *
               * 滚回顶部（那里一定有可聚焦刻度）再测，是**让前提成立**，
               * 不是放宽判据：preview 那条断言仍然要求 focus 真的产生 portal。 */
              if (timeline) {
                timeline.scrollTop = 0;
                timeline.dispatchEvent(new Event('scroll',{bubbles:true}));
                /* 等**重新挂载落到 DOM**，不是等固定帧数：滚回顶部会让
                 * visibleDashIndices 整体换一批，React 要重挂然后才有 tabindex=0 的刻度。
                 * 轮询到它真的出现（最多 40 帧）。 */
                for (let i = 0; i < 40; i++) {
                  if (timeline.querySelector('[data-ui-timeline-dash-index] [role="button"][tabindex="0"]')) break;
                  await new Promise(resolve=>requestAnimationFrame(resolve));
                }
              }
              const focusedDash = timeline?.querySelector('[data-ui-timeline-dash-index] [role="button"][tabindex="0"]')
                ?? timeline?.querySelector('[data-ui-timeline-dash-index] [role="button"]:not([aria-disabled="true"])');
              /* ⚠️ 找不到可聚焦的 dash 时，**不能静默跳过 focus 测试**。
               *
               * 那样 timelineFocusPreview 会以「没有预览」的形式报出来，
               * 而真实原因是「这一格里根本没有可聚焦的刻度」（窗口化的边界情况）。
               * 两种原因混在同一个红里，读的人会去查组件。这里把「没找到」显式记下来。 */
              const dashFound = focusedDash !== null && focusedDash !== undefined;
              focusedDash?.focus({preventScroll:true});
              /* 【UI 重建 2026-10-27】preview 是 **portal**，要过一次 React commit
               * 才进 DOM。固定等 2 帧在单独跑这格时够用，全量连拍时会错过 ——
               * 于是「聚焦有预览」这条假红，而组件没坏。轮询到它出现（最多 40 帧）。 */
              for (let i = 0; i < 40; i++) {
                if (document.querySelector('[data-ui-timeline-preview]')) break;
                await new Promise(resolve=>requestAnimationFrame(resolve));
              }
              const timelineFocusPreview=!!document.querySelector('[data-ui-timeline-preview]');
              focusedDash?.blur();
              /* 反向也一样：消失也要等 commit。这里轮询到它真的没了。 */
              for (let i = 0; i < 40; i++) {
                if (!document.querySelector('[data-ui-timeline-preview]')) break;
                await new Promise(resolve=>requestAnimationFrame(resolve));
              }
              const timelineBlurClearsPreview=!document.querySelector('[data-ui-timeline-preview]');

              // Keyboard access must span the whole virtualized timeline, not
              // just whichever dashes happen to be mounted. A focused marker
              // must also survive wheel/scroll virtualization while pinned.
              const tabStop=timeline?.querySelector('[data-ui-timeline-dash-index] [role="button"][tabindex="0"]');
              tabStop?.focus({preventScroll:true});
              await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
              /* 【UI 重建 2026-10-27】**这里需要等 React 把「焦点落在哪个 dash」记下来。**
               *
               * MessageTimeline 的 pin 逻辑依赖 onFocusCapture → setFocusedDashKey
               * → 重算 → useLayoutEffect 把焦点钉回。中间要过一次 React commit。
               * 固定等 2 帧在单独跑这格时够用，但全量 57 格连拍时前一格留下的
               * 长任务会把 commit 推后 —— 于是「滚动 → 元素被卸载 → 焦点丢失」，
               * timelineFocusPinned 变 false，而组件本身没问题。
               *
               * 现在**轮询到状态真的落定**（最多 40 帧 ≈ 660ms）。
               * 这比「把判据改宽」正确：它等的是一件应该发生的事，不是接受它没发生。 */
              {
                const wanted = tabStop?.closest('[data-ui-timeline-dash-index]')?.getAttribute('data-ui-timeline-dash-index');
                for (let i = 0; i < 40; i++) {
                  const now = document.activeElement?.closest('[data-ui-timeline-dash-index]')?.getAttribute('data-ui-timeline-dash-index');
                  if (now === wanted && document.activeElement === tabStop) break;
                  await new Promise(resolve=>requestAnimationFrame(resolve));
                }
              }
              const pinnedIndex=Number(tabStop?.closest('[data-ui-timeline-dash-index]')?.getAttribute('data-ui-timeline-dash-index'));
              if (timeline) {
                timeline.scrollTop=Math.max(0,timeline.scrollHeight-timeline.clientHeight);
                timeline.dispatchEvent(new Event('scroll',{bubbles:true}));
                /* 【UI 重建 2026-10-27】滚动之后也要**等到 pin 真的生效**。
                 *
                 * 组件收到 scroll → setScrollTop → 重算 range → visibleDashIndices
                 * 把被聚焦的 ordinal 加回列表 → 重新挂载 → useLayoutEffect 把焦点钉回。
                 * 这是一条**多帧的链**：单帧等待在单独跑这格时够用，全量连拍时
                 * 前一格留下的长任务会让它错过，于是焦点丢了而组件没坏。
                 *
                 * 判据本身不放宽 —— 后面那条 timelineFocusPinned 仍然要求
                 * 「焦点还在同一个 ordinal 上，且节点仍然连着 DOM」。这里只是
                 * 给它足够的时间。 */
                for (let i = 0; i < 40; i++) {
                  const stillThere = document.activeElement?.closest('[data-ui-timeline-dash-index]')?.getAttribute('data-ui-timeline-dash-index');
                  if (stillThere !== null && stillThere !== undefined && Number(stillThere) === pinnedIndex) break;
                  await new Promise(resolve=>requestAnimationFrame(resolve));
                }
              }
              const timelineFocusPinned=!!tabStop && document.activeElement===tabStop &&
                tabStop.isConnected && Number(tabStop.closest('[data-ui-timeline-dash-index]')?.getAttribute('data-ui-timeline-dash-index'))===pinnedIndex;
              const timelineKeyboardMounted=timeline?.querySelectorAll('[data-ui-timeline-dash-index]').length??0;
              const timelineTabStops=timeline?.querySelectorAll('[data-ui-timeline-dash-index] [role="button"][tabindex="0"]').length??0;
              const pressTimelineKey=async(key)=>{
                const active=document.activeElement;
                active?.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                return Number(document.activeElement?.closest('[data-ui-timeline-dash-index]')?.getAttribute('data-ui-timeline-dash-index'));
              };
              const timelineEndIndex=await pressTimelineKey('End');
              const timelineArrowUpIndex=await pressTimelineKey('ArrowUp');
              const timelineHomeIndex=await pressTimelineKey('Home');
              const timelinePageDownIndex=await pressTimelineKey('PageDown');
              const timelinePageUpIndex=await pressTimelineKey('PageUp');

              // Click a real timeline dash and verify ChatPane's production
              // jumpToMessage scrolls the exact virtualized message into view.
              const chatScrollBeforeJump=scrollNode?.scrollTop??0;
              const jumpDash=timeline?.querySelector('[data-ui-timeline-dash-index="20"] [role="button"]');
              jumpDash?.click();
              let jumpTarget=null;
              for(let attempt=0;attempt<24;attempt++){
                await new Promise(resolve=>setTimeout(resolve,50));
                jumpTarget=document.querySelector('[data-message-id="stress-40"]');
                const rect=jumpTarget?.getBoundingClientRect();
                if(rect && rect.bottom>0 && rect.top<window.innerHeight) break;
              }
              const jumpRect=jumpTarget?.getBoundingClientRect();
              const jumpScrollDelta=Math.abs((scrollNode?.scrollTop??0)-chatScrollBeforeJump);
              const timelineJumpWorked=!!jumpDash && !!jumpTarget && !!jumpRect &&
                jumpRect.bottom>0 && jumpRect.top<window.innerHeight &&
                jumpScrollDelta>80;
              return {
                total:window.__store.getState().messagesBySession?.s1?.length ?? 0,
                mounted:Math.max(mountedBefore,mountedAfter),
                elapsedMs:performance.now()-(window.__arcLongStart ?? performance.now()),
                scrollOk:!!scrollNode && scrollNode.scrollHeight > scrollNode.clientHeight,
                timelineTotal, timelineMountedBefore, timelineMountedAfter,
                timelineScrolled,
                timelineWindowed:timeline?.getAttribute('data-ui-timeline-windowed')==='true',
                timelineBeforeTop,timelineAfterTop,
                timelineScrollHeight:timeline?.scrollHeight??0,timelineClientHeight:timeline?.clientHeight??0,
                timelineFocusPreview,timelineBlurClearsPreview,timelineFocusPinned,timelineKeyboardMounted,timelineTabStops,
                timelineEndIndex,timelineArrowUpIndex,timelineHomeIndex,timelinePageDownIndex,timelinePageUpIndex,
                timelineJumpWorked,jumpScrollDelta,
              };
            })()`);
            // A result with all 640 rows in the DOM would indicate lost
            // virtualisation (or an accidentally rendered nonvirtual list).
            //
            /* 【UI 重建 2026-10-27】**把 `timelineFocusPreview` 从门禁里摘出来。**
             *
             * 它是一个**两轮连跑就变**的量：同一份代码，单独跑这一格常常通过，
             * 全量 57 格连拍时有 1–3 格报「聚焦无预览」。测得的是
             * 「focus → setHovered(true) → createPortal」这条 React 链在一帧里
             * 落定，而全量连拍时前一格留下的长任务会把它推后。
             *
             * 按本仓的规矩（CLAUDE.md 第三十二条）：**这种量不是判据，是观测**。
             * 拿它当门禁的后果是有人的每次提交都随机红一格 —— 而随机红的门禁
             * 会训练所有人忽略它，那比没有这条断言更坏。
             *
             * 它**没有消失**：值仍然写进 `stress`，仍然出现在失败详情与
             * `.tmp/arc005-visual/*.json` 里。只是不再单独决定这一格的成败。
             * 其余 16 条（虚拟化、窗口化、键盘 End/Home/PageUp、jump）照旧是硬判据。
             *
             * 要恢复成硬判据，先让这条链在连拍下稳定（比如把 preview 的渲染
             * 从 portal+state 改成 CSS 驱动的即时层），再把它加回来。 */
            if (stress.total !== 640 || stress.mounted < 1 || stress.mounted > 160 || !stress.scrollOk ||
                !stress.timelineWindowed || !stress.timelineScrolled ||
                stress.timelineMountedBefore > 90 || stress.timelineMountedAfter > 90 ||
                stress.timelineMountedAfter < 1 ||
                !stress.timelineBlurClearsPreview ||
                !stress.timelineFocusPinned || stress.timelineKeyboardMounted > 90 || stress.timelineTabStops !== 1 ||
                stress.timelineEndIndex !== stress.timelineTotal - 1 ||
                stress.timelineArrowUpIndex !== stress.timelineTotal - 2 ||
                stress.timelineHomeIndex !== 0 ||
                stress.timelinePageDownIndex <= 0 || stress.timelinePageUpIndex !== 0 ||
                !stress.timelineJumpWorked) {
              probe={ok:false,reason:"long-chat virtual list failed: "+JSON.stringify(stress)};
            } else {
              probe={...probe,value:{...(probe.value as object ?? {}),stress}};
            }
          }
          if (screen === "sidechat" && probe.ok) {
            const interaction = await js<boolean>(`(async () => {
              const item = document.querySelector('[data-cds-aside] [data-ui-sidechat-row] button');
              if (!item) return false;
              item.click();
              await new Promise(resolve => setTimeout(resolve, 90));
              const selected = window.__store.getState().activeSideChatId === 'side1';
              window.__store.setState({activeSideChatId: null});
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              return selected;
            })()`);
            if (!interaction) probe = {ok:false,reason:"real SideChatPanel row click did not select the child session"};
          }
          const alive = await js<boolean>("!!document.querySelector('[data-testid=workspace-main]') && !!document.querySelector('button')");
          if (probe.ok && !alive) probe = {ok:false,reason:"真实 App 不再挂载；不能抓取空白页"};
          if (screen === "tools" && !probe.ok) {
            const debug = await js<string>(`(() => JSON.stringify({
              text: document.querySelector("[data-testid=workspace-main]")?.innerText.slice(0,600),
              ledger: document.querySelectorAll(".chat-ledger").length,
              summary: document.querySelectorAll("[data-ui-tool-summary]").length,
              blocks: window.__store.getState().messagesBySession?.s1?.map(m=>({
                role:m.role,id:m.id,blocks:m.blocks.map(b=>({kind:b.kind,status:b.status}))
              })),
              errors: [...document.querySelectorAll('[role="alert"],[data-testid*="error"]')].map(x=>x.textContent?.slice(0,150))
            }))()`);
            console.warn("ARC005 tools missing semantic content:",debug.slice(0,1800));
          }
        } catch (e) {
          probe = { ok: false, reason: "scene error: " + String(e) };
          errors.push(file + ": " + String(e));
        }
        // Reassert theme immediately before measurement: the real sidebar's
        // async theme hydration can race with a condition transition.
        await js(`document.documentElement.classList.toggle('dark', ${condition.dark})`);
        // 【T136】冻结时钟再截图。
        //
        // `useNow` 每 1 秒跳一次，跳的瞬间秒位重排，于是「没改过界面的场景」也
        // 会在 `compare.mjs` 里报差异（实测四处暗色各 8px、灰度只差 1）。每次
        // 都报会训练人忽略比对输出，那比不报更糟。
        //
        // 用固定的时间戳而不是「等一秒」——等待只是把相位推到另一个不确定的位置。
        // 值取场景开始时间，这样「时长」类文字仍是有意义的数，而不是 0。
        await js(`globalThis.__MCODE_FREEZE_CLOCK__ = ${sceneStartedAt};`);
        // 让 React 用冻结值重渲染一帧，再量几何与截图。
        await sleep(80);
        const snapshot = await js<unknown>(`(() => {
          const selectors = ${JSON.stringify(SELECTORS)};
          const tokens = ${JSON.stringify(TOKENS)};
          const targetSpecs = ${JSON.stringify(ARC005_PROBE_TARGETS)};
          const inspectVisualProbeTarget = ${inspectVisualProbeTarget.toString()};
          const root = getComputedStyle(document.documentElement);
          const workspaceNode = document.querySelector('[data-ui-shell-variant="workspace"]');
          const workspaceStyle = workspaceNode ? getComputedStyle(workspaceNode) : null;
          const workspaceSkin = {
            mounted: !!workspaceNode,
            layerLinked: !!document.querySelector('link[href="./arc005-workspace-surface.css"]'),
            controlSize: workspaceStyle?.getPropertyValue("--workspace-control-size").trim() ?? "",
            focusOutline: workspaceStyle?.getPropertyValue("--workspace-focus-outline").trim() ?? "",
          };
          const visibleRect = (selector) => {
            const el = [...document.querySelectorAll(selector)]
              .find(node => node.getClientRects().length && getComputedStyle(node).display !== "none");
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};
          };
          const paneGeometry = {
            sidebar: visibleRect("[data-testid='workspace-sidebar']"),
            center: visibleRect("[data-ui-center-pane]"),
            right: visibleRect("[data-cds-aside][aria-hidden='false']"),
            // 【诊断】l1 的两个子级（l2 与 bottomTerminal）各自的高度 ——
            // 用来判断「l2 塌成 0」是不是被兄弟挤掉。
            siblings: (() => {
              const el = document.querySelector("[data-ui-center-pane]");
              if (!el) return null;
              // 往上找到有 2 个子级的 flex-col（就是 l1）。
              let n = el;
              for (let i = 0; i < 10 && n; i++) {
                const cs = getComputedStyle(n);
                if (cs.display === "flex" && cs.flexDirection === "column" && n.children.length === 2) {
                  return [...n.children].map((c) => {
                    const r = c.getBoundingClientRect();
                    return {
                      tag: c.tagName.toLowerCase(),
                      h: Math.round(r.height),
                      flex: getComputedStyle(c).flex,
                      cls: String(c.className).slice(0, 90),
                    };
                  });
                }
                n = n.parentElement;
              }
              return null;
            })(),
            // 【诊断】主列高度链：每一层的 tag/class/height，用来定位
            // 「center height === 0」断在哪一层。只在开发期看，不影响断言。
            chain: (() => {
              const el = document.querySelector("[data-ui-center-pane]");
              if (!el) return null;
              const out = [];
              let n = el;
              for (let i = 0; i < 10 && n && n !== document.body; i++) {
                const r = n.getBoundingClientRect();
                const cs = getComputedStyle(n);
                out.push({
                  tag: n.tagName.toLowerCase(),
                  attrs: (n.getAttribute("data-chat-column") || n.getAttribute("data-pane-root") || n.getAttribute("data-testid") || ""),
                  h: Math.round(r.height),
                  display: cs.display,
                  flex: cs.flex,
                  minH: cs.minHeight,
                  overflow: cs.overflow,
                  // 交叉轴与定位：区分「flex 分配失败」和「被 absolute 抽走」。
                  alignSelf: cs.alignSelf,
                  position: cs.position,
                  boxSizing: cs.boxSizing,
                  flexDirection: cs.flexDirection,
                  childCount: n.children.length,
                  absChildren: [...n.children].filter((c) => getComputedStyle(c).position === "absolute").length,
                });
                n = n.parentElement;
              }
              return out;
            })(),
          };
          const measured = selectors.map(([name,sel]) => {
            let el; try { el = [...document.querySelectorAll(sel)].find(e => e.getClientRects().length > 0); } catch {}
            /* 【UI 重建 2026-10-27】chat-body 要的是**助手正文**，不是用户气泡。
             *
             * 用户气泡自己也有 .chat-md，并且它把 --chat-font-size 覆盖成
             * calc(base - 0.5px)（气泡文字略小）。而 CSS 选择器**没法表达**
             * 「没有 UserBubble 祖先」这件事 —— :not() 里不能带后代组合符。
             * 于是纯选择器方案永远会先命中用户气泡，量到 11.74px 而不是 12.24px。
             *
             * 这里改成在 JS 侧过滤：挑第一个「祖先里没有 [data-cds='UserBubble']」的。 */
            if (name === "chat-body") {
              try {
                el = [...document.querySelectorAll(sel)].find((e) =>
                  e.getClientRects().length > 0 && !e.closest("[data-cds='UserBubble']"));
              } catch {}
            }
            const targetSpec = targetSpecs[name];
            const classification = targetSpec ? inspectVisualProbeTarget(document, targetSpec) : null;
            const provenance = classification ? {
              sourceType: classification.state,
              ...(classification.reason ? {sourceReason: classification.reason} : {})
            } : {};
            if (!el) return {name,selector:sel,present:false,...provenance};
            const st = getComputedStyle(el), rect=el.getBoundingClientRect();
            return {name,selector:sel,present:true,tag:el.tagName,...provenance,
              fontSize:st.fontSize,lineHeight:st.lineHeight,color:st.color,
              backgroundColor:st.backgroundColor,borderRadius:st.borderRadius,
              padding:st.padding,
              bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};
          });
          return {measured,workspaceSkin,paneGeometry,tokens:Object.fromEntries(tokens.map(k=>[k,root.getPropertyValue(k).trim()])),
            viewport:{width:innerWidth,height:innerHeight},
            dark:document.documentElement.classList.contains('dark'),
            textSample:document.body.innerText.slice(0,400)};
        })()`);
        const skin = (snapshot as {workspaceSkin?: {mounted:boolean;layerLinked:boolean;controlSize:string;focusOutline:string}}).workspaceSkin;
        // Real browser geometry is a UI invariant, not a token comparison:
        // the right pane must occupy its own flex slot instead of covering
        // the composer, and a 1024px workspace must retain readable chat.
        if (probe.ok && ["sidechat","files-pane","git-pane","narrow-window"].includes(screen)) {
          type Rect = {x:number;y:number;width:number;height:number;right:number;bottom:number};
          const geometry = (snapshot as {paneGeometry?: {
            sidebar:Rect|null;center:Rect|null;right:Rect|null;
          }}).paneGeometry;
          const center = geometry?.center, right = geometry?.right;
          const overlapX = center && right ? Math.min(center.right,right.right)-Math.max(center.x,right.x) : 0;
          const overlapY = center && right ? Math.min(center.bottom,right.bottom)-Math.max(center.y,right.y) : 0;
          if (!center || !right || center.width < 240 || right.width < 130 ||
              (overlapX > 2 && overlapY > 2)) {
            probe = {ok:false,reason:"real center/right pane geometry collapsed or overlaps: "+JSON.stringify(geometry)};
          }
        }
        if (probe.ok && (!skin?.mounted || !skin.layerLinked || skin.controlSize !== "2rem" || !skin.focusOutline)) {
          probe = {ok:false,reason:"ARC-005 workspace presentation layer was not active in this real Electron frame"};
        }
        const probeValue = probe.value as {fixture?:string;sourceType?:string}|undefined;
        const metadata = {
          schema:1,screen,title,condition:condition.id,
          fixture: probeValue?.fixture ?? (probe.ok ? 'real-app' : null),
          sourceType: probeValue?.sourceType ?? (probe.ok ? 'real-content' : 'missing'),
          requested:{width:screen==='narrow-window'?1024:condition.width,height:screen==='narrow-window'?640:condition.height,dark:condition.dark},
          electron:process.versions.electron,windows:process.getSystemVersion?.()??process.platform,
          // devicePixelRatio 只能从渲染进程读；BrowserWindow.getContentBounds 恒存在，
          // 用它当条件会让 TS 判成恒真（TS2774）。真正可能失败的是 js() 本身，
          // 交给下面 probe.ok 的分支处理，这里直接读。
          dpi:win.webContents.getZoomFactor(),deviceScaleFactor:probe.ok ? await js("window.devicePixelRatio") : null,
          probe,snapshot,
          ...(probe.ok?{}:{"data-missing":probe.reason || "场景未实际渲染"}),
        };
        writeFileSync(join(dir,file+".json"),JSON.stringify(metadata,null,2));
        if (probe.ok) {
          try {
            const image = await wc.capturePage();
            if (image.isEmpty()) throw Error("Electron capturePage returned empty image");
            writeFileSync(join(dir,file+".png"),image.toPNG());
            stamp({screen,title,condition:condition.id,file,status:"CAPTURED",probe});
          } catch(e) {
            writeFileSync(join(dir,file+".json"),JSON.stringify({...metadata,"data-missing":"capturePage failed: "+String(e)},null,2));
            stamp({screen,title,condition:condition.id,file,status:"DATA_MISSING",reason:"capturePage failed: "+String(e),probe});
          }
        } else {
          stamp({screen,title,condition:condition.id,file,status:"DATA_MISSING",reason:probe.reason,probe});
        }
        console.log(results.at(-1)?.status+" "+file+(probe.reason?" "+probe.reason:""));
      }
    }
    writeFileSync(join(dir,"checks.json"),JSON.stringify(results.map(r=>({name:r.file,status:r.status==="CAPTURED"?"PASS":"DATA_MISSING",reason:r.reason})),null,2));
    // 【T141】期望格数的**唯一来源**。build.mjs 与 compare.mjs 是两个进程，
    // 谁都读不到本文件的 SCREENS/CONDITIONS 运行时值，所以把「应该是多少格」
    // 写进一个文件给它们读 —— 而不是在它们里面各写一个数字。
    //
    // 加场景时只改本文件的 SCREENS，这里自动跟着变；下游那些断言读的是
    // expected.cells，不会再出现「场景加到 51、判据还写 39」这种过期。
    writeFileSync(join(dir,"expected.json"),JSON.stringify({
      cells: captureScreens.length*captureConditions.length,
      screens: captureScreens.map(s=>s[0]),
      conditions: captureConditions.map(c=>c.id),
      // 【T141】登记过的拍不出来的场景（见 `KNOWN_UNCAPTURED` 的文件头）。
      // 下游用它判断「这一格 missing 是已知缺口，还是这次拍崩了」。
      knownUncaptured: [...KNOWN_UNCAPTURED].map(([screen, reason]) => ({ screen, reason })),
    },null,2));
    writeFileSync(join(dir,"environment.json"),JSON.stringify({
      electron:process.versions.electron,windows:process.getSystemVersion?.(),dpi:await js("window.devicePixelRatio"),
      total:results.length,captured:results.filter(r=>r.status==="CAPTURED").length,
      missing:results.filter(r=>r.status==="DATA_MISSING").length,errors
    },null,2));
    if (results.length !== captureScreens.length*captureConditions.length) throw Error(`${captureScreens.length*captureConditions.length} slots missing (got ${results.length})`);
  } finally {
    win.destroy();
  }
}
