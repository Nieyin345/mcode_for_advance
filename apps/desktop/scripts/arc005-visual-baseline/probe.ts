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
] as const;
const CONDITIONS = [
  { id: "light", width: 1280, height: 800, dark: false },
  { id: "dark", width: 1280, height: 800, dark: true },
  { id: "narrow", width: 1024, height: 640, dark: false },
] as const;
// Optional targeted U1 run for rapid UI iteration. Default remains the full
// 17 × 3 real-Electron evidence matrix. Unknown screen IDs are rejected.
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
const KNOWN_UNCAPTURED = new Map<string, string>();
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
        centerTabFocus:'chat', displayMode:'tabs', leftBarMode:'tree', locale:'zh'
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
          rightPanelTab:'files',leftBarMode:'tree', centerTabFocus:'chat',
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
                sideChatsByParent: {s1:a.sideChats}, leftBarMode:'tree'
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
              st.setState({leftOpen:true,rightOpen:true,rightPanelTab:'files',leftBarMode:'tree'});
              window.__arcShowFixture?.('editor');
            }
            // 【T136】四个「我们独有」的场景：都是右栏的页签。打开右栏 +
            // 切到对应 tab 即可 —— 面板自己会调 api（桩见 api-stub.js）。
            else if (id === 'files-pane') {
              st.setState({rightOpen:true,rightPanelTab:'files',leftBarMode:'tree'});
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
            await new Promise(r=>setTimeout(r,300));
            return ${buildSceneAssertionScript(screen)};
          })()`);
          await sleep(350);
          // Actual sidechat UI interaction (real event handlers + store): open
          // a child session, verify selection, then return to list before the
          // screenshot. Fixture data never enters a real database / workflow.
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
          };
          const measured = selectors.map(([name,sel]) => {
            let el; try { el = [...document.querySelectorAll(sel)].find(e => e.getClientRects().length > 0); } catch {}
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
