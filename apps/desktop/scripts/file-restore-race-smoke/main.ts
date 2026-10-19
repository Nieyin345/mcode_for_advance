/** File rewind TOCTOU injection: synthetic temp project only. */
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { restoreFiles } from "../../src/main/lib/fileSnapshot.js";
import { armOverwrite,armHardlink,clear,hits } from "./fsPromisesStub.js";

let passed=0,failed=0;
function check(name:string,ok:boolean,detail?:unknown){
  if(ok)passed++;else failed++;
  console.log((ok?"  ok   ":"  FAIL ")+name+(ok?"":" "+JSON.stringify(detail)));
}
const root=mkdtempSync(join(tmpdir(),"mcode-restore-race-"));
const ws=join(root,"workspace");const outside=join(root,"outside");
mkdirSync(ws);mkdirSync(outside);
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const snapshot=(path:string,kind:"created"|"modified")=>({
  filePath:path, kind, before:kind==="modified"?"BEFORE":"",afterHash:hash("AFTER"),adds:1,dels:1
} as const);
try {
  const newer=join(ws,"newer-modified.txt");
  writeFileSync(newer,"AFTER");
  armOverwrite(newer,"NEWER_USER_EDIT");
  const modified=await restoreFiles(ws,[snapshot(newer,"modified")]);
  check("★ later edit between read and restore write is not overwritten",
    hits()===1 && readFileSync(newer,"utf8")==="NEWER_USER_EDIT" &&
    !modified.restored.includes(newer) && modified.conflicts.includes(newer),modified);

  const newerCreated=join(ws,"newer-created.txt");
  writeFileSync(newerCreated,"AFTER");
  armOverwrite(newerCreated,"NEWER_CREATED_EDIT");
  const created=await restoreFiles(ws,[snapshot(newerCreated,"created")]);
  check("★ later edit between read and unlink does not vanish",
    hits()===1 && existsSync(newerCreated) && readFileSync(newerCreated,"utf8")==="NEWER_CREATED_EDIT" &&
    !created.restored.includes(newerCreated) && created.conflicts.includes(newerCreated),created);

  const outsideFile=join(outside,"unrelated.txt");
  const swapped=join(ws,"swapped-hardlink.txt");
  writeFileSync(outsideFile,"AFTER");
  writeFileSync(swapped,"AFTER");
  armHardlink(swapped,outsideFile);
  const hard=await restoreFiles(ws,[snapshot(swapped,"modified")]);
  check("★ final hardlink swap cannot overwrite external synthetic inode",
    hits()===1 && readFileSync(outsideFile,"utf8")==="AFTER" &&
    readFileSync(swapped,"utf8")==="AFTER" && !hard.restored.includes(swapped) &&
    (hard.conflicts.includes(swapped)||hard.failed.includes(swapped)),hard);

  const stable=join(ws,"stable.txt");
  writeFileSync(stable,"AFTER");
  clear();
  const healthy=await restoreFiles(ws,[snapshot(stable,"modified")]);
  check("★ stable modified file still rewinds normally",
    healthy.restored.includes(stable) && readFileSync(stable,"utf8")==="BEFORE",healthy);
  const createdStable=join(ws,"created-stable.txt");
  writeFileSync(createdStable,"AFTER");
  const validCreated=await restoreFiles(ws,[snapshot(createdStable,"created")]);
  check("★ stable created file still unlinks normally",
    validCreated.restored.includes(createdStable) && !existsSync(createdStable),validCreated);
}finally{clear();rmSync(root,{recursive:true,force:true});}
console.log("file-restore-race-smoke:" + passed + "/" + (passed+failed));
if(failed)process.exitCode=1;
