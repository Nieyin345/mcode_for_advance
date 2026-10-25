"use strict";
const { test }=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {createHash}=require("node:crypto");
const {auditRelease,parseLatest,codes}=require("./verify.cjs");
const HASH="a".repeat(64);
const GIT_HASH="a".repeat(40);
function makeFixture(t) {
  const repo=fs.mkdtempSync(path.join(os.tmpdir(),"mcode-office-release-audit-"));
  t.after(()=>fs.rmSync(repo,{recursive:true,force:true}));
  const release=path.join(repo,"apps","desktop","release");
  fs.mkdirSync(release,{recursive:true});
  fs.mkdirSync(path.join(repo,"apps","desktop","build"),{recursive:true});
  fs.writeFileSync(path.join(repo,"apps","desktop","package.json"),JSON.stringify({version:"0.1.62"}));
  fs.writeFileSync(path.join(repo,"apps","desktop","build","genoffice-upstream.lock.json"),JSON.stringify({revision:GIT_HASH,expectedTree:GIT_HASH}));
  const payload=Buffer.from("synthetic executable only for isolated release audit tests");
  const filename="Mcode-0.1.62-x64.exe";
  const exe=path.join(release,filename);
  const sha=createHash("sha512").update(payload).digest("base64");
  fs.writeFileSync(path.join(release,"latest.yml"),"version: 0.1.62\nfiles:\n  - url: "+filename+"\n    sha512: "+sha+"\n    size: "+payload.length+"\npath: "+filename+"\nsha512: "+sha+"\n");
  const res=path.join(release,"win-unpacked","resources","genoffice");
  fs.mkdirSync(res,{recursive:true});
  const manifest={
    format:"mcode.genoffice.resources.v1",bundled:true,editorsBundled:true,
    editors:["docs","sheets","slides","pdf","markdown","html"],
    editorAssetsSha256:Object.fromEntries(["docs","sheets","slides","pdf","markdown","html"].map(x=>[x,HASH])),
    cliSha256:HASH,pdfiumWasmSha256:HASH,nativeSidecarSha256:HASH,
    genofficeSourceRevision:GIT_HASH,genofficeSourceTree:GIT_HASH,
    mcodeSourceRevision:GIT_HASH,mcodeSourceClean:true,
  };
  const manifestFile=path.join(res,"availability.json");
  fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  fs.writeFileSync(exe,payload);
  const now=Date.now();
  fs.utimesSync(manifestFile,new Date(now-8000),new Date(now-8000));
  fs.utimesSync(exe,new Date(now-4000),new Date(now-4000));
  const opts={repoRoot:repo,releaseDir:release,signatureStatus:"Valid",resourceVerifier:()=>true,
    gitEvidence:{head:GIT_HASH,commitTime:now-12000,dirty:false}};
  const codesFor=(options=opts)=>auditRelease(options).blockers.map(x=>x.code);
  const updateManifest=()=>fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  return {repo,release,exe,manifest,manifestFile,opts,codesFor,updateManifest,now};
}
test("matching installer/latest SHA512, six-editor provenance, signed clean source passes",t=>{
  const f=makeFixture(t);
  assert.equal(auditRelease(f.opts).status,"READY");
});
test("rejects missing installer and invented latest.yml asset path",t=>{
  const f=makeFixture(t);
  fs.rmSync(f.exe);
  assert.ok(f.codesFor().includes(codes.MISSING_RELEASE));
});
test("rejects same-sized installer tampering by SHA512",t=>{
  const f=makeFixture(t);
  fs.writeFileSync(f.exe,Buffer.from("Z".repeat(fs.statSync(f.exe).size)));
  assert.ok(f.codesFor().includes(codes.HASH_MISMATCH));
});
test("refuses unsigned Windows executable, even when hashes match",t=>{
  const f=makeFixture(t);
  assert.ok(f.codesFor({...f.opts,signatureStatus:"NotSigned"}).includes(codes.UNSIGNED_INSTALLER));
});
test("refuses stale installer predating reviewed Mcode HEAD",t=>{
  const f=makeFixture(t);
  assert.ok(f.codesFor({...f.opts,gitEvidence:{...f.opts.gitEvidence,commitTime:f.now+70000}})
    .includes(codes.STALE_INSTALLER));
});
test("refuses source fork revision mismatch",t=>{
  const f=makeFixture(t);
  f.manifest.genofficeSourceTree="b".repeat(40);f.updateManifest();
  assert.ok(f.codesFor().includes(codes.SOURCE_REVISION_MISMATCH));
});
test("refuses missing GenOffice source attestation rather than assuming fresh package",t=>{
  const f=makeFixture(t);
  delete f.manifest.genofficeSourceRevision; f.updateManifest();
  assert.ok(f.codesFor().includes(codes.MISSING_SOURCE_ATTESTATION));
});
test("refuses dirty or different Mcode build-source revision",t=>{
  const f=makeFixture(t);
  f.manifest.mcodeSourceClean=false;f.updateManifest();
  assert.ok(f.codesFor().includes(codes.MCODE_BUILD_REVISION_MISMATCH));
});
test("refuses a mutable git worktree from parallel agent edits",t=>{
  const f=makeFixture(t);
  assert.ok(f.codesFor({...f.opts,gitEvidence:{...f.opts.gitEvidence,dirty:true}})
    .includes(codes.DIRTY_WORKTREE));
});
test("refuses malformed or incomplete GenOffice native six-format manifest",t=>{
  const f=makeFixture(t);
  f.manifest.editors=["docs","sheets"]; f.updateManifest();
  assert.ok(f.codesFor().includes(codes.INVALID_RESOURCE_MANIFEST));
});
test("refuses unpacked renderer staging newer than NSIS installer",t=>{
  const f=makeFixture(t);
  fs.utimesSync(f.manifestFile,new Date(f.now+11000),new Date(f.now+11000));
  assert.ok(f.codesFor().includes(codes.STAGED_AFTER_INSTALLER));
});
test("physical packaged editor/sidecar/preload integrity failure blocks release",t=>{
  const f=makeFixture(t);
  const result=f.codesFor({...f.opts,resourceVerifier:()=>{throw Error("sidecar mismatch");}});
  assert.ok(result.includes(codes.RESOURCE_INTEGRITY_MISMATCH));
});
test("refuses malformed release index without correct asset name",()=>{
  assert.throws(()=>parseLatest("path: ..\\payload.exe\nsha512: xxx\n"),/latest.yml/);
});
