/**
 * App-shell 布局回归台 —— 「打开设置不许动工作区的布局」。
 *
 * 起因(2026-10-10,用户报「点设置很卡」):设置覆盖层从前是 `absolute inset-0`,
 * 而它只在「左栏先被 `display:none`」之后才横跨全宽 —— 于是每次点设置,那个 flex
 * 兄弟从 0 宽弹回 20% 宽,右边整棵工作区跟着重排:对话虚拟列表重新测量折行、
 * Files 树(未虚拟化)整棵重排、每个挂着的 TerminalView 重新 fit 并发一条
 * `pty.resize`。全发生在**被覆盖层盖住、用户看不见**的树上。
 *
 * 本台把**真的 `App`** 挂进真 Chrome,只把面板内容换成占位(布局外壳是真的),
 * 于是可以用几何断言把那条不变量钉住:
 *
 *   1. 打开设置前后,左栏的 rect(位置+宽度)必须**逐像素相同**;
 *   2. 打开设置前后,主列的 rect 也必须相同(它不该被撑宽);
 *   3. 设置覆盖层必须覆盖整个窗口(左边缘到 0),否则"盖住了"就不成立;
 *   4. 关闭设置后一切复原,且工作区子树全程没有被卸载(终端保活的根据)。
 *
 * 判据立在**用户能看见的几何**上,而不是"源码里写了什么 class"。
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
const dir=mkdtempSync(join(desktop,'.tmp','settings-layout-'));

// ── 只换**必须**换的几处 ──
// 判据:模块在真 Chrome 里**跑不起来**(没有 preload / 没有 Electron),才换桩。
// 凡是纯 DOM / 纯逻辑的模块一律走真源码 —— 被量的外壳必须是真外壳。
//   · api            —— 真 Chrome 没有 preload 桥
//   · monacoSetup    —— 引 `?worker` 资源,esbuild 解析不了,且本台不需要编辑器
//
// 下面这几支**只把"面板内容"换成空壳**:被测的是外壳的布局(aside 的宽度、
// 主列的宽度、覆盖层盖到哪),而这些深层组件会去读各自的 store(工作区里就有
// 一个空项目的资料库树),空数据下它们自己会炸 —— 那和布局无关。它们**只被
// App.tsx 引用**,所以换掉不影响任何外壳决策。
// 桩按**解析后的绝对路径**匹配 —— App.tsx 用的是相对路径(`./components/...`),
// 别处用 `@renderer/...`,只按包名匹配会漏掉一半。`abs()` 把两种写法归一到同一个键。
/** 把源码里写的 `.js` 说明符解析成磁盘上真实的 `.ts` / `.tsx`(本仓一律写 `.js`)。 */
const resolveTs=(p)=>{
  const candidates=[p,p.replace(/\.js$/,'.tsx'),p.replace(/\.js$/,'.ts'),p+'/index.ts',p+'/index.tsx'];
  for(const c of candidates){try{if(statSync(c).isFile())return c.replaceAll('\\','/');}catch{}}
  return p.replaceAll('\\','/');
};
const abs=(rel)=>join(root,rel).replaceAll('\\','/');
const stubs={
  [abs('lib/api.ts')]:'export const api=window.labApi;',
  [abs('lib/monacoSetup.ts')]:'export const monacoSetup=()=>{};export default {};',
  [abs('components/layout/LeftBar.tsx')]:'export const LeftBar=()=>window.React.createElement("div",{"data-testid":"left-bar"},"左栏占位");',
  [abs('components/layout/StreamSidebar.tsx')]:'export const StreamSidebar=()=>window.React.createElement("div",{"data-testid":"stream-sidebar"},"流式侧栏占位");',
  // 设置页:**不换** —— 本台要连同真实设置页一起量(它的懒加载面板全部走真源码)。
  // 「常规」页只碰 `setting.get/set`,以及 store 里几个数组字段;桩给对形状就够。
};

const esbuild=await import(pathToFileURL(pkg('esbuild@','esbuild/lib/main.js')).href);

