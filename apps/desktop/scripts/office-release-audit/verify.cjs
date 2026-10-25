"use strict";
/**
 * Read-only Windows Mcode Office release audit. Never builds, installs,
 * launches, deletes or mutates anything. Treat missing proof as BLOCKED.
 *
 * This audit is independent of the O3 unpacked six-renderer smoke:
 * a real launch of old win-unpacked cannot prove today's installer contains
 * current Mcode + GenOffice changes or has an OS-trusted signature.
 */
const { existsSync, readFileSync, statSync } = require("node:fs");
const { resolve, join, basename } = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const EXPECTED_EDITORS = Object.freeze(["docs", "sheets", "slides", "pdf", "markdown", "html"]);
const DIGEST_RE = /^[a-f0-9]{64}$/;
const GIT_OBJECT_RE = /^[a-f0-9]{40}$/;
const codes = Object.freeze({
  MISSING_RELEASE: "MISSING_RELEASE",
  MISSING_RESOURCE: "MISSING_RESOURCE",
  INVALID_RESOURCE_MANIFEST: "INVALID_RESOURCE_MANIFEST",
  RESOURCE_INTEGRITY_MISMATCH: "RESOURCE_INTEGRITY_MISMATCH",
  HASH_MISMATCH: "HASH_MISMATCH",
  VERSION_MISMATCH: "VERSION_MISMATCH",
  STALE_INSTALLER: "STALE_INSTALLER",
  STAGED_AFTER_INSTALLER: "STAGED_AFTER_INSTALLER",
  MISSING_SOURCE_ATTESTATION: "MISSING_SOURCE_ATTESTATION",
  SOURCE_REVISION_MISMATCH: "SOURCE_REVISION_MISMATCH",
  MCODE_BUILD_REVISION_MISMATCH: "MCODE_BUILD_REVISION_MISMATCH",
  UNATTESTED_BUILD: "UNATTESTED_BUILD",
  UNSIGNED_INSTALLER: "UNSIGNED_INSTALLER",
  DIRTY_WORKTREE: "DIRTY_WORKTREE",
  MISSING_GIT_EVIDENCE: "MISSING_GIT_EVIDENCE",
});

