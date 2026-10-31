"use strict";
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),cp=require("node:child_process");
const repo=path.resolve(__dirname,"../../../.."),desktop=path.resolve(__dirname,"../..");
let esbuild;
try{esbuild=require(require.resolve("esbuild",{paths:[desktop,repo]}))}
catch{const vs=fs.readdirSync(path.join(repo,"node_modules",".pnpm")).filter(s=>/^esbuild@[0-9]/.test(s)).sort();esbuild=require(path.join(repo,"node_modules",".pnpm",vs[vs.length-1],"node_modules","esbuild"))}
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"mcode-md-boundary-smoke-"));
(async()=>{
try {
const out=path.join(temp,"smoke.mjs"),stub=path.join(__dirname,"stubs.ts");
await esbuild.build({entryPoints:[path.join(__dirname,"main.ts")],bundle:true,platform:"node",format:"esm",target:"node22",tsconfig:path.join(desktop,"tsconfig.json"),outfile:out,logLevel:"error",
alias:{"@main/store/repositories.js":stub,"@main/lib/logger.js":stub,"@main/library/adoptMarkdown.js":stub,"@main/lib/pathGuard.js":path.join(desktop,"src/main/lib/realPathWithin.ts")},
plugins:[{name:"relative-paths-stub",setup(build){
build.onResolve({filter:/^\.\/paths\.js$/},args=>args.importer.endsWith("markdownPreview.ts")?{path:stub}:undefined);
}}]});
const r=cp.spawnSync(process.execPath,[out],{cwd:desktop,encoding:"utf8",timeout:48000,maxBuffer:2*1024*1024,
  env:{...process.env,MCODE_NATIVE_FS_PATH:path.join(desktop,"native","mcode-fs","build","Release","mcode_fs.node")}});
process.stdout.write(r.stdout||"");process.stderr.write(r.stderr||"");
if(r.error)throw r.error;process.exitCode=r.status===0?0:1;
}finally{fs.rmSync(temp,{recursive:true,force:true})}
})().catch(err=>{console.error(err);process.exitCode=1});
