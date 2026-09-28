import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync } from 'node:fs';
const source=dirname(fileURLToPath(import.meta.url));
const desktop=resolve(source,'../..');
mkdirSync(join(desktop,'.tmp'),{recursive:true});
const dir=mkdtempSync(join(desktop,'.tmp','markdown-quote-'));
const pnpm=join(desktop,'../../node_modules/.pnpm');
const pkg=(prefix,sub)=>{const name=readdirSync(pnpm).filter(n=>n.startsWith(prefix)).sort().at(-1);if(!name)throw new Error('Missing installed dependency: '+prefix);return join(pnpm,name,'node_modules',sub);};
for(const name of ['main.tsx','stubs.ts','verify.mjs'])copyFileSync(join(source,name),join(dir,name));
copyFileSync(join(desktop,'scripts/workflow-ui-smoke/browser.mjs'),join(dir,'browser.mjs'));
writeFileSync(join(dir,'index.html'),`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script src="bundle.js"></script></body></html>`);
console.log('Markdown quote browser artifacts: '+dir);
const esbuild=await import(pathToFileURL(pkg('esbuild@','esbuild/lib/main.js')).href);
await esbuild.build({entryPoints:[join(dir,'main.tsx')],bundle:true,platform:'browser',format:'iife',jsx:'automatic',tsconfig:join(desktop,'tsconfig.json'),absWorkingDir:desktop,define:{'process.env.NODE_ENV':'"production"'},loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl','.png':'dataurl','.svg':'dataurl'},outfile:join(dir,'bundle.js'),logLevel:'error',plugins:[{name:'isolated-host',setup(build){
  build.onResolve({filter:/^@renderer\/(lib\/(api|i18n\/index)|stores\/(sessionStore|toastStore))\.js$/},()=>({path:join(dir,'stubs.ts')}));
}}]});
// Keep the actual Crepe CSS. Only layout for the host's Tailwind-based picker
// is supplied here; this test does not bundle or launch the whole application.
writeFileSync(join(dir,'app.css'),readFileSync(join(dir,'bundle.css'),'utf8')+`
html,body,#root{height:100%;margin:0}body{font-family:sans-serif}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.h-full{height:100%}.min-h-0{min-height:0}.overflow-auto{overflow:auto}.relative{position:relative}.absolute{position:absolute}.pointer-events-none{pointer-events:none}.border{border:1px solid #ccc}.rounded-lg{border-radius:8px}.bg-surface{background:white}.w-full{width:100%}.text-left{text-align:left}.overflow-y-auto{overflow-y:auto}.z-50{z-index:50}.milkdown{min-height:100%;--crepe-color-background:#fff;--crepe-color-on-background:#222}.quote-fixture{height:680px;width:850px;border:1px solid #aaa;margin:50px}.quote-fixture button{cursor:pointer}.quote-fixture .mcode-milkdown{height:100%}.mcode-milkdown .editor{min-height:300px}
`);
await import(pathToFileURL(join(dir,'verify.mjs')).href);
