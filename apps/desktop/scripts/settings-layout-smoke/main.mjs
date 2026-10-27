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
import {useToastStore} from ${JSON.stringify(join(root,'stores/toastStore.ts').replaceAll('\\','/'))};
window.React=React;
window.__store=useSessionStore;
// MC-046 焦点断言的夹具件:吐司栈挂在根级、在设置层与 inert 壳之外,拿它当
// "层外的可聚焦元素"探针(见下方 P4 的守卫)。
window.__toast=useToastStore;
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

/** 派发一次**真实**的 Tab 键(CDP 输入事件,走浏览器自己的焦点遍历 —— 不是
 *  在页面里手调 focus())。rawKeyDown + keyUp 是浏览器接受 Tab 的最短组合。 */
const pressTab=async(page,shift)=>{
  const base={modifiers:shift?8:0,windowsVirtualKeyCode:9,nativeVirtualKeyCode:9,code:'Tab',key:'Tab'};
  await page.send('Input.dispatchKeyEvent',{type:'rawKeyDown',...base});
  await page.send('Input.dispatchKeyEvent',{type:'keyUp',...base});
  await page.sleep(60);
};

/** 与 useFocusTrap 同一套「可聚焦」判据(见 hooks/useFocusTrap.ts 的
 *  FOCUSABLE_SELECTOR):断言数的是真实参与 Tab 的元素,不是"源码里写了什么"。 */
const FOCUSABLE_SEL=["a[href]","button:not([disabled])","input:not([disabled]):not([type='hidden'])","select:not([disabled])","textarea:not([disabled])","summary","[contenteditable]:not([contenteditable='false'])","[tabindex]:not([tabindex='-1'])"].join(",");

/** 把设置层内首/尾可聚焦元素存到 window 上,并返回总数 —— 供回绕断言比对。 */
const layerEndsExpr=`(()=>{const sel=${JSON.stringify(FOCUSABLE_SEL)};
  const root=document.querySelector(".settings-root");if(!root)return {count:0};
  const vis=el=>el.getClientRects().length>0&&getComputedStyle(el).visibility!=="hidden";
  const list=[...root.querySelectorAll(sel)].filter(vis);
  window.__firstFocusable=list[0]||null;window.__lastFocusable=list[list.length-1]||null;
  return {count:list.length};})()`;

