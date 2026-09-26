import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readdirSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,copyFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const source=dirname(fileURLToPath(import.meta.url)),desktop=resolve(source,'../..');
const root=join(desktop,'src/renderer');
const deps=process.env.MCODE_UI_TEST_DEPS;
const pnpm=resolve(desktop,'../../node_modules/.pnpm');
const pkg=(prefix,sub)=>{if(deps)return join(deps,sub);const n=readdirSync(pnpm).filter(n=>n.startsWith(prefix)).sort().at(-1);if(!n)throw Error('Missing installed dependency '+prefix);return join(pnpm,n,'node_modules',sub);};
mkdirSync(join(desktop,'.tmp'),{recursive:true});const dir=mkdtempSync(join(desktop,'.tmp','ui-interaction-'));
console.log('UI interaction artifacts: '+dir);
for(const file of ['main.jsx','verify.mjs'])copyFileSync(join(source,file),join(dir,file));
copyFileSync(join(source,'browser.mjs'),join(dir,'browser.mjs'));
const stubs={
 '@monaco-editor/react': `import React from 'react';export default function Editor(p){return <textarea aria-label="Memory editor test input" value={p.value} readOnly={p.options?.readOnly} onChange={e=>p.onChange(e.target.value)} />;}`,
 '@renderer/lib/monacoSetup.js':'',
 '@renderer/hooks/useSuppressBrowserView.js':'export const useSuppressBrowserView=()=>{};',
 '@renderer/components/ide/FileEditor.js':'export const useMonacoTheme=()=>"vs";',
 '@contracts/memory':'export const MEMORY_CATEGORIES=["facts"];',
 './MemoryTransferPanel.js':'export const MemoryTransferPanel=()=>null;',
 './MemoryMaintenanceReview.js':'export const MemoryMaintenanceReview=()=>null;',
 '@renderer/lib/api.js':'export const api=window.labApi;',
 '@renderer/stores/sessionStore.js':`import {useSyncExternalStore} from 'react';export const useSessionStore=(fn)=>fn(useSyncExternalStore(window.labSubscribe,()=>window.labState));useSessionStore.getState=()=>window.labState;`,
 '@renderer/stores/toastStore.js':'export const useToastStore={getState:()=>({push:()=>{}})};',
 '@renderer/lib/i18n/core.js':'export const translate=(_locale,key)=>key;',
 '@renderer/stores/fileViewStore.js':'export const useFileViewStore={getState:()=>({open:()=>{}})};',
 '@renderer/lib/icons.js':"export * from '@tabler/icons-react';",
 '@renderer/lib/commands.js':'export const collectCommands=()=>[];export const commandMatches=()=>true;',
 '@renderer/lib/shortcuts.js':'export const resolveShortcut=()=>null;export const acceleratorToDisplayString=()=>"";',
 '@renderer/lib/providerIcon.js':'export const getProviderIcon=()=>null;',
 '@renderer/lib/useRgStatus.js':'export const useRgStatus=()=>({ready:true});',
 '@renderer/components/ui/index.js':['button','input','switch','card','error-note','spinner','confirm-dialog','select'].map(n=>`export * from ${JSON.stringify(root+'/components/ui/'+n+'.tsx')};`).join('\n'),
 '@contracts/ipc':"export const TURN_BUDGET_SETTING_KEY='runtime.turnBudget',RUNTIME_FALLBACK_MODELS_SETTING_KEY='runtime.fallbackModels';",
};
const locales=['chat-composer','settings','layout','mobile','common','browser','ide','memory'];
stubs['@renderer/lib/i18n/index.js']=locales.map((n,i)=>`import {zh as d${i}} from ${JSON.stringify(root+'/lib/i18n/zh/'+n+'.ts')};`).join('\n')+`const dict=Object.assign({},${locales.map((_,i)=>'d'+i).join(',')});const t=(key,params={})=>Object.entries(params).reduce((str,[k,v])=>str.replaceAll('{'+k+'}',String(v)),dict[key]??key);export const useI18n=()=>({t,locale:'zh'});`;
const esbuild=await import(pathToFileURL(pkg('esbuild@','esbuild/lib/main.js')).href);
await esbuild.build({entryPoints:[join(dir,'main.jsx')],bundle:true,platform:'browser',format:'iife',jsx:'automatic',nodePaths:deps?[deps]:[],absWorkingDir:desktop,define:{'process.env.NODE_ENV':'"production"'},outfile:join(dir,'bundle.js'),plugins:[{name:'mock-ipc-not-ui',setup(b){
 b.onResolve({filter:/.*/},a=>{if(a.path in stubs)return {path:a.path,namespace:'mock'};if(a.path==='./MobileFileViewer.js')return {path:'viewer',namespace:'mock'};if(a.path.startsWith('@renderer/')){let p=join(root,a.path.slice(10));if(!existsSync(p))p=p.replace(/\.js$/,existsSync(p.replace(/\.js$/,'.tsx'))?'.tsx':'.ts');return {path:p};}});
 b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:a.path==='viewer'?'export const FileViewerOverlay=()=>null;':stubs[a.path],loader:'tsx',resolveDir:deps?dirname(deps):desktop}));
}}]});
const configPath=join(dir,'tailwind.config.cjs');
const config=readFileSync(join(desktop,'tailwind.config.js'),'utf8').replace('export default','module.exports =').replace('content: ["./src/renderer/**/*.{ts,tsx,html}"]','content: '+JSON.stringify([root.replaceAll('\\','/')+'/**/*.{ts,tsx,html}',join(source,'main.jsx').replaceAll('\\','/')]));
writeFileSync(configPath,config);
const css=spawnSync(process.execPath,[pkg('tailwindcss@','tailwindcss/lib/cli.js'),'-c',configPath,'-i','src/renderer/styles.css','-o',join(dir,'app.css')],{cwd:desktop,encoding:'utf8'});
if(css.status!==0)throw Error(css.stderr);
const mocks=readFileSync(join(source,'mocks.js'),'utf8');
writeFileSync(join(dir,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Isolated UI regression</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script>'+mocks+'</script><script src="/bundle.js"></script></body></html>');
await import(pathToFileURL(join(dir,'verify.mjs')).href);
