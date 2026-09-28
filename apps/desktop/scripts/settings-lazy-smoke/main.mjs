// settings-lazy-smoke — guards the first open of the settings overlay.
//
// SettingsPage used to import all ~25 panels statically, so the first click on
// the gear fetched + evaluated ~6MB (Monaco via MemoryExplorerPanel). This
// suite bundles the real renderer with esbuild (code splitting, metafile) and
// asserts:
//   1. no editor/viewer engine is in SettingsPage's static import graph;
//   2. no panel module is in that graph (each is its own lazy chunk) while
//      every panel is still bundled — deferred, not dropped;
//   3. what SettingsPage adds on top of App's static closure fits a budget;
//   4. App warms the settings shell at idle, and SettingsPage prefetches only
//      light panels (never the Monaco-backed memory panel).
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readdirSync,readFileSync,statSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
const here=dirname(fileURLToPath(import.meta.url)),desktop=resolve(here,'../..');
const root=join(desktop,'src/renderer'),contracts=resolve(desktop,'../../packages/contracts/src');
const pnpm=resolve(desktop,'../../node_modules/.pnpm');
const pkg=(p,s)=>{const n=readdirSync(pnpm).filter(n=>n.startsWith(p)).sort().at(-1);if(!n)throw Error('Missing installed dependency '+p+' (no network install)');return join(pnpm,n,'node_modules',s);};
const esbuild=await import(pathToFileURL(pkg('esbuild@','esbuild/lib/main.js')).href);
const isFile=p=>{try{return statSync(p).isFile();}catch{return false;}};
const rs=p=>{if(isFile(p))return p;const b=p.replace(/\.js$/,'');for(const c of [b+'.tsx',b+'.ts',b+'/index.ts',b+'/index.tsx'])if(isFile(c))return c;return p;};
mkdirSync(join(desktop,'.tmp'),{recursive:true});
const out=mkdtempSync(join(desktop,'.tmp','settings-lazy-'));
const results=[];
const check=(name,ok,detail)=>{results.push(!!ok);console.log(`${ok?'PASS':'FAIL'} ${name}${ok||detail===undefined?'':' — '+detail}`);};
const norm=p=>p.replaceAll('\\','/');
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
  const find=re=>Object.keys(inputs).find(k=>re.test(norm(k)));
  const appIn=find(/src\/renderer\/App\.tsx$/),setIn=find(/src\/renderer\/components\/settings\/SettingsPage\.tsx$/);
  check('renderer bundles; App.tsx and SettingsPage.tsx are found', !!appIn&&!!setIn);
  const closure=start=>{const reach=new Map([[start,null]]);const q=[start];
    while(q.length){const c=q.shift();for(const i of inputs[c]?.imports??[]){if(i.external||i.kind==='dynamic-import'||reach.has(i.path))continue;reach.set(i.path,c);q.push(i.path);}}
    return reach;};
  const app=closure(appIn),set=closure(setIn);
  const short=p=>norm(p).replace(/^.*node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?/,'npm:').replace(/^.*src\/renderer\//,'R/');
  const chain=p=>{const c=[];for(let x=p;x;x=set.get(x))c.unshift(short(x));return c.join(' -> ');};
  const HEAVY=[['Monaco editor','/node_modules/monaco-editor/'],['@monaco-editor/react','/@monaco-editor/react/'],
    ['Milkdown','/@milkdown/'],['CodeMirror','/@codemirror/'],['EmbedPDF','/@embedpdf/'],['xterm','/@xterm/xterm/'],
    ['docx-preview','/docx-preview/'],['pptx-preview','/pptx-preview/'],['@js-preview/excel','/@js-preview/excel/'],
    ['Monaco setup (workers/themes)','src/renderer/lib/monacoSetup.ts'],['FileEditor','src/renderer/components/ide/FileEditor.tsx']];
  for(const [label,frag] of HEAVY){
    const hit=[...set.keys()].find(k=>norm(k).includes(frag));
    check(`★ ${label} is not in SettingsPage's static import graph`, !hit, hit&&chain(hit));
  }
  // Panels: parse SettingsPage's own loader table so new panels are covered too.
  const src=readFileSync(setIn.startsWith('/')||/^[A-Za-z]:/.test(setIn)?setIn:join(desktop,setIn),'utf8');
  const loaders=[...src.matchAll(/^\s+(\w+Panel): \(\) => import\("([^"]+)"\)/gm)];
  check('SettingsPage declares lazy loaders for its panels', loaders.length>=20, `found ${loaders.length}`);
  const staticPanelImports=[...src.matchAll(/^import \{[^}]*\b\w+Panel\b[^}]*\} from "\.{1,2}\/[^"]*Panel\.js";$/gm)].map(m=>m[0]);
  check('★ SettingsPage has no static panel imports', staticPanelImports.length===0, staticPanelImports.join(' | '));
  for(const [,name,spec] of loaders){
    const file=spec.replace(/^\.\.?\//,'').replace(/\.js$/,'');
    const inBundle=Object.keys(inputs).find(k=>norm(k).match(new RegExp(`/${file.replace(/[/.]/g,m=>'\\'+m)}\\.tsx?$`)));
    const inStatic=inBundle&&set.has(inBundle)&&!app.has(inBundle);
    check(`   ${name} is bundled and loaded on demand`, !!inBundle&&!inStatic, !inBundle?'missing from bundle':'statically reachable: '+chain(inBundle));
  }
  // Budget: bytes SettingsPage adds beyond what App already loaded.
  const extra=new Set([...set.keys()].filter(k=>!app.has(k)));let bytes=0;
  for(const o of Object.values(outputs))for(const [m,v] of Object.entries(o.inputs))if(extra.has(m))bytes+=v.bytesInOutput;
  const BUDGET=400*1024;
  console.log(`Settings shell on top of App: ${(bytes/1024).toFixed(0)}KB minified (budget ${(BUDGET/1024).toFixed(0)}KB)`);
  check('★ settings shell adds little on top of App', bytes<=BUDGET, `${(bytes/1024).toFixed(0)}KB`);
  // Prefetch wiring (source-level; behaviour is covered by the lazy graph above).
  const appSrc=readFileSync(join(root,'App.tsx'),'utf8');
  check('App idle-prefetches the settings shell', /requestIdleCallback/.test(appSrc)&&/loadSettingsPage\(\)/.test(appSrc)&&/const SettingsPage = lazy\(\(\) => loadSettingsPage\(\)/.test(appSrc));
  check('memory panel (Monaco) is excluded from background prefetch', /HEAVY_PANELS[^\n]*new Set<PanelName>\(\[[^\]]*"MemoryExplorerPanel"/.test(src));
}finally{try{rmSync(out,{recursive:true,force:true});}catch{}}
const failed=results.filter(x=>!x).length;
console.log(`\n${results.length-failed}/${results.length} passed`);
if(failed)throw Error(`${failed} settings-lazy assertions failed`);
