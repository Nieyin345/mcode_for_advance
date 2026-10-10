/**
 * 右栏两个面板的真浏览器核对台 —— 「原生子代理归任务列表，不归对话列表」。
 *
 * 起因（2026-10-10，用户报）：右栏「工作流运行」页下半嵌着 `SideChatPanel`，它的列表里
 * **混了两种东西** —— Claude Code 原生 Task 子代理（主对话行 `subagents` 字段的名册快照，
 * **不是会话**）和 mcode 自己的子对话（`kind: "side"`，**是真会话**）。用户原话：
 * 「这两个子代理放在一起不合理呀，你把原生的子代理放到终端列表里面去」。
 *
 * 本台把**真组件**挂进真 Chrome（只桩掉 store 与 api，组件本身是真的），量三件事：
 *
 *   1. 「任务列表」页里**有**原生子代理 —— 含**跑完的**（从前只列 running，跑完的就哪儿都
 *      看不见了），每行带状态文字；
 *   2. 那一页**有**「清空已结束」，点一下已结束的真的消失、正在跑的不动；
 *   3. 「对话列表」（`SideChatPanel`）里**不再**出现原生子代理那一组。
 *
 * 判据全落在**看得见的文字与行数**上，不落在源码写了什么 class。
 */
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readdirSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,copyFileSync,existsSync,rmSync,statSync} from 'node:fs';
import {buildTailwindCached} from '../lib/tailwind-cache.mjs';
import {withAuditPage} from './browser.mjs';

const source=dirname(fileURLToPath(import.meta.url));
const desktop=resolve(source,'../..');
const root=join(desktop,'src/renderer');
const pnpm=resolve(desktop,'../../node_modules/.pnpm');
const pkg=(prefix,sub)=>{
  const n=readdirSync(pnpm).filter(n=>n.startsWith(prefix)).sort().at(-1);
  if(!n)throw Error('Missing installed dependency '+prefix);
  return join(pnpm,n,'node_modules',sub);
};
mkdirSync(join(desktop,'.tmp'),{recursive:true});
const dir=mkdtempSync(join(desktop,'.tmp','subagent-lists-'));

/** 把源码里写的 `.js` 说明符解析成磁盘上真实的 `.ts` / `.tsx`（本仓一律写 `.js`）。 */
const resolveTs=(p)=>{
  const candidates=[p,p.replace(/\.js$/,'.tsx'),p.replace(/\.js$/,'.ts'),p+'/index.ts',p+'/index.tsx'];
  for(const c of candidates){try{if(statSync(c).isFile())return c.replaceAll('\\','/');}catch{}}
  return p.replaceAll('\\','/');
};
const abs=(rel)=>join(root,rel).replaceAll('\\','/');

// 只换**必须**换的一处：真 Chrome 里没有 preload 桥。
//
// ⚠️ **store 不换**。一开始想连 store 一起桩掉（喂固定名册），但 `SideChatPanel` 拖着
// `ChatPane` 那一大串，它们要的 `EMPTY_MESSAGES` 之类的稳定空数组都存在真模块里 ——
// 桩掉一个 hook 就会把整棵 import 图碰断（12 个 "No matching export"）。改用
// **真 store + `setState` 播种**（zustand 本来就是这个用法），一行桩都不用打。
const stubs={
  [abs('lib/api.ts')]:'export const api=window.labApi;',
};

const esbuild=await import(pathToFileURL(pkg('esbuild@','esbuild/lib/main.js')).href);

