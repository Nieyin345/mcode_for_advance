import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readdirSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import { buildTailwindCached } from "../lib/tailwind-cache.mjs";
const source=dirname(fileURLToPath(import.meta.url)),desktop=resolve(source,'../..'),root=join(desktop,'src/renderer');
const pnpm=resolve(desktop,'../../node_modules/.pnpm');
const pkg=(prefix,sub)=>{const n=readdirSync(pnpm).filter(n=>n.startsWith(prefix)).sort().at(-1);if(!n)throw Error('Missing installed dependency '+prefix);return join(pnpm,n,'node_modules',sub);};
const esbuild=await import(pathToFileURL(pkg('esbuild@','esbuild/lib/main.js')).href);
mkdirSync(join(desktop,'.tmp'),{recursive:true});const dir=mkdtempSync(join(desktop,'.tmp/module-ui-'));console.log('Module UI artifacts: '+dir);
const stubs={
 '@renderer/hooks/useSuppressBrowserView.js':'export const useSuppressBrowserView=()=>{};',
 '@renderer/lib/api.js':'export const api=window.testApi;',
 '@renderer/stores/sessionStore.js':'export const useSessionStore={getState:()=>({locale:"zh"})};',
 '@renderer/stores/toastStore.js':'export const useToastStore={getState:()=>({push:()=>{}})};',
 '@renderer/lib/i18n/index.js':`import {zh as ide} from ${JSON.stringify(root+'/lib/i18n/zh/ide.ts')};import {zh as common} from ${JSON.stringify(root+'/lib/i18n/zh/common.ts')};const dict={...ide,...common};export const useI18n=()=>({locale:'zh',t:key=>dict[key]??key});`,
 '@renderer/components/ui/index.js':['button','error-note','spinner','empty-state','badge'].map(n=>`export * from ${JSON.stringify(root+'/components/ui/'+n+'.tsx')};`).join('\n'),
};
await esbuild.build({entryPoints:[join(source,'main.jsx')],bundle:true,platform:'browser',format:'iife',jsx:'automatic',tsconfig:join(desktop,'tsconfig.json'),define:{'process.env.NODE_ENV':'"production"'},outfile:join(dir,'bundle.js'),plugins:[{name:'transport-only',setup(b){b.onResolve({filter:/.*/},a=>a.path in stubs?{path:a.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:stubs[a.path],loader:'tsx',resolveDir:desktop}));}}]});
const configPath=join(dir,'tailwind.config.cjs');writeFileSync(configPath,readFileSync(join(desktop,'tailwind.config.js'),'utf8').replace('export default','module.exports =').replace('content: ["./src/renderer/**/*.{ts,tsx,html}"]','content: '+JSON.stringify([root.replaceAll('\\','/')+'/**/*.{ts,tsx,html}',join(source,'main.jsx').replaceAll('\\','/')])));
const css = buildTailwindCached({ cliPath: pkg('tailwindcss@','tailwindcss/lib/cli.js'), configPath: configPath, inputCss: 'src/renderer/styles.css', outPath: join(dir,'app.css'), cwd: desktop });if (css.status !== undefined && css.status !== 0) throw Error('tailwind failed');
await esbuild.build({entryPoints:[join(source,'verify.ts')],bundle:true,platform:'node',format:'esm',tsconfig:join(desktop,'tsconfig.json'),outfile:join(dir,'verify.mjs'),banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});
await import(pathToFileURL(join(dir,'verify.mjs')).href);