function parseLatest(content) {
  // The checked release emitter's exact machine-readable YAML subset.
  // Refuse unexpected path forms rather than guessing a filename to publish.
  const value = (k) => {
    const match = new RegExp("^" + k + ":\\s*(.+)\\s*$", "m").exec(content);
    return match?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? null;
  };
  const file = value("path");
  const hash = value("sha512");
  const size = Number(/^[ \t]+size:\s*(\d+)\s*$/m.exec(content)?.[1]);
  const listed = /^[ \t]+- url:\s*(\S+)\s*$/m.exec(content)?.[1] ?? null;
  if (!file || !/^Mcode-[\w.-]+-x64\.exe$/.test(file) || file !== listed ||
      !hash || !/^[\w+/]+={0,2}$/.test(hash) || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error("latest.yml missing trustworthy path/url/sha512/size");
  }
  return { filename:file, sha512:hash, size, version:value("version") };
}
function sha512(file) {
  // Hash potentially gigabyte-scale installers with a bounded 1 MiB buffer.
  const fs=require("node:fs");
  const hash=createHash("sha512"), chunk=Buffer.allocUnsafe(1024*1024);
  const fd=fs.openSync(file,"r");
  try {
    for(;;){const n=fs.readSync(fd,chunk,0,chunk.length,null);if(n===0)break;hash.update(chunk.subarray(0,n));}
  }finally{fs.closeSync(fd);}
  return hash.digest("base64");
}
function defaultGit(repoRoot) {
  const git = (...args) => execFileSync("git", args, {cwd:repoRoot, encoding:"utf8",timeout:20000,windowsHide:true}).trim();
  return {head:git("rev-parse","HEAD"), commitTime:Date.parse(git("log","-1","--format=%cI")),
    dirty:git("status","--porcelain").length > 0};
}
function defaultSignature(exe) {
  if (process.platform !== "win32") return "UnsupportedOS";
  const quote = exe.replace(/'/g, "''");
  return execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",
    "(Get-AuthenticodeSignature -LiteralPath '"+quote+"').Status.ToString()"],{
      encoding:"utf8",timeout:30000,windowsHide:true,
    }).trim();
}
function auditRelease(opts={}) {
  const repo = resolve(opts.repoRoot || join(__dirname,"../../../.."));
  const release = resolve(opts.releaseDir || join(repo,"apps","desktop","release"));
  const blockers = [], facts = {};
  const block = (code,detail) => blockers.push({code,detail});
  let latest;
  try {latest=parseLatest(readFileSync(join(release,"latest.yml"),"utf8"));}
  catch(err){block(codes.MISSING_RELEASE, "latest.yml: "+String(err.message));}
  let exe=null;
  if (latest) {
    facts.version=latest.version;
    const p=join(release,latest.filename);
    exe=p;
    if (!existsSync(p)) block(codes.MISSING_RELEASE,"installer referenced by latest.yml not found");
    else {
      const s=statSync(p); facts.installerBytes=s.size;
      facts.installerModifiedUtc=s.mtime.toISOString();
      if(s.size!==latest.size || sha512(p)!==latest.sha512)
        block(codes.HASH_MISMATCH,"installer bytes or SHA512 disagree with latest.yml");
      const expectedVersion=/^Mcode-(.+)-x64\.exe$/.exec(latest.filename)?.[1];
      let packageVersion=null;
      try {packageVersion=JSON.parse(readFileSync(join(repo,"apps/desktop/package.json"),"utf8")).version;}
      catch { /* absent */ }
      if (!packageVersion || expectedVersion!==packageVersion || packageVersion!==latest.version)
        block(codes.VERSION_MISMATCH,"installer/latest.yml/package.json versions differ");
      let signature="Unknown";
      try {signature=opts.signatureStatus ?? defaultSignature(p);}
      catch(e){signature="Unavailable";block(codes.UNSIGNED_INSTALLER,"signature check unavailable: "+String(e.message));}
      facts.signature=signature;
      if (signature!=="Valid" && !blockers.some(b=>b.code===codes.UNSIGNED_INSTALLER))
        block(codes.UNSIGNED_INSTALLER,"Windows Authenticode status is "+signature);
    }
  }
  let manifest=null;
  const manifestFile=join(release,"win-unpacked","resources","genoffice","availability.json");
  if(!existsSync(manifestFile))block(codes.MISSING_RESOURCE,"win-unpacked GenOffice resource availability.json missing");
  else {
    try {
      manifest=JSON.parse(readFileSync(manifestFile,"utf8"));
      facts.bundledEditors=Array.isArray(manifest.editors)?manifest.editors.slice().sort():[];
      const complete=manifest.format==="mcode.genoffice.resources.v1" &&
        manifest.bundled===true && manifest.editorsBundled===true &&
        EXPECTED_EDITORS.every(name=>manifest.editors.includes(name)) &&
        EXPECTED_EDITORS.every(name=>DIGEST_RE.test(manifest.editorAssetsSha256?.[name])) &&
        DIGEST_RE.test(manifest.cliSha256) && DIGEST_RE.test(manifest.pdfiumWasmSha256) &&
        DIGEST_RE.test(manifest.nativeSidecarSha256);
      if(!complete)block(codes.INVALID_RESOURCE_MANIFEST,"not all six native editors/sidecar/CLI/WASM digests are declared");
      if (exe && existsSync(exe) && statSync(manifestFile).mtimeMs > statSync(exe).mtimeMs)
        block(codes.STAGED_AFTER_INSTALLER,"unpacked resources were staged after the published installer; cannot prove parity");
    } catch (e) { block(codes.INVALID_RESOURCE_MANIFEST,String(e.message)); }
  }
  if(manifest?.bundled === true && manifest?.editorsBundled === true) {
    try {
      const verifier = opts.resourceVerifier ?? require("../../build/verify-genoffice-editors-after-pack.cjs").verifyPackagedGenofficeEditorAssets;
      verifier(join(release,"win-unpacked","resources","genoffice"));
      facts.nativeResourceIntegrity="PASS";
    } catch(e) {
      block(codes.RESOURCE_INTEGRITY_MISMATCH,"physical GenOffice CLI/renderer/preload/sidecar resources failed afterPack integrity verification: "+String(e.message));
    }
  }
  let lock=null;
  try {lock=JSON.parse(readFileSync(join(repo,"apps/desktop/build/genoffice-upstream.lock.json"),"utf8"));}
  catch(e){block(codes.MISSING_SOURCE_ATTESTATION,"trusted GenOffice upstream lock missing");}
  if(lock) {
    facts.expectedGenofficeRevision=lock.revision;
    if (!GIT_OBJECT_RE.test(lock.revision)||!GIT_OBJECT_RE.test(lock.expectedTree))
      block(codes.MISSING_SOURCE_ATTESTATION,"invalid repository revision/tree lock");
    if (!manifest || typeof manifest.genofficeSourceRevision!=="string" ||
        typeof manifest.genofficeSourceTree!=="string") {
      block(codes.MISSING_SOURCE_ATTESTATION,"this package has no embedded GenOffice source revision/tree; freshness unprovable");
    } else if(manifest.genofficeSourceRevision!==lock.revision || manifest.genofficeSourceTree!==lock.expectedTree) {
      block(codes.SOURCE_REVISION_MISMATCH,"packaged GenOffice revision/tree not equal to current approved fork");
    }
  }
  try {
    const git=opts.gitEvidence ?? defaultGit(repo);
    facts.head=git.head;
    if (manifest) {
      if(typeof manifest.mcodeSourceRevision!=="string" || typeof manifest.mcodeSourceClean!=="boolean") {
        block(codes.UNATTESTED_BUILD,"package does not record its Mcode source revision or source clean state");
      } else if(manifest.mcodeSourceRevision!==git.head || manifest.mcodeSourceClean!==true) {
        block(codes.MCODE_BUILD_REVISION_MISMATCH,"packaged Mcode source revision differs from current HEAD or was built dirty");
      }
    }
    if (!Number.isFinite(git.commitTime))throw Error("invalid git commit timestamp");
    if (exe && existsSync(exe) && statSync(exe).mtimeMs < git.commitTime)
      block(codes.STALE_INSTALLER,"installer predates current Mcode source HEAD commit");
    if(git.dirty)block(codes.DIRTY_WORKTREE,"concurrent uncommitted changes: source snapshot is not release-frozen");
  } catch(e) {block(codes.MISSING_GIT_EVIDENCE,"cannot verify release source git state: "+String(e.message));}
  return {status:blockers.length?"BLOCKED":"READY",blockers,facts};
}
if(require.main===module) {
  const out=auditRelease();
  process.stdout.write(JSON.stringify(out,null,2)+"\n");
  process.exitCode=out.status==="READY"?0:2;
}
module.exports={auditRelease,parseLatest,codes};
