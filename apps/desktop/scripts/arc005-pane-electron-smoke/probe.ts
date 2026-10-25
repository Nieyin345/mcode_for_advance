import {BrowserWindow,nativeTheme,ipcMain} from 'electron';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

type Check={name:string;status:'PASS'|'FAIL';error?:string};
export async function runPaneProbe(dir:string):Promise<boolean>{
 const variant=process.env.MCODE_PANE_VARIANT||'green';
 const checks:Check[]=[];
 const check=async(name:string,action:()=>Promise<void>|void)=>{
  try{await action();checks.push({name,status:'PASS'});console.log('PASS U1 '+name)}
  catch(e){checks.push({name,status:'FAIL',error:String(e)});console.error('FAIL U1 '+name+' '+String(e))}
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
     rightSide:state.paneLayout.placements.find(p=>p.id==='right')?.side??'none'
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
   // DndContext's grip is the docking control; the vertical divider is resize-only.
   // Mouse events are injected by Electron/Chromium, not DOM dispatchEvent.
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
   await until(()=>js<boolean>(`window.__store.getState().paneLayout.placements.find(p=>p.id==='right')?.side===${JSON.stringify(side)}`),'dock '+side,5500);
   await delay(180);
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
  const hidden=await js<{ptySame:boolean;monacoSame:boolean;terminalHidden:boolean;rightHidden:boolean}>(`(() => ({
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
 return checks.length>=8&&checks.every(c=>c.status==='PASS');
}
