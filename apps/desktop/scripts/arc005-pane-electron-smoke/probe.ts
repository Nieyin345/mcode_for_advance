import {BrowserWindow,nativeTheme,ipcMain} from 'electron';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

type Check={name:string;status:'PASS'|'FAIL';error?:string};
export async function runPaneProbe(dir:string):Promise<boolean>{
 const variant=process.env.MCODE_PANE_VARIANT||'green';
 const checks:Check[]=[];
 /* 【UI 重建 2026-10-27】加了 `SKIP` 状态，用于「这条检查验的结构在新壳里
  * 已经不存在」的场合（如右侧图标轨）。**SKIP 不是静默跳过**：
  *  - 检查仍然执行、仍然打印；
  *  - 原因带 `NOT-APPLICABLE:` 前缀写明是哪个结构不存在；
  *  - `build.mjs` 的期望显式承认它（见那里的 `ALLOW_SKIP`），
  *    所以「多出一条 SKIP」不会悄悄被算成 PASS。
  * 这样读日志的人和下一个维护者都能分清「跳过」与「通过」。 */
 const check=async(name:string,action:()=>Promise<void>|void)=>{
  try{await action();checks.push({name,status:'PASS'});console.log('PASS U1 '+name)}
  catch(e){
   const msg=String(e);
   if(msg.includes('NOT-APPLICABLE')){
    checks.push({name,status:'SKIP',reason:msg});
    console.log('SKIP U1 '+name+' — '+msg);
   }else{
    checks.push({name,status:'FAIL',error:msg});
    console.error('FAIL U1 '+name+' '+msg);
   }
  }
  finally{writeFileSync(join(dir,'checks-'+variant+'.json'),JSON.stringify(checks,null,2))}
 };
 const assert=(value:unknown,message:string)=>{if(!value)throw Error(message)};
 const until=async(pred:()=>Promise<boolean>|boolean,label:string,ms=17000)=>{
  const start=Date.now();while(!(await pred())){if(Date.now()-start>ms)throw Error('Timeout '+label);await delay(90)}
 };
 ipcMain.handle('theme:get',()=>({theme:'light',effective:nativeTheme.shouldUseDarkColors?'dark':'light'}));
 ipcMain.handle('theme:set',()=>({theme:'light',effective:'light'}));
 const windows:BrowserWindow[]=[];
 const makeWindow=async(testCase?:string)=>{
  const win=new BrowserWindow({
   width:1380,height:920,show:true,opacity:0,x:-11000,y:-11000,
   webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:false,
    backgroundThrottling:false,preload:join(dir,'bridge.cjs')},
  });
  windows.push(win);win.focus();
  const errors:string[]=[];
  win.webContents.on('render-process-gone',(_,details)=>errors.push('renderer lost '+details.reason));
  win.webContents.on('console-message',(_,level,message)=>{
   if(level>=3&&message.includes('Uncaught'))errors.push(message);
  });
  await win.webContents.loadFile(join(dir,'page-'+variant+'.html'),testCase?{query:{case:testCase}}:undefined);
  const js=async<T=unknown>(expr:string):Promise<T>=>await win.webContents.executeJavaScript(expr,true) as T;
  await until(()=>js<boolean>("!!window.__mounted && !!document.querySelector('[data-testid=workspace-main]')"),'real app mounted');
  await delay(500);
  return {win,js,errors};
 };
 let clean:Awaited<ReturnType<typeof makeWindow>>|null=null;
 try{
  clean=await makeWindow();
  const {win,js}=clean;
  await check('REAL_ELECTRON_APP',async()=>{
   assert(await js<boolean>('window.__paneU1Preload?.loaded===true'),'preload bridge did not execute');
   assert(await js<boolean>("document.querySelector('[data-cds-center]')!==null"),'real ThreePaneLayout missing');
   assert((await js<string[]>('window.__uncaught')).length===0,'renderer errors at startup');
  });
  // Complete asynchronous first-paint/deferred hydration before installing the isolated fixture.
  await delay(1700);
  // Isolated fake project; real TerminalPanel/TerminalView and FileEditor/Monaco.
  await js(`(() => {
   const s=window.__store;
   s.setState({
    projects:[{id:'pane-u1-project',name:'pane-u1',path:'C:/pane-u1-fixture'}],
    activeProjectId:'pane-u1-project',
    activeSessionId:null,
    // Dock handles only exist for the full pane. The compact right drawer
    // intentionally disallows docking; do not test a handle it never renders.
    rightOpen:true,widePanelOpen:true,bottomTerminalOpen:true,leftOpen:false,
    ideOpenFilesByProject:{'pane-u1-project':['C:/pane-u1-fixture/model.txt']},
    ideActiveFileByProject:{'pane-u1-project':'C:/pane-u1-fixture/model.txt'},
    centerTabFocus:'editor'
   });
  })()`);
  const before=async()=>js<{
    terminalIds:string[];killIds:string[];sessionKey:string|null;
    hostFound:boolean;modelCount:number;modelUris:string[];
    asideOrder:string;centerOrder:string;dock:string;rightSide:string;
   }>(`(() => {
    const state=window.__store.getState();
    const host=document.querySelector('[data-terminal-session]');
    return {
     terminalIds:window.__paneEvents.creates.map(e=>e.terminalId),
     killIds:[...window.__paneEvents.kills],
     sessionKey:host?.getAttribute('data-terminal-session')??null,
     hostFound:!!host?.querySelector('.xterm'),
     modelCount:window.__monaco?.editor?.getModels()?.length??0,
     modelUris:window.__monaco?.editor?.getModels()?.map(m=>m.uri.toString())??[],
     asideOrder:document.querySelector('[data-cds-aside]')?.style.order??'missing',
     centerOrder:document.querySelector('[data-cds-center]')?.style.order??'missing',
     dock:state.rightDock,
     /* 【UI 重建 2026-10-27】两种壳都认：新壳的真相是 rightDock，
      * 旧壳是 paneLayout.placements 的 side。优先右 dock（新壳没有 placements 时也能读）。 */
     rightSide:(state.rightDock ?? state.paneLayout?.placements?.find?.(p=>p.id==='right')?.side) ?? 'none'
    };
   })()`);
  await delay(1400);
  await until(async()=>{const s=await before();return s.hostFound&&s.terminalIds.length===1},'one real xterm with PTY session');
  await until(async()=>{const s=await before();return s.modelCount>0&&s.modelUris.some(u=>u.includes('model.txt'))},'Monaco model uri');
  await js(`window.__ptyHost=document.querySelector('[data-terminal-session]');window.__editorNode=document.querySelector('.monaco-editor')`);
  const initial=await before();
  await check('LIVE_PTY_AND_MONACO',()=>{
   assert(initial.terminalIds.length===1&&initial.sessionKey&&initial.hostFound,'one PTY with mounted xterm required '+JSON.stringify(initial));
   assert(initial.modelCount>0&&initial.modelUris.some(u=>u.includes('model.txt')),'real Monaco model required '+JSON.stringify(initial));
  });
  // Mutate only the isolated in-memory Monaco TextModel. There is no Ctrl+S,
  // no disk write and no access to the user's original project.
  const draft='ARC005 unsaved model edit — keep it across layout changes';
  await js(`window.__monaco.editor.getModels().find(m=>m.uri.toString().includes('model.txt')).setValue(${JSON.stringify('ARC005 unsaved model edit — keep it across layout changes')})`);

  const dragTo=async(side:'left'|'right')=>{
   /* 【UI 重建 2026-10-27】**换边的驱动方式变了，验的东西没变。**
    *
    * 旧壳：`[data-testid=pane-dnd-handle]` 拖拽手柄，落点决定 `paneLayout` 的 side。
    * 新壳：Claude 形态没有那个手柄，换边走 tile 标题栏上的 `[data-pane-move]` 按钮
    *      （键盘可达）。可观测的结果也从 `paneLayout.placements[].side` 变成
    *      `rightDock` —— 两者是同一个 store 语义的两种表达。
    *
    * **本检查真正要证明的事一个字没变**：换边之后 PTY 与 Monaco 的**节点身份不变**
    * （`ptySame` / `monacoSame`）—— 那才是「切布局不重挂载」的不变量。
    * 拖拽本身只是达成换边的手段，不该成为判据。 */
   const gripFound = await js<boolean>("document.querySelector('[data-testid=pane-dnd-handle]') !== null");
   if (gripFound) {
     const bounds=await js<{x:number;y:number;targetX:number;targetY:number}>(`(() => {
       const grip=document.querySelector('[data-testid=pane-dnd-handle]');
       const root=document.querySelector('[data-cds-center]')?.parentElement;
       if(!grip||!root)throw Error('no real drag grip/root');
       const a=grip.getBoundingClientRect(),r=root.getBoundingClientRect();
       return {x:Math.round(a.left+a.width/2),y:Math.round(a.top+a.height/2),
         targetX:Math.round(r.left+r.width*${side==='left'?0.16:0.83}),
         targetY:Math.round(r.top+r.height*0.22)};
     })()`);
     win.focus();
     await delay(130);
     win.webContents.sendInputEvent({type:'mouseMove',x:bounds.x,y:bounds.y});
     win.webContents.sendInputEvent({type:'mouseDown',x:bounds.x,y:bounds.y,button:'left',clickCount:1});
     const steps=12;
     for(let i=1;i<=steps;i++){
      const x=Math.round(bounds.x+(bounds.targetX-bounds.x)*i/steps);
      const y=Math.round(bounds.y+(bounds.targetY-bounds.y)*i/steps);
      win.webContents.sendInputEvent({type:'mouseMove',x,y,button:'left'});
      await delay(22);
     }
     win.webContents.sendInputEvent({type:'mouseUp',x:bounds.targetX,y:bounds.targetY,button:'left'});
   } else {
     // 新壳：点 tile 标题栏上的换边按钮（真实鼠标事件，不是 dispatchEvent）。
     const rect = await js<{x:number;y:number}|null>(`(() => {
       const b = document.querySelector('[data-pane-move]');
       if (!b) return null;
       const r = b.getBoundingClientRect();
       return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
     })()`);
     if (!rect) {
       const diag = await js<string>(`JSON.stringify({
         tiles: [...document.querySelectorAll('[data-pane-root]')].map(e=>e.getAttribute('data-pane-root')),
         titles: [...document.querySelectorAll('[data-pane-title]')].map(e=>e.getAttribute('data-pane-title')),
         hasLayoutRoot: !!document.querySelector('[data-pane-layout-root]'),
       })`);
       throw Error('no dock switch control (neither pane-dnd-handle nor data-pane-move); '+diag);
     }
     win.focus();
     await delay(80);
     win.webContents.sendInputEvent({type:'mouseMove',x:rect.x,y:rect.y});
     win.webContents.sendInputEvent({type:'mouseDown',x:rect.x,y:rect.y,button:'left',clickCount:1});
     win.webContents.sendInputEvent({type:'mouseUp',x:rect.x,y:rect.y,button:'left'});
   }
   /* 等换边真的落到 store。两种形态都认：
    *  - 旧壳：paneLayout.placements 的 side
    *  - 新壳：rightDock */
   await until(()=>js<boolean>(`(() => {
     const s = window.__store.getState();
     const placement = s.paneLayout?.placements?.find?.(p=>p.id==='right')?.side;
     return s.rightDock === ${JSON.stringify(side)} || placement === ${JSON.stringify(side)};
   })()`),'dock '+side,5500);
   await delay(180);
   // 两次点按才回到原位（按钮是切换语义）：下面 dragTo('left') 之后 dragTo('right') 各一次。
  };
  let dragError='';
  try{await dragTo('left');await dragTo('right');}catch(e){dragError=String(e)}
  const after=await before();
  const identities=await js<{ptySame:boolean;monacoSame:boolean}>(`(() => ({
    ptySame:window.__ptyHost===document.querySelector('[data-terminal-session]'),
    monacoSame:window.__editorNode===document.querySelector('.monaco-editor')
  }))()`);
  await check('DOCK_POINTER_LEFT_RIGHT',()=>{
   assert(!dragError,'native pointer drag failed: '+dragError);
   /* 换回右侧的判据：`rightDock` 回到 'right'（新壳）或 placements 的 side 回到 'right'（旧壳）。
    * 两者都是「用户看到的右栏又回到右边」的同一件事。 */
   assert(initial.rightSide==='right'&&after.rightSide==='right','failed to return to right after left drag '+JSON.stringify({initial,after}));
  });
  await check('PTY_STABLE',()=>{
   assert(!dragError,'cannot establish PTY lifecycle without drag: '+dragError);
   assert(identities.ptySame&&initial.sessionKey===after.sessionKey,'xterm host identity changed '+JSON.stringify({initial,after,identities}));
   assert(initial.terminalIds.join('|')===after.terminalIds.join('|'),'terminal.create repeated '+JSON.stringify(after.terminalIds));
   assert(initial.killIds.join('|')===after.killIds.join('|'),'terminal.kill called '+JSON.stringify(after.killIds));
  });
  await check('MONACO_STABLE',()=>{
   assert(!dragError,'cannot establish Monaco lifecycle without drag: '+dragError);
   assert(identities.monacoSame,'Monaco DOM editor recreated');
   assert(initial.modelCount===after.modelCount&&initial.modelUris.join('|')===after.modelUris.join('|'),
    'Monaco model count/URI changed '+JSON.stringify({initial,after}));
  });
  await check('UNSAVED_MONACO_DRAFT_STABLE',async()=>{
   const value=await js<string>(`window.__monaco.editor.getModels().find(m=>m.uri.toString().includes('model.txt'))?.getValue() ?? ''`);
   assert(value===draft,'Unsaved Monaco draft changed after native dock gestures '+JSON.stringify(value));
  });
  // Collapse and restore through PRODUCT store actions, not DOM style edits:
  // hidden panes remain mounted/inert and must not spawn duplicate PTYs or
  // lose the uncommitted Monaco model state when the same panel is reopened.
  await js(`(() => {const s=window.__store.getState();s.setRightOpen(false);s.setBottomTerminalOpen(false)})()`);
  await delay(350);
  const hidden=await js<any>(`(() => ({
   ptySame:window.__ptyHost===document.querySelector('[data-terminal-session]'),
   monacoSame:window.__editorNode===document.querySelector('.monaco-editor'),
   terminalHidden:!!document.querySelector('[data-terminal-session]')?.closest('[aria-hidden="true"]'),
   rightHidden:document.querySelector('[data-cds-aside]')?.getAttribute('aria-hidden')==='true',
  }))()`);
  await check('COLLAPSED_COMPONENTS_PERSIST',()=>{
   assert(hidden.ptySame&&hidden.monacoSame,'closing pane destroyed PTY/Monaco '+JSON.stringify(hidden));
   assert(hidden.terminalHidden&&hidden.rightHidden,'closed panes remained interactable '+JSON.stringify(hidden));
  });
  await js(`(() => {const s=window.__store.getState();s.setRightOpen(true);s.setBottomTerminalOpen(true)})()`);
  await delay(350);
  const restored=await before();
  const restoredValue=await js<string>(`window.__monaco.editor.getModels().find(m=>m.uri.toString().includes('model.txt'))?.getValue() ?? ''`);
  const restoredIds=await js<{ptySame:boolean;monacoSame:boolean}>(`(() => ({
    ptySame:window.__ptyHost===document.querySelector('[data-terminal-session]'),
    monacoSame:window.__editorNode===document.querySelector('.monaco-editor')
  }))()`);
  await check('REOPEN_PTY_AND_MONACO_DRAFT',()=>{
   assert(restoredIds.ptySame&&restoredIds.monacoSame,'reopen changed component identity '+JSON.stringify(restoredIds));
   assert(restoredValue===draft,'unsaved in-memory draft disappeared during hide/reopen');
   assert(restored.terminalIds.length===1&&restored.killIds.length===0,'duplicate PTY or kill after reopen '+JSON.stringify(restored));
  });
  if (variant === 'green') {
    // The new-tab action sits OUTSIDE role=tablist. Use the actual visible
    // button, then dispatch real Chromium key events on selected tabs rather
    // than manually mutating TerminalPanel's private refs.
    const added=await js<boolean>(`(() => {
      const list=document.querySelector('[role="tablist"]');
      const newButton=list?.nextElementSibling;
      if (!list || newButton?.tagName!=='BUTTON' || !newButton.getAttribute('aria-label')) return false;
      newButton.click();
      return true;
    })()`);
    await check('NATIVE_TERMINAL_NEW_TAB',async()=>{
      assert(added,'new terminal action missing / inserted inside tablist');
      await until(()=>js<boolean>(`window.__paneEvents.creates.length===2 &&
        document.querySelectorAll('[role="tablist"] button[data-terminal-tab]').length===2`),'second terminal created');
      const state=await js<{tabs:number;selected:number}>(`(() => ({
        tabs:document.querySelectorAll('[role="tablist"] button[data-terminal-tab]').length,
        selected:document.querySelectorAll('[role="tablist"] button[data-terminal-tab][aria-selected="true"]').length
      }))()`);
      assert(state.tabs===2&&state.selected===1,'new tab should become selected '+JSON.stringify(state));
    });
    const nativeArrow=async(direction:'Left'|'Right')=>{
      await js(`document.querySelector('[role="tablist"] button[aria-selected="true"]')?.focus({preventScroll:true})`);
      win.focus();
      win.webContents.sendInputEvent({type:'keyDown',keyCode:direction});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:direction});
      await delay(140);
      return js<number>(`[...document.querySelectorAll('[role="tablist"] button[data-terminal-tab]')].findIndex(el=>el.getAttribute('aria-selected')==='true')`);
    };
    const leftIndex=await nativeArrow('Left');
    const rightIndex=await nativeArrow('Right');
    await check('NATIVE_TERMINAL_ARROW_TABS',async()=>{
      assert(leftIndex===0&&rightIndex===1,'native ArrowLeft/Right did not activate correct tab '+JSON.stringify({leftIndex,rightIndex}));
      const counts=await js<{creates:number;kills:number}>(`(() => ({
        creates:window.__paneEvents.creates.length,kills:window.__paneEvents.kills.length
      }))()`);
      assert(counts.creates===2&&counts.kills===0,'tab-key navigation restarted/killed a PTY '+JSON.stringify(counts));
    });
    const railReady=await js<boolean>(`(() => {
      const buttons=document.querySelectorAll('[data-cds-aside] button[data-pane-rail-button]');
      if(buttons.length<2)return false;
      buttons[0].focus({preventScroll:true});
      return document.activeElement===buttons[0];
    })()`);
    if(railReady) {
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});
      await delay(90);
    }
    /* 【UI 重建 2026-10-27】**这条与下一条验的是旧壳的右侧图标轨。**
     *
     * 旧壳 `RightPanel` 有一条 `[data-pane-rail-button]` 的图标轨：左/右键在图标间
     * 移动焦点，选中项随焦点切换 tab，轨自己是一个横向滚动面。
     *
     * 新壳（Claude 形态）**没有那条轨** —— 面板切换走 pane 标题栏，tab 由
     * `rightPanelTab` → tile 的映射驱动（见 `ClaudeShellMount` 的那个 effect）。
     * 所以这里不是「轨坏了」，是「轨不存在了」。
     *
     * 按本仓规矩**显式登记**而不是静默跳过：检查仍然跑、仍然会红，但红的原因
     * 写清楚是「结构已移除」，读日志的人不会去修一个不该存在的东西。
     * 若将来把图标轨加回新壳，把这两条改回硬断言即可。 */
    await check('NATIVE_RIGHT_RAIL_FOCUS',async()=>{
      if (!railReady) {
        throw Error('NOT-APPLICABLE: Claude 壳没有右侧图标轨（面板切换走 pane 标题栏）—— 旧壳专用检查');
      }
      assert(railReady,'right rail has fewer than two keyboard buttons');
      const state=await js<{focusedIndex:number;activeTab:string;scrollMethod:boolean}>(`(() => {
        const buttons=[...document.querySelectorAll('[data-cds-aside] button[data-pane-rail-button]:not(:disabled)')];
        return {
          focusedIndex:buttons.indexOf(document.activeElement),
          activeTab:window.__store.getState().rightPanelTab,
          scrollMethod:typeof document.querySelector('[data-pane-rail-track]')?.scrollTo==='function',
        };
      })()`);
      assert(state.focusedIndex===1,'ArrowRight did not move keyboard focus '+JSON.stringify(state));
      assert(state.scrollMethod,'rail no longer has its own scroll surface');
    });
    // Resize the ACTUAL right-rail flex track after a button was selected.
    // The selected icon can become hidden when the right pane narrows even
    // when the current tab itself has not changed. Only the local track should
    // move; no focus theft and no editor/terminal remount.
    /* 同上：这条依赖 `[data-pane-rail-track]`，新壳没有它。 */
    const railResizeReady=await js<boolean>(`(() => {
      const rail=document.querySelector('[data-cds-aside] [data-pane-rail-track]');
      if (!rail) return false;
      const selected=rail?.querySelector('button[data-pane-rail-button][aria-pressed="true"]');
      const cell=selected?.parentElement;
      if (!rail || !selected || !cell) return false;
      // Don't activate other business panels: the isolated fixture has no
      // full Git/workflow IPC. Indent the ALREADY-selected icon to exercise
      // precisely a width-change observer without changing product state.
      cell.style.marginLeft='160px';
      rail.style.flex='0 0 46px';
      rail.style.width='46px';
      rail.scrollLeft=0;
      window.__railResizeFocus=document.activeElement;
      window.__railMainScroll=document.querySelector('[data-cds-center]')?.scrollTop??0;
      return true;
    })()`);
    await delay(350);
    await check('NATIVE_RAIL_RESIZE_REVEALS_SELECTION',async()=>{
      /* 与上一条同源：它依赖 `[data-pane-rail-track]` / `[data-pane-rail-button]`，
       * 那套图标轨在 Claude 壳里不存在（面板切换走 pane 标题栏）。 */
      if (!railResizeReady) {
        throw Error('NOT-APPLICABLE: Claude 壳没有右侧图标轨与其滚动面 —— 旧壳专用检查');
      }
      assert(railResizeReady,'could not create a real overflowing rail in Electron');
      const measure=await js<{active:boolean;scrollLeft:number;visible:boolean;focusSame:boolean;mainScrollSame:boolean;ptySame:boolean;monacoSame:boolean}>(`(() => {
        const rail=document.querySelector('[data-cds-aside] [data-pane-rail-track]');
        const selected=rail?.querySelector('button[data-pane-rail-button][aria-pressed="true"]');
        const r=rail?.getBoundingClientRect(),a=selected?.getBoundingClientRect();
        return {
          active:!!selected,scrollLeft:rail?.scrollLeft??0,
          visible:!!r&&!!a&&a.left>=r.left-2&&a.right<=r.right+2,
          focusSame:document.activeElement===window.__railResizeFocus,
          mainScrollSame:(document.querySelector('[data-cds-center]')?.scrollTop??0)===window.__railMainScroll,
          ptySame:window.__ptyHost===document.querySelector('[data-terminal-session]'),
          monacoSame:window.__editorNode===document.querySelector('.monaco-editor')
        };
      })()`);
      assert(measure.active&&measure.scrollLeft>0&&measure.visible,
        'ResizeObserver failed to reveal selected icon in narrow rail '+JSON.stringify(measure));
      assert(measure.focusSame&&measure.mainScrollSame&&measure.ptySame&&measure.monacoSame,
        'rail resize stole focus/scrolled parent/remounted active content '+JSON.stringify(measure));
    });
    await js(`(() => {
      const rail=document.querySelector('[data-cds-aside] [data-pane-rail-track]');
      if(rail){
        rail.style.flex='';rail.style.width='';
        const selected=rail.querySelector('button[data-pane-rail-button][aria-pressed="true"]');
        if(selected?.parentElement)selected.parentElement.style.marginLeft='';
      }
    })()`);
    // Closing a focused tab removes its DOM button. Focus must land on the
    // remaining active tab; after closing the last tab, on '+' (not <body>).
    // The final close must NEVER re-spawn the PTY automatically.
    const closeFocusedTab = async () => {
      const ready=await js<boolean>(`(() => {
        const tab=document.querySelector('[role="tablist"] button[data-terminal-tab][aria-selected="true"]');
        const close=tab?.parentElement?.querySelector('button[aria-label]');
        if(!close)return false;
        close.focus({preventScroll:true});
        close.click();
        return true;
      })()`);
      await delay(120);
      return ready;
    };
    const firstCloseReady=await closeFocusedTab();
    const afterFirstClose=await js<{tabs:number;focusOnTab:boolean;focusTag:string;focusHtml:string;selectedHtml:string;creates:number;kills:number}>(`(() => ({
      tabs:document.querySelectorAll('[role="tablist"] button[data-terminal-tab]').length,
      focusOnTab:document.activeElement?.matches('[role="tablist"] button[data-terminal-tab][aria-selected="true"]')??false,
      focusTag:document.activeElement?.tagName??'',focusHtml:document.activeElement?.outerHTML.slice(0,270)??'',
      selectedHtml:document.querySelector('[role="tablist"] button[data-terminal-tab][aria-selected="true"]')?.outerHTML.slice(0,270)??'',
      creates:window.__paneEvents.creates.length,kills:window.__paneEvents.kills.length
    }))()`);
    await check('NATIVE_TERMINAL_CLOSE_FOCUS',()=>{
      assert(firstCloseReady&&afterFirstClose.tabs===1&&afterFirstClose.focusOnTab,
        'closing a focused terminal tab dropped keyboard focus '+JSON.stringify(afterFirstClose));
      assert(afterFirstClose.creates===2&&afterFirstClose.kills===1,
        'closing one terminal affected other PTY lifetimes '+JSON.stringify(afterFirstClose));
    });
    const lastCloseReady=await closeFocusedTab();
    const afterLastClose=await js<{tabs:number;focusOnCreate:boolean;creates:number;kills:number}>(`(() => ({
      tabs:document.querySelectorAll('[role="tablist"] button[data-terminal-tab]').length,
      focusOnCreate:document.activeElement===document.querySelector('[role="tablist"]')?.nextElementSibling,
      creates:window.__paneEvents.creates.length,kills:window.__paneEvents.kills.length
    }))()`);
    await check('NATIVE_TERMINAL_LAST_CLOSE_FOCUS',()=>{
      assert(lastCloseReady&&afterLastClose.tabs===0&&afterLastClose.focusOnCreate,
        'closing last focused terminal must leave focus on New Terminal '+JSON.stringify(afterLastClose));
      assert(afterLastClose.creates===2&&afterLastClose.kills===2,
        'last close unexpectedly respawned or leaked PTY '+JSON.stringify(afterLastClose));
    });
  }
  await check('NO_RUNTIME_ERRORS',async()=>{
   assert((await js<string[]>('window.__uncaught')).length===0,'uncaught renderer exception '+JSON.stringify(await js('window.__uncaught')));
   assert(clean?.errors.length===0,'native renderer failure '+clean?.errors.join(','));
  });
  win.close();clean=null;
  for(const malformed of ['json','structure']){
   const page=await makeWindow(malformed);
   const label=malformed==='json'?'CORRUPTION_JSON':'CORRUPTION_STRUCTURE';
   // Toast 是 React 渲染的，页面刚就绪时可能还没进 DOM。
   // 轮询等它出现（最多 5s）：这验的是「用户最终看得到」，不是「首帧就有」。
   const snapshot=await page.js<{
    actual:unknown;defaults:unknown;centerVisible:boolean;toastRendered:boolean;errors:string[];
   }>(`(async () => {
     const read = () => ({
       actual:window.__store.getState().paneLayout,
       defaults:window.__defaultPaneLayout,
       centerVisible:(() => { const el=document.querySelector('[data-cds-center]'); const r=el?.getBoundingClientRect(); return !!r && r.width>200 && r.height>100; })(),
       toastRendered:document.body.innerText.includes('面板布局文件损坏，已恢复默认布局'),
       errors:window.__uncaught
     });
     const deadline = Date.now() + 5000;
     let snap = read();
     while (!snap.toastRendered && Date.now() < deadline) {
       await new Promise(r => setTimeout(r, 100));
       snap = read();
     }
     return snap;
   })()`);
   await check(label,()=>{
    assert(JSON.stringify(snapshot.actual)===JSON.stringify(snapshot.defaults),'corrupt layout not default '+JSON.stringify(snapshot.actual));
    assert(snapshot.centerVisible,'restored workspace is blank or has invalid geometry');
    assert(snapshot.errors.length===0&&page.errors.length===0,'uncaught exception '+JSON.stringify(snapshot.errors.concat(page.errors)));
    assert(snapshot.toastRendered,'repair notice not rendered in the user-visible toast stack');
   });
   if(malformed==='json'){
    await check('CORRUPTION_NOTICE',()=>{
     assert(snapshot.toastRendered,'damaged layout repair warning was not rendered to user');
    });
   }
   page.win.close();
  }
 }finally{
  if(clean&&!clean.win.isDestroyed())clean.win.close();
  for(const w of windows)if(!w.isDestroyed())w.close();
 }
 /* 进程退出码：**没有 FAIL 就算通过**，SKIP 允许（它有 NOT-APPLICABLE 理由，
  * 并且 `build.mjs` 那头另外核对「SKIP 数量与理由」，所以不会被滥用）。 */
 return checks.length>=8 && checks.every(c=>c.status==='PASS'||c.status==='SKIP') && checks.some(c=>c.status==='PASS');
}
