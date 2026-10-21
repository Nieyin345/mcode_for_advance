import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join,resolve,dirname } from "node:path";
import { fileURLToPath,pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const pnpm=resolve(desktop,"../../node_modules/.pnpm");
const pkg=readdirSync(pnpm).find(name=>name.startsWith("esbuild@"));
if(!pkg)throw Error("Installed esbuild required");
const { build }=await import(pathToFileURL(join(pnpm,pkg,"node_modules/esbuild/lib/main.js")).href);
mkdirSync(join(desktop,".tmp"),{recursive:true});
const out=mkdtempSync(join(desktop,".tmp/module-permissions-"));
const mutations=[
  {name:"auth",file:/ModuleHost\.ts$/,target:'if (explicit && !grant.granted.includes(permission)) {',replace:'if (false && !grant.granted.includes(permission)) {',fail:"Live revocation prevents execution"},
  {name:"blocked",file:/appPermission\.ts$/,target:'if (required === null) throw Error(',replace:'if (required === null && false) throw Error(',fail:"Nondelegable approvals"},
  {name:"upgrade",file:/ModuleHost\.ts$/,target:'if (executionChanged && grantedPermissions === undefined && priorConsent?.granted.length) {',replace:'if (false && executionChanged && grantedPermissions === undefined && priorConsent?.granted.length) {',fail:"A changed manifest requires renewed consent"},
];
let mutationFailures=0;
for(const mutation of [null,...mutations]) {
  const mode=mutation?.name ?? "baseline";
  const plugin=mutation===null?[]:[{name:"t48-mutation-"+mode,setup(b){
    b.onLoad({filter:mutation.file},args=>{
      const original=readFileSync(args.path,"utf8");
      if(!original.includes(mutation.target))throw Error("Mutation anchor missing: "+mode);
      let contents=original.replace(mutation.target,mutation.replace);
      if(mode==="upgrade") {
        const early='if (grantedPermissions === undefined && manifest.permissions.some(p => p !== "resource.read" && p !== "resource.write" && p !== "network")) {';
        if(!contents.includes(early))throw Error("Early upgrade guard missing");
        contents=contents.replace(early,'if (false && grantedPermissions === undefined && manifest.permissions.some(p => p !== "resource.read" && p !== "resource.write" && p !== "network")) {');
        const second='if (previousRecord.granted.length) throw Error("扩展的权限或执行内容已变化，请重新逐项同意授权");';
        if(!contents.includes(second))throw Error("Second upgrade mutation anchor missing");
        contents=contents.replace(second,'if (false && previousRecord.granted.length) throw Error("unreachable");');
      }
      return {contents,loader:"ts"};
    });
  }}];
  const file=join(out,mode+".mjs");
  await build({entryPoints:[join(desktop,"scripts/module-permissions-smoke/main.ts")],bundle:true,platform:"node",format:"esm",outfile:file,tsconfig:join(desktop,"tsconfig.json"),plugins:plugin,logLevel:"error"});
  const result=spawnSync(process.execPath,[file],{encoding:"utf8",timeout:90000});
  const logs=(result.stdout??"")+(result.stderr??"");
  writeFileSync(join(out,mode+".log"),logs);
  if(mode==="baseline") {
    console.log(logs);
    if(result.status!==0)throw Error("T48 baseline failed; see "+join(out,mode+".log"));
  }else{
    const detected=result.status!==0 && logs.includes("FAIL "+mutation.fail);
    console.log(`Mutation ${mode}: ${detected?"PASS (assertion RED)":"FAIL (assertion did not detect regression)"}`);
    if(!detected){mutationFailures++;console.error(logs.slice(-3000));}
  }
}
console.log("T48 artifacts:",out);
if(mutationFailures)process.exitCode=1;
