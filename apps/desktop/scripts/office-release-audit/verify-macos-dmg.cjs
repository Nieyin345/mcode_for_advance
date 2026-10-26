"use strict";
/**
 * Read-only verification of the ACTUAL shipped macOS DMG payload.
 *
 * Electron-builder's mac-unpacked/ folder can be re-staged AFTER a DMG was
 * created, just like the Windows win-unpacked/ vs NSIS mismatch in O26.
 * Only hdiutil's read-only mounted distributable image proves what ships.
 *
 * No install, Apple signing, user account access or network calls.
 */
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {execFileSync}=require("node:child_process");
const {verifyPackagedGenofficeEditorAssets}=require("../../build/verify-genoffice-editors-after-pack.cjs");

const EDITORS=Object.freeze(["docs","sheets","slides","pdf","markdown","html"]);
const GIT_SHA=/^[0-9a-f]{40}$/;
function isPlainDirectory(dir) {
  try {
    const st=fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch(e) {
    if(e?.code==="ENOENT")return false;
    throw e;
  }
}
function validatedAppRoot(mountpoint) {
  const mount=path.resolve(mountpoint);
  if(!isPlainDirectory(mount))throw Error("DMG mountpoint is not a real directory");
  const apps=fs.readdirSync(mount,{withFileTypes:true})
    .filter(x=>x.name.endsWith(".app"));
  if(apps.length!==1)throw Error("DMG must contain exactly one .app bundle; found "+apps.length);
  const app=path.join(mount,apps[0].name);
  // Cannot permit .app symlink to an unrelated directory.
  if(!isPlainDirectory(app))throw Error("DMG .app is not a physical directory");
  const parts=["Contents","Resources","genoffice"];
  let root=app;
  for(const part of parts) {
    root=path.join(root,part);
    if(!isPlainDirectory(root))throw Error("DMG GenOffice resource path is missing or symlinked: "+part);
  }
  if(!fs.realpathSync(root).startsWith(fs.realpathSync(mount)+path.sep)) {
    throw Error("DMG GenOffice resources escape mounted image");
  }
  return root;
}
function readJson(file) {
  const st=fs.lstatSync(file);
  if(!st.isFile() || st.isSymbolicLink() || st.size===0 || st.size>512*1024) {
    throw Error("Invalid or oversized GenOffice availability.json: "+file);
  }
  const parsed=JSON.parse(fs.readFileSync(file,"utf8"));
  if(!parsed || typeof parsed!=="object" || Array.isArray(parsed))
    throw Error("GenOffice availability must be an object");
  return parsed;
}
function verifyMountedDmg(mountpoint, stageManifestFile, {
  sourceLockFile=path.join(__dirname,"../../build/genoffice-upstream.lock.json"),
  resourceVerifier=verifyPackagedGenofficeEditorAssets,
  version=process.env.MCODE_RELEASE_VERSION,
}={}) {
  const root=validatedAppRoot(mountpoint);
  const embeddedFile=path.join(root,"availability.json");
  const embedded=readJson(embeddedFile);
  const staged=readJson(stageManifestFile);
  if(embedded.format!=="mcode.genoffice.resources.v1" ||
      embedded.bundled!==true || embedded.editorsBundled!==true ||
      !Array.isArray(embedded.editors) ||
      JSON.stringify(embedded.editors)!==JSON.stringify(EDITORS)) {
    throw Error("Actual DMG has GenOffice native editors disabled or incomplete");
  }
  // Identical manifest prevents an 'old DMG, newly staged resources' false PASS.
  if(!fs.readFileSync(embeddedFile).equals(fs.readFileSync(stageManifestFile))) {
    throw Error("DMG embedded GenOffice manifest differs from source staging manifest");
  }
  const lock=readJson(sourceLockFile);
  if(!GIT_SHA.test(embedded.genofficeSourceRevision) ||
      !GIT_SHA.test(embedded.genofficeSourceTree) ||
      embedded.genofficeSourceRevision!==lock.revision ||
      embedded.genofficeSourceTree!==lock.expectedTree) {
    throw Error("DMG embedded GenOffice revision/tree differs from approved source lock");
  }
  if(!GIT_SHA.test(embedded.mcodeSourceRevision) ||
      embedded.mcodeSourceClean!==true ||
      typeof embedded.mcodeReleaseVersion!=="string" ||
      !embedded.mcodeReleaseVersion ||
      (version!==undefined && embedded.mcodeReleaseVersion!==version)) {
    throw Error("DMG Mcode source version or clean-build attestation missing/mismatched");
  }
  const verified=resourceVerifier(root);
  if(!verified || verified.editorsBundled!==true) {
    throw Error("DMG actual six native GenOffice renderer/preload/CLI/sidecar integrity not verified");
  }
  return {
    ok:true,embeddedGenofficeRevision:embedded.genofficeSourceRevision,
    mcodeSourceRevision:embedded.mcodeSourceRevision,
    mcodeReleaseVersion:embedded.mcodeReleaseVersion,
    editors:EDITORS.slice(),verifiedResources:root,
  };
}
function verifyMacZip(zip,stageManifest,options={}) {
  if(process.platform!=="darwin" && options.allowTestPlatform!==true)
    throw Error("Actual macOS updater ZIP verification requires macOS ditto");
  const archive=path.resolve(zip);
  if(path.extname(archive).toLowerCase()!==".zip")throw Error("Expected a .zip updater archive");
  if(!fs.statSync(archive).isFile())throw Error("macOS updater ZIP does not exist");
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"mcode-office-maczip-check-"));
  const execute=options.ditto ?? ((args)=>execFileSync("ditto",args,{
    timeout:180000,windowsHide:true,stdio:["ignore","pipe","pipe"],
  }));
  try {
    execute(["-x","-k",archive,temp]);
    return verifyMountedDmg(temp,stageManifest,options);
  } finally {
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
function verifyDmg(dmg,stageManifest,options={}) {
  if(process.platform!=="darwin" && options.allowTestPlatform!==true)
    throw Error("Actual DMG verification requires macOS hdiutil");
  const archive=path.resolve(dmg);
  if(path.extname(archive).toLowerCase()!==".dmg") throw Error("Expected a .dmg distributable");
  if(!fs.statSync(archive).isFile())throw Error("DMG file does not exist");
  const mount=fs.mkdtempSync(path.join(os.tmpdir(),"mcode-office-dmg-check-"));
  const execute=options.hdiutil ?? ((args)=>execFileSync("hdiutil",args,{
    timeout:180000,windowsHide:true,stdio:["ignore","pipe","pipe"],
  }));
  let attached=false;
  try {
    execute(["attach","-readonly","-nobrowse","-mountpoint",mount,archive]);
    attached=true;
    return verifyMountedDmg(mount,stageManifest,options);
  } finally {
    if (attached) {
      // Never recursively remove a mounted volume if detach fails. Leave a
      // diagnostic mountpoint in the ephemeral CI runner and fail closed.
      execute(["detach",mount]);
      fs.rmSync(mount,{recursive:true,force:true});
    } else {
      // The attach command failed; it may have partially mounted something.
      // rmdir is safe only for an empty mountpoint, unlike recursive deletion.
      try { fs.rmdirSync(mount); } catch { /* fail closed without erasing mounted contents */ }
    }
  }
}
if(require.main===module) {
  const [dmg,staging]=process.argv.slice(2);
  if(!dmg||!staging) {
    console.error("Usage: node verify-macos-dmg.cjs <release/Mcode-*.dmg> <staged-genoffice/availability.json>");
    process.exitCode=2;
  } else {
    try {
      const result=verifyDmg(dmg,staging);
      console.log(JSON.stringify(result,null,2));
    } catch(error) {
      console.error("DMG GenOffice release FAILED CLOSED: "+String(error));
      process.exitCode=2;
    }
  }
}
module.exports={validatedAppRoot,verifyMountedDmg,verifyDmg,verifyMacZip,EDITORS};
