"use strict";
const fs=require("node:fs"),p=require("node:path"),os=require("node:os"),cp=require("node:child_process");
const repo=p.resolve(__dirname,"../../../.."),desktop=p.resolve(__dirname,"../..");
let eb;try{eb=require(require.resolve("esbuild",{paths:[repo,desktop]}));}catch{eb=require(p.join(repo,"node_modules/.pnpm/esbuild@0.25.1/node_modules/esbuild"));}
const temp=fs.mkdtempSync(p.join(os.tmpdir(),"mcode-theia-copy-smoke-"));
try{
const out=p.join(temp,"main.mjs");
eb.buildSync({entryPoints:[p.join(__dirname,"main.ts")],bundle:true,platform:"node",format:"esm",target:"node22",tsconfig:p.join(desktop,"tsconfig.json"),outfile:out,logLevel:"silent"});
const r=cp.spawnSync(process.execPath,[out],{encoding:"utf8",cwd:desktop,timeout:55000,maxBuffer:3*1024*1024,
  env:{...process.env,MCODE_NATIVE_FS_PATH:p.join(desktop,"native","mcode-fs","build","Release","mcode_fs.node")}});
process.stdout.write(r.stdout||"");process.stderr.write(r.stderr||"");if(r.error)throw r.error;process.exitCode=r.status===0?0:1;
}finally{fs.rmSync(temp,{recursive:true,force:true})}
