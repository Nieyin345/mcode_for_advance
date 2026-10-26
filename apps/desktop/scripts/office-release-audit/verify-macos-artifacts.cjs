"use strict";
/** CI publishes DMG for direct install AND ZIP for updater: verify BOTH. */
const fs=require("node:fs");
const path=require("node:path");
const {verifyDmg,verifyMacZip}=require("./verify-macos-dmg.cjs");
function findMacArtifacts(releaseDir) {
  const files=fs.readdirSync(releaseDir,{withFileTypes:true})
    .filter(x=>x.isFile()).map(x=>x.name);
  const dmg=files.filter(x=>/^Mcode-[\w.-]+\.dmg$/i.test(x));
  const zip=files.filter(x=>/^Mcode-[\w.-]+\.zip$/i.test(x));
  if(dmg.length!==1||zip.length!==1)
    throw Error("Expected exactly one release Mcode DMG and one updater ZIP; got "+dmg.length+"/"+zip.length);
  return {dmg:path.join(releaseDir,dmg[0]),zip:path.join(releaseDir,zip[0])};
}
function verifyMacArtifacts(releaseDir,staging,options={}) {
  const files=findMacArtifacts(path.resolve(releaseDir));
  const dmg=(options.verifyDmg??verifyDmg)(files.dmg,staging,options);
  const zip=(options.verifyZip??verifyMacZip)(files.zip,staging,options);
  if(dmg.embeddedGenofficeRevision!==zip.embeddedGenofficeRevision ||
      dmg.mcodeSourceRevision!==zip.mcodeSourceRevision ||
      dmg.mcodeReleaseVersion!==zip.mcodeReleaseVersion)
    throw Error("macOS DMG and updater ZIP source revisions differ");
  return {ok:true,dmg:files.dmg,zip:files.zip,
    genofficeRevision:dmg.embeddedGenofficeRevision,
    mcodeRevision:dmg.mcodeSourceRevision,releaseVersion:dmg.mcodeReleaseVersion};
}
if(require.main===module) {
  const [release,stage]=process.argv.slice(2);
  if(!release||!stage) {
    console.error("Usage: node verify-macos-artifacts.cjs <release-dir> <staged-availability.json>");
    process.exitCode=2;
  } else {
    try {
      const result=verifyMacArtifacts(release,stage);
      console.log(JSON.stringify(result,null,2));
    }catch(error) {
      console.error("macOS actual DMG/ZIP Office payload verification FAILED: "+String(error));
      process.exitCode=2;
    }
  }
}
module.exports={findMacArtifacts,verifyMacArtifacts};