const entry=join(dir,'entry.tsx');
writeFileSync(entry,`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {TaskListPanel} from ${JSON.stringify(join(root,'components/ide/TaskListPanel.tsx').replaceAll('\\','/'))};
import {SideChatPanel} from ${JSON.stringify(join(root,'components/chat/SideChatPanel.tsx').replaceAll('\\','/'))};
import {useSessionStore} from ${JSON.stringify(join(root,'stores/sessionStore.ts').replaceAll('\\','/'))};
window.React=React;

// 一个**固定**的名册：2 个跑完的 + 1 个正在跑的。判据就靠这三条。
const agents=[
  {taskId:'t_done_1',toolUseId:'tu1',description:'Running List non-node_modules top files',subagentType:'general-purpose',status:'completed',totalTokens:12000,toolUses:7,durationMs:41000},
  {taskId:'t_done_2',toolUseId:'tu2',description:'Running Search memory markers',subagentType:'general-purpose',status:'killed',totalTokens:3000,toolUses:2,durationMs:8000},
  {taskId:'t_run_1',toolUseId:'tu3',description:'Running Locate update/lsp anchors',subagentType:'general-purpose',status:'running',totalTokens:500,toolUses:1,durationMs:2000,lastToolName:'Grep'},
];
// 真 store + 播种。**用真 store 而不是桩**：清空已结束那条动作就是要验的真实现，
// 而它读写的正是这些格子。
useSessionStore.setState({
  streamSessions:[{id:'s_main',title:'主对话',projectId:'p1',kind:'chat',archived:false}],
  activeSessionId:'s_main',activeProjectId:'p1',activeSideChatId:null,
  sideChatsByParent:{},sessionsByProject:{p1:[{id:'s_main',title:'主对话',projectId:'p1',kind:'chat',archived:false}]},
  pinnedSessions:[],runningBySession:{},workflowNodeTranscripts:{},
  subagentTranscriptsBySession:{},
  subagentsBySession:{s_main:agents},
});

const q=new URLSearchParams(location.search);
const Which=q.get('panel')==='chat'?SideChatPanel:TaskListPanel;
createRoot(document.getElementById('root')).render(React.createElement(Which));
window.__mounted=true;
`);

await esbuild.build({
  entryPoints:[entry],bundle:true,platform:'browser',format:'iife',jsx:'automatic',
  absWorkingDir:desktop,define:{'process.env.NODE_ENV':'"production"'},outfile:join(dir,'bundle.js'),
  logLevel:'error',
  loader:{'.css':'empty','.woff2':'empty','.woff':'empty','.ttf':'empty','.png':'empty','.svg':'empty'},
  plugins:[{name:'stand-stubs',setup(b){
    b.onResolve({filter:/\?(worker|url|raw)$/},a=>({path:a.path,external:true}));
    b.onResolve({filter:/.*/},a=>{
      if(a.kind!=='import-statement'&&a.kind!=='require-call'&&a.kind!=='dynamic-import')return undefined;
      const raw=a.path;
      const isAlias=raw.startsWith('@renderer/');
      const isRel=raw.startsWith('./')||raw.startsWith('../');
      if(!isAlias&&!isRel)return undefined;
      const resolved=resolveTs(isAlias?join(root,raw.slice(10)):resolve(a.resolveDir,raw));
      if(resolved in stubs)return {path:resolved,namespace:'mock'};
      return isAlias?{path:resolved}:undefined;
    });
    b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:stubs[a.path],loader:'tsx',resolveDir:desktop}));
  }}],
});

const configPath=join(dir,'tailwind.config.cjs');
writeFileSync(configPath,readFileSync(join(desktop,'tailwind.config.js'),'utf8')
  .replace('export default','module.exports =')
  .replace('content: ["./src/renderer/**/*.{ts,tsx,html}"]','content: '+JSON.stringify([root.replaceAll('\\','/')+'/**/*.{ts,tsx,html}'])));
const css=buildTailwindCached({cliPath:pkg('tailwindcss@','tailwindcss/lib/cli.js'),configPath,inputCss:'src/renderer/styles.css',outPath:join(dir,'app.css'),cwd:desktop});
if(css.status!==undefined&&css.status!==0)throw Error('tailwind failed');

