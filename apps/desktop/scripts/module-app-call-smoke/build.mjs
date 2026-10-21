import { mkdtempSync,mkdirSync,readdirSync,readFileSync,writeFileSync } from "node:fs";
import { join,resolve,dirname } from "node:path";
import { fileURLToPath,pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const pnpm=resolve(desktop,"../../node_modules/.pnpm");
const pkg=readdirSync(pnpm).find(name=>name.startsWith("esbuild@"));
if(!pkg)throw Error("Installed esbuild required");
const {build}=await import(pathToFileURL(join(pnpm,pkg,"node_modules/esbuild/lib/main.js")).href);
mkdirSync(join(desktop,".tmp"),{recursive:true});
const out=mkdtempSync(join(desktop,".tmp/module-app-call-"));
const mutations=[
 {name:"auth",file:/ModuleHost\.ts$/,target:"    this.authorizeAppMethod(manifest.id, method);",replace:"    void method; // TEST MUTATION",fail:"an ungranted method names"},
 {name:"blocked",file:/appPermission\.ts$/,target:"if (required === null) throw Error(",replace:"if (required === null && false) throw Error(",fail:"a blocked method is never delegated"},
 {name:"cancel",file:/permissionedProcessRunner\.ts$/,target:'else options.signal.addEventListener("abort", cancel, {once:true});',replace:"else void cancel; // TEST MUTATION",fail:"revoking a grant aborts"},
];
let failures=0;
for(const mutation of [null,...mutations]) {
 const mode=mutation?.name??"baseline";
 const plugin=mutation===null?[]:[{name:"t49-mutation-"+mode,setup(b){
   b.onLoad({filter:mutation.file},args=>{
     const original=readFileSync(args.path,"utf8");
     if(!original.includes(mutation.target))throw Error("Mutation anchor missing: "+mode);
     return {contents:original.replaceAll(mutation.target,mutation.replace),loader:"ts"};
   });
 }}];
 const file=join(out,mode+".mjs");
 await build({
  entryPoints:[join(desktop,"scripts/module-app-call-smoke/main.ts")],
  bundle:true,platform:"node",format:"esm",outfile:file,
  tsconfig:join(desktop,"tsconfig.json"),
  plugins:plugin,
  logLevel:"error",
 });
 const result=spawnSync(process.execPath,[file],{encoding:"utf8",timeout:60000,maxBuffer:4*1024*1024});
 const logs=(result.stdout??"")+(result.stderr??"");
 writeFileSync(join(out,mode+".log"),logs);
 if(mode==="baseline") {
   console.log(logs);
   if(result.status!==0){console.log("T49 logs:",out);throw Error("T49 baseline failed");}
 }else {
   const detected=result.status!==0 && logs.includes("FAIL "+mutation.fail);
   console.log("Mutation "+mode+": "+(detected?"PASS (expected assertion RED)":"FAIL (regression undetected)"));
   if(!detected){failures++;console.error(logs.slice(-3500));}
 }
}
console.log("T49 artifacts:",out);
if(failures)process.exitCode=1;
