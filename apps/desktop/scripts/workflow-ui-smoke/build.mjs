import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const source=dirname(fileURLToPath(import.meta.url));
const desktop=resolve(source,'../..');
mkdirSync(join(desktop,'.tmp'),{recursive:true});
const dir=mkdtempSync(join(desktop,'.tmp','workflow-ui-'));
const pnpm=join(desktop,'../../node_modules/.pnpm');
const pkg=(prefix,sub)=>{const name=readdirSync(pnpm).filter(n=>n.startsWith(prefix)).sort().at(-1);if(!name)throw new Error('Missing installed dependency: '+prefix);return join(pnpm,name,'node_modules',sub);};
for(const name of ['main.tsx','metadata.ts','index.html','api-stub.ts','unrelated-editor.tsx','browser.mjs','verify.mjs'])copyFileSync(join(source,name),join(dir,name));
console.log('Workflow browser artifacts: '+dir);
const esbuild=await import(pathToFileURL(pkg('esbuild@','esbuild/lib/main.js')).href);
const tsModule=await import(pathToFileURL(pkg('typescript@','typescript/lib/typescript.js')).href);const ts=tsModule.default??tsModule;
// Reuse the real backend canonicalization at its AST boundary, with no database imports.
const library=readFileSync(join(desktop,'src/main/orchestration/library.ts'),'utf8');
const ast=ts.createSourceFile('library.ts',library,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const derive=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='deriveTrigger');
if(!derive)throw new Error('deriveTrigger AST boundary is missing');
writeFileSync(join(dir,'derive-trigger.generated.ts'),'import {parseTriggerSpec,WORKFLOW_TRIGGER_OF_TRIGGER_KIND,type NodeTypeManifest} from "@contracts/nodeType";\nimport type {WorkflowDoc} from "@contracts/workflow";\n'+derive.getText(ast)+'\n');
await esbuild.build({entryPoints:[join(dir,'metadata.ts')],bundle:true,platform:'node',format:'cjs',tsconfig:join(desktop,'tsconfig.json'),absWorkingDir:desktop,outfile:join(dir,'metadata.cjs'),logLevel:'error',plugins:[{name:'no-user-data',setup(build){
 build.onResolve({filter:/^@main\/(lib\/dataRoot|library\/groupRegistry|plugins\/pluginManager)\.js$/},a=>({path:a.path,namespace:'audit-mock'}));
 build.onLoad({filter:/.*/,namespace:'audit-mock'},a=>({loader:'js',contents:a.path.includes('dataRoot')?'export const dataRoot=()=>{throw new Error("Workflow test cannot access user dataRoot")};':a.path.includes('groupRegistry')?'export const loadLibraryGroups=()=>[];':'export const getEnabledPluginNodeTypeSources=async()=>[];'}));
}}]});
const metadata=spawnSync(process.execPath,[join(dir,'metadata.cjs'),join(dir,'catalog.json')],{cwd:desktop,stdio:'inherit'});
if(metadata.status!==0)throw new Error('Catalog probe failed');
writeFileSync(join(dir,'catalog.generated.js'),'export default '+readFileSync(join(dir,'catalog.json'),'utf8')+';\n');
if(JSON.parse(readFileSync(join(dir,'pure-probes.json'),'utf8')).some(p=>p.actual!==p.expected))throw new Error('Workflow dirty-state regression');
await esbuild.build({entryPoints:[join(dir,'main.tsx')],bundle:true,platform:'browser',format:'iife',jsx:'automatic',tsconfig:join(desktop,'tsconfig.json'),absWorkingDir:desktop,define:{'process.env.NODE_ENV':'"production"'},loader:{'.css':'empty','.woff2':'empty','.woff':'empty','.ttf':'empty','.png':'dataurl','.svg':'dataurl'},outfile:join(dir,'bundle.js'),logLevel:'error',plugins:[{name:'isolated-renderer',setup(build){
 build.onResolve({filter:/\?worker$/},a=>({path:a.path,namespace:'test-worker'}));
 build.onLoad({filter:/.*/,namespace:'test-worker'},()=>({loader:'js',contents:'export default class WorkerStub {}'}));
 build.onResolve({filter:/^@renderer\/lib\/api\.js$/},()=>({path:join(dir,'api-stub.ts')}));
 build.onResolve({filter:/MarkdownEditorPane\.js$/},()=>({path:join(dir,'unrelated-editor.tsx')}));
}}]});
const css=spawnSync(process.execPath,[pkg('tailwindcss@','tailwindcss/lib/cli.js'),'-c','tailwind.config.js','-i','src/renderer/styles.css','-o',join(dir,'app.css')],{cwd:desktop,encoding:'utf8'});
if(css.status!==0)throw new Error('CSS build failed: '+css.stderr);
await import(pathToFileURL(join(dir,'verify.mjs')).href);
