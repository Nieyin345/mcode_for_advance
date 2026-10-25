"use strict";
/**
 * Inspect the actual NSIS/7z payload WITHOUT executing/installing it.
 * Neither unpacked sidecars nor external availability.json alone constitute
 * proof that installer users receive six native GenOffice editors.
 */
const {execFileSync}=require("node:child_process");
const {readdirSync,existsSync}=require("node:fs");
const {join,resolve}=require("node:path");

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
function readPayload(archive, opts={}) {
  const sevenZip=opts.sevenZip??find7za();
  const run=(args,maxBuffer)=>execFileSync(sevenZip,args,{
    encoding:"utf8",windowsHide:true,timeout:100_000,maxBuffer,
  });
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
  return {manifest,missing:REQUIRED.filter(x=>!found.has(x.toLowerCase())),count:found.size};
}
module.exports={readPayload,find7za,REQUIRED};
