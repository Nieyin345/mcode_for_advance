/** Exercise upgraded browser libraries, not mocks or the product main.
 * Synthetic PPTX/chart only, disposable Electron profile, no external networking.
 *
 * 【2026-10-17】`pptx-preview` 与它带进来的 `echarts` 已随三个本地 Office
 * 预览组件一起删掉(Office 预览走 OnlyOffice,见 commit e0a90713)。因此本文件
 * 里那条 "PPTX + ECharts + 图表实例" 的浏览器检查**不再有被测对象** —— 它测的是
 * 已移除依赖的内部行为,留着只会让 release-readiness 永远红。清理时保留的仍是
 * 有被测对象的几条:DOMPurify(经 @milkdown/crepe 传递)、Tiptap 编辑器挂载与
 * 序列化 —— 它们都还在生产渲染路径上。 */
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
 const tiptapReq=createRequire(req.resolve('@tiptap/react')),milkReq=createRequire(req.resolve('@milkdown/crepe'));
 const imports={core:tiptapReq.resolve('@tiptap/core'),starter:req.resolve('@tiptap/starter-kit'),purify:milkReq.resolve('dompurify')};
 const script=`import {Editor,mergeAttributes} from ${JSON.stringify(imports.core)};
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
 return {ok:true,checks,versions:{dompurify:DOMPurify.version}};
})().catch(error=>({ok:false,error:String(error.stack||error)}));`;
 const esbuild=createRequire(req.resolve('electron-vite'))('esbuild');
 esbuild.buildSync({stdin:{contents:script,resolveDir:path.dirname(imports.core),sourcefile:'release-library-fixture.js'},bundle:true,platform:'browser',format:'iife',target:'chrome120',outfile:path.join(fixture,'bundle.js'),logLevel:'warning'});
 fs.writeFileSync(path.join(fixture,'index.html'),'<!doctype html><meta charset="utf-8"><body><div id="editor"></div><script src="bundle.js"></script></body>');
 const env={...process.env,APPDATA:path.join(fixture,'appdata'),LOCALAPPDATA:path.join(fixture,'local-appdata')};for(const name of ['ELECTRON_RUN_AS_NODE','ELECTRON_NO_ASAR','NODE_OPTIONS','NODE_PATH'])delete env[name];
 const result=spawnSync(req('electron'),[__filename,'--host',fixture],{cwd:fixture,env,encoding:'utf8',windowsHide:true,timeout:60000});
 fs.writeFileSync(path.join(fixture,'host.log'),(result.stdout||'')+(result.stderr||''));console.log('Browser dependency artifacts: '+fixture);if(result.stdout)console.log(result.stdout.trim());
 assert.equal(result.status,0,result.error?.message||result.stderr||'Browser dependency host failed');assert.ok(fs.existsSync(path.join(fixture,'result.json')));
}
if(process.argv[2]==='--host')host().catch(error=>{console.error(error);require('electron').app.exit(1);});else try{main();}catch(error){console.error(error);process.exitCode=1;}