/** 焦点现场:activeElement 是不是在设置层里 / 层外的 inert 后台里。 */
const focusWhereExpr=`(()=>{const a=document.activeElement;const root=document.querySelector(".settings-root");
  return {insideRoot:!!(root&&a&&root.contains(a)),activeIsBody:a===document.body,
    tag:a?a.tagName:null,inInert:!!(a&&a.closest&&a.closest("[inert]")),
    isFirst:a===window.__firstFocusable,isLast:a===window.__lastFocusable};})()`;

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

    // —— MC-046(焦点归还断言的锚):打开设置**前**,先在真实工作区里聚焦一个
    // 控件,并把元素记到 window 上;关闭设置后焦点必须回到它身上。——
    const preFocused=await page.eval(`(()=>{const sel=${JSON.stringify(FOCUSABLE_SEL)};
      const vis=el=>el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden';
      const list=[...document.querySelectorAll('[data-testid="workspace-main"] '+sel)].filter(vis);
      if(!list.length)return false;
      window.__preFocusTarget=list[0];
      window.__preFocusTarget.focus();
      return document.activeElement===window.__preFocusTarget;})()`);
    check('打开设置前能聚焦工作区控件(关闭后焦点归还断言的锚)',preFocused===true,preFocused);

    // MC-046 夹具:**层外**的可聚焦探针。吐司栈挂在根级、在设置层与 inert 壳
    // 之外 —— 若设置层不接管 Tab(或后台不 inert),原生 Tab 会停在这根吐司的
    // 关闭按钮上(台账登记的反例就是"第一下 Tab 落到覆盖层外的控件")。sticky
    // (duration=0)保证它全程活着;测完 clear。
    await page.eval(`window.__toast.getState().push({kind:'info',title:'MC-046 层外焦点探针',duration:0})`);
    await page.waitFor('document.querySelector("[data-toast-id] button")!==null');
    const toastReady=await page.eval(`(()=>{const t=document.querySelector("[data-toast-id]");const b=t&&t.querySelector("button");if(!b)return false;const r=b.getBoundingClientRect();return r.width>0&&r.height>0;})()`);
    if(toastReady!==true)throw Error('MC-046 夹具前置失败:层外吐司探针没有渲染出来(后续"不逃到层外"的断言会空过)');

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

    // ══════════ MC-046:设置层拥有键盘焦点 ══════════
    // 判据立在**用户可观察的焦点状态**上:activeElement 在哪、真实 Tab 键把焦点
    // 带到哪。不是断"源码里有没有调 focus()"。

    // 量层内首/尾可聚焦元素(与 useFocusTrap 同一套判据),供回绕断言比对。
    const ends=await page.eval(layerEndsExpr);
    check('设置层里的可聚焦元素足够做首尾回绕断言(夹具有效性)',ends.count>=3,ends);
    const firstText=await page.eval('window.__firstFocusable?window.__firstFocusable.textContent.slice(0,20):null');

    // 1) 打开设置后,焦点必须已经在设置层内(且不是 body)。
    const fOpen=await page.eval(focusWhereExpr);
    check('★ 打开设置后焦点立即落在设置层内(不是 BODY)',fOpen.insideRoot&&!fOpen.activeIsBody,{...fOpen,ends,firstText});
    // 2) 初始焦点就是层内第一个控件(设置标题栏的「返回工作区」按钮)。
    check('★ 初始焦点是层内第一个可聚焦控件(设置标题栏「返回工作区」按钮)',fOpen.isFirst&&typeof firstText==='string'&&firstText.includes('返回工作区'),{...fOpen,firstText});

    // 3) 后台整棵工作区被 inert —— 退出 Tab 序与辅助技术读序。
    const inertState=await page.eval(`(()=>{const w=document.querySelector("[data-testid=workspace-main]");return w?!!(w.closest("[inert]")):null;})()`);
    check('★ 后台工作区子树被 inert(整棵退出 Tab 序)',inertState===true,inertState);
    // 4) inert 真生效:后台控件即使被程序化聚焦也不接受(焦点不移动)。
    // ⚠️ 必须挑**可见的可聚焦**控件(与 preFocus 锚同一套判据)—— 拿第一个
    // `button` 可能撞上 display:none 保活子树里的按钮,那种本来就 focus() 不动,
    // 断言会假绿(实测:inert 不存在时它也绿)。
    const deepInert=await page.eval(`(()=>{const sel=${JSON.stringify(FOCUSABLE_SEL)};
      const vis=el=>el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden';
      const list=[...document.querySelectorAll('[data-testid="workspace-main"] '+sel)].filter(vis);
      if(!list.length)return {found:false};
      const b=list[0];b.focus();
      return {found:true,focusMoved:document.activeElement===b};})()`);
    check('★ 后台控件即使被程序化聚焦也不接受(inert 真生效)',deepInert.found&&!deepInert.focusMoved,deepInert);

    // 回绕断言前重取一次首/尾(懒加载面板落位后 DOM 可能已定稿,重取保证比对的是当前节点)。
    await page.eval(layerEndsExpr);

    // 5) 层内首控件上 Shift+Tab:回绕到层内**末**控件,不许逃到层外吐司/BODY。
    await page.eval('window.__firstFocusable.focus()');
    await pressTab(page,true);
    const fShift=await page.eval(focusWhereExpr);
    check('★ 首控件上 Shift+Tab 回绕到层内末控件,不逃到层外',fShift.insideRoot&&fShift.isLast,{...fShift,ends});

    // 6) 层内末控件上 Tab:回绕到层内**首**控件,不落进层外吐司。
    await page.eval('window.__lastFocusable.focus()');
    await pressTab(page,false);
    const fWrap=await page.eval(focusWhereExpr);
    check('★ 末控件上 Tab 回绕到层内首控件,不落进层外吐司',fWrap.insideRoot&&fWrap.isFirst,{...fWrap,ends});

    // 7) 自末控件起连续 Tab 五次,每一步焦点都还在设置层内(第一步回绕到首)。
    await page.eval('window.__lastFocusable.focus()');
    const trail=[];let allInside=true;
    for(let i=0;i<5;i++){
      await pressTab(page,false);
      const w=await page.eval(focusWhereExpr);
      trail.push({step:i+1,tag:w.tag,inside:w.insideRoot,isFirst:w.isFirst});
      if(!w.insideRoot)allInside=false;
    }
    check('★ 自末控件起连续 Tab 五次,每一步焦点都在设置层内',allInside&&trail[0].isFirst,trail);
    // ══════════ /MC-046 ══════════

    // ══════════ MC-045:设置**已打开**时的深链必须当场切栏 ══════════
    // 判据立在被高亮的那一项(左栏可视激活态)与内容区正文上 —— 台账红例就是
    // 「Store 改了、左栏高亮和内容停在原栏目」。
    /** 左栏当前被高亮(accent 竖条)的那一项的文字 —— active 的用户可见判据。 */
    const activeNavExpr=`(()=>{const nav=document.querySelector('.settings-root nav');if(!nav)return null;
      const marker=nav.querySelector('span.bg-accent');
      return marker&&marker.closest('button')?marker.closest('button').innerText.trim():null;})()`;
    const navBefore=await page.eval(activeNavExpr);
    check('MC-045 前置:此刻高亮在「常规」(夹具有效性)',navBefore==='常规',navBefore);

    // 1) 已打开时深链(跨面板跳转的真实调用形状:`setSettingsOpen(true, section)`)。
    await page.eval(`window.__store.getState().setSettingsOpen(true,"workflows")`);
    await page.sleep(350);
    const navAfterJump=await page.eval(activeNavExpr);
    /* 【UI 重建 2026-10-27】拿不到 `.settings-root` 时，把**控制台与异常**一并报出来。
     * 「页面还在但内容没了」最常见的两种原因（被错误边界接住、Suspense 永久挂起）
     * 都只在 console 里留痕，不在 exceptionThrown 里 —— 而 fixture 之前只收后者，
     * 于是日志干净得像什么都没发生。 */
    const bodyAfterJump=await page.eval('(document.querySelector(".settings-root")||{innerText:"<missing>"}).innerText');
    if (bodyAfterJump === "<missing>") {
      console.log('  [diag] exceptions=', JSON.stringify(page.exceptions ?? []).slice(0, 600));
      console.log('  [diag] console=', JSON.stringify(page.consoleMessages ?? []).slice(0, 1500));
    }
    check('★ 已打开时深链「workflows」:左栏高亮当场切到「工作流」',navAfterJump==='工作流',navAfterJump);
    check('★ 深链后内容区真的换成工作流页(不是停在上一个栏目)',bodyAfterJump.includes('工作流库'),bodyAfterJump.slice(0,160));

    // 2) 手动点导航(真实鼠标)切回「常规」——不被旧请求弹回(sleep 后仍停在常规)。
    const generalRect=await page.eval(`(()=>{const nav=document.querySelector('.settings-root nav');
      const b=[...nav.querySelectorAll('button')].find(e=>e.innerText.trim()==='常规');if(!b)return null;
      const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    if(generalRect){
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:generalRect.x,y:generalRect.y});
      await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:generalRect.x,y:generalRect.y});
    }
    await page.sleep(350);
    const navAfterManual=await page.eval(activeNavExpr);
    await page.sleep(250);
    const navAfterManualLate=await page.eval(activeNavExpr);
    check('★ 手动切回「常规」生效且不被过期深链弹回',navAfterManual==='常规'&&navAfterManualLate==='常规',{navAfterManual,navAfterManualLate});

    // 3) 遗留 id(`data-root` → 资料库类型)的深链同样当场切栏。
    await page.eval(`window.__store.getState().setSettingsOpen(true,"data-root")`);
    await page.sleep(350);
    check('★ 遗留 id「data-root」深链当场切到「文档管理」',(await page.eval(activeNavExpr))==='文档管理',await page.eval(activeNavExpr));

    // 3b) 【ARC-004 验收】Agent 的 open_settings 落在**同一状态机**上:契约把
    //     `section` 定义成自由字符串(`{op:"open_settings"; section?: string}`),所以
    //     MCP/插件/技能页与 Agent 三条路只要都调用 `setSettingsOpen(true, section)`,
    //     行为就一致。这里按 Agent 的真实调用形状再走一遍(与上面同一条实现),
    //     包括一个**合法**目标和一个**过期**目标。
    await page.eval(`window.__store.getState().setSettingsOpen(true,"engine-tools")`);
    await page.sleep(350);
    check('★ Agent open_settings 合法栏目(engine-tools)当场切栏',(await page.eval(activeNavExpr))==='引擎工具',await page.eval(activeNavExpr));
    await page.eval(`window.__store.getState().setSettingsOpen(true,"retired-agent-only")`);
    await page.sleep(350);
    check('★ Agent open_settings 过期栏目同样显式回退「常规」',(await page.eval(activeNavExpr))==='常规',await page.eval(activeNavExpr));

    // 3c) 收尾:回到「工作流」—— 下一段(焦点/关闭)假设当前仍在设置内且栏目合法。
    await page.eval(`window.__store.getState().setSettingsOpen(true,"workflows")`);
    await page.sleep(350);

    // 4) 未知栏目:显式回退到「常规」(有诊断 warn),不静默停在旧栏目上。
    // ⚠️ 先切到**非常规**(workflows),这样"回退到常规"才有判别力 —— 上一状态
    // 就是常规的话,变异(不消费请求)下这条会假绿(实测过)。
    await page.eval(`window.__store.getState().setSettingsOpen(true,"workflows")`);
    await page.sleep(350);
    await page.eval(`window.__store.getState().setSettingsOpen(true,"definitely-retired")`);
    await page.sleep(350);
    check('★ 未知深链栏目显式回退到「常规」(不再停在旧栏目)',(await page.eval(activeNavExpr))==='常规',await page.eval(activeNavExpr));
    // ══════════ /MC-045 ══════════

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

    // MC-046:关闭后焦点必须**归还**到打开前聚焦的工作区控件(不是 body、不是
    // 设置层里的按钮)。
    const restored=await page.eval(`document.activeElement===window.__preFocusTarget`);
    const restoredWhere=await page.eval(focusWhereExpr);
    check('★ 关闭设置后焦点归还到打开前那个工作区控件',restored===true,{restored,...restoredWhere});
    // 归还断言要有意义,后台必须先解除 inert —— 否则"焦点在工作区里"是 inert
    // 生效前的假象(顺带验证 inert 随关闭撤销,工作区回到可交互)。
    const inertCleared=await page.eval(`(()=>{const w=document.querySelector("[data-testid=workspace-main]");return w?!(w.closest("[inert]")):false;})()`);
    check('★ 关闭设置后工作区的 inert 被撤销(后台重新可交互)',inertCleared===true,inertCleared);

    // 清掉层外焦点探针,别让它影响后续断言/截图。
    await page.eval('window.__toast.getState().clear()');

    // MC-046 第二轮:键盘路径关闭(Escape 仍归 SettingsPage 自己的监听 —— hook
    // 不重复处理它)。打开 → 焦点在层内 → 按 Escape → 设置关闭且焦点再次归还。
    await page.eval(`window.__store.getState().setSettingsOpen(true)`);
    await page.waitFor('document.querySelector(".settings-root")!==null');
    await page.sleep(400);
    const fReopen=await page.eval(focusWhereExpr);
    if(fReopen.insideRoot){
      await page.send('Input.dispatchKeyEvent',{type:'rawKeyDown',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27,code:'Escape',key:'Escape'});
      await page.send('Input.dispatchKeyEvent',{type:'keyUp',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27,code:'Escape',key:'Escape'});
    }
    let escapedClosed=false;
    try{await page.waitFor('document.querySelector(".settings-root")===null',3000);escapedClosed=true;}catch{}
    await page.sleep(150);
    const fEscRestored=await page.eval(`document.activeElement===window.__preFocusTarget`);
    check('★ Escape 仍能关闭设置(SettingsPage 的 Escape 所有权未被 hook 顶掉)',escapedClosed,{fReopen});
    check('★ Escape 关闭后焦点同样归还到打开前的控件',escapedClosed&&fEscRestored===true,fEscRestored);

    check('全程没有未捕获异常',page.exceptions.length===0,page.exceptions.slice(0,3));

    await page.screenshot('settings-open.png');
  });
}finally{
  try{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{}
}
const failed=results.filter(x=>!x).length;
console.log(`\n${results.length-failed}/${results.length} passed`);
if(failed)throw Error(`${failed} settings-layout assertions failed`);
