"use strict";
/**
 * Inspect the actual NSIS/7z payload WITHOUT executing/installing it.
 * Neither unpacked sidecars nor external availability.json alone constitute
 * proof that installer users receive six native GenOffice editors.
 */
const {execFileSync}=require("node:child_process");
const {createHash}=require("node:crypto");
const {readdirSync,existsSync,readFileSync,lstatSync,mkdtempSync,rmSync}=require("node:fs");
const {tmpdir}=require("node:os");
const {join,resolve,sep}=require("node:path");

const REQUIRED=Object.freeze([
  "resources/genoffice/availability.json",
  "resources/genoffice/cli/genoffice.cjs",
  "resources/genoffice/wasm/pdfium.wasm",
  "resources/genoffice/native/xlsx-sidecar.exe",
  "resources/genoffice/licenses/GenOffice-LICENSE",
  ...["docs","sheets","slides","pdf","markdown","html"].map(n=>`resources/genoffice/apps/${n}/out/renderer/index.html`),
  ...["sheets","slides","pdf","markdown","html"].map(n=>`resources/genoffice/apps/${n}/out/preload/index.js`),
]);

function find7za(env=process.env) {
  if (env.MCODE_OFFICE_7ZA) {
    const explicit=resolve(env.MCODE_OFFICE_7ZA);
    if(!existsSync(explicit))throw Error("MCODE_OFFICE_7ZA is set but unavailable");
    return explicit;
  }
  // electron-builder already installs 7za into its user-local cache. Discover
  // it rather than hard-coding workstation usernames, install roots or hashes.
  if(env.LOCALAPPDATA) {
    const cache=join(env.LOCALAPPDATA,"electron-builder","Cache");
    if(existsSync(cache)) {
      for(const dir of readdirSync(cache,{withFileTypes:true})) {
        if(!dir.isDirectory()||!dir.name.startsWith("7zip@"))continue;
        const root=join(cache,dir.name);
        for(const e of readdirSync(root,{withFileTypes:true})) {
          if(!e.isDirectory())continue;
          const bin=join(root,e.name,"bin","7za.exe");
          if(existsSync(bin))return bin;
        }
      }
    }
  }
  for(const p of ["C:\\Program Files\\7-Zip\\7z.exe","C:\\Program Files (x86)\\7-Zip\\7z.exe"]) {
    if(existsSync(p))return p;
  }
  // PATH fallback for CI or Linux cross-verification; missing command fails
  // closed in the calling release audit rather than suppressing inspection.
  return "7za";
}
/** Compare the actual NSIS core binaries with the already audited unpacked files. */
function verifyCoreParity(archive, unpackedGenofficeRoot, sevenZip, extract) {
  const root=resolve(unpackedGenofficeRoot);
  const results=[];
  for(const name of REQUIRED) {
    if(name.endsWith("/availability.json"))continue; // exact JSON equality handled separately
    const relative=name.slice("resources/genoffice/".length);
    if(!relative || relative.split("/").some(part=>part===".." || part===".")) {
      throw Error("unsafe NSIS core asset path");
    }
    const staged=resolve(root,...relative.split("/"));
    if(!staged.startsWith(root+sep))throw Error("unpacked asset path escapes verified root");
    const st=lstatSync(staged);
    if(!st.isFile() || st.isSymbolicLink() || st.size<=0 || st.size>128*1024*1024) {
      throw Error("GenOffice unpacked core asset is missing, unsafe or exceeds 128 MiB: "+relative);
    }
    const sourceDigest=createHash("sha256").update(readFileSync(staged)).digest("hex");
    // 7za extracts precisely ONE path's uncompressed bytes to stdout, never
    // executes the installer or writes files on the user's machine.
    const payload=extract(sevenZip,["e","-so",archive,name.replace(/\//g,"\\")],
      Math.max(1024*1024,st.size+64*1024));
    if(!Buffer.isBuffer(payload) || payload.length!==st.size) {
      throw Error("NSIS packaged "+relative+" length differs from unpacked verified asset");
    }
    const payloadDigest=createHash("sha256").update(payload).digest("hex");
    if(payloadDigest!==sourceDigest) {
      throw Error("NSIS packaged "+relative+" SHA256 differs from unpacked verified asset");
    }
    results.push(relative);
  }
  return {ok:true,files:results.length};
}
/**
 * Extract ONLY the previously listed, path-sanitized GenOffice subtree into
 * an owned throwaway directory; verify every renderer chunk, preload bundle,
 * CLI dependency, license, PDFium and native worker with the SAME afterPack
 * verifier used for win-unpacked. This closes the gap left by entry-only
 * checks (thousands of JS/CSS assets could otherwise be stale).
 */
function verifyCompletePayload(archive, sevenZip, names, opts={}) {
  for(const name of names) {
    const norm=name.replace(/\\/g,"/").replace(/\/$/,"");
    const segments=norm.split("/");
    if(!(norm.toLowerCase()==="resources/genoffice" || norm.toLowerCase().startsWith("resources/genoffice/")) ||
       segments.some(part=>!part||part==="."||part===".."||part.includes(":")||part.includes("\0"))) {
      throw Error("Unsafe GenOffice NSIS archive entry refuses extraction: "+name);
    }
  }
  const parent=mkdtempSync(join(tmpdir(),"mcode-nsis-genoffice-"));
  try {
    const unpack=opts.unpack??((bin,args)=>execFileSync(bin,args,{
      windowsHide:true,timeout:180_000,maxBuffer:2*1024*1024,
    }));
    unpack(sevenZip,["x","-y","-bd","-o"+parent,archive,"resources\\genoffice\\*"]);
    const root=join(parent,"resources","genoffice");
    const verify=opts.verify??require("../../build/verify-genoffice-editors-after-pack.cjs").verifyPackagedGenofficeEditorAssets;
    const result=verify(root);
    if(result?.editorsBundled!==true)throw Error("NSIS extracted GenOffice does not contain all six editors");
    return {ok:true,files:names.length};
  }finally{
    rmSync(parent,{recursive:true,force:true,maxRetries:4,retryDelay:150});
  }
}
function readPayload(archive, opts={}) {
  const sevenZip=opts.sevenZip??find7za();
  const extract=opts.extract??((bin,args,maxBuffer)=>execFileSync(bin,args,{
    encoding:null,windowsHide:true,timeout:100_000,maxBuffer,
  }));
  const run=(args,maxBuffer)=>extract(sevenZip,args,maxBuffer).toString("utf8");
  const manifestPath="resources\\genoffice\\availability.json";
  const json=run(["e","-so",archive,manifestPath],256*1024).trim();
  const manifest=JSON.parse(json);
  if(!manifest || typeof manifest!=="object" || Array.isArray(manifest))
    throw Error("NSIS GenOffice availability.json is not an object");
  // Restrict listing to GenOffice resources, not the potentially huge
  // application archive. -ba suppresses 7z decorative headers.
  const listing=run(["l","-ba","-slt",archive,"resources\\genoffice\\*"],96*1024*1024);
  const found=new Set();
  for(const line of listing.split(/\r?\n/)) {
    const match=/^Path = (.+)$/.exec(line);
    if(match)found.add(match[1].replace(/\\/g,"/").toLowerCase());
  }
  const missing=REQUIRED.filter(x=>!found.has(x.toLowerCase()));
  const coreParity=opts.compareRoot && missing.length===0
    ?verifyCoreParity(archive,opts.compareRoot,sevenZip,extract):null;
  const fullTreeParity=opts.compareRoot && missing.length===0
    ?verifyCompletePayload(archive,sevenZip,found,opts):null;
  return {manifest,missing,count:found.size,coreParity,fullTreeParity};
}
module.exports={readPayload,find7za,verifyCoreParity,verifyCompletePayload,REQUIRED};
