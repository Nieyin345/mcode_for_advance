/**
 * T15 ARC-005: real Electron + real App/ThreePaneLayout/TerminalView/FileEditor.
 * Only api/monacoSetup/LeftBar/StreamSidebar are replaced; mutations apply to
 * the bundled source in memory. Product source files are never edited.
 */
import {mkdirSync,mkdtempSync,readdirSync,readFileSync,writeFileSync,existsSync,copyFileSync,statSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {buildTailwindCached} from '../lib/tailwind-cache.mjs';
import {guardHeavyTestProcess} from '../lib/heavy-test-lease.mjs';

const suite=dirname(fileURLToPath(import.meta.url));
const desktop=resolve(suite,'../..');
const root=join(desktop,'src/renderer');
const pnpm=resolve(desktop,'../../node_modules/.pnpm');
if(process.argv.length>2)throw Error('no options accepted');
guardHeavyTestProcess(desktop,'arc005-pane-electron-smoke/build.mjs');
const pkg=(prefix,sub)=>{
 const n=readdirSync(pnpm).filter(x=>x.startsWith(prefix)).sort().at(-1);
 if(!n)throw Error('Missing '+prefix);
 return join(pnpm,n,'node_modules',sub);
};
mkdirSync(join(desktop,'.tmp'),{recursive:true});
const dir=mkdtempSync(join(desktop,'.tmp/arc005-pane-electron-'));
console.log('ARC005 pane U1 evidence: '+dir);
const originalFiles=['components/layout/ThreePaneLayout.tsx','stores/sessionStore.ts'];
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const originals=Object.fromEntries(originalFiles.map(f=>[f,hash(join(root,f))]));
const resolveTs=p=>{
 const candidates=[p,p.replace(/\.js$/,'.tsx'),p.replace(/\.js$/,'.ts'),p+'/index.ts',p+'/index.tsx'];
 for(const c of candidates){try{if(statSync(c).isFile())return c.replaceAll('\\','/')}catch{}}
 return p.replaceAll('\\','/');
};
const abs=rel=>join(root,rel).replaceAll('\\','/');
const stubs={
 [abs('lib/api.ts')]: 'export const api=window.labApi;',
 [abs('lib/monacoSetup.ts')]: `
 import * as monaco from 'monaco-editor';
 import {loader} from '@monaco-editor/react';
 loader.config({monaco});
 self.MonacoEnvironment={getWorker(){return new Worker(URL.createObjectURL(new Blob(['self.onmessage=function(){}'],{type:'text/javascript'})))}};
 window.__monaco=monaco;
 export {monaco};
 `,
 [abs('components/layout/LeftBar.tsx')]: 'export const LeftBar=()=>window.React.createElement("div",{"data-testid":"left-bar"},"left");',
 [abs('components/layout/StreamSidebar.tsx')]: 'export const StreamSidebar=()=>window.React.createElement("div",{"data-testid":"stream-sidebar"},"stream");',
};
const esbuild=await import(pathToFileURL(pkg('esbuild@','esbuild/lib/main.js')).href);
const entry=join(dir,'entry.tsx');
writeFileSync(entry,`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from ${JSON.stringify(join(root,'App.tsx').replaceAll('\\','/'))};
import {useSessionStore} from '@renderer/stores/sessionStore.js';
import {DEFAULT_PANE_LAYOUT} from ${JSON.stringify(join(root,'components/layout/paneLayout.ts').replaceAll('\\','/'))};
window.React=React;
window.__store=useSessionStore;
window.__defaultPaneLayout=DEFAULT_PANE_LAYOUT;
try{createRoot(document.getElementById('root')).render(<App/>);window.__mounted=true}
catch(e){window.__mountError=String(e?.stack||e);throw e}
`);
for(const variant of ['green','rekey','silent']){
 await esbuild.build({
  entryPoints:[entry],bundle:true,platform:'browser',format:'iife',jsx:'automatic',
  absWorkingDir:desktop,define:{'process.env.NODE_ENV':'"production"'},
  outfile:join(dir,'bundle-'+variant+'.js'),logLevel:'error',
  loader:{'.css':'empty','.woff2':'empty','.woff':'empty','.ttf':'empty','.png':'empty','.svg':'empty'},
  plugins:[{name:'pane-u1-stubs-and-mutations',setup(b){
   b.onResolve({filter:/\?(worker|url|raw)$/},a=>({path:a.path,external:true}));
   b.onResolve({filter:/.*/},a=>{
    if(!['import-statement','require-call','dynamic-import'].includes(a.kind))return;
    const raw=a.path;const isAlias=raw.startsWith('@renderer/');
    const isRel=raw.startsWith('./')||raw.startsWith('../');
    if(!isAlias&&!isRel)return;
    const resolved=resolveTs(isAlias?join(root,raw.slice(10)):resolve(a.resolveDir,raw));
    if(resolved in stubs)return {path:resolved,namespace:'mock'};
    if(variant==='rekey'&&resolved===abs('components/layout/ThreePaneLayout.tsx'))return {path:resolved,namespace:'mutation'};
    if(variant==='silent'&&resolved===abs('stores/sessionStore.ts'))return {path:resolved,namespace:'mutation'};
    return isAlias?{path:resolved}:undefined;
   });
   b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:stubs[a.path],loader:'tsx',resolveDir:desktop}));
   b.onLoad({filter:/.*/,namespace:'mutation'},a=>{
    let code=readFileSync(a.path,'utf8');
    if(variant==='rekey'){
      const needle='<main data-ui-center-pane="" className={cn(';
      if(!code.includes(needle))throw Error('rekey mutation target missing');
      code=code.replace(needle,'<main key={rightDock} data-ui-center-pane="" className={cn(');
    }else{
      const needle='if (canonicalCorrupt) {\n      // Corruption must be visible';
      if(!code.includes(needle))throw Error('silent mutation target missing');
      code=code.replace(needle,'if (false && canonicalCorrupt) {\n      // Corruption must be visible');
    }
    return {contents:code,loader:a.path.endsWith('.tsx')?'tsx':'ts',resolveDir:dirname(a.path)};
   });
  }}],
 });
}
const configPath=join(dir,'tailwind.config.cjs');
writeFileSync(configPath,readFileSync(join(desktop,'tailwind.config.js'),'utf8')
 .replace('export default','module.exports =')
 .replace('content: ["./src/renderer/**/*.{ts,tsx,html}"]','content: '+JSON.stringify([root.replaceAll('\\','/')+'/**/*.{ts,tsx,html}'])));
