// Browser regression for the phase-2 capability catalog (native "UI extensions"
// window) and the module-capability node inspector. Only the IPC transport
// (`@renderer/lib/api.js`) and the BrowserView suppressor are replaced; React
// components, real i18n dictionaries/stores, contracts and the real ModuleHost
// + file capabilities (see verify.ts) are bundled unchanged.
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readdirSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import { buildTailwindCached } from "../lib/tailwind-cache.mjs";
const source=dirname(fileURLToPath(import.meta.url)),desktop=resolve(source,'../..'),root=join(desktop,'src/renderer');
const pnpm=resolve(desktop,'../../node_modules/.pnpm');
const pkg=(prefix,sub)=>{const n=readdirSync(pnpm).filter(n=>n.startsWith(prefix)).sort().at(-1);if(!n)throw Error('Missing installed dependency '+prefix);return join(pnpm,n,'node_modules',sub);};
const esbuild=await import(pathToFileURL(pkg('esbuild@','esbuild/lib/main.js')).href);
mkdirSync(join(desktop,'.tmp'),{recursive:true});const dir=mkdtempSync(join(desktop,'.tmp/module-catalog-ui-'));console.log('Module catalog UI artifacts: '+dir);
const stubs={
 '@renderer/hooks/useSuppressBrowserView.js':'export const useSuppressBrowserView=()=>{};',
 // Transport only: namespaces the test does not provide resolve to undefined
 // (never Electron, never the network).
 '@renderer/lib/api.js':'const none=new Proxy({},{get:(_t,m)=>typeof m==="string"&&/^on[A-Z]/.test(m)?()=>()=>{}:()=>Promise.resolve(undefined)});export const api=new Proxy({},{get:(_t,ns)=>typeof ns!=="string"?undefined:(window.testApi[ns]??none)});',
};
await esbuild.build({entryPoints:[join(source,'main.jsx')],bundle:true,platform:'browser',format:'iife',jsx:'automatic',tsconfig:join(desktop,'tsconfig.json'),absWorkingDir:desktop,define:{'process.env.NODE_ENV':'"production"'},loader:{'.css':'empty','.woff2':'empty','.woff':'empty','.ttf':'empty','.png':'dataurl','.svg':'dataurl'},outfile:join(dir,'bundle.js'),logLevel:'error',plugins:[{name:'transport-only',setup(b){
 b.onResolve({filter:/\?worker$/},a=>({path:a.path,namespace:'test-worker'}));
 b.onLoad({filter:/.*/,namespace:'test-worker'},()=>({loader:'js',contents:'export default class WorkerStub {}'}));
 b.onResolve({filter:/.*/},a=>a.path in stubs?{path:a.path,namespace:'mock'}:undefined);
 b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:stubs[a.path],loader:'tsx',resolveDir:desktop}));
}}]});
const configPath=join(dir,'tailwind.config.cjs');writeFileSync(configPath,readFileSync(join(desktop,'tailwind.config.js'),'utf8').replace('export default','module.exports =').replace('content: ["./src/renderer/**/*.{ts,tsx,html}"]','content: '+JSON.stringify([root.replaceAll('\\','/')+'/**/*.{ts,tsx,html}',join(source,'main.jsx').replaceAll('\\','/')])));
const css = buildTailwindCached({ cliPath: pkg('tailwindcss@','tailwindcss/lib/cli.js'), configPath: configPath, inputCss: 'src/renderer/styles.css', outPath: join(dir,'app.css'), cwd: desktop });if (css.status !== undefined && css.status !== 0) throw Error('tailwind failed');
await esbuild.build({entryPoints:[join(source,'verify.ts')],bundle:true,platform:'node',format:'esm',tsconfig:join(desktop,'tsconfig.json'),outfile:join(dir,'verify.mjs'),banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});
await import(pathToFileURL(join(dir,'verify.mjs')).href);
