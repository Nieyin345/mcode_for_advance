import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {deflateRawSync} from "node:zlib";
import {defineU1Journey,step} from "../../electron-u1/driver/index.js";

function crc32(raw:Buffer):number{
  let crc=0xffffffff;
  for(const byte of raw){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
function zip(entries:Array<{name:string;bytes:Buffer}>):Buffer{
  const local:Buffer[]=[],central:Buffer[]=[];
  let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.name,"utf8"),body=deflateRawSync(entry.bytes),crc=crc32(entry.bytes);
    const header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);
    header.writeUInt16LE(8,8);header.writeUInt32LE(crc,14);header.writeUInt32LE(body.length,18);
    header.writeUInt32LE(entry.bytes.length,22);header.writeUInt16LE(name.length,26);
    local.push(header,name,body);
    const c=Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);
    c.writeUInt16LE(0x800,8);c.writeUInt16LE(8,10);c.writeUInt32LE(crc,16);
    c.writeUInt32LE(body.length,20);c.writeUInt32LE(entry.bytes.length,24);
    c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);central.push(c,name);
    offset+=header.length+name.length+body.length;
  }
  const middle=Buffer.concat(central),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(middle.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,middle,end]);
}

async function setup(ctx:{projectDir:string;dataDir:string;runDir:string}){
  const repo=process.env.MCODE_U1_REPO;
  if(!repo)throw Error("F040 MCODE_U1_REPO is missing");
  const fixture=join(repo,"apps/desktop/scripts/theia-host-boot-smoke/fixtures/spawn-ext");
  const docPath=join(ctx.projectDir,"u1-doc.txt");
  const vsixPath=join(ctx.projectDir,"f040-spawn-ext.vsix");
  writeFileSync(docPath,"native-text\n");
  const extensionSource=readFileSync(join(fixture,"extension.js"),"utf8");
  const mutation=process.env.MCODE_F040_MUTATION;
  const mutatedSource=mutation==="rename-placeholder"
    ?extensionSource.replace('range:new vscode.Range(0,0,0,6),placeholder:"native"',
      'range:new vscode.Range(0,0,0,6),placeholder:"f040-corrupted-placeholder"')
    :extensionSource;
  if(mutation==="rename-placeholder"&&mutatedSource===extensionSource)
    throw Error("F040 mutation target was not found; refusing to run an unmutated negative control");
  writeFileSync(vsixPath,zip([
    {name:"extension/package.json",bytes:readFileSync(join(fixture,"package.json"))},
    {name:"extension/extension.js",bytes:Buffer.from(mutatedSource,"utf8")},
  ]));
  const {ipcMain}=await import("electron");
  const runtimePath=join(ctx.runDir,"../../theia-installed-runtime.mjs");
  const {registerF040TheiaHandlers}=await import(pathToFileURL(runtimePath).href);
  registerF040TheiaHandlers(ipcMain,ctx.dataDir,join(repo,"vendor/theia"));
  return {runtime:{docPath,vsixPath,workspacePath:ctx.projectDir}};
}

export {setup as setupF040};

