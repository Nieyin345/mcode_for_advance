/**
 * T04: isolated real-Chromium mobile viewport geometry checks.
 * Real production mobile components + CSS; only transport/store/expensive editors are stubbed.
 * Uses the existing owned CDP browser harness, never attaches to a user's browser.
 * MCODE_T04_MUTATE_SAFE=1 deletes SettingsSheet's safe-bottom class in the test bundle
 * (mutant must fail the exact same padding assertion).
 */
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { buildTailwindCached } from '../lib/tailwind-cache.mjs';
import { withAuditPage } from '../settings-layout-smoke/browser.mjs';

const source=dirname(fileURLToPath(import.meta.url));
const desktop=resolve(source,'../..');
const root=join(desktop,'src/renderer');
const pnpm=resolve(desktop,'../../node_modules/.pnpm');
const pkg=(prefix,sub)=>{
  const n=readdirSync(pnpm).filter(n=>n.startsWith(prefix)).sort().at(-1);
  if(!n)throw Error('Missing installed dependency '+prefix);
  return join(pnpm,n,'node_modules',sub);
};
const resolveTs=(p)=>{
  const candidates=[p,p.replace(/\.js$/,'.tsx'),p.replace(/\.js$/,'.ts'),p+'/index.ts',p+'/index.tsx'];
  for(const c of candidates){try{if(statSync(c).isFile())return c.replaceAll('\\','/');}catch{}}
  return p.replaceAll('\\','/');
};
const abs=(rel)=>join(root,rel).replaceAll('\\','/');
const stubs={
  [abs('lib/api.ts')]: 'export const api=window.testApi;',
  [abs('lib/webApi.ts')]: 'export const fetchAuthMethods=async()=>({password:true});export const pairWithCode=async()=>{};export const loginWithPassword=async()=>{};export const clearAuth=()=>{};',
  [abs('lib/theme.ts')]: 'export const applyThemeClass=()=>{};',
  [abs('stores/sessionStore.ts')]: 'export const useSessionStore=(pick)=>pick(window.testStore);useSessionStore.getState=()=>window.testStore;',
  [abs('stores/toastStore.ts')]: 'export const useToastStore={getState:()=>({push:()=>{}})};',
  [abs('lib/providerIcon.tsx')]: 'export const getProviderIcon=()=>({Icon:()=>null,color:""});',
  [abs('lib/providerIcon.ts')]: 'export const getProviderIcon=()=>({Icon:()=>null,color:""});',
  [abs('components/chat/Markdown.tsx')]: 'export const Markdown=()=>null;',
  [abs('components/chat/ActivityConsole.tsx')]: 'export const ActivityConsole=()=>null;',
  [abs('components/chat/DiffView.tsx')]: 'export const DiffView=()=>null;',
  [abs('components/ide/OnlyOfficeEditorPane.tsx')]: 'export const OnlyOfficeEditorPane=()=>null;',
  [abs('lib/i18n/index.ts')]: 'export const useI18n=()=>({t:(key)=>key,locale:"zh"});',
  [abs('hooks/useRpc.ts')]: 'import {useEffect,useState} from "react";export const useRpc=(f,deps,opt)=>{const [data,setData]=useState(null);useEffect(()=>{if(opt?.enabled)f().then(setData).catch(()=>{});},deps);return {data,loading:opt?.enabled&&!data,error:null,refetch:()=>f().then(setData)}};',
};
mkdirSync(join(desktop,'.tmp'),{recursive:true});
const dir=mkdtempSync(join(desktop,'.tmp','mobile-viewport-'));
try{
  const entry=join(dir,'entry.tsx');
  writeFileSync(entry,`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PairingScreen} from ${JSON.stringify(abs('components/mobile/PairingScreen.tsx'))};
import {MobileSettingsSheet} from ${JSON.stringify(abs('components/mobile/MobileSettingsSheet.tsx'))};
import {MobileSessionDrawer} from ${JSON.stringify(abs('components/mobile/MobileSessionDrawer.tsx'))};
import {MobileFilesScreen} from ${JSON.stringify(abs('components/mobile/MobileFilesScreen.tsx'))};
import {MobileGitScreen} from ${JSON.stringify(abs('components/mobile/MobileGitScreen.tsx'))};
import {BranchSheet} from ${JSON.stringify(abs('components/mobile/MobileGitScreenParts.tsx'))};
import {FileViewerOverlay} from ${JSON.stringify(abs('components/mobile/MobileFileViewer.tsx'))};
import {MobileViewerOverlay} from ${JSON.stringify(abs('components/mobile/MobileViewerOverlay.tsx'))};
import {ActivitySheet} from ${JSON.stringify(abs('components/mobile/ActivitySheet.tsx'))};
const choice=new URLSearchParams(location.search).get('case')||'pairing';
function Fixture(){
  const [open,setOpen]=useState(true);
  window.__setOpen=setOpen;
  return <div data-fixture={choice} className="h-full w-full min-w-0 bg-surface text-content">
   {choice==='pairing' && <PairingScreen onPaired={()=>{}}/>}
   {choice==='settings' && <MobileSettingsSheet open={open} onClose={()=>setOpen(false)}/>}
   {choice.startsWith('drawer') && <MobileSessionDrawer open={open} view="chat" onClose={()=>setOpen(false)} onPickView={()=>setOpen(false)} onPickSession={()=>setOpen(false)}/>}
   {choice==='files' && <MobileFilesScreen/>}
   {choice==='git' && <MobileGitScreen/>}
   {choice==='branch' && <BranchSheet repoPath="C:/fake" onClose={()=>setOpen(false)} onChanged={()=>{}}/>}
   {choice==='file-viewer' && <FileViewerOverlay name="demo.txt" path="C:/fake/demo.txt" onClose={()=>setOpen(false)}/>}
   {choice==='mobile-viewer' && <MobileViewerOverlay/>}
   {choice==='activity' && <ActivitySheet node="todos" subagents={[]} todos={[]} planBlocks={[]} tabs={{}} onPickNode={()=>{}} onTabChange={()=>{}} onClose={()=>setOpen(false)} onPickPlan={()=>{}}/>}
  </div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
  const mock=join(dir,'mocks.js');
  writeFileSync(mock,`
document.documentElement.style.setProperty('--safe-bottom','24px');
window.testStore={
 projects:[{id:'p1',name:'Project',path:'C:/fake',archived:false}],
 activeProjectId:'p1',activeSessionId:'s1',
 sessionsByProject:{p1:[{id:'s1',projectId:'p1',title:'Demo session',createdAt:Date.now(),updatedAt:Date.now()}]},
 sessionsHasMoreByProject:{p1:false},sessionsTotalByProject:{p1:1},
 archivedSessionsByProject:{p1:[]},pinnedSessions:[],expandedProjects:{p1:true},
 runningBySession:{},unreadBySession:{},commitGenModel:null,commitGenPrompt:'',
 gitChangeVersionByRepo:{},displayMode:'single',
 mobileViewer:{kind:'plan',plan:'sample plan'},closeMobileViewer:()=>{},
 setDisplayMode:async()=>{},startSession:async()=>{},renameSession:async()=>{},
 setSessionPinned:async()=>{},archiveSession:async()=>{},deleteSession:async()=>{},
 archiveProject:async()=>{},deleteProject:async()=>{},toggleProjectExpanded:()=>{},
 loadMoreSessions:async()=>{},selectProject:async()=>{},openTab:async()=>{}
};
window.testApi={
 theme:{get:async()=>({theme:'system'}),set:async({theme})=>({effective:theme})},
 session:{search:async()=>({sessions:[]})},
 file:{listDir:async()=>({entries:[{name:'demo.txt',path:'C:/fake/demo.txt',isDir:false},{name:'src',path:'C:/fake/src',isDir:true}]}),readFile:async()=>({content:'sample text'}),readBinary:async()=>({dataUrl:null})},
 git:{discoverRepos:async()=>({repos:[{path:'C:/fake',name:'fake'}]}),status:async()=>({status:{branch:'main',ahead:0,behind:0,files:[{path:'demo.txt',index:'unmodified',workingTree:'modified'}]}}),
 listBranches:async()=>({branches:{current:'main',detached:false,local:[{name:'main',label:'main',type:'local',current:true},{name:'feature',label:'feature',type:'local',current:false}],remote:[],tags:[]}}),
 onChanged:()=>()=>{},stage:async()=>{},unstage:async()=>{},diff:async()=>({diff:''})}
};
`);
  const esbuild=await import(pathToFileURL(pkg('esbuild@','esbuild/lib/main.js')).href);
  await esbuild.build({entryPoints:[entry],bundle:true,platform:'browser',format:'iife',jsx:'automatic',
    absWorkingDir:desktop,define:{'process.env.NODE_ENV':'"production"'},outfile:join(dir,'bundle.js'),
    logLevel:'error',loader:{'.css':'empty','.woff2':'empty','.woff':'empty','.ttf':'empty','.png':'empty','.svg':'empty'},
    plugins:[{name:'mobile-fixture-stubs',setup(b){
      b.onResolve({filter:/.*/},a=>{
        const raw=a.path;
        const alias=raw.startsWith('@renderer/');
        const relative=raw.startsWith('./')||raw.startsWith('../');
        if(!alias&&!relative)return undefined;
        const full=resolveTs(alias?join(root,raw.slice(10)):resolve(a.resolveDir,raw));
        if(full in stubs)return {path:full,namespace:'mock'};
        return alias?{path:full}:undefined;
      });
      b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:stubs[a.path],loader:'tsx',resolveDir:desktop}));
      if(process.env.MCODE_T04_MUTATE_SAFE==='1'){
        b.onLoad({filter:/MobileSettingsSheet\.tsx$/},a=>({
          contents:readFileSync(a.path,'utf8').replace('pb-[calc(1.5rem+var(--safe-bottom,0px))]','pb-0'),
          loader:'tsx',resolveDir:dirname(a.path)
        }));
      }
    }}],
  });
  const configPath=join(dir,'tailwind.config.cjs');
  writeFileSync(configPath,readFileSync(join(desktop,'tailwind.config.js'),'utf8')
    .replace('export default','module.exports =')
    .replace('content: ["./src/renderer/**/*.{ts,tsx,html}"]','content: '+JSON.stringify([root.replaceAll('\\','/')+'/**/*.{ts,tsx,html}',entry.replaceAll('\\','/')])));
  const css=buildTailwindCached({cliPath:pkg('tailwindcss@','tailwindcss/lib/cli.js'),configPath,inputCss:'src/renderer/styles.css',outPath:join(dir,'app.css'),cwd:desktop});
  if(css.status!==undefined&&css.status!==0)throw Error('tailwind failed');
  writeFileSync(join(dir,'index.html'),'<html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><div id="root" style="height:100dvh"></div><script src="/mocks.js"></script><script src="/bundle.js"></script></body></html>');
  // The shared CDP server deliberately only serves index.html,bundle.js,app.css;
  // append mocks to the index instead of widening the server surface.
  const html=readFileSync(join(dir,'index.html'),'utf8').replace('<script src="/mocks.js"></script>','<script>'+readFileSync(mock,'utf8')+'</script>');
  writeFileSync(join(dir,'index.html'),html);
  let failures=0, checks=0;
  await withAuditPage(dir,async(page)=>{
    for(const [width,height] of [[375,812],[768,1024]]){
      await page.size(width,height);
      for(const c of ['pairing','settings','drawer','drawer-actions','drawer-rename','files','git','branch','file-viewer','mobile-viewer','activity']){
        await page.goto('case='+c+(c==='pairing'?'&nonce=abc':''),'document.querySelector("[data-fixture]")');
        await page.sleep(380);
        if(c==='drawer-actions'||c==='drawer-rename'){
          await page.eval("(()=>{const el=document.querySelector('[aria-label=\"mobile.drawer.moreActions\"]');if(!el)throw Error('missing session row');el.click();return true})()");
          await page.sleep(280);
        }
        if(c==='drawer-rename'){
          await page.eval("(()=>{const el=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='common.rename');if(!el)throw Error('missing rename action');el.click();return true})()");
          await page.sleep(280);
        }
        const report=await page.eval(`(()=>{
          const targets=[...document.querySelectorAll('button,input,textarea,select')];
          const undersized=targets.filter(el=>{
            const r=el.getBoundingClientRect(),css=getComputedStyle(el);
            if(!r.width||!r.height||css.visibility==='hidden'||css.display==='none')return false;
            if(el.getAttribute('aria-hidden')==='true')return false;
            return r.height<43.5;
          }).map(el=>({tag:el.tagName,text:(el.getAttribute('aria-label')||el.title||el.textContent||el.placeholder||'').trim().slice(0,42),height:Math.round(el.getBoundingClientRect().height*10)/10,html:el.outerHTML.slice(0,220)}));
          const sheets=[...document.querySelectorAll('[class*="safe-bottom"]')].filter(el=>getComputedStyle(el).display!=='none').map(el=>({pad:parseFloat(getComputedStyle(el).paddingBottom),tag:el.tagName,classes:el.className}));
          const html=document.documentElement;
          return {overscroll:html.scrollWidth-html.clientWidth,undersized,sheets,errors:window.__mountError||null};
        })()`);
        const prefix=width+'x'+height+'/'+c;
        const verify=(name,ok,detail)=>{checks++;if(!ok){failures++;console.log('FAIL '+prefix+' '+name+' '+JSON.stringify(detail));}else console.log('ok '+prefix+' '+name);};
        verify('no horizontal scroll',report.overscroll<=0,report.overscroll);
        verify('all touch targets >=44px',report.undersized.length===0,report.undersized);
        verify('safe-area padding >=24px',report.sheets.every(s=>s.pad>=24)&&(!['settings','branch','activity','drawer-actions','drawer-rename'].includes(c)||report.sheets.length>0),report.sheets);
        verify('no React crash',!report.errors && !page.exceptions.length,page.exceptions);
        if(c==='drawer'||c==='settings'){
          // Close and reopen in the same viewport: transitions must not grow page width.
          await page.eval('window.__setOpen(false)');
          await page.sleep(250);
          const closed=await page.eval('document.documentElement.scrollWidth-document.documentElement.clientWidth');
          verify('closed without scroll',closed<=0,closed);
          await page.eval('window.__setOpen(true)');
          await page.sleep(250);
          const reopened=await page.eval('document.documentElement.scrollWidth-document.documentElement.clientWidth');
          verify('reopened without scroll',reopened<=0,reopened);
        }
      }
    }
  });
  console.log('mobile-viewport-smoke checks='+checks+' failures='+failures);
  if(failures)process.exitCode=1;
}finally{
  if(process.env.MCODE_T04_KEEP!=='1')rmSync(dir,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}
