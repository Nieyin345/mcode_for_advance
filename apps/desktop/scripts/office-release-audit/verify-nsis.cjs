"use strict";
/** Fail-closed CI gate for the ACTUAL NSIS payload. Does not install anything. */
const {readFileSync}=require("node:fs");
const {resolve,dirname}=require("node:path");
const {readPayload,REQUIRED}=require("./nsis-inspector.cjs");
const EDITORS=["docs","sheets","slides","pdf","markdown","html"];
function verifyInstallerContent(installer,unpackedManifest,read=readPayload) {
  const result=read(resolve(installer),{compareRoot:dirname(resolve(unpackedManifest))});
  const manifest=JSON.parse(readFileSync(resolve(unpackedManifest),"utf8"));
  const failures=[];
  if (result.manifest?.bundled!==true || result.manifest?.editorsBundled!==true ||
      !EDITORS.every(x=>result.manifest?.editors?.includes(x))) {
    failures.push("Actual NSIS installer has GenOffice native editors disabled or incomplete");
  }
  if (result.missing?.length)failures.push("Actual NSIS missing: "+result.missing.join(", "));
  if (JSON.stringify(result.manifest)!==JSON.stringify(manifest))
    failures.push("NSIS embedded availability.json differs from adjacent win-unpacked availability.json");
  if (result.coreParity?.ok!==true || result.coreParity.files!==REQUIRED.length-1)
    failures.push("NSIS installer core asset bytes are not proven equal to staged six-editor resources");
  if (result.fullTreeParity?.ok!==true)
    failures.push("NSIS full GenOffice asset tree was not extracted and verified against the embedded SHA256 manifest");
  return {ok:failures.length===0,failures,installerBundled:result.manifest?.bundled===true,
    installerEditorsBundled:result.manifest?.editorsBundled===true,
    embeddedGenofficePaths:result.count,verifiedCoreAssets:result.coreParity?.files??0,
    fullTreeVerified:result.fullTreeParity?.ok===true};
}
if(require.main===module) {
  const exe=process.argv[2], unpacked=process.argv[3];
  if(!exe || !unpacked) {
    console.error("Usage: node verify-nsis.cjs <installer.exe> <win-unpacked/resources/genoffice/availability.json>");
    process.exitCode=2;
  }else{
    try{
      const report=verifyInstallerContent(exe,unpacked);
      process.stdout.write(JSON.stringify(report,null,2)+"\n");
      if(!report.ok)process.exitCode=2;
    }catch(e){console.error("NSIS actual payload verification failed CLOSED:",String(e));process.exitCode=2;}
  }
}
module.exports={verifyInstallerContent};
