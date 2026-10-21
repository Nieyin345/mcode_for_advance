/** T16: mutation of Windows default-deny policy with no changes to product files. */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const suite=dirname(fileURLToPath(import.meta.url));
const desktop=resolve(suite,"../..");
const runner=join(desktop,"src/main/modules/permissionedProcessRunner.ts");
const source=readFileSync(runner,"utf8");
const before=createHash("sha256").update(source).digest("hex");
const needle="if (!hasJsOnlyEgressConsent()) {";
assert(source.includes(needle)&&source.split(needle).length===2,"default-deny target missing");
const require=createRequire(join(desktop,"package.json"));
const pnpm=resolve(desktop,"../../node_modules/.pnpm");
const esbuildDir=readdirSync(pnpm).filter(n=>n.startsWith("esbuild@")).sort().at(-1);
assert(esbuildDir,"installed esbuild required");
const esbuild=require(join(pnpm,esbuildDir,"node_modules/esbuild/lib/main.js"));
const dir=mkdtempSync(join(tmpdir(),"t16-default-deny-mutation-"));
try{
  const output=join(dir,"mutated.mjs");
  await esbuild.build({
    entryPoints:[join(desktop,"scripts/mc035-egress-isolation-smoke/main.ts")],
    absWorkingDir:desktop,tsconfig:join(desktop,"tsconfig.json"),
    bundle:true,platform:"node",format:"esm",outfile:output,logLevel:"error",
    banner:{js:"import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"},
    plugins:[{name:"t16-failopen-mutation",setup(b){
      b.onResolve({filter:/permissionedProcessRunner\.js$/},a=>({
        path:runner,namespace:"t16-mutated",
      }));
      b.onLoad({filter:/.*/,namespace:"t16-mutated"},()=>({
        contents:source.replace(needle,"if (false) {"),
        resolveDir:dirname(runner),loader:"ts",
      }));
    }}],
  });
  const child=spawnSync(process.execPath,[output],{
    cwd:desktop,env:{...process.env,NODE_OPTIONS:"",ELECTRON_RUN_AS_NODE:"1"},
    encoding:"utf8",timeout:45000,maxBuffer:1024*1024,
  });
  const failures=(child.stdout??"").split(/\r?\n/).filter(s=>s.includes("  FAIL "));
  assert.notEqual(child.status,0,"mutated test must be red");
  assert(failures.some(s=>s.includes("without persisted consent rejects install")),
    "default-deny installation assertion did not detect mutation");
  assert(failures.some(s=>s.includes("default-deny rejects execution")),
    "default-deny runtime assertion did not detect mutation");
  assert(failures.some(s=>s.includes("revoking consent immediately rejects")),
    "revocation assertion did not detect mutation");
  const after=createHash("sha256").update(readFileSync(runner)).digest("hex");
  assert.equal(after,before,"product file changed, bytewise compare failed");
  console.log("T16_DEFAULT_DENY_MUTATION PASS expected red="
    +failures.length+" source-bytewise-cmp=true SHA256="+after);
  console.log(failures.join("\n"));
}finally{rmSync(dir,{recursive:true,force:true});}
