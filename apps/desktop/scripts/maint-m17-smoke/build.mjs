// Bundles main.jsx with the real memory components; IPC/Monaco/i18n are stubbed
// the same way ui-interaction-smoke does (MemoryMaintenanceReview is NOT stubbed here).
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readdirSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,copyFileSync,existsSync,rmSync} from 'node:fs';
const source=dirname(fileURLToPath(import.meta.url)),desktop=resolve(source,'../..');
const root=join(desktop,'src/renderer');
const pnpm=resolve(desktop,'../../node_modules/.pnpm');
const pkg=(prefix,sub)=>{const n=readdirSync(pnpm).filter(n=>n.startsWith(prefix)).sort().at(-1);if(!n)throw Error('Missing installed dependency '+prefix+' (no network install)');return join(pnpm,n,'node_modules',sub);};
mkdirSync(join(desktop,'.tmp'),{recursive:true});
const dir=mkdtempSync(join(desktop,'.tmp','maint-m17-'));
console.log('M17 artifacts: '+dir);
for(const file of ['main.jsx','verify.mjs','browser.mjs'])copyFileSync(join(source,file),join(dir,file));
const stubs={
 '@monaco-editor/react':`import React from 'react';export default function Editor(p){return <textarea aria-label="Memory editor test input" value={p.value} readOnly={p.options?.readOnly} onChange={e=>p.onChange(e.target.value)} />;}`,
 '@renderer/lib/monacoSetup.js':'',
 '@renderer/components/ide/FileEditor.js':'export const useMonacoTheme=()=>"vs";',
 '@contracts/memory':'export const MEMORY_CATEGORIES=["facts"];',
 './MemoryTransferPanel.js':'export const MemoryTransferPanel=()=>null;',
 '@renderer/lib/api.js':'export const api=window.labApi;',
 '@renderer/stores/toastStore.js':'export const useToastStore={getState:()=>({push:()=>{}})};',
 '@renderer/lib/icons.js':"export * from '@tabler/icons-react';",
 '@renderer/components/ui/index.js':['button','input','switch','card','error-note','spinner','confirm-dialog','select','info-hint'].map(n=>`export * from ${JSON.stringify(root+'/components/ui/'+n+'.tsx')};`).join('\n'),
};
const locales=['settings','common','memory'];
stubs['@renderer/lib/i18n/index.js']=locales.map((n,i)=>`import {zh as d${i}} from ${JSON.stringify(root+'/lib/i18n/zh/'+n+'.ts')};`).join('\n')+`const dict=Object.assign({},${locales.map((_,i)=>'d'+i).join(',')});const t=(key,params={})=>Object.entries(params).reduce((str,[k,v])=>str.replaceAll('{'+k+'}',String(v)),dict[key]??key);export const useI18n=()=>({t,locale:'zh'});`;
const esbuild=await import(pathToFileURL(pkg('esbuild@','esbuild/lib/main.js')).href);
await esbuild.build({entryPoints:[join(dir,'main.jsx')],bundle:true,platform:'browser',format:'iife',jsx:'automatic',absWorkingDir:desktop,define:{'process.env.NODE_ENV':'"production"'},outfile:join(dir,'bundle.js'),logLevel:'error',plugins:[{name:'mock-ipc-not-ui',setup(b){
 b.onResolve({filter:/.*/},a=>{if(a.path in stubs)return {path:a.path,namespace:'mock'};if(a.path.startsWith('@renderer/')){let p=join(root,a.path.slice(10));if(!existsSync(p))p=p.replace(/\.js$/,existsSync(p.replace(/\.js$/,'.tsx'))?'.tsx':'.ts');return {path:p};}});
 b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:stubs[a.path],loader:'tsx',resolveDir:desktop}));
}}]});
writeFileSync(join(dir,'app.css'),'');
const mocks=readFileSync(join(source,'mocks.js'),'utf8');
writeFileSync(join(dir,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>M17 memory review</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script>'+mocks+'</script><script src="/bundle.js"></script></body></html>');
try{await import(pathToFileURL(join(dir,'verify.mjs')).href);}
finally{if(!process.env.MCODE_KEEP_ARTIFACTS){try{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{}}}
