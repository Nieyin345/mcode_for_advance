import {dirname,resolve,join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {readdirSync,writeFileSync,mkdirSync,mkdtempSync} from "node:fs";
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const root=join(desktop,"src/renderer");
const deps=resolve(desktop,"../../node_modules/.pnpm");
const pkg=readdirSync(deps).find(n=>n.startsWith("esbuild@"));
if(!pkg)throw Error("esbuild required");
const {build}=await import(pathToFileURL(join(deps,pkg,"node_modules/esbuild/lib/main.js")).href);
mkdirSync(join(desktop,".tmp"),{recursive:true});
const dir=mkdtempSync(join(desktop,".tmp/t50-ui-"));
const stubs={
 "@renderer/lib/api.js":"export const api=new Proxy({}, {get:(_,domain)=>new Proxy({}, {get:(_,method)=>(...args)=>window.testApi[domain][method](...args)})});",
 "@renderer/stores/sessionStore.js":"export const useSessionStore=(selector)=>selector(window.__store);useSessionStore.getState=()=>window.__store;",
 "@renderer/stores/toastStore.js":"export const useToastStore={getState:()=>({push:()=>{}})};",
 "@renderer/lib/i18n/index.js":"export const useI18n=()=>({locale:'zh',t:k=>k});",
 "@renderer/lib/commands.js":"export const collectCommands=()=>[];export const commandMatches=(c,q)=>c.label.toLowerCase().includes(q)||c.keywords?.some(x=>x.toLowerCase().includes(q));",
 "@renderer/lib/shortcuts.js":"export const resolveShortcut=()=>null;export const acceleratorToDisplayString=()=>'';",
 "@renderer/lib/useRgStatus.js":"export const useRgStatus=()=>({ready:true,installing:false,error:null,install:()=>{}});",
 "@renderer/stores/fileViewStore.js":"export const useFileViewStore={getState:()=>({open:()=>{}})};",
};
await build({entryPoints:[join(desktop,"scripts/module-contributions-smoke/ui-harness.jsx")],bundle:true,platform:"browser",format:"iife",jsx:"automatic",tsconfig:join(desktop,"tsconfig.json"),define:{"process.env.NODE_ENV":'"production"'},outfile:join(dir,"bundle.js"),plugins:[{name:"ui-stubs",setup(b){b.onResolve({filter:/.*/},a=>a.path in stubs?{path:a.path,namespace:"mock"}:undefined);b.onLoad({filter:/.*/,namespace:"mock"},a=>({contents:stubs[a.path],loader:"ts",resolveDir:desktop}));}}]});
writeFileSync(join(dir,"index.html"),'<html lang="zh"><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
await build({entryPoints:[join(desktop,"scripts/module-contributions-smoke/verify-ui.ts")],bundle:true,platform:"node",format:"esm",tsconfig:join(desktop,"tsconfig.json"),outfile:join(dir,"verify.mjs"),banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});
await import(pathToFileURL(join(dir,"verify.mjs")).href);