copyFileSync(join(source,'browser.mjs'),join(dir,'browser.mjs'));
// API 桩必须写在 HTML 的 script 里（`lib/api.ts` 在模块求值那一刻就选定 transport）。
const apiStub=`window.labApi=new Proxy({},{get:function(_t,ns){
  if(ns==='then')return undefined;
  if(typeof ns!=='string')return undefined;
  if(ns==='on')return new Proxy({},{get:function(){return function(){return function(){};};}});
  if(ns==='terminal')return {list:function(){return Promise.resolve({terminals:[]});},kill:function(){return Promise.resolve({ok:true});}};
  return new Proxy(function(){},{get:function(_t2,p){
    if(p==='then')return undefined;
    return function(){return Promise.resolve({});};
  }});
}});`;
writeFileSync(join(dir,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  +'<title>Subagent list placement</title><link rel="stylesheet" href="/app.css"></head>'
  +'<body><div id="root" style="height:640px"></div><script>'+apiStub+'</script><script src="/bundle.js"></script></body></html>');

const results=[];
const check=(name,ok,detail)=>{results.push(!!ok);console.log(`${ok?'PASS':'FAIL'} ${name}${ok||detail===undefined?'':' — '+JSON.stringify(detail)}`);};

try{
  await withAuditPage(dir,async page=>{
    // ── A. 任务列表页:原生子代理在这儿,含跑完的 ──
    await page.goto('panel=tasks','window.__mounted===true');
    await page.waitFor('document.body.innerText.includes("子代理")');
    await page.sleep(300);
    const tasksText=await page.eval('document.body.innerText');
    check('任务列表页里有子代理那一组',tasksText.includes('子代理'),tasksText.slice(0,80));
    check('★ 跑完的子代理**也在**列表里(从前只列 running)',tasksText.includes('Running List non-node_modules top files'),tasksText.slice(0,300));
    check('★ 正在跑的那个也在',tasksText.includes('Running Locate update/lsp anchors'),tasksText.slice(0,300));
    check('★ 每行带状态文字(不是只有一个名字)',
      /运行中|已完成|已停止|失败/.test(tasksText), tasksText.slice(0,300));
    check('★ 有「清空已结束」且带着条数(2 条跑完的)',(await page.eval('document.body.innerText')).includes('清空已结束(2)'),tasksText.slice(0,300));
    // 停止按钮只该出现在正在跑的那一行上（正在跑 1 个，所以 title 恰好 1 个）。
    const stopBtns=await page.eval(`[...document.querySelectorAll('[title="停掉这个子代理"]')].length`);
    check('★ 只有正在跑的那一行有停止按钮',stopBtns===1,stopBtns);

    // ── B. 点「清空已结束」→ 跑完的消失,正在跑的不动 ──
    await page.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('清空已结束'))?.click()`);
    await page.sleep(250);
    const afterClear=await page.eval('document.body.innerText');
    check('★ 点过之后跑完的那条没了',!afterClear.includes('Running List non-node_modules top files'),afterClear.slice(0,300));
    check('★ 正在跑的那条**没被误清**',afterClear.includes('Running Locate update/lsp anchors'),afterClear.slice(0,300));
    check('清空之后按钮本身也收掉了(没有已结束的了)',!afterClear.includes('清空已结束'),afterClear.slice(0,200));

    // ── C. 对话列表页:原生子代理**不该**在这儿 ──
    await page.goto('panel=chat','window.__mounted===true');
    await page.sleep(400);
    const chatText=await page.eval('document.body.innerText');
    check('★ 对话列表里**没有**原生子代理那一组',!chatText.includes('Running List non-node_modules top files')&&!chatText.includes('Running Search memory markers'),chatText.slice(0,300));
    check('★ 也没有留下那个「子代理」分组标题',!chatText.includes('子代理'),chatText.slice(0,300));
    check('对话列表自己还在(主对话那一行仍渲染)',chatText.length>0,chatText.slice(0,120));
    check('全程没有未捕获异常',page.exceptions.length===0,page.exceptions.slice(0,3));

    await page.screenshot('subagent-lists.png');
  });
}finally{
  try{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{}
}
const failed=results.filter(x=>!x).length;
console.log(`\n${results.length-failed}/${results.length} passed`);
if(failed)throw Error(`${failed} subagent-list assertions failed`);