/** 挂一个**父容器**当"窗口":App 的根是 `h-full w-full`,没有父容器就是 0 高。 */
const entry=join(dir,'entry.tsx');
writeFileSync(entry,`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from ${JSON.stringify(join(root,'App.tsx').replaceAll('\\','/'))};
import {useSessionStore} from ${JSON.stringify(join(root,'stores/sessionStore.ts').replaceAll('\\','/'))};
window.React=React;
window.__store=useSessionStore;
try{
  createRoot(document.getElementById('root')).render(<App/>);
  window.__mounted=true;
}catch(e){
  window.__mountError=String(e&&e.stack||e);
  throw e;
}
`);

await esbuild.build({
  entryPoints:[entry],bundle:true,platform:'browser',format:'iife',jsx:'automatic',
  absWorkingDir:desktop,define:{'process.env.NODE_ENV':'"production"'},outfile:join(dir,'bundle.js'),
  logLevel:'error',
  loader:{'.css':'empty','.woff2':'empty','.woff':'empty','.ttf':'empty','.png':'empty','.svg':'empty'},
  plugins:[{name:'shell-stubs',setup(b){
    b.onResolve({filter:/\?(worker|url|raw)$/},a=>({path:a.path,external:true}));
    // 只接管两种写法:`@renderer/...` 与相对路径。裸包名(含 CJS 的
    // `require("./utilities")` 这种由 esbuild 自己解析的)一律放行 —— 越界接管会把
    // 依赖里的内部 require 换错。
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
// ⚠️ API 桩必须写在 HTML 的 `<script>` 里,**不能写在 entry.tsx 里** —— `lib/api.ts`
// 在**模块求值那一刻**决定用哪套 transport(`window.api ?? createWebApi()`),而 ES 的
// import 先于模块体执行。写在 entry 里的话,App 链路上的模块早就import完了。
// (同 scripts/flow-preview 与 docs/前端怎么核对.md 记着的那条坑。)
const apiStub=`
window.labApi={};
(function(){
  var noopSub=function(){return function(){};};
  var nsProto={};
  function makeNs(){
    return new Proxy(function(){},{
      get:function(_t,prop){
        if(prop==='then')return undefined;
        if(prop==='on')return noopSub;
        if(typeof prop!=='string')return undefined;
        return function(){return Promise.resolve({});};
      }
    });
  }
  var fixed={
    setting:{get:function(){return Promise.resolve({value:null});},getMany:function(){return Promise.resolve({});},set:function(){return Promise.resolve({ok:true});}},
    project:{list:function(){return Promise.resolve({projects:[]});}},
    session:{listPinned:function(){return Promise.resolve({sessions:[]});},list:function(){return Promise.resolve({sessions:[]});}},
    customModel:{list:function(){return Promise.resolve({models:[]});}},
    outputStyle:{list:function(){return Promise.resolve({styles:[]});}},
    workflow:{list:function(){return Promise.resolve({workflows:[]});},agentProfiles:function(){return Promise.resolve({profiles:[],problems:[]});}},
    automation:{statusAll:function(){return Promise.resolve({statuses:{}});}},
    library:{groupsGet:function(){return Promise.resolve({groups:[]});}},
    modules:{catalog:function(){return Promise.resolve({modules:[]});}}
  };
  void nsProto;
  window.labApi=new Proxy({},{
    get:function(_t,ns){
      if(ns==='then')return undefined;
      if(typeof ns!=='string')return undefined;
      if(ns==='on')return new Proxy({},{get:function(){return noopSub;}});
      if(Object.prototype.hasOwnProperty.call(fixed,ns))return fixed[ns];
      return makeNs();
    }
  });
})();
`;
writeFileSync(join(dir,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  +'<title>Settings layout regression</title><link rel="stylesheet" href="/app.css"></head>'
  +'<body><div id="root" style="height:900px"></div><script>'+apiStub+'</script><script src="/bundle.js"></script></body></html>');

const results=[];
const check=(name,ok,detail)=>{results.push(!!ok);console.log(`${ok?'PASS':'FAIL'} ${name}${ok||detail===undefined?'':' — '+JSON.stringify(detail)}`);};

/** 量一根几何:`aside[data-testid=...]` 的 rect。 */
const rectExpr=(sel)=>`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};})()`;

try{
  await withAuditPage(dir,async page=>{
    await page.goto('', 'window.__mounted===true');
    await page.waitFor('document.querySelector("[data-testid=workspace-sidebar]")!==null && document.querySelector("[data-testid=workspace-main]")!==null');
    await page.sleep(400);

    const before={
      sidebar:await page.eval(rectExpr('[data-testid="workspace-sidebar"]')),
      main:await page.eval(rectExpr('[data-testid="workspace-main"]')),
    };
    check('工作区左栏已渲染',before.sidebar&&before.sidebar.w>0,before.sidebar);
    check('主列已渲染',before.main&&before.main.w>0,before.main);

    // 像用户那样打开设置:走 store 的同一个动作。
    await page.eval(`window.__store.getState().setSettingsOpen(true)`);
    await page.waitFor('document.querySelector(".settings-root")!==null');
    await page.sleep(400);

    const during={
      sidebar:await page.eval(rectExpr('[data-testid="workspace-sidebar"]')),
      main:await page.eval(rectExpr('[data-testid="workspace-main"]')),
      overlay:await page.eval(rectExpr('.settings-root')),
      page:await page.eval('document.querySelector(".settings-root nav")!==null'),
    };
    check('★ 打开设置后左栏几何逐像素不变',JSON.stringify(before.sidebar)===JSON.stringify(during.sidebar),{before:before.sidebar,during:during.sidebar});
    check('★ 打开设置后主列几何逐像素不变',JSON.stringify(before.main)===JSON.stringify(during.main),{before:before.main,during:during.main});
    // 覆盖层必须**盖住左栏那块矩形**(它是用户能看见的判据)。⚠️ 从前这里断的是
    // "左边缘贴 0" —— 但覆盖层挂在根上时 `absolute` 同样贴 0,那条断言撤掉修复也
    // 不会红(实测过)。改成"覆盖层的矩形包含左栏的矩形":覆盖层一旦只盖主列而没盖
    // 左栏(旧结构),这条就红。
    const covers=!!during.overlay&&!!before.sidebar
      && during.overlay.x<=before.sidebar.x
      && during.overlay.y<=before.sidebar.y
      && during.overlay.x+during.overlay.w>=before.sidebar.x+before.sidebar.w
      && during.overlay.y+during.overlay.h>=before.sidebar.y+before.sidebar.h;
    check('★ 覆盖层盖住了整条左栏(含其矩形)',covers,{overlay:during.overlay,sidebar:before.sidebar});
    check('设置页真的渲染出来了',during.page);
    // 真面板(不是空壳):导航里应出现「常规」,内容区应出现它的小节标题。
    const navText=await page.eval('document.querySelector(".settings-root nav").innerText');
    const bodyText=await page.eval('document.querySelector(".settings-root").innerText');
    check('导航里列出了「常规」',navText.includes('常规'),navText.slice(0,60));
    check('「常规」页的内容真的渲染了(不是空壳/错误页)',bodyText.includes('语言')||bodyText.includes('显示'),bodyText.slice(0,120));
    check('工作区子树没有被卸载(终端保活)',during.sidebar!==null);

    // 真正的退出路径:设置自己那条标题栏上的「返回工作区」按钮(鼠标点,不是调 store)。
    const backRect=await page.eval(`(()=>{const b=[...document.querySelectorAll('.settings-root button')].find(e=>e.textContent.includes('返回工作区'));if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    check('设置标题栏有「返回工作区」按钮',backRect!==null,backRect);
    if(backRect){
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:backRect.x,y:backRect.y});
      await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:backRect.x,y:backRect.y});
    }
    await page.waitFor('document.querySelector(".settings-root")===null');
    await page.sleep(300);
    const after={
      sidebar:await page.eval(rectExpr('[data-testid="workspace-sidebar"]')),
      main:await page.eval(rectExpr('[data-testid="workspace-main"]')),
    };
    check('关闭设置后左栏复原',JSON.stringify(before.sidebar)===JSON.stringify(after.sidebar),after.sidebar);
    check('关闭设置后主列复原',JSON.stringify(before.main)===JSON.stringify(after.main),after.main);
    check('全程没有未捕获异常',page.exceptions.length===0,page.exceptions.slice(0,3));

    await page.screenshot('settings-open.png');
  });
}finally{
  try{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{}
}
const failed=results.filter(x=>!x).length;
console.log(`\n${results.length-failed}/${results.length} passed`);
if(failed)throw Error(`${failed} settings-layout assertions failed`);
