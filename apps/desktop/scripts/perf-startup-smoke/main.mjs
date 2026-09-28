// perf-startup-smoke — guards the renderer's first-paint JS.
//
// App.tsx is already a lazy chunk of main.tsx; everything it imports
// *statically* is parsed before the workspace can paint. A single static
// import (e.g. SettingsPage -> MemoryExplorerPanel -> Monaco) silently drags
// multi-MB editors back onto that path, so this suite bundles the renderer with
// esbuild (code splitting, metafile) and asserts:
//   1. none of the heavy on-demand libraries is statically reachable from App;
//   2. each of them is still present in the bundle (reachable dynamically) —
//      i.e. the feature was deferred, not dropped;
//   3. the App static closure stays under a byte budget.
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readdirSync,statSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
const here=dirname(fileURLToPath(import.meta.url)),desktop=resolve(here,'../..');
const root=join(desktop,'src/renderer'),contracts=resolve(desktop,'../../packages/contracts/src');
const pnpm=resolve(desktop,'../../node_modules/.pnpm');
const pkg=(p,s)=>{const n=readdirSync(pnpm).filter(n=>n.startsWith(p)).sort().at(-1);if(!n)throw Error('Missing installed dependency '+p+' (no network install)');return join(pnpm,n,'node_modules',s);};
const esbuild=await import(pathToFileURL(pkg('esbuild@','esbuild/lib/main.js')).href);
const isFile=p=>{try{return statSync(p).isFile();}catch{return false;}};
const rs=p=>{if(isFile(p))return p;const b=p.replace(/\.js$/,'');for(const c of [b+'.tsx',b+'.ts',b+'/index.ts',b+'/index.tsx'])if(isFile(c))return c;return p;};
mkdirSync(join(desktop,'.tmp'),{recursive:true});
const out=mkdtempSync(join(desktop,'.tmp','perf-startup-'));
const results=[];
const check=(name,ok,detail)=>{results.push(!!ok);console.log(`${ok?'PASS':'FAIL'} ${name}${ok||detail===undefined?'':' — '+detail}`);};
try{
  const r=await esbuild.build({entryPoints:[join(root,'main.tsx')],bundle:true,splitting:true,format:'esm',platform:'browser',outdir:out,write:false,metafile:true,minify:true,jsx:'automatic',absWorkingDir:desktop,logLevel:'error',
    define:{'process.env.NODE_ENV':'"production"'},
    loader:{'.css':'empty','.woff2':'empty','.woff':'empty','.ttf':'empty','.png':'empty','.svg':'empty','.wasm':'empty'},
    plugins:[{name:'renderer-paths',setup(b){
      b.onResolve({filter:/\?(worker|url|raw)/},a=>({path:a.path,external:true}));
      b.onResolve({filter:/^@renderer\//},a=>({path:rs(join(root,a.path.slice(10)))}));
      b.onResolve({filter:/^@contracts\//},a=>({path:rs(join(contracts,a.path.slice(11)))}));
    }}]});
  const {inputs,outputs}=r.metafile;
  const appIn=Object.keys(inputs).find(k=>/src\/renderer\/App\.tsx$/.test(k));
  check('renderer bundles and App.tsx is found', !!appIn);
  // Static module closure of App.tsx (import-statement / require only).
  const reach=new Map([[appIn,null]]);const q=[appIn];
  while(q.length){const c=q.shift();for(const i of inputs[c]?.imports??[]){if(i.external||i.kind==='dynamic-import'||reach.has(i.path))continue;reach.set(i.path,c);q.push(i.path);}}
  const short=p=>p.replace(/^.*node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?/,'npm:').replace(/^.*src\/renderer\//,'R/');
  const chain=p=>{const c=[];for(let x=p;x;x=reach.get(x))c.unshift(short(x));return c.join(' -> ');};
  const HEAVY=[
    ['Monaco editor','/node_modules/monaco-editor/'],
    ['@monaco-editor/react','/@monaco-editor/react/'],
    ['Milkdown markdown editor','/@milkdown/'],
    ['CodeMirror (via Milkdown)','/@codemirror/'],
    ['Vue runtime (via Milkdown)','/@vue/runtime-core/'],
    ['EmbedPDF viewer','/@embedpdf/'],
    ['xterm','/@xterm/xterm/'],
    ['material-icon-theme collection','/@iconify-json/material-icon-theme/'],
    ['docx-preview','/docx-preview/'],
    ['pptx-preview','/pptx-preview/'],
    ['@js-preview/excel','/@js-preview/excel/'],
  ];
  const norm=p=>p.replaceAll('\\','/');
  for(const [label,frag] of HEAVY){
    const hit=[...reach.keys()].find(k=>norm(k).includes(frag));
    check(`★ ${label} is not in App's static import graph`, !hit, hit&&chain(hit));
    const present=Object.keys(inputs).some(k=>norm(k).includes(frag));
    check(`   ${label} is still bundled (loaded on demand)`, present, 'not found in any output');
  }
  // Byte budget: outputs holding any module of App's static closure.
  let bytes=0;const reachSet=new Set(reach.keys());
  for(const o of Object.values(outputs))for(const [m,v] of Object.entries(o.inputs))if(reachSet.has(m))bytes+=v.bytesInOutput;
  const BUDGET=4*1024*1024;
  console.log(`App static closure: ${(bytes/1024).toFixed(0)}KB minified (budget ${(BUDGET/1024).toFixed(0)}KB)`);
  check('★ App static closure within budget', bytes<=BUDGET, `${(bytes/1024).toFixed(0)}KB`);
}finally{try{rmSync(out,{recursive:true,force:true});}catch{}}
const failed=results.filter(x=>!x).length;
console.log(`\n${results.length-failed}/${results.length} passed`);
if(failed)throw Error(`${failed} perf-startup assertions failed`);
