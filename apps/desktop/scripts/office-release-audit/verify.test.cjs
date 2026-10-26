"use strict";
const { test }=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {createHash}=require("node:crypto");
const {auditRelease,parseLatest,codes}=require("./verify.cjs");
const {verifyInstallerContent}=require("./verify-nsis.cjs");
const {verifyCoreParity,verifyCompletePayload,REQUIRED}=require("./nsis-inspector.cjs");
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
    mcodeSourceRevision:GIT_HASH,mcodeSourceClean:true,mcodeReleaseVersion:"0.1.62",
  };
  const manifestFile=path.join(res,"availability.json");
  fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  fs.writeFileSync(exe,payload);
  const now=Date.now();
  fs.utimesSync(manifestFile,new Date(now-8000),new Date(now-8000));
  fs.utimesSync(exe,new Date(now-4000),new Date(now-4000));
  const opts={repoRoot:repo,releaseDir:release,signatureStatus:"Valid",resourceVerifier:()=>true,
    nsisInspector:()=>({manifest:JSON.parse(fs.readFileSync(manifestFile,"utf8")),missing:[],count:19,coreParity:{ok:true,files:15},fullTreeParity:{ok:true,files:2584}}),
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
test("refuses an embedded release version that differs from latest.yml",t=>{
  const f=makeFixture(t);
  f.manifest.mcodeReleaseVersion="0.1.61";f.updateManifest();
  assert.ok(f.codesFor().includes(codes.MCODE_BUILD_VERSION_MISMATCH));
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
test("rejects real NSIS image when it disables GenOffice although win-unpacked includes editors",t=>{
  const f=makeFixture(t);
  const notBundled={...f.manifest,bundled:false,editorsBundled:false,editors:[]};
  const codesFor=f.codesFor({...f.opts,nsisInspector:()=>({manifest:notBundled,missing:[],count:1})});
  assert.ok(codesFor.includes(codes.NSIS_PAYLOAD_MISSING_EDITORS));
  assert.ok(codesFor.includes(codes.NSIS_MANIFEST_MISMATCH));
});
test("rejects NSIS image with declared editor assets but missing actual native preload",t=>{
  const f=makeFixture(t);
  const codesFor=f.codesFor({...f.opts,nsisInspector:()=>({
    manifest:f.manifest,missing:["resources/genoffice/apps/slides/out/preload/index.js"],count:19,
  })});
  assert.ok(codesFor.includes(codes.NSIS_PAYLOAD_MISSING_EDITORS));
});
test("rejects uninspectable or encrypted/unsupported NSIS rather than claiming readiness",t=>{
  const f=makeFixture(t);
  const codesFor=f.codesFor({...f.opts,nsisInspector:()=>{throw Error("unavailable");}});
  assert.ok(codesFor.includes(codes.NSIS_INSPECTION_FAILED));
});
test("CI gate inspects installer actual manifest, not just the staged unpacked directory",t=>{
  const f=makeFixture(t);
  const good=verifyInstallerContent(f.exe,f.manifestFile,
    ()=>({manifest:f.manifest,missing:[],count:29,coreParity:{ok:true,files:15},fullTreeParity:{ok:true,files:2584}}));
  assert.equal(good.ok,true);
  const hollow=verifyInstallerContent(f.exe,f.manifestFile,
    ()=>({manifest:{format:"mcode.genoffice.resources.v1",bundled:false,editorsBundled:false,editors:[]},
      missing:["resources/genoffice/apps/docs/out/renderer/index.html"],count:1,coreParity:null}));
  assert.equal(hollow.ok,false);
  assert.ok(hollow.failures.some(x=>x.includes("disabled")));
  assert.ok(hollow.failures.some(x=>x.includes("differs")));
});
test("CI rejects a matching manifest if actual installer core bytes are not verified",t=>{
  const f=makeFixture(t);
  const hollow=verifyInstallerContent(f.exe,f.manifestFile,
    ()=>({manifest:f.manifest,missing:[],count:29,coreParity:null}));
  assert.equal(hollow.ok,false);
  assert.ok(hollow.failures.some(x=>x.includes("core asset bytes")));
  assert.ok(f.codesFor({...f.opts,nsisInspector:()=>({
    manifest:f.manifest,missing:[],count:29,coreParity:{ok:false,files:15},
  })}).includes(codes.NSIS_CORE_ASSET_MISMATCH));
});
test("independent SHA256 parity detects one tampered NSIS payload with identical paths and manifest",t=>{
  const f=makeFixture(t);
  const root=path.join(f.release,"win-unpacked","resources","genoffice");
  for(const name of REQUIRED){
    if(name.endsWith("/availability.json"))continue;
    const relative=name.slice("resources/genoffice/".length);
    const target=path.join(root,...relative.split("/"));
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,Buffer.from("safe-"+relative));
  }
  const fakeArchive=new Map(REQUIRED.filter(x=>!x.endsWith("/availability.json")).map(name=>{
    const relative=name.slice("resources/genoffice/".length);
    return [name.toLowerCase(),fs.readFileSync(path.join(root,...relative.split("/")))];
  }));
  const extract=(_bin,args)=>{
    const key=args[3].replace(/\\/g,"/").toLowerCase();
    return fakeArchive.get(key);
  };
  const original=verifyCoreParity(f.exe,root,"mock7za",extract);
  assert.equal(original.ok,true);
  assert.equal(original.files,15);
  const targeted="resources/genoffice/native/xlsx-sidecar.exe";
  fakeArchive.set(targeted,Buffer.from("unsafe-sidecar-byte-change"));
  assert.throws(()=>verifyCoreParity(f.exe,root,"mock7za",extract),/SHA256 differs|length differs/);
});
test("missing whole-tree verification blocks a package despite matching entrypoints and manifest",t=>{
  const f=makeFixture(t);
  const result=f.codesFor({...f.opts,nsisInspector:()=>({
    manifest:f.manifest,missing:[],count:2584,coreParity:{ok:true,files:15},fullTreeParity:null,
  })});
  assert.ok(result.includes(codes.NSIS_FULL_TREE_MISMATCH));
  const gate=verifyInstallerContent(f.exe,f.manifestFile,()=>({
    manifest:f.manifest,missing:[],count:2584,coreParity:{ok:true,files:15},fullTreeParity:null,
  }));
  assert.equal(gate.ok,false);
  assert.ok(gate.failures.some(x=>x.includes("full GenOffice asset tree")));
});
test("whole-tree extractor blocks archive path traversal BEFORE unpack",()=>{
  let unpacked=false;
  assert.throws(()=>verifyCompletePayload("dummy","mock7za",
    ["resources/genoffice/apps/../../outside.txt"],{
      unpack:()=>{unpacked=true;},verify:()=>({editorsBundled:true}),
    }),/Unsafe GenOffice/);
  assert.equal(unpacked,false);
});
test("whole-tree verifier fails closed on corrupted non-entry JS chunks and removes only its own temp folder",()=>{
  let tempRoot;
  const unpack=(_bin,args)=>{
    tempRoot=args.find(x=>x.startsWith("-o")).slice(2);
    const js=path.join(tempRoot,"resources","genoffice","apps","sheets","out","renderer","assets","chart-chunk.js");
    fs.mkdirSync(path.dirname(js),{recursive:true});
    fs.writeFileSync(js,"corrupted");
  };
  const verify=root=>{
    assert.equal(root,path.join(tempRoot,"resources","genoffice"));
    const js=fs.readFileSync(path.join(root,"apps","sheets","out","renderer","assets","chart-chunk.js"),"utf8");
    if(js!=="expected")throw Error("renderer tree SHA256 mismatch: non-entry JS chunk");
    return {editorsBundled:true};
  };
  assert.throws(()=>verifyCompletePayload("mock-archive","mock7za",
    ["resources/genoffice/apps/sheets/out/renderer/assets/chart-chunk.js"],{
      unpack,verify,
    }),/renderer tree SHA256 mismatch/);
  assert.equal(fs.existsSync(tempRoot),false,"owned extraction directory must be removed even on verifier failure");
});
test("refuses malformed release index without correct asset name",()=>{
  assert.throws(()=>parseLatest("path: ..\\payload.exe\nsha512: xxx\n"),/latest.yml/);
});