const css=buildTailwindCached({cliPath:pkg('tailwindcss@','tailwindcss/lib/cli.js'),
 configPath,inputCss:'src/renderer/styles.css',outPath:join(dir,'app.css'),cwd:desktop});
if(css.status!==undefined&&css.status!==0)throw Error('tailwind failed');
// Match the production renderer's stylesheet cascade: ARC-005 loads after
// base theme CSS. Without this line pane U1 verifies an outdated design.
copyFileSync(join(root,'arc005-workspace-surface.css'),join(dir,'arc005-workspace-surface.css'));
for(const f of ['api-stub.js','bridge.cjs','electron-host.cjs'])copyFileSync(join(suite,f),join(dir,f));
for(const variant of ['green','rekey','silent']){
 writeFileSync(join(dir,'page-'+variant+'.html'),`<!doctype html><html lang="zh-CN">
<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"
content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; worker-src 'self' blob:">
<title>pane electron U1</title><link rel="stylesheet" href="./app.css"><link rel="stylesheet" href="./arc005-workspace-surface.css"></head>
<body><div id="root" style="height:900px"></div><script src="./api-stub.js"></script>
<script src="./bundle-${variant}.js"></script></body></html>`);
}
await esbuild.build({entryPoints:[join(suite,'probe.ts')],bundle:true,platform:'node',
 format:'cjs',tsconfig:join(desktop,'tsconfig.json'),absWorkingDir:desktop,
 outfile:join(dir,'probe.cjs'),logLevel:'error',external:['electron']});
const require=createRequire(join(desktop,'package.json'));
const electron=require('electron');
if(typeof electron!=='string'||!existsSync(electron))throw Error('Installed Electron binary required; no download');
let allOk=true;const result={dir,originals,variants:{}};
for(const variant of (process.env.MCODE_PANE_U1_ONLY ? [process.env.MCODE_PANE_U1_ONLY] : ['green','rekey','silent'])){
 const vdir=join(dir,variant);
 mkdirSync(vdir,{recursive:true});
 const home=join(vdir,'home');const temp=join(vdir,'temp');
 mkdirSync(home,{recursive:true});mkdirSync(temp,{recursive:true});
 const env={...process.env,MCODE_PANE_U1_DIR:dir,MCODE_PANE_VARIANT:variant,
  HOME:home,USERPROFILE:home,APPDATA:join(vdir,'userData'),LOCALAPPDATA:join(vdir,'localAppData'),TEMP:temp,TMP:temp};
 delete env.ELECTRON_RUN_AS_NODE;
 const run=spawnSync(electron,[join(dir,'electron-host.cjs')],{
  cwd:desktop,env,encoding:'utf8',timeout:165000,maxBuffer:16*1024*1024});
 const output=(run.stdout??'')+(run.stderr??'');
 writeFileSync(join(dir,'run-'+variant+'.log'),output);
 process.stdout.write(output);
 let checks=[];try{checks=JSON.parse(readFileSync(join(dir,'checks-'+variant+'.json'),'utf8'))}catch{}
 const statuses=Object.fromEntries(checks.map(c=>[c.name,c.status]));
 const expected=variant==='green'
  ? checks.length>=12&&checks.every(c=>c.status==='PASS')&&run.status===0
  : variant==='rekey'
  ? statuses.PTY_STABLE==='FAIL'&&statuses.MONACO_STABLE==='FAIL'&&statuses.REOPEN_PTY_AND_MONACO_DRAFT==='FAIL'&&run.status!==0
  : statuses.CORRUPTION_NOTICE==='FAIL'&&statuses.PTY_STABLE==='PASS'&&statuses.MONACO_STABLE==='PASS'&&run.status!==0;
 result.variants[variant]={exitCode:run.status,checks,statuses,expected};
 console.log('PANE U1 '+variant+': '+(expected?'EXPECTED':'UNEXPECTED')+' '+JSON.stringify(statuses));
 if(!expected)allOk=false;
}
result.sourceUnchanged=Object.entries(originals).every(([f,h])=>hash(join(root,f))===h);
if(!result.sourceUnchanged)allOk=false;
result.complete=allOk;
writeFileSync(join(dir,'result.json'),JSON.stringify(result,null,2));
console.log('PANE U1 '+(allOk?'PASS':'FAIL')+' source SHA cmp='+result.sourceUnchanged);
if(!allOk)process.exitCode=1;
