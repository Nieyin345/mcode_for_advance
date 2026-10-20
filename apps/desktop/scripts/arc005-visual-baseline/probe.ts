/**
 * T01 / ARC-005 U1. Real App + real Electron capturePage; fixtures go through
 * the real Zustand store, never by fabricating DOM or generated screenshots.
 * Screens requiring unavailable live services are recorded as data-missing.
 */
import { BrowserWindow, nativeTheme, ipcMain, app } from "electron";
import { join } from "node:path";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const SCREENS = [
  ["empty", "初始空会话"], ["messages", "已有消息"],
  ["tools", "工具运行中/完成/失败"], ["approval", "权限审批"],
  ["diff", "代码/文件 Diff"], ["sidechat", "侧聊"],
  ["terminal", "终端"], ["editor", "文件编辑"],
  ["preview", "预览"], ["parallel", "并行会话侧栏"],
  ["projects", "项目切换"], ["settings", "设置菜单"],
  ["narrow-window", "窗口缩窄"],
] as const;
const CONDITIONS = [
  { id: "light", width: 1280, height: 800, dark: false },
  { id: "dark", width: 1280, height: 800, dark: true },
  { id: "narrow", width: 1024, height: 640, dark: false },
] as const;
const SELECTORS: ReadonlyArray<[string, string]> = [
  ["titlebar", "[data-testid='titlebar'], header"],
  ["sidebar", "[data-testid='workspace-sidebar']"],
  ["sidebar-row", "[data-testid='workspace-sidebar'] button"],
  ["main", "[data-testid='workspace-main']"],
  ["message", "[data-testid='workspace-main'] .prose, [data-testid='workspace-main'] [data-message-id]"],
  ["tool-row", "[data-testid='workspace-main'] [data-tool-id], [data-testid='workspace-main'] [data-testid*='tool']"],
  ["composer", "[data-testid='workspace-main'] textarea"],
  ["approval", "[role='alertdialog']"],
  ["card", "[data-testid='workspace-main'] [class*='rounded']"],
  ["button", "button"],
  ["panel", "[data-testid='workspace-sidebar'], [data-testid='right-panel']"],
  ["settings", ".settings-root"],
  ["terminal", ".xterm, [data-testid='bottom-terminal-bar']"],
  ["editor", ".monaco-editor"],
  ["preview", "[data-testid='arc005-real-markdown'], [data-testid*='preview'], [class*='pdf-preview']"],
  ["fixture", "[data-testid='arc005-fixture-panel']"],
];
const TOKENS = [
 "--surface", "--surface-muted", "--surface-hover", "--content",
 "--content-muted", "--content-subtle", "--edge", "--panel-edge",
 "--radius-panel", "--composer-radius", "--radius-bubble", "--radius-control",
 "--radius-btn-xs", "--radius-btn-md", "--radius-dialog", "--radius-code",
 "--dur-fast", "--dur-snap", "--dur-base", "--dur-sheet", "--dur-slow",
 "--ease-out", "--ease-snap", "--ease-overshoot", "--spring-btn",
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
    for (const condition of CONDITIONS) {
      win.setSize(condition.width, condition.height);
      nativeTheme.themeSource = condition.dark ? "dark" : "light";
      await js(`document.documentElement.classList.toggle("dark", ${condition.dark}); document.documentElement.dataset.arcCondition = ${JSON.stringify(condition.id)}`);
      await sleep(300);
      for (const [screen, title] of SCREENS) {
        const file = `${screen}-${condition.id}-${condition.width}`;
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
            const result = (ok,reason,value) => ({ok,reason:ok?undefined:reason,value});
            if (id === 'empty') return result(true,undefined,0);
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
              window.__arcShowFixture?.('sidechat');
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
            await new Promise(r=>setTimeout(r,300));
            const q = (sel) => !![...document.querySelectorAll(sel)].find(e=>e.getClientRects().length);
            if (['diff','terminal','editor','preview','sidechat'].includes(id)) {
              const panel = document.querySelector('[data-testid="arc005-fixture-panel"]');
              const kind = panel?.getAttribute('data-arc-fixture');
              const present = !!panel && panel.getBoundingClientRect().width > 0;
              const healthy = id === 'diff' ? !!document.querySelector('.diff-add') && !!document.querySelector('.diff-del')
                : id === 'preview' ? !!document.querySelector('[data-testid="arc005-real-markdown"] strong')
                : id === 'terminal' ? !!document.querySelector('[data-testid="arc005-static-terminal"]')
                : id === 'editor' ? !!document.querySelector('[data-testid="arc005-stub-editor"] code')
                : !!document.querySelector('[data-testid="arc005-sidechat-partial"]');
              return result(present && healthy, '指定面板没有渲染出验证节点', {fixture:kind});
            }
            if (id === 'projects') return result(document.body.textContent.includes('视觉探针项目 A') && document.body.textContent.includes('视觉探针项目 B'), '真实项目树没有两个项目', {fixture:'real-LeftBar'});
            if (id === 'parallel') return result(document.body.textContent.includes('并行会话 B') && document.body.textContent.includes('切换目标项目'), '真实流式侧栏没有多会话行', {fixture:'real-StreamSidebar'});
            if (id === 'narrow-window') return result(innerWidth <= 1024 && !!document.querySelector('[data-testid="arc005-stub-editor"]'), '组合窄窗未达到 1024px 或编辑器桩未出现', {fixture:'stub-editor+real-layout',width:innerWidth});
            if (id === 'messages') return result(document.body.textContent.includes('视觉基线记录真实界面'), '消息正文未出现在真实 App');
            if (id === 'tools') return result(q('[data-tool-id],[data-testid*="tool"],[class*="tool-card"]'), '工具卡 DOM 未出现在真实 App');
            if (id === 'approval') return result(q('[role="alertdialog"]'), '审批卡没有出现');
            if (id === 'sidechat') return result(q('[data-testid*="side-chat"],[class*="side-chat"]'), '右侧聊组件 DOM 未出现');
            if (id === 'terminal') return result(q('.xterm,[data-testid="bottom-terminal-bar"]'), '终端真实组件 DOM 未出现');
            if (id === 'parallel') return result(q('[data-testid="stream-sidebar"]'), '流式侧栏真实组件未出现');
            if (id === 'settings') return result(q('.settings-root'), '设置层未出现');
            return result(false,'未知场景');
          })()`);
          await sleep(350);
          const alive = await js<boolean>("!!document.querySelector('[data-testid=workspace-main]') && !!document.querySelector('button')");
          if (probe.ok && !alive) probe = {ok:false,reason:"真实 App 不再挂载；不能抓取空白页"};
        } catch (e) {
          probe = { ok: false, reason: "scene error: " + String(e) };
          errors.push(file + ": " + String(e));
        }
        // Reassert theme immediately before measurement: the real sidebar's
        // async theme hydration can race with a condition transition.
        await js(`document.documentElement.classList.toggle('dark', ${condition.dark})`);
        const snapshot = await js<unknown>(`(() => {
          const selectors = ${JSON.stringify(SELECTORS)};
          const tokens = ${JSON.stringify(TOKENS)};
          const root = getComputedStyle(document.documentElement);
          const measured = selectors.map(([name,sel]) => {
            let el; try { el = [...document.querySelectorAll(sel)].find(e => e.getClientRects().length > 0); } catch {}
            if (!el) return {name,selector:sel,present:false};
            const st = getComputedStyle(el), rect=el.getBoundingClientRect();
            return {name,selector:sel,present:true,tag:el.tagName,
              fontSize:st.fontSize,lineHeight:st.lineHeight,color:st.color,
              backgroundColor:st.backgroundColor,borderRadius:st.borderRadius,
              padding:st.padding,
              bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};
          });
          return {measured,tokens:Object.fromEntries(tokens.map(k=>[k,root.getPropertyValue(k).trim()])),
            viewport:{width:innerWidth,height:innerHeight},
            dark:document.documentElement.classList.contains('dark'),
            textSample:document.body.innerText.slice(0,400)};
        })()`);
        const metadata = {
          schema:1,screen,title,condition:condition.id,
          fixture: (probe.value as {fixture?:string}|undefined)?.fixture ?? (probe.ok ? 'real-app' : null),
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
    writeFileSync(join(dir,"environment.json"),JSON.stringify({
      electron:process.versions.electron,windows:process.getSystemVersion?.(),dpi:await js("window.devicePixelRatio"),
      total:results.length,captured:results.filter(r=>r.status==="CAPTURED").length,
      missing:results.filter(r=>r.status==="DATA_MISSING").length,errors
    },null,2));
    if (results.length !== SCREENS.length*CONDITIONS.length) throw Error("39 slots missing");
  } finally {
    win.destroy();
  }
}
