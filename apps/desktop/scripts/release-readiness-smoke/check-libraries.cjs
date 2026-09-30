/** Exercise upgraded browser libraries, not mocks or the product main.
 * Synthetic PPTX/chart only, disposable Electron profile, no external networking. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createRequire}=require('node:module'),{spawnSync}=require('node:child_process');
const appDir=path.resolve(__dirname,'../..'),req=createRequire(path.join(appDir,'package.json'));
async function host(){
 const fixture=process.argv[3],{app,BrowserWindow,session}=require('electron');
 app.setPath('userData',path.join(fixture,'user-data'));app.setPath('sessionData',path.join(fixture,'session-data'));app.setAppLogsPath(path.join(fixture,'logs'));
 app.disableHardwareAcceleration();app.commandLine.appendSwitch('disable-background-networking');
 await app.whenReady();
 session.defaultSession.setPermissionRequestHandler((_wc,_permission,done)=>done(false));
 session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:! /^(file|data|blob):/.test(details.url)}));
 const win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message);});
 try{
  await win.loadFile(path.join(fixture,'index.html'));
  const result=await Promise.race([win.webContents.executeJavaScript('window.__libraryReady'),new Promise((_,reject)=>setTimeout(()=>reject(Error('Browser dependency check timed out')),30000))]);
  assert.ok(result?.ok,result?.error||'Browser dependency check produced no result');
  fs.writeFileSync(path.join(fixture,'result.json'),JSON.stringify(result,null,2));console.log('PASS real browser dependency checks: '+result.checks.length);
 }finally{win.destroy();}
 app.exit(0);
}
function main(){
 const root=path.join(appDir,'.tmp');fs.mkdirSync(root,{recursive:true});const fixture=fs.mkdtempSync(path.join(root,'release-libraries-'));
 const pptxReq=createRequire(req.resolve('pptx-preview')),tiptapReq=createRequire(req.resolve('@tiptap/react')),milkReq=createRequire(req.resolve('@milkdown/crepe'));
 const fixtureData=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/pptx-chart.json'),'utf8'));
 const imports={pptx:req.resolve('pptx-preview'),echarts:pptxReq.resolve('echarts'),core:tiptapReq.resolve('@tiptap/core'),starter:req.resolve('@tiptap/starter-kit'),purify:milkReq.resolve('dompurify')};
 const script=`import {init} from ${JSON.stringify(imports.pptx)};
import * as echarts from "echarts";
import {Editor,mergeAttributes} from ${JSON.stringify(imports.core)};
import StarterKit from ${JSON.stringify(imports.starter)};
import DOMPurify from ${JSON.stringify(imports.purify)};
window.__libraryReady=(async()=>{
 const checks=[];const check=(ok,name)=>{if(!ok)throw Error(name);checks.push(name);};
 check(typeof window.require==='undefined','renderer has no Node require');
 const clean=DOMPurify.sanitize('<img src=x onerror="window.__unsafe=true"><script>window.__unsafe=true<\\/script><b>keep</b>');
 check(!/onerror|<script/i.test(clean)&&clean.includes('<b>keep</b>'),'DOMPurify removes executable attributes and preserves text');
 const attrs=mergeAttributes(JSON.parse('{"__proto__":{"onclick":"unsafe"}}'));
 check(attrs.onclick===undefined,'Tiptap mergeAttributes does not inherit executable attributes');
 const editor=new Editor({element:document.getElementById('editor'),extensions:[StarterKit],content:'<p>Initial text</p>'});
 editor.commands.setContent('<p>Edited safely</p>');
 check(editor.getText()==='Edited safely'&&editor.getJSON().content[0].type==='paragraph','Tiptap editor mounts, edits and serializes');editor.destroy();
 const target=document.getElementById('pptx'),viewer=init(target,{width:960,height:540});
 const bytes=Uint8Array.from(atob(${JSON.stringify(fixtureData.base64)}),c=>c.charCodeAt(0));
 await viewer.preview(bytes.buffer);
 check(target.textContent.includes('Release chart fixture'),'PPTX title rendered');
 // pptx-preview creates chart instances in setTimeout(0), after preview() resolves.
 await new Promise((resolve,reject)=>{
  const observer=new MutationObserver(ready);
  const timer=setTimeout(()=>{observer.disconnect();reject(Error('PPTX chart did not render'));},5000);
  function ready(){if(target.querySelector('[_echarts_instance_] svg,[_echarts_instance_] canvas')){clearTimeout(timer);observer.disconnect();resolve();}}
  observer.observe(target,{subtree:true,childList:true,attributes:true});ready();
 });
 const chart=target.querySelector('[_echarts_instance_]'),instance=chart&&echarts.getInstanceByDom(chart);
 check(Boolean(instance),'PPTX created a real ECharts instance using uuid.v4');
 const option=instance.getOption(),series=option.series[0];
 check(series.type==='bar'&&series.data.map(x=>Number(typeof x==='object'?x.value:x)).join(',')==='10,20','PPTX bar series data survives the ECharts major upgrade');
 check(Boolean(chart.querySelector('canvas,svg')),'PPTX chart has a rendered surface');
 viewer.destroy?.();return {ok:true,checks,versions:{echarts:echarts.version,dompurify:DOMPurify.version}};
})().catch(error=>({ok:false,error:String(error.stack||error)}));`;
 const esbuild=createRequire(req.resolve('electron-vite'))('esbuild');
 esbuild.buildSync({stdin:{contents:script,resolveDir:path.dirname(imports.pptx),sourcefile:'release-library-fixture.js'},bundle:true,platform:'browser',format:'iife',target:'chrome120',outfile:path.join(fixture,'bundle.js'),logLevel:'warning'});
 fs.writeFileSync(path.join(fixture,'index.html'),'<!doctype html><meta charset="utf-8"><body><div id="editor"></div><div id="pptx" style="width:960px;height:540px"></div><script src="bundle.js"></script></body>');
 const env={...process.env,APPDATA:path.join(fixture,'appdata'),LOCALAPPDATA:path.join(fixture,'local-appdata')};for(const name of ['ELECTRON_RUN_AS_NODE','ELECTRON_NO_ASAR','NODE_OPTIONS','NODE_PATH'])delete env[name];
 const result=spawnSync(req('electron'),[__filename,'--host',fixture],{cwd:fixture,env,encoding:'utf8',windowsHide:true,timeout:60000});
 fs.writeFileSync(path.join(fixture,'host.log'),(result.stdout||'')+(result.stderr||''));console.log('Browser dependency artifacts: '+fixture);if(result.stdout)console.log(result.stdout.trim());
 assert.equal(result.status,0,result.error?.message||result.stderr||'Browser dependency host failed');assert.ok(fs.existsSync(path.join(fixture,'result.json')));
}
if(process.argv[2]==='--host')host().catch(error=>{console.error(error);require('electron').app.exit(1);});else try{main();}catch(error){console.error(error);process.exitCode=1;}
