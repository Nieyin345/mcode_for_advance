import {mkdirSync,mkdtempSync,readdirSync,readFileSync,writeFileSync} from "node:fs";
import {dirname,resolve,join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {spawnSync} from "node:child_process";
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const deps=resolve(desktop,"../../node_modules/.pnpm");
const pkg=readdirSync(deps).find(n=>n.startsWith("esbuild@"));
if(!pkg)throw Error("esbuild missing");
const {build}=await import(pathToFileURL(join(deps,pkg,"node_modules/esbuild/lib/main.js")).href);
mkdirSync(join(desktop,".tmp"),{recursive:true});
const dir=mkdtempSync(join(desktop,".tmp/t50-smoke-"));
const mode=process.argv.includes("--mutate-slot")?"slot":process.argv.includes("--mutate-settings")?"settings":"normal";
await build({entryPoints:[join(desktop,"scripts/module-contributions-smoke/main.ts")],bundle:true,platform:"node",format:"esm",outfile:join(dir,"test.mjs"),tsconfig:join(desktop,"tsconfig.json"),plugins:[{name:"t50-targeted-mutation",setup(b){
  if(mode!=="slot")return;
  b.onLoad({filter:/[\\/]contracts[\\/]src[\\/]modules\.ts$/},arg=>{
    const old=readFileSync(arg.path,"utf8");
    const changed=old.replace(/export const ModuleContributionSchema = z\.discriminatedUnion\("slot", \[[\s\S]*?\n\]\);/,"export const ModuleContributionSchema = z.any();");
    if(changed===old)throw Error("slot mutation was not applied");
    return {contents:changed,loader:"ts"};
  });
}}]});
if(mode==="settings"){
  const source=readFileSync(join(desktop,"src/renderer/components/modules/ModuleContributions.tsx"),"utf8");
  if(!source.includes("api.extensionStore.set"))throw Error("settings mutation target missing");
  // Tests read the same source that production ships; use a copied fixture of
  // the code under test, then alter that one read in the smoke.
  const changed=source.replace("api.extensionStore.set","api.setting.set");
  const testPath=join(desktop,"src/renderer/components/modules/ModuleContributions.tsx");
  // Do not modify worktree; emit a test copy and make fs.readFileSync see it
  // only inside the isolated bundle via a bundled source-check variant.
  const mainPath=join(desktop,"scripts/module-contributions-smoke/main.ts");
  const main=readFileSync(mainPath,"utf8");
  const mutated=main.replace('assert.match(source,/api\\.extensionStore\\.set/);','assert.match('+JSON.stringify(changed)+',/api\\.extensionStore\\.set/);');
  if(mutated===main)throw Error("settings assertion mutation not applied");
  await build({stdin:{contents:mutated,resolveDir:join(desktop,"scripts/module-contributions-smoke"),sourcefile:mainPath,loader:"ts"},bundle:true,platform:"node",format:"esm",outfile:join(dir,"test.mjs"),tsconfig:join(desktop,"tsconfig.json")});
}
const result=spawnSync(process.execPath,[join(dir,"test.mjs")],{cwd:resolve(desktop,"../.."),encoding:"utf8"});
const output=(result.stdout??"")+(result.stderr??"");
writeFileSync(join(dir,mode+".log"),output);process.stdout.write(output);
process.exitCode=result.status??1;
