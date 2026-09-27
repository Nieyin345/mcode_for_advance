// Bundles main.jsx with the REAL GeneralPanel / RuntimesPanel / DataRootPanel
// + sessionStore. Only the IPC bridge (`@renderer/lib/api.js`) and Monaco are
// stubbed (in-page mock RPC lives in mocks.js). Self-contained copy of the
// maint-m22-smoke build harness (same esbuild lookup, no network install).
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readdirSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,copyFileSync,rmSync,statSync} from 'node:fs';
const source=dirname(fileURLToPath(import.meta.url)),desktop=resolve(source,'../..');
const root=join(desktop,'src/renderer'),contracts=resolve(desktop,'../../packages/contracts/src');
const pnpm=resolve(desktop,'../../node_modules/.pnpm');
const pkg=(prefix,sub)=>{const n=readdirSync(pnpm).filter(n=>n.startsWith(prefix)).sort().at(-1);if(!n)throw Error('Missing installed dependency '+prefix+' (no network install)');return join(pnpm,n,'node_modules',sub);};
mkdirSync(join(desktop,'.tmp'),{recursive:true});
const dir=mkdtempSync(join(desktop,'.tmp','maint-m25-'));
console.log('M25 artifacts: '+dir);
for(const file of ['main.jsx','verify.mjs','browser.mjs'])copyFileSync(join(source,file),join(dir,file));
const stubs={
 '@monaco-editor/react':`export default function Editor(){return null;}`,
 '@renderer/lib/monacoSetup.js':'',
 '@renderer/lib/api.js':'export const api=window.labApi;',
};
const isFile=(p)=>{try{return statSync(p).isFile();}catch{return false;}};
const resolveTs=(p)=>{if(isFile(p))return p;const bare=p.replace(/\.js$/,'');for(const c of [bare+'.tsx',bare+'.ts',bare+'/index.ts',bare+'/index.tsx'])if(isFile(c))return c;return p;};
const esbuild=await import(pathToFileURL(pkg('esbuild@','esbuild/lib/main.js')).href);
await esbuild.build({entryPoints:[join(dir,'main.jsx')],bundle:true,platform:'browser',format:'iife',jsx:'automatic',absWorkingDir:desktop,define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'},loader:{'.svg':'dataurl','.png':'dataurl','.woff2':'dataurl','.css':'empty'},outfile:join(dir,'bundle.js'),logLevel:'error',plugins:[{name:'mock-ipc-only',setup(b){
 b.onResolve({filter:/.*/},a=>{
  if(a.path in stubs)return {path:a.path,namespace:'mock'};
  if(a.path.startsWith('@renderer/'))return {path:resolveTs(join(root,a.path.slice(10)))};
  if(a.path.startsWith('@contracts/'))return {path:resolveTs(join(contracts,a.path.slice(11)))};
 });
 b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:stubs[a.path],loader:'tsx',resolveDir:desktop}));
}}]});
writeFileSync(join(dir,'app.css'),'');
const mocks=readFileSync(join(source,'mocks.js'),'utf8');
writeFileSync(join(dir,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>M25 settings panels</title><link rel="stylesheet" href="/app.css"></head><body><div id="root" style="min-height:640px"></div><script>'+mocks+'</script><script src="/bundle.js"></script></body></html>');
try{await import(pathToFileURL(join(dir,'verify.mjs')).href);}
finally{if(!process.env.MCODE_KEEP_ARTIFACTS){try{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{}}}