export const journeys=[defineU1Journey({
  name:"product-fileeditor-real-vsix-rename-fix",
  launch:{page:{file:"product-page.html"},preload:"product",useRealDb:true,
    setup,size:{width:1440,height:900},defaultTimeoutMs:20000,
    assertions:{dom:true,visual:true,sideEffect:true}},
  steps:[
    step.assertEvaluated("window.__mounted",true,"production-app-bundle-mounted"),
    step.assertEvaluated("window.__store.getState()._initStarted===true&&window.__store.getState().projects.length>0",
      true,"real-app-store-initialized",{timeoutMs:20000}),
    step.eval("(()=>{const doc=new URLSearchParams(location.search).get('doc');const dir=doc.replace(/[\\\\/][^\\\\/]*$/,'');const project={id:'proj_u1_fixture',name:'F040 temporary project',path:dir,archived:false,pinnedAt:null,sortOrder:0,createdAt:Date.now(),updatedAt:Date.now()};window.__store.setState({projects:[project],activeProjectId:project.id,ideEditorMode:'replace'});window.__store.getState().openFileInIde(doc);return {doc,projectPath:dir}})()",
      "open-real-product-file"),
    step.assertEvaluated("window.__store.getState().ideActiveFileByProject['proj_u1_fixture']===new URLSearchParams(location.search).get('doc')",
      true,"product-store-opened-the-temp-document"),
    step.waitFor(".monaco-editor","real-fileeditor-mounted",{timeoutMs:20000}),
    step.assertEvaluated("document.querySelector('.view-lines')?.innerText?.includes('native-text')",true,
      "fileeditor-read-through-product-preload",{timeoutMs:20000}),
    step.assertEvaluated("window.__u1ProductPreloadCalls.some(x=>x.namespace==='file'&&x.method==='readFile'&&x.filePath===new URLSearchParams(location.search).get('doc')&&x.contentLength===12)",
      true,"real-preload-read-file-evidence"),
    step.assertEvaluated("window.__u1WorkerAttempts.length>0&&window.__u1Workers.length===window.__u1WorkerAttempts.length&&window.__u1Workers.some(x=>x.type==='module'&&(()=>{const u=new URL(x.url,location.href);return u.protocol===location.protocol&&u.host===location.host&&u.pathname.startsWith(location.pathname.replace(/[^/]*$/,''))})())",
      true,"production-monaco-worker-created-same-origin",{timeoutMs:20000}),
    step.sleep(500,"allow-worker-startup"),
    step.eval("({page:location.href,origin:location.origin,attempts:window.__u1WorkerAttempts,constructed:window.__u1Workers,errors:window.__u1WorkerErrors,fallbackWarnings:window.__u1WorkerFallbackWarnings})",
      "capture-production-worker-evidence"),
    step.assertEvaluated("window.__u1WorkerErrors.length===0&&window.__u1WorkerFallbackWarnings.length===0",true,
      "production-monaco-worker-has-no-errors-or-main-thread-fallback"),
    step.eval("(async()=>{const doc=new URLSearchParams(location.search).get('doc');const dir=doc.replace(/[\\\\/][^\\\\/]*$/,'');const inspected=await window.labApi.modules.theiaInstalled({op:'inspect',path:dir+'\\\\f040-spawn-ext.vsix'});if(inspected.kind!=='inspected')throw Error('VSIX inspect failed: '+JSON.stringify(inspected));const installed=await window.labApi.modules.theiaInstalled({op:'install',ticket:inspected.ticket,accepted:true});if(installed.kind!=='installed')throw Error('VSIX install failed: '+JSON.stringify(installed));const started=await window.labApi.modules.theiaInstalled({op:'start',id:installed.item.id,workspacePath:dir});if(started.kind!=='started')throw Error('Theia start failed: '+JSON.stringify(started));const listed=await window.labApi.modules.theiaInstalled({op:'list'});const item=listed.items.find(x=>x.id===installed.item.id);window.__f040={id:installed.item.id,sessionId:started.sessionId,doc,workspacePath:dir,providers:item?.activeSession?.languageProviders||[],activationErrors:started.activationErrors};return {installed:installed.kind,started:started.kind,extensionId:item?.extensionId,providers:window.__f040.providers,activationErrors:started.activationErrors}})()",
      "install-and-start-real-vsix-through-product-ipc"),
    step.assertEvaluated("window.__f040.activationErrors.length===0&&window.__f040.providers.some(x=>x.kind==='rename'&&x.supportsRenameLocation===true)&&window.__f040.providers.some(x=>x.kind==='codeActions')",
      true,"real-vsix-started-with-rename-and-code-actions-providers"),
    step.assertEvaluated("['inspect','install','start'].every(op=>window.__u1ProductPreloadCalls.some(x=>x.namespace==='modules'&&x.method==='theiaInstalled'&&x.op===op))&&window.__u1ProductPreloadCalls.some(x=>x.namespace==='on'&&x.method==='theiaContributionChanged'&&x.action==='subscribe')",
      true,"real-preload-ipc-and-contribution-event-evidence"),
    step.assertEvaluated("window.__u1ProductPreloadCalls.some(x=>x.namespace==='on'&&x.method==='theiaContributionChanged'&&x.action==='subscribe')&&window.__u1ProductPreloadCalls.some(x=>x.namespace==='on'&&x.method==='theiaContributionChanged'&&x.action==='event'&&x.sessionId===window.__f040.sessionId)",
      true,"real-preload-contribution-change-event-evidence"),
    step.sleep(300,"wait-for-product-provider-refresh"),
    step.click(".view-line .mtk1","focus-real-fileeditor",{text:"native-text"}),
    step.press("Up","ensure-rename-cursor-is-on-symbol-line"),
    step.press("F2","open-product-rename"),
    step.sleep(100,"allow-rename-provider-roundtrip"),
    step.eval("window.__u1TheiaCalls.filter(x=>x.op==='editorSync'||(x.op==='languageQuery'&&x.query==='rename')).slice(-10)","capture-real-rename-provider-result"),
    step.waitFor(".rename-box input","product-rename-widget-open",{timeoutMs:20000}),
    step.assertEvaluated("(()=>{const r=[...window.__u1TheiaCalls].reverse().find(x=>x.op==='languageQuery'&&x.query==='rename'&&x.result?.renameLocation);const p=r?.result?.renameLocation;return p?.text==='native'&&p.range.start.line===0&&p.range.start.character===0&&p.range.end.line===0&&p.range.end.character===6})()",
      true,"real-provider-prepare-rename-range-and-placeholder",{timeoutMs:20000}),
    step.assertEvaluated("document.querySelector('.rename-box input').value==='native'",true,"provider-prepare-rename-placeholder"),
    step.eval("(()=>{const input=document.querySelector('.rename-box input');input.focus();input.select();return {start:input.selectionStart,end:input.selectionEnd,value:input.value}})()",
      "select-product-rename-text"),
    step.assertEvaluated("(()=>{const input=document.querySelector('.rename-box input');return input.selectionStart===0&&input.selectionEnd===input.value.length})()",
      true,"rename-placeholder-selected"),
    step.type(".rename-box input","edited","type-product-rename"),
    step.press("Enter","commit-product-rename"),
    step.assertEvaluated("document.querySelector('.view-lines')?.innerText?.includes('edited-text')",true,
      "real-vsix-rename-edited-product-monaco",{timeoutMs:15000}),
    step.press("z","undo-product-rename",["control"]),
    step.assertEvaluated("document.querySelector('.view-lines')?.innerText?.includes('native-text')",true,
      "product-rename-undo-restores-original",{timeoutMs:15000}),
    step.click(".view-line .mtk1","focus-for-product-quick-fix",{text:"native-text"}),
    step.press("Up","ensure-quick-fix-cursor-is-on-symbol-line"),
    step.press(".","trigger-product-quick-fix",["control"]),
    step.waitFor(".action-widget","product-code-action-menu-open",{timeoutMs:20000}),
    step.assertEvaluated("document.querySelector('.action-widget')?.innerText?.includes('Mcode safe local fix')",true,
      "real-vsix-safe-code-action-visible"),
    step.assertEvaluated("!document.querySelector('.action-widget')?.innerText?.includes('Mcode forbidden cross-file')&&!document.querySelector('.action-widget')?.innerText?.includes('Mcode forbidden command')",
      true,"cross-file-and-command-actions-filtered"),
    step.press("Enter","apply-product-quick-fix"),
    step.assertEvaluated("document.querySelector('.view-lines')?.innerText?.includes('safe-fixed-text')",true,
      "real-vsix-quick-fix-edited-product-monaco",{timeoutMs:15000}),
    step.press("z","undo-product-quick-fix",["control"]),
    step.assertEvaluated("document.querySelector('.view-lines')?.innerText?.includes('native-text')",true,
      "product-quick-fix-undo-restores-original",{timeoutMs:15000}),
    step.sleep(2000,"settle-provider-requests-before-stop"),
    step.eval("(async()=>{const stopped=await window.labApi.modules.theiaInstalled({op:'stop',sessionId:window.__f040.sessionId});const listed=await window.labApi.modules.theiaInstalled({op:'list'});const item=listed.items.find(x=>x.id===window.__f040.id);window.__f040StopResult={kind:stopped.kind,sessionId:window.__f040.sessionId,stillRunning:!!item?.activeSession};return window.__f040StopResult})()",
      "stop-real-vsix-session"),
    step.eval("window.__u1ProductPreloadCalls.filter(x=>x.rejected).slice(-20)","capture-rejected-product-preload-calls"),
    step.assertEvaluated("window.__u1ProductPreloadCalls.filter(x=>x.rejected).every(x=>x.op==='editorSync'&&x.rejected.includes('仅当前窗口的空闲运行会话可以同步编辑器'))",true,
      "editor-sync-contention-fails-closed"),
    step.assertEvaluated("window.__f040StopResult.kind==='stopped'&&window.__f040StopResult.stillRunning===false",
      true,"real-vsix-stop-confirmed-through-ipc"),
    step.assertEvaluated("window.__u1Workers.length>0&&window.__u1WorkerErrors.length===0",true,
      "final-worker-health"),
  ],
})];
