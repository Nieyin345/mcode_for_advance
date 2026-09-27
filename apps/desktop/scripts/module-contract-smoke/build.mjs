import {mkdirSync,mkdtempSync,readdirSync,readFileSync,writeFileSync} from "node:fs";
import {resolve,join,dirname} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {spawnSync} from "node:child_process";
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const pnpm=resolve(desktop,"../../node_modules/.pnpm");
const pkg=readdirSync(pnpm).find(name=>name.startsWith("esbuild@"));
if(!pkg)throw Error("Installed esbuild required; no dependency installation permitted");
const {build}=await import(pathToFileURL(join(pnpm,pkg,"node_modules/esbuild/lib/main.js")).href);
mkdirSync(join(desktop,".tmp"),{recursive:true});
const dir=mkdtempSync(join(desktop,".tmp/module-contract-"));
const baseline=process.argv.includes("--baseline");
const mutation=process.argv.includes("--mutation-depth");
console.log("Module contract artifacts: "+dir);
await build({entryPoints:[join(desktop,"scripts/module-contract-smoke/"+(baseline?"baseline.ts":"main.ts"))],bundle:true,platform:"node",format:"esm",outfile:join(dir,"test.mjs"),tsconfig:join(desktop,"tsconfig.json"),
  plugins:mutation?[{name:"test-only-depth-mutation",setup(b){b.onLoad({filter:/moduleCapability\.ts$/},args=>{
    const source=readFileSync(args.path,"utf8");
    const target='if (depth > MODULE_SCHEMA_MAX_DEPTH) throw new Error("JSON schema depth limit exceeded");';
    if(!source.includes(target))throw Error("Mutation target not found");
    return {contents:source.replace(target,"/* test-only: depth guard removed */"),loader:"ts"};
  });}}]:[]});
const result=spawnSync(process.execPath,[join(dir,"test.mjs")],{encoding:"utf8"});
const output=(result.stdout??"")+(result.stderr??"");
writeFileSync(join(dir,"output.log"),output);
writeFileSync(join(dir,"result.json"),JSON.stringify({baseline,mutation,exitCode:result.status,error:result.error?.message},null,2));
process.stdout.write(output);if(result.error)throw result.error;process.exitCode=result.status??1;
