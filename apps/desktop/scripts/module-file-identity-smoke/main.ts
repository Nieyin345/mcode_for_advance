/** MC-035: real file-descriptor races around canonical resource authorization.
 * Only random private temp paths and synthetic byte strings; never user data.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, linkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileCapabilities, resolveModuleResource } from "../../src/main/modules/fileCapabilities.js";
import { armSwap, armRewriteOnRead, rewriteReadHits, clearSwap, swapHits } from "./fsPromisesStub.js";

let total=0, failed=0;
function check(label:string, yes:boolean, detail?:unknown):void {
  total++;if(!yes)failed++;
  console.log((yes?"  ok   ":"  FAIL ")+label+(yes?"":" "+JSON.stringify(detail)));
}
async function rejects(fn:()=>Promise<unknown>):Promise<boolean> {
  try{await fn();return false;}catch{return true;}
}
const temp=mkdtempSync(join(tmpdir(),"mcode-file-identity-"));
try{
  const project=join(temp,"project");
  const outside=join(temp,"outside");
  mkdirSync(project);mkdirSync(outside);
  const base=join(project,"allowed.txt");
  const secret=join(outside,"outside.txt");
  const good="IN_WORKSPACE_CONTENT";
  const forbidden="OUTSIDE_SYNTHETIC_TEST_BYTES";
  writeFileSync(base,good);
  writeFileSync(secret,forbidden);
  const root=resolve(project);
  const knownRoot=(path:string)=>resolve(path)===root;
  const caps=fileCapabilities(knownRoot);
  const info=caps.find(c=>c.id==="core.file.info");
  const inspect=caps.find(c=>c.id==="core.file.inspect");
  if(!info?.run||!inspect?.run)throw Error("Missing executable builtin file capabilities");
  const infoRun=info.run;
  const inspectRun=inspect.run;
  const resource={projectPath:project,path:base};
  const ctx={signal:new AbortController().signal,progress:(_n:number)=>{}};
  const checked=await inspectRun(resource,ctx);
  check("normal in-workspace SHA256 remains valid",checked.sha256===createHash("sha256").update(good).digest("hex") && checked.bytes===good.length,checked);
  const normalInfo=await infoRun(resource,ctx);
  check("normal file-info remains valid",normalInfo.bytes===good.length,normalInfo);

  // Attacker swaps the allowed pathname into a hard link of an outside file
  // exactly between resolveModuleResource's canonical check and file open.
  armSwap("open",base,secret);
  const blockedHash=await rejects(()=>inspectRun(resource,ctx));
  check("★ hash must not read an external hardlink swapped after allowlist check",blockedHash && swapHits()===1,{blockedHash,hits:swapHits()});
  clearSwap();
  rmSync(base);writeFileSync(base,good);

  // Info originally does a second stat(path) without a pinned fd. Swap after
  // canonical realpath but just before the first stat in resolveModuleResource.
  armSwap("stat",base,secret);
  const blockedInfo=await rejects(()=>infoRun(resource,ctx));
  check("★ info must not disclose external inode metadata after pathname switch",blockedInfo && swapHits()===1,{blockedInfo,hits:swapHits()});
  clearSwap();
  rmSync(base);writeFileSync(base,good);

  rmSync(base);
  linkSync(secret,base);
  const preflight=await rejects(()=>resolveModuleResource(resource,knownRoot));
  check("★ shared canonical preflight must refuse cross-boundary hard links",preflight);
  const directHash=await rejects(()=>inspectRun(resource,ctx));
  const directInfo=await rejects(()=>infoRun(resource,ctx));
  check("★ already-hardlinked external file must be refused by hash",directHash);
  check("★ already-hardlinked external file must be refused by info",directInfo);

  // Concurrent same-size replacement with the mtime restored deliberately.
  // The original hash code checked inode/size/mtime only, so a same-size
  // replacement was invisible if the mtime was reset.
  rmSync(base);writeFileSync(base,good);
  const historic=new Date("2024-01-01T00:00:00.000Z");
  utimesSync(base,historic,historic);
  armRewriteOnRead(base,"Z".repeat(good.length));
  const staleDigest=await rejects(()=>inspectRun(resource,ctx));
  check("★ same-size file rewrite during hash with mtime reset must fail",staleDigest && rewriteReadHits()===1,
    {staleDigest,hits:rewriteReadHits()});
  check("adversarial fixture never modifies original outside bytes",readFileSync(secret,"utf8")===forbidden);
}finally{
  clearSwap();
  rmSync(temp,{recursive:true,force:true});
}
console.log("module-file-identity-smoke:"+(total-failed)+"/"+total+" PASS");
if(failed)process.exitCode=1;
