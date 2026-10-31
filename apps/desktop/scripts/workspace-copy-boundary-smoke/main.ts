import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, linkSync, symlinkSync, existsSync, renameSync, rmSync } from "node:fs";

import { join } from "node:path";
import { tmpdir } from "node:os";
import { McodeWorkspaceFs, fileResource } from "../../src/main/modules/theiaHost/mcodeWorkspaceFs.js";
const temp=mkdtempSync(join(tmpdir(),"mcode-theia-copy-boundary-"));
const root=join(temp,"workspace");
mkdirSync(root);
let pass=0;
const check=(name:string,value:boolean)=>{assert.ok(value,name);pass++;console.log("PASS "+name)};
const rejected=async(task:()=>Promise<unknown>)=>{
 try{await task();return false}catch{return true}
};
const openWorkspaces:McodeWorkspaceFs[]=[];
try {
 const ws=await McodeWorkspaceFs.open(root);openWorkspaces.push(ws);
 const wsSecondExtension=await McodeWorkspaceFs.open(root);openWorkspaces.push(wsSecondExtension);
 const specialUriFile=join(root,"literal%20# name-量子.txt");
 writeFileSync(specialUriFile,"URI_PATH_BYTES");
 check("file URI round-trip preserves literal percent, hash, spaces and Unicode",
   (await ws.readFile(fileResource(specialUriFile))).toString()==="URI_PATH_BYTES");
 const specialUriWrite=join(root,"created%2F-not-a-slash.txt");
 await ws.writeFile(fileResource(specialUriWrite),Buffer.from("URI_WRITE_BYTES"));
 check("file URI writes preserve encoded-looking literal percent sequences",
   existsSync(specialUriWrite)&&readFileSync(specialUriWrite,"utf8")==="URI_WRITE_BYTES");
 const specialMatches=await ws.findFiles("**/literal%20# name-量子.txt");
 check("findFiles results round-trip through URI encoding without changing the filename",
   specialMatches.length===1&&(await ws.readFile(specialMatches[0])).toString()==="URI_PATH_BYTES");
 const concurrentWrite=join(root,"concurrent-write.bin");
 const payloadA=Buffer.alloc(8*1024*1024,0x41),payloadB=Buffer.alloc(8*1024*1024,0x42);
 await Promise.all([
   ws.writeFile(fileResource(concurrentWrite),payloadA),
   wsSecondExtension.writeFile(fileResource(concurrentWrite),payloadB),
 ]);
 const committed=readFileSync(concurrentWrite);
 check("concurrent writes from separate extension hosts serialize to one complete version",
   committed.equals(payloadA)||committed.equals(payloadB));
 const src=join(root,"src.txt"),dst=join(root,"dst.txt");
 const outside=join(temp,"outside.txt"),alias=join(root,"hardlinked-dst.txt");
 writeFileSync(src,"SOURCE_BYTES");writeFileSync(outside,"OUTSIDE_DATA");
 await ws.copy(fileResource(src),fileResource(dst));
 check("new file copy retains source content",readFileSync(dst,"utf8")==="SOURCE_BYTES");
 writeFileSync(dst,"KEEP_CURRENT");
 check("non-overwriting copy rejects existing target",await rejected(()=>ws.copy(fileResource(src),fileResource(dst))));
 check("existing target unchanged after refusal",readFileSync(dst,"utf8")==="KEEP_CURRENT");
 linkSync(outside,alias);
 const wasRefused=await rejected(()=>ws.copy(fileResource(src),fileResource(alias),true));
 check("overwriting an external hardlinked destination is refused",wasRefused);
 check("external hardlink source data never modified",readFileSync(outside,"utf8")==="OUTSIDE_DATA");
 check("writing an external hardlinked destination is refused",
   await rejected(()=>ws.writeFile(fileResource(alias),Buffer.from("MODIFIED"))));
 check("rejected hardlink write preserves external data",readFileSync(outside,"utf8")==="OUTSIDE_DATA");
 const linkSource=join(root,"hardlinked-src.txt");
 linkSync(outside,linkSource);
 check("copying externally hardlinked source is refused",await rejected(()=>ws.copy(fileResource(linkSource),fileResource(join(root,"from-hardlink.txt")))));
 check("copy from hardlink did not create destination",!existsSync(join(root,"from-hardlink.txt")));
 const huge=join(root,"huge.bin");writeFileSync(huge,Buffer.alloc(9*1024*1024));
 check("oversized source copy is rejected",await rejected(()=>ws.copy(fileResource(huge),fileResource(join(root,"big-copy.bin")))));
 check("oversized copy leaves no target",!existsSync(join(root,"big-copy.bin")));
 check("workspace write enforces the 8 MiB content limit",
   await rejected(()=>ws.writeFile(fileResource(join(root,"too-large-write.bin")),Buffer.alloc(9*1024*1024))));
 check("oversized workspace write leaves no target",!existsSync(join(root,"too-large-write.bin")));
 check("copying a file onto itself is rejected",
   await rejected(()=>ws.copy(fileResource(src),fileResource(src),true)));
 check("renaming a file onto itself is rejected",
   await rejected(()=>ws.rename(fileResource(src),fileResource(src),true)));
 check("renaming an external hardlinked source is refused",
   await rejected(()=>ws.rename(fileResource(linkSource),fileResource(join(root,"renamed-hardlink.txt")))));
 check("rejected hardlinked rename leaves external source intact",
   readFileSync(outside,"utf8")==="OUTSIDE_DATA"&&existsSync(linkSource));
 const renamed=join(root,"renamed-copy.txt");
 await ws.rename(fileResource(dst),fileResource(renamed));
 check("normal exclusive file rename succeeds",readFileSync(renamed,"utf8")==="KEEP_CURRENT"&&!existsSync(dst));
 writeFileSync(dst,"WINNER");
 check("exclusive rename cannot replace occupied destination",
   await rejected(()=>ws.rename(fileResource(renamed),fileResource(dst))));
 check("rename failure preserves both source and destination",
   readFileSync(dst,"utf8")==="WINNER"&&readFileSync(renamed,"utf8")==="KEEP_CURRENT");
 await ws.rename(fileResource(renamed),fileResource(dst),true);
 check("explicit overwrite rename atomically replaces the destination",
   readFileSync(dst,"utf8")==="KEEP_CURRENT"&&!existsSync(renamed));
 await ws.copy(fileResource(src),fileResource(dst),true);
 check("explicit overwrite copy replaces a regular destination",
   readFileSync(dst,"utf8")==="SOURCE_BYTES");
 const newDir=join(root,"deep","inside","created");
 await ws.mkdir(fileResource(newDir));
 check("deep nested directory creation stays within workspace",existsSync(newDir));
 const dirSrc=join(root,"original-dir");
 mkdirSync(dirSrc);writeFileSync(join(dirSrc,"child.txt"),"DIR_DATA");
 const dirNew=join(root,"renamed-dir");
 await ws.rename(fileResource(dirSrc),fileResource(dirNew));
 check("existing directory rename remains supported",readFileSync(join(dirNew,"child.txt"),"utf8")==="DIR_DATA");
 const externalDir=join(temp,"external-folder");
 mkdirSync(externalDir);writeFileSync(join(externalDir,"outside.txt"),"PRIVATE");
 const junction=join(root,"junction-out");
 try{
   symlinkSync(externalDir,junction,"junction");
   check("mkdir refuses outside junction ancestors",
     await rejected(()=>ws.mkdir(fileResource(join(junction,"new-subdir")))));
   check("copy refuses outside junction destination",
     await rejected(()=>ws.copy(fileResource(src),fileResource(join(junction,"stolen.txt")))));
   check("rename refuses outside junction destination",
     await rejected(()=>ws.rename(fileResource(src),fileResource(join(junction,"moved.txt")))));
   check("outside directory never acquired new files",
     !existsSync(join(externalDir,"new-subdir"))&&!existsSync(join(externalDir,"stolen.txt"))&&!existsSync(join(externalDir,"moved.txt")));
 }catch(error){
   const code=(error as NodeJS.ErrnoException).code;
   if(code!=="EPERM"&&code!=="EACCES")throw error;
   console.log("SKIP OS junction creation restricted by current account");
 }
 // Native findFiles must reject an outside directory alias without using path-based readdir.
 const scanRoot=join(root,"scan-race"),swapDir=join(scanRoot,"swap"),outsideScan=join(temp,"outside-scan");
 mkdirSync(scanRoot);mkdirSync(outsideScan);
 writeFileSync(join(outsideScan,"secret.private"),"PRIVATE");
 try {
   symlinkSync(outsideScan,swapDir,process.platform==="win32"?"junction":"dir");
   const found=await ws.findFiles("**/*.private",undefined,100,fileResource(scanRoot));
   check("findFiles rejects an outside directory symlink/junction",
     !found.some(item=>item.path.endsWith("secret.private")));
 } catch(error) {
   const code=(error as NodeJS.ErrnoException).code;
   if(code!=="EPERM"&&code!=="EACCES")throw error;
   console.log("SKIP OS denies creation of directory alias for native findFiles test");
 }
 // The workspace root itself is part of the authorization decision. Replacing
 // that original directory with an outside junction must not redefine the trust root.
 const pinnedRoot=join(temp,"pinned-workspace"),movedRoot=join(temp,"pinned-workspace-original"),outsideRoot=join(temp,"outside-root");
 mkdirSync(pinnedRoot);mkdirSync(outsideRoot);
 writeFileSync(join(outsideRoot,"private.txt"),"PRIVATE_ROOT");
 const pinnedWorkspace=await McodeWorkspaceFs.open(pinnedRoot);openWorkspaces.push(pinnedWorkspace);
 renameSync(pinnedRoot,movedRoot);
 try{
   symlinkSync(outsideRoot,pinnedRoot,process.platform==="win32"?"junction":"dir");
   const readRejected=await rejected(()=>pinnedWorkspace.readFile(fileResource(join(pinnedRoot,"private.txt"))));
   const writeRejected=await rejected(()=>pinnedWorkspace.writeFile(fileResource(join(pinnedRoot,"pwned.txt")),Buffer.from("PWNED")));
   const searchRejected=await rejected(()=>pinnedWorkspace.findFiles("**/*"));
   check("an opened workspace rejects its root being replaced by an outside junction",readRejected&&writeRejected&&searchRejected);
   check("root replacement cannot read or write outside workspace",
     readFileSync(join(outsideRoot,"private.txt"),"utf8")==="PRIVATE_ROOT"&&!existsSync(join(outsideRoot,"pwned.txt")));
 }catch(error){
   const code=(error as NodeJS.ErrnoException).code;
   if(code!=="EPERM"&&code!=="EACCES")throw error;
   console.log("SKIP root replacement junction creation restricted by current account");
 }
 // Replacing the root with a different ordinary directory at the same lexical path
 // must also fail; path containment alone cannot distinguish the new inode.
 const ordinaryRoot=join(temp,"ordinary-workspace"),ordinaryOriginal=join(temp,"ordinary-workspace-original");
 mkdirSync(ordinaryRoot);
 const ordinaryWorkspace=await McodeWorkspaceFs.open(ordinaryRoot);openWorkspaces.push(ordinaryWorkspace);
 renameSync(ordinaryRoot,ordinaryOriginal);
 mkdirSync(ordinaryRoot);
 writeFileSync(join(ordinaryRoot,"private.txt"),"REPLACED_ROOT");
 const ordinaryReadRejected=await rejected(()=>ordinaryWorkspace.readFile(fileResource(join(ordinaryRoot,"private.txt"))));
 const ordinaryWriteRejected=await rejected(()=>ordinaryWorkspace.writeFile(fileResource(join(ordinaryRoot,"pwned.txt")),Buffer.from("PWNED")));
 check("an opened workspace rejects a different ordinary directory at the same root path",ordinaryReadRejected&&ordinaryWriteRejected);
 check("ordinary root replacement cannot read or write replacement contents",
   readFileSync(join(ordinaryRoot,"private.txt"),"utf8")==="REPLACED_ROOT"&&!existsSync(join(ordinaryRoot,"pwned.txt")));
 ordinaryWorkspace.close();
 pinnedWorkspace.close();
 wsSecondExtension.close();
 ws.close();
 check("closed workspace rejects subsequent operations",
   await rejected(()=>ws.stat(fileResource(root))));
 console.log("workspace-copy-boundary-smoke: "+pass+"/"+pass+" PASS");
}finally{for(const workspace of openWorkspaces)workspace.close();rmSync(temp,{recursive:true,force:true})}
