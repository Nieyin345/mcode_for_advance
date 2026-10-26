"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {verifyMountedDmg,verifyDmg,verifyMacZip}=require("./verify-macos-dmg.cjs");
const {verifyMacArtifacts}=require("./verify-macos-artifacts.cjs");
const HASH="a".repeat(40);
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"mcode-dmg-release-unit-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const mount=path.join(root,"mount");
  const genoffice=path.join(mount,"Mcode.app","Contents","Resources","genoffice");
  fs.mkdirSync(genoffice,{recursive:true});
  const stage=path.join(root,"availability.json");
  const lock=path.join(root,"upstream-lock.json");
  const manifest={
    format:"mcode.genoffice.resources.v1",
    bundled:true,editorsBundled:true,editors:["docs","sheets","slides","pdf","markdown","html"],
    genofficeSourceRevision:HASH,genofficeSourceTree:HASH,
    mcodeSourceRevision:HASH,mcodeSourceClean:true,mcodeReleaseVersion:"1.2.3",
  };
  function write() {
    const json=JSON.stringify(manifest);
    fs.writeFileSync(path.join(genoffice,"availability.json"),json);
    fs.writeFileSync(stage,json);
    fs.writeFileSync(lock,JSON.stringify({revision:HASH,expectedTree:HASH}));
  }
  write();
  const options={sourceLockFile:lock,version:"1.2.3",resourceVerifier:()=>({
    editorsBundled:true,editors:manifest.editors,
  })};
  return {root,mount,genoffice,stage,lock,manifest,write,options};
}
test("accepts real .app path only with six editors and matching approved source tree",t=>{
  const f=fixture(t);
  const result=verifyMountedDmg(f.mount,f.stage,f.options);
  assert.equal(result.ok,true);
  assert.equal(result.editors.length,6);
  assert.equal(result.mcodeReleaseVersion,"1.2.3");
});
test("rejects older DMG while the adjacent stage was refreshed",t=>{
  const f=fixture(t);
  f.manifest.mcodeReleaseVersion="1.2.4";
  fs.writeFileSync(f.stage,JSON.stringify(f.manifest));
  assert.throws(()=>verifyMountedDmg(f.mount,f.stage,f.options),/differs/);
});
test("rejects actual mounted DMG lacking Office despite a complete stage",t=>{
  const f=fixture(t);
  const inside={...f.manifest,bundled:false,editorsBundled:false,editors:[]};
  fs.writeFileSync(path.join(f.genoffice,"availability.json"),JSON.stringify(inside));
  assert.throws(()=>verifyMountedDmg(f.mount,f.stage,f.options),/disabled/);
});
test("rejects wrong GenOffice Git tree even when staged manifest matches",t=>{
  const f=fixture(t);
  f.manifest.genofficeSourceTree="b".repeat(40);f.write();
  assert.throws(()=>verifyMountedDmg(f.mount,f.stage,f.options),/source lock/);
});
test("rejects missing clean-build proof or different tag version",t=>{
  const f=fixture(t);
  f.manifest.mcodeSourceClean=false;f.write();
  assert.throws(()=>verifyMountedDmg(f.mount,f.stage,f.options),/clean-build/);
  f.manifest.mcodeSourceClean=true;f.write();
  assert.throws(()=>verifyMountedDmg(f.mount,f.stage,{...f.options,version:"2.0.0"}),/clean-build/);
});
test("rejects unverifiable renderer, preload, sidecar or CLI content",t=>{
  const f=fixture(t);
  assert.throws(()=>verifyMountedDmg(f.mount,f.stage,{
    ...f.options,resourceVerifier:()=>{throw Error("sidecar SHA-256 changed");},
  }),/sidecar SHA-256/);
  assert.throws(()=>verifyMountedDmg(f.mount,f.stage,{
    ...f.options,resourceVerifier:()=>({editorsBundled:false}),
  }),/integrity not verified/);
});
test("rejects missing, duplicate or fake .app directories",t=>{
  const f=fixture(t);
  fs.mkdirSync(path.join(f.mount,"Other.app"));
  assert.throws(()=>verifyMountedDmg(f.mount,f.stage,f.options),/exactly one/);
  fs.rmSync(path.join(f.mount,"Other.app"),{recursive:true,force:true});
  fs.renameSync(path.join(f.mount,"Mcode.app"),path.join(f.mount,"Mcode.disabled"));
  assert.throws(()=>verifyMountedDmg(f.mount,f.stage,f.options),/exactly one/);
});
test("DMG reader mounts only read-only and always detaches its owned temp mount",t=>{
  const f=fixture(t);
  const dmg=path.join(f.root,"Mcode-test.dmg");
  fs.writeFileSync(dmg,"isolated fake DMG, no real hdiutil invoked");
  let attached=false,detached=false,detachedMount;
  const fakeHdiutil=args=>{
    if(args[0]==="attach") {
      assert.deepEqual(args.slice(0,4),["attach","-readonly","-nobrowse","-mountpoint"]);
      const mount=args[4];assert.equal(args[5],dmg);
      fs.mkdirSync(path.join(mount,"Mcode.app","Contents","Resources","genoffice"),{recursive:true});
      fs.copyFileSync(f.stage,path.join(mount,"Mcode.app","Contents","Resources","genoffice","availability.json"));
      attached=true;return;
    }
    if(args[0]==="detach") {
      detached=true;detachedMount=args[1];return;
    }
    throw Error("unexpected hdiutil operation");
  };
  const result=verifyDmg(dmg,f.stage,{...f.options,hdiutil:fakeHdiutil,allowTestPlatform:true});
  assert.equal(result.ok,true);
  assert.equal(attached,true);assert.equal(detached,true);
  assert.equal(fs.existsSync(detachedMount),false);
});
test("macOS updater ZIP is independently unpacked and verified, with owned temp cleanup",t=>{
  const f=fixture(t);
  const zip=path.join(f.root,"Mcode-test.zip");
  fs.writeFileSync(zip,"fixture zip");
  let extracted;
  const result=verifyMacZip(zip,f.stage,{
    ...f.options,allowTestPlatform:true,
    ditto:args=>{
      assert.deepEqual(args.slice(0,3),["-x","-k",zip]);
      extracted=args[3];
      const dir=path.join(extracted,"Mcode.app","Contents","Resources","genoffice");
      fs.mkdirSync(dir,{recursive:true});
      fs.copyFileSync(f.stage,path.join(dir,"availability.json"));
    },
  });
  assert.equal(result.ok,true);
  assert.equal(fs.existsSync(extracted),false);
});
test("macOS updater ZIP fails when its GenOffice manifest is disabled",t=>{
  const f=fixture(t);
  const zip=path.join(f.root,"Mcode-test.zip");
  fs.writeFileSync(zip,"fixture zip");
  assert.throws(()=>verifyMacZip(zip,f.stage,{
    ...f.options,allowTestPlatform:true,
    ditto:args=>{
      const dir=path.join(args[3],"Mcode.app","Contents","Resources","genoffice");
      fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,"availability.json"),JSON.stringify({...f.manifest,bundled:false}));
    },
  }),/disabled/);
});
test("release gate requires BOTH macOS DMG and ZIP with matching revision",t=>{
  const f=fixture(t);
  const release=path.join(f.root,"release");fs.mkdirSync(release);
  fs.writeFileSync(path.join(release,"Mcode-1.2.3.dmg"),"fixture");
  fs.writeFileSync(path.join(release,"Mcode-1.2.3-mac.zip"),"fixture");
  const ok={embeddedGenofficeRevision:HASH,mcodeSourceRevision:HASH,mcodeReleaseVersion:"1.2.3"};
  const result=verifyMacArtifacts(release,f.stage,{verifyDmg:()=>ok,verifyZip:()=>ok});
  assert.equal(result.ok,true);
  assert.throws(()=>verifyMacArtifacts(release,f.stage,{verifyDmg:()=>ok,
    verifyZip:()=>({...ok,mcodeSourceRevision:"b".repeat(40)})}),/revisions differ/);
  fs.rmSync(path.join(release,"Mcode-1.2.3-mac.zip"));
  assert.throws(()=>verifyMacArtifacts(release,f.stage,{verifyDmg:()=>ok,verifyZip:()=>ok}),/exactly one/);
});
test("DMG reader detaches even when validation fails",t=>{
  const f=fixture(t);
  const dmg=path.join(f.root,"Mcode-test.dmg");
  fs.writeFileSync(dmg,"fixture");
  let detached=false;
  assert.throws(()=>verifyDmg(dmg,f.stage,{
    ...f.options,allowTestPlatform:true,
    hdiutil:args=>{
      if(args[0]==="attach") {
        const mount=args[4];
        fs.mkdirSync(path.join(mount,"Other.app"));
      }else if(args[0]==="detach")detached=true;
    },
  }),/missing or symlinked/);
  assert.equal(detached,true);
});
