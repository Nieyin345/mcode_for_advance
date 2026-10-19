"use strict";
/** FULL-0 upstream provenance test: synthetic Git fixtures only; no vendor mutations. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { verifyReleaseSource, assertUpstreamRevision, EDITORS } =
  require("../../build/verify-genoffice-upstream.cjs");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-go-upstream-"));
const repo = path.join(base, "mcode");
const vendor = path.join(repo, "genoffice");
const lockPath = path.join(base, "upstream-lock.json");
let count = 0;
function run(...args) {
  return execFileSync("git", ["-C", vendor, ...args], {
    encoding:"utf8", windowsHide:true, timeout:12000,
  }).trim();
}
function put(p, s = "fixture") { fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p,s); }
function check(name, fn) { fn(); count++; console.log("  ok " + name); }
function lock(revision) {
  put(lockPath, JSON.stringify({
    format:"mcode.genoffice.upstream-lock.v1",
    repository:"https://github.com/genspark-ai/genoffice",
    revision, license:"Apache-2.0", editors:[...EDITORS],
  }));
}
try {
  check("without opt-in no vendor checkout is necessary", () => {
    assert.deepEqual(verifyReleaseSource({repoRoot: repo, lockPath}), {bundled:false,checked:false});
  });
  check("release opt-in cannot silently accept missing GenOffice source", () => {
    assert.throws(() => verifyReleaseSource({repoRoot:repo,lockPath,env:{MCODE_INCLUDE_GENOFFICE_BUNDLE:"1"}}),
      /lock|missing|GenOffice/i);
  });
  check("six-editor opt-in cannot bypass CLI bundle opt-in", () => {
    assert.throws(() => verifyReleaseSource({repoRoot:repo,lockPath,env:{MCODE_INCLUDE_GENOFFICE_EDITORS:"1"}}),
      /require.*BUNDLE|require.*CLI/i);
  });
  fs.mkdirSync(vendor, {recursive:true});
  execFileSync("git",["init","-q",vendor],{windowsHide:true});
  run("config","user.email","fixture@example.invalid");
  run("config","user.name","Mcode Upstream Fixture");
  put(path.join(vendor,"LICENSE"),"Apache License\nVersion 2.0, January 2004\n");
  put(path.join(vendor,"NOTICE"),"Fixture upstream NOTICE\n");
  for(const name of EDITORS) for(const sub of ["main","preload","renderer"]) {
    put(path.join(vendor,"apps",name,"src",sub,"index.ts"),"export const fixture = true;\n");
  }
  run("add",".");run("commit","-qm","upstream fixture baseline");
  const sha = run("rev-parse","HEAD");
  lock(sha);
  check("pinned clean nested Git checkout with all six original app source roots passes",()=>{
    const r=assertUpstreamRevision({repoRoot:repo,lockPath});
    assert.equal(r.revision,sha);assert.deepEqual(r.editors,[...EDITORS]);
    assert.equal(verifyReleaseSource({repoRoot:repo,lockPath,env:{MCODE_INCLUDE_GENOFFICE_BUNDLE:"1"}}).checked,true);
  });
  check("wrong upstream Git revision fails even with identical copied files",()=>{
    lock("0".repeat(40));
    assert.throws(()=>assertUpstreamRevision({repoRoot:repo,lockPath}),/commit mismatch/i);
    lock(sha);
  });
  check("dirty tracked vendor file fails rather than advertising an old HEAD",()=>{
    put(path.join(vendor,"apps/docs/src/renderer/index.ts"),"export const changed = true;\n");
    assert.throws(()=>assertUpstreamRevision({repoRoot:repo,lockPath}),/dirty/i);
    run("restore","apps/docs/src/renderer/index.ts");
  });
  check("untracked native source under apps fails rather than bypassing revision pin",()=>{
    put(path.join(vendor,"apps/pdf/src/main/new-native.ts"),"export const newPart=true;");
    assert.throws(()=>assertUpstreamRevision({repoRoot:repo,lockPath}),/dirty/i);
    fs.rmSync(path.join(vendor,"apps/pdf/src/main/new-native.ts"));
  });
  check("missing one renderer source root is not six-app provenance",()=>{
    fs.rmSync(path.join(vendor,"apps/html/src/renderer"),{recursive:true,force:true});
    assert.throws(()=>assertUpstreamRevision({repoRoot:repo,lockPath}),/dirty|html|renderer/i);
    put(path.join(vendor,"apps/html/src/renderer/index.ts"),"export const fixture = true;\n");
  });
  check("missing notice cannot pass upstream source gate",()=>{
    fs.rmSync(path.join(vendor,"NOTICE"));
    assert.throws(()=>assertUpstreamRevision({repoRoot:repo,lockPath}),/dirty|NOTICE|missing/i);
    put(path.join(vendor,"NOTICE"),"Fixture upstream NOTICE\n");
  });
  check("invalid lock with partial editor list is rejected",()=>{
    const partial=JSON.parse(fs.readFileSync(lockPath));
    partial.editors.pop();put(lockPath,JSON.stringify(partial));
    assert.throws(()=>assertUpstreamRevision({repoRoot:repo,lockPath}),/source lock/i);
    lock(sha);
  });
  check("package pipeline must verify source BEFORE staging or electron-builder",()=>{
    const pkg=JSON.parse(fs.readFileSync(path.join(__dirname,"../../package.json"),"utf8"));
    const script=pkg.scripts.package;
    const gate=script.indexOf("verify-genoffice-upstream.cjs");
    const stage=script.indexOf("stage-genoffice-resources.cjs");
    assert.ok(gate>=0 && stage>gate && script.indexOf("electron-builder")>stage,
      "FULL-0 source provenance gate missing from packaged release pipeline");
  });
  console.log("genoffice-source-smoke: "+count+"/"+count+" PASS");
} finally { fs.rmSync(base,{recursive:true,force:true}); }
