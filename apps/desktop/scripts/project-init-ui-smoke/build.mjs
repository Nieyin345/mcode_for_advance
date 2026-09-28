import { dirname, join, resolve } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { writeFileSync,mkdirSync,mkdtempSync,copyFileSync } from 'node:fs';
import {createRequire} from 'node:module';
const source=dirname(fileURLToPath(import.meta.url));const desktop=resolve(source,'../..');
const req=createRequire(join(desktop,'package.json'));const esbuild=createRequire(req.resolve('vite'))('esbuild');
mkdirSync(join(desktop,'.tmp'),{recursive:true});const dir=mkdtempSync(join(desktop,'.tmp','project-init-ui-'));
for(const name of ['main.tsx','stubs.tsx','verify.mjs'])copyFileSync(join(source,name),join(dir,name));
copyFileSync(join(desktop,'scripts/workflow-ui-smoke/browser.mjs'),join(dir,'browser.mjs'));
writeFileSync(join(dir,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script src="bundle.js"></script></body></html>');
writeFileSync(join(dir,'app.css'),'body{font-family:sans-serif;margin:20px;max-width:900px}button,select,input,textarea{font:inherit;padding:6px;margin:4px}label{display:block}fieldset{border:0}textarea{display:block;min-height:55px;width:90%}section{padding:8px;border:1px solid #ddd}details{padding:8px}[role=dialog]{position:fixed;z-index:1000;inset:6% 15%;overflow:auto;background:white;border:1px solid #555;padding:20px;box-shadow:0 0 0 100vmax #0007}');
console.log('Project init browser artifacts: '+dir);
const built=await esbuild.build({entryPoints:[join(dir,'main.tsx')],bundle:true,platform:'browser',format:'iife',jsx:'automatic',tsconfig:join(desktop,'tsconfig.json'),absWorkingDir:desktop,define:{'process.env.NODE_ENV':'"production"'},outfile:join(dir,'bundle.js'),logLevel:'error',metafile:true,plugins:[{name:'isolated-host',setup(build){
 build.onResolve({filter:/^@renderer\/(lib\/(api|i18n\/index|i18n\/core)|stores\/(sessionStore|toastStore))\.js$/},()=>({path:join(dir,'stubs.tsx')}));
}}]});
for(const path of ['components/chat/useProjectInitializer.tsx','components/memory/ProjectInitManager.tsx','components/chat/SlashCommandPicker.tsx','components/ui/dialog.tsx','hooks/useRpc.ts'])if(!Object.keys(built.metafile.inputs).some(p=>p.replaceAll('\\','/').endsWith(path)))throw Error('Production coverage missing: '+path);
writeFileSync(join(dir,'metafile.json'),JSON.stringify(built.metafile,null,2));await import(pathToFileURL(join(dir,'verify.mjs')).href);
