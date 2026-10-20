/**
 * ARC-006 MERGE-1: untrusted flow bytes must never change workflow identity or gain approval.
 * All writes use a newly-created OS temporary root, never the user's Node-RED data dir.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { existsSync, linkSync, lstatSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { NodeRedFlowStorage, safeFlowFileName, flowRevision, pendingFlowSaveQueues, FLOWS_SUBDIR } from "@main/workflowEngines/nodeRedStorage.js";
import { acquireOsFileLease } from "@main/lib/osFileLease.js";
import { resolveProjectFlowDir } from "@main/workflowEngines/projectFlowDir.js";

let total=0, failures=0;
function check(name:string, ok:boolean, detail?:unknown):void{
  total++;
  if(ok) console.log("  ok   "+name);
  else {failures++;console.error("  FAIL "+name+" — "+JSON.stringify(detail));}
}
// Spawn THIS same esbuild bundle in a fresh Node process. A separate JS
// process has no shared Promise queue; only the real filesystem lease can
// make two concurrent CAS saves serialize.
if (process.env.MCODE_FLOW_OS_WORKER_ROOT && process.env.MCODE_FLOW_OS_WORKER_MARKER) {
  const ownStore=new NodeRedFlowStorage(process.env.MCODE_FLOW_OS_WORKER_ROOT);
  console.log("READY");
  const result=await ownStore.saveFlow("os-process-project","wf-os-process",
    {nodes:[{id:"node1",type:"inject"}],"x-mcode":{marker:process.env.MCODE_FLOW_OS_WORKER_MARKER}} as never,
    {expectedRevision:null});
  console.log("RESULT:"+JSON.stringify(result));
  process.exit(0);
}
const root=await mkdtemp(join(tmpdir(),"mcode-flow-integrity-"));
try {
  const store=new NodeRedFlowStorage(root);
  const project="project-safe";
  const flowId="wf-safe";
  const folder=join(store.projectDir(project),FLOWS_SUBDIR);
  await mkdir(folder,{recursive:true});
  const path=join(folder,safeFlowFileName(flowId)+".json");
  const node={id:"node1",type:"inject"};

  // Two real, isolated Node processes each see a fresh empty in-memory CAS
  // queue. Hold their shared OS lock first; they must both block. On release
  // only one may create the flow and the loser must receive a conflict.
  {
    const projectDir=store.projectDir("os-process-project");
    const diskDir=join(projectDir,FLOWS_SUBDIR);
    await mkdir(diskDir);
    const disk=join(diskDir,safeFlowFileName("wf-os-process")+".json");
    const unlock=await acquireOsFileLease(disk+".mcode-lock",2000);
    function worker(marker:string) {
      let captured="";
      const child=spawn(process.execPath,[process.argv[1]!],{
        env:{...process.env,MCODE_FLOW_OS_WORKER_ROOT:root,MCODE_FLOW_OS_WORKER_MARKER:marker},
        stdio:["ignore","pipe","pipe"],windowsHide:true,
      });
      let readyResolve:(value:boolean)=>void=()=>undefined;
      const ready=new Promise<boolean>((resolve)=>{readyResolve=resolve;});
      child.stdout?.on("data",(data:Buffer)=>{
        captured+=data.toString("utf8");
        if(captured.includes("READY"))readyResolve(true);
      });
      child.stderr?.on("data",(data:Buffer)=>{captured+=data.toString("utf8");});
      const finished=new Promise<{code:number|null,text:string}>((resolve)=>{
        child.once("error",(error)=>{readyResolve(false);resolve({code:-1,text:String(error)});});
        child.once("close",(code)=>{readyResolve(false);resolve({code,text:captured});});
      });
      return {ready,finished,output:()=>captured};
    }
    let both:{ready:Promise<boolean>,finished:Promise<{code:number|null,text:string}>,output:()=>string}[]=[];
    try {
      both=[worker("os-one"),worker("os-two")];
      const ready=await Promise.all(both.map(w=>w.ready));
      check("★ two independent OS worker processes entered the same flow CAS",ready.every(Boolean),ready);
      await new Promise<void>(resolve=>setTimeout(resolve,220));
      check("★ a parent-held OS lease blocks both separate Node processes",
        both.every(w=>!w.output().includes("RESULT:")),both.map(w=>w.output()));
    } finally {
      await unlock();
    }
    const settled=await Promise.all(both.map(w=>w.finished));
    const results=settled.map(({text})=>{
      const row=text.split(/\r?\n/).find(line=>line.startsWith("RESULT:"));
      try {return row?JSON.parse(row.slice(7)) as {ok:boolean;kind?:string}:null;}catch{return null;}
    });
    check("★ both separate OS processes settle without startup errors",
      settled.every(item=>item.code===0),settled);
    check("★ across two OS processes CAS allows exactly one create and one conflict",
      results.filter(result=>result?.ok===true).length===1
      && results.filter(result=>result?.ok===false&&result.kind==="conflict").length===1,results);
    const diskResult=store.loadFlow("os-process-project","wf-os-process");
    check("★ winning OS process archives exactly its own complete flow",
      diskResult.ok && ["os-one","os-two"].includes(
        String((diskResult.flow as unknown as {"x-mcode"?:{marker?:unknown}})["x-mcode"]?.marker)),diskResult);
    check("★ true OS-process CAS leaves no abandoned lock",
      !(await readdir(diskDir)).some(name=>name.endsWith(".mcode-lock")));
  }

  // Reading a flow list must never manufacture an otherwise absent flow
  // directory. The project ownership marker is allowed to exist already;
  // the read-only listing itself may not alter flows/ on disk.
  {
    const listProject="read-only-flow-list";
    const readonlyDir=join(store.projectDir(listProject),FLOWS_SUBDIR);
    check("★ fixture begins without a flows/ directory",!existsSync(readonlyDir));
    const listing=store.listFlows(listProject);
    check("★ listing a project with no flows returns an empty list",
      listing.ok && listing.entries.length===0,listing);
    check("★ listing may not materialize an empty flows/ directory",
      !existsSync(readonlyDir));
    const missing=store.loadFlow(listProject,"absent-id");
    check("★ after read-only listing a missing flow stays missing",
      !missing.ok && missing.kind==="missing",missing);
    check("★ missing flow read still does not create a flows/ directory",
      !existsSync(readonlyDir));
  }

  // A read-only query of a completely new project must not create the
  // project directory, identity marker or flows/ under the engine root.
  {
    const neverProject="never-used-read-only-project";
    const resolved=resolveProjectFlowDir(root,neverProject);
    if(!resolved.ok)throw new Error(resolved.reason);
    check("★ fresh project root fixture truly does not exist",!existsSync(resolved.dir));
    const freshListing=store.listFlows(neverProject);
    check("★ listing nonexistent project returns empty rather than creating it",
      freshListing.ok && freshListing.entries.length===0,freshListing);
    const freshLoad=store.loadFlow(neverProject,"absent");
    check("★ reading a nonexistent project returns missing",
      !freshLoad.ok && freshLoad.kind==="missing",freshLoad);
    check("★ neither read may create the project directory or identity sidecar",
      !existsSync(resolved.dir));
  }

  // Even a malformed save that claims a different docId must be rejected
  // before creating any new project/flow directory or identity marker.
  {
    const badProject="invalid-document-identity-project";
    const mapped=resolveProjectFlowDir(root,badProject);
    if(!mapped.ok)throw new Error(mapped.reason);
    check("★ malformed docId save fixture starts with no project directory",!existsSync(mapped.dir));
    const deniedSave=await store.saveFlow(badProject,"new-doc",
      {nodes:[node],"x-mcode":{docId:"someone-else"}} as never,{expectedRevision:null});
    check("★ mismatch docId is rejected as doc-id-drift",!deniedSave.ok&&deniedSave.kind==="doc-id-drift",deniedSave);
    check("★ rejected wrong-document save must not create its project sidecar",
      !existsSync(mapped.dir));
  }

  // Store.projectDir has a directory fence, but its flows/ subdirectory is
  // independently user-writable. A junction here must not bypass that fence.
  {
    const linkedProject = "project-linked-flows";
    const linkedDir = join(store.projectDir(linkedProject), FLOWS_SUBDIR);
    const outside = join(root, "untrusted-foreign-flows");
    await mkdir(outside);
    const escapedId = "wf-foreign";
    const escapedFile = join(outside, safeFlowFileName(escapedId)+".json");
    const escapedRaw = JSON.stringify({nodes:[node],"x-mcode":{docId:escapedId,marker:"outside"}});
    await writeFile(escapedFile, escapedRaw);
    let linked = false;
    try {
      try {
        symlinkSync(outside, linkedDir, process.platform==="win32"?"junction":"dir");
        linked = true;
      } catch (error) {
        console.log("  SKIP cannot create test-only flows junction: "+String(error));
      }
      if (linked) {
        check("★ fixture created a real directory link at flows/",lstatSync(linkedDir).isSymbolicLink());
        const readLinked=store.loadFlow(linkedProject,escapedId);
        check("★ flow read must reject linked flows/ directory, not read external flow",
          !readLinked.ok && readLinked.kind==="invalid-project",readLinked);
        const listLinked=store.listFlows(linkedProject);
        check("★ flow listing must reject linked flows/, not enumerate external project",
          !listLinked.ok && listLinked.kind==="invalid-project",listLinked);
        const saveLinked=await store.saveFlow(linkedProject,"wf-write-foreign",
          {nodes:[node]} as never,{expectedRevision:null});
        check("★ flow save must reject linked flows/, not create external archive",
          !saveLinked.ok && saveLinked.kind==="invalid-project",saveLinked);
        check("★ rejected writes never change external existing flow bytes",
          await readFile(escapedFile,"utf8")===escapedRaw);
        const outsideNames=await readdir(outside);
        check("★ linked flows/ may not create any extra external file or lock",
          outsideNames.length===1 && outsideNames[0]===safeFlowFileName(escapedId)+".json",outsideNames);
      }
    } finally {
      if (linked) {
        if (process.platform==="win32") rmdirSync(linkedDir);
        else unlinkSync(linkedDir);
      }
    }
    const recovered=await store.saveFlow(linkedProject,"wf-after-link-restored",
      {nodes:[node]} as never,{expectedRevision:null});
    check("★ after removing flows/ symlink, ordinary save creates managed directory",
      recovered.ok,recovered);
  }
  const forged={nodes:[node],"x-mcode":{docId:"wf-other", marker:"tampered"}};
  await writeFile(path,JSON.stringify(forged),"utf8");
  const before=await readFile(path);
  const loaded=store.loadFlow(project,flowId);
  check("磁盘文件的 docId 与请求 workflowId 不一致必须 corrupt",!loaded.ok && loaded.kind==="corrupt",loaded);
  const denied=store.executableUnderTrust(project,flowId,()=>
    JSON.stringify({origin:"import",approvedRevision:flowRevision(forged)}));
  check("即使持有伪造内容的审批 revision，也不得执行错绑 workflowId",!denied.ok && denied.kind==="corrupt",denied);
  const listed=store.listFlows(project);
  check("清单不能将被篡改的文件登记为其他 workflowId",
    listed.ok && listed.entries.length===1 && listed.entries[0]?.corrupt===true
      && listed.entries[0]?.flowId!== "wf-other",listed);
  check("坏档读/执行/清单均不改旧字节",Buffer.compare(before,await readFile(path))===0);
  const missingMeta={nodes:[node]};
  await writeFile(path,JSON.stringify(missingMeta),"utf8");
  const missing=store.loadFlow(project,flowId);
  check("已有文件缺 x-mcode.docId 不得冒充可信映射",!missing.ok && missing.kind==="corrupt",missing);
  const missingList=store.listFlows(project);
  check("缺身份字段的文件在清单显示 corrupt 而非正常可执行",
    missingList.ok && missingList.entries[0]?.corrupt===true,missingList);
  await writeFile(path,JSON.stringify({nodes:"broken","x-mcode":{docId:flowId}}),"utf8");
  const badShapeList=store.listFlows(project);
  check("坏节点形状的清单诊断明确点名形状而非伪报身份错绑",
    badShapeList.ok && badShapeList.entries[0]?.corrupt===true
    && (badShapeList.entries[0]?.reason??"").includes("形状"),badShapeList);
  // Also validate runtime input to a typed API: IPC callers can cast unknown values.
  const invalidSave=await store.saveFlow(project,"wf-bad-shape",{nodes:"not an array"} as never,{expectedRevision:null});
  check("不合法 flow 输入在落盘前拒绝",!invalidSave.ok && invalidSave.kind==="corrupt",invalidSave);
  const files=await readdir(folder);
  check("拒绝不合法 flow 未新增不可读文件",!files.some(x=>x===safeFlowFileName("wf-bad-shape")+".json"),files);
  // A structurally valid JSON document with duplicate/blank node identity is
  // not a deployable Node-RED graph, even if a caller supplies valid approval.
  const duplicateId="wf-duplicate-nodes";
  const duplicatePath=join(folder,safeFlowFileName(duplicateId)+".json");
  const duplicateFlow={nodes:[{id:"same",type:"inject"},{id:"same",type:"debug"}],
    "x-mcode":{docId:duplicateId}};
  await writeFile(duplicatePath,JSON.stringify(duplicateFlow));
  const duplicateRead=store.loadFlow(project,duplicateId);
  check("★ duplicate Node-RED node ids cannot load as trusted executable flow",
    !duplicateRead.ok && duplicateRead.kind==="corrupt",duplicateRead);
  const duplicateTrust=store.executableUnderTrust(project,duplicateId,()=>
    JSON.stringify({origin:"import",approvedRevision:flowRevision(duplicateFlow)}));
  check("★ even a matching revision cannot authorize duplicate node ids",
    !duplicateTrust.ok && duplicateTrust.kind==="corrupt",duplicateTrust);
  const blankNode=await store.saveFlow(project,"wf-blank-node-id",
    {nodes:[{id:"",type:"inject"}]} as never,{expectedRevision:null});
  check("★ empty Node-RED node id must be rejected before saving",
    !blankNode.ok && blankNode.kind==="corrupt",blankNode);
  const blankType=await store.saveFlow(project,"wf-blank-node-type",
    {nodes:[{id:"n1",type:""}]} as never,{expectedRevision:null});
  check("★ empty Node-RED node type must be rejected before saving",
    !blankType.ok && blankType.kind==="corrupt",blankType);
  let optionsThrown="";
  let optionsResult:unknown;
  try {
    optionsResult=await store.saveFlow(project,"wf-no-options",
      {nodes:[node]} as never,undefined as never);
  } catch(error) { optionsThrown=String(error); }
  check("★ malformed save options return a structured error, never throw",
    optionsThrown==="" && !!optionsResult && typeof optionsResult==="object"
    && "ok" in optionsResult && (optionsResult as {ok:boolean}).ok===false,
    {optionsThrown,optionsResult});

  const invalidMeta=await store.saveFlow(project,"wf-bad-meta",{nodes:[node],"x-mcode":"bad"} as never,{expectedRevision:null});
  check("非对象元信息在落盘前拒绝",!invalidMeta.ok && invalidMeta.kind==="corrupt",invalidMeta);

  // A save is queued on a Promise; mutating caller-owned input synchronously
  // before that queue runs must not alter what was validated/accepted.
  // The directory may disappear between the synchronous path validation and
  // the asynchronous queued CAS/OS lease acquisition. A rejected Promise here
  // is not a legal SaveFlowResult and bypasses existing IPC conflict handling.
  {
    const deletedProject="project-vanished-before-lease";
    const pending = store.saveFlow(deletedProject,"wf-vanished",
      {nodes:[node]} as never,{expectedRevision:null});
    const flowDir=join(store.projectDir(deletedProject),FLOWS_SUBDIR);
    rmSync(flowDir,{recursive:true,force:true});
    let actual:unknown;
    let thrown="";
    try { actual=await pending; } catch(error) { thrown=String(error); }
    check("★ deleted flows/ while save is queued must return structured io-error",
      thrown==="" && !!actual && typeof actual==="object" && "ok" in actual
      && (actual as {ok:boolean,kind?:string}).ok===false
      && (actual as {kind?:string}).kind==="io-error",{thrown,actual});
  }

  const mutableFlow = { nodes: [{id:"stable",type:"inject"}] };
  const pendingSnapshot = store.saveFlow(project,"wf-snapshot",mutableFlow as never,{expectedRevision:null});
  mutableFlow.nodes[0]!.type = "exec";
  const snapshotResult = await pendingSnapshot;
  const snapshotRead = store.loadFlow(project,"wf-snapshot");
  check("★ queued save snapshots the validated node bytes before caller mutates them",
    snapshotResult.ok && snapshotRead.ok && snapshotRead.flow.nodes[0]?.type === "inject",snapshotRead);
  const cyc: {nodes:{id:string;type:string}[];self?:unknown} = { nodes:[{id:"cyclic",type:"inject"}] };
  cyc.self = cyc;
  let cyclicResult: unknown;
  let cyclicThrow = "";
  try { cyclicResult = await store.saveFlow(project,"wf-cyclic",cyc as never,{expectedRevision:null}); }
  catch(err) { cyclicThrow=String(err); }
  check("★ non-JSON/cyclic caller input is a structured fail-closed result",
    cyclicThrow === "" && typeof cyclicResult === "object" && cyclicResult !== null
      && "ok" in cyclicResult && (cyclicResult as {ok:boolean}).ok===false,
    {cyclicThrow,cyclicResult});
  const afterCyclic = await readdir(folder);
  check("★ rejected cyclic payload must not create a broken archive",
    !afterCyclic.includes(safeFlowFileName("wf-cyclic")+".json"),afterCyclic);

  // A hard link aliases bytes outside the managed flow directory. A valid
  // docId/revision alone must not make this foreign inode executable or
  // eligible for overwrite through the managed storage API.
  const aliasId = "wf-alias";
  const foreign = join(root,"outside-managed-flow.json");
  const aliasedBytes = JSON.stringify({nodes:[node],"x-mcode":{docId:aliasId}});
  await writeFile(foreign, aliasedBytes);
  const aliasFile = join(folder,safeFlowFileName(aliasId)+".json");
  linkSync(foreign,aliasFile);
  const aliasRead = store.loadFlow(project,aliasId);
  check("★ linked foreign inode cannot be loaded as a trusted flow",
    !aliasRead.ok && aliasRead.kind==="corrupt",aliasRead);
  const aliasList = store.listFlows(project);
  check("★ linked flow remains a visible corrupt diagnostic in the list",
    aliasList.ok && aliasList.entries.some(x=>x.flowId===safeFlowFileName(aliasId)
      && x.corrupt===true),aliasList);
  const aliasExecute=store.executableUnderTrust(project,aliasId,()=>
    JSON.stringify({origin:"import",approvedRevision:flowRevision(JSON.parse(aliasedBytes))}));
  check("★ aliased flow cannot execute even with matching revision",
    !aliasExecute.ok && aliasExecute.kind==="corrupt",aliasExecute);
  const aliasWrite = await store.saveFlow(project,aliasId,{nodes:[node]} as never,{expectedRevision:null});
  check("★ managed storage refuses overwriting a linked foreign flow",
    !aliasWrite.ok && aliasWrite.kind==="corrupt",aliasWrite);
  check("★ denied read/write never modifies foreign file bytes",
    (await readFile(foreign,"utf8"))===aliasedBytes);

  const good=await store.saveFlow(project,"wf-good",{nodes:[node]} as never,{expectedRevision:null});
  check("合法且省略 docId 的 flow 仍能自动补齐",good.ok,good);
  const validRead=store.loadFlow(project,"wf-good");
  check("合法自动补齐后磁盘身份与 revision 一致",
    validRead.ok && (validRead.flow as unknown as {"x-mcode":{docId:string}})["x-mcode"].docId==="wf-good"
      && validRead.revision=== (good.ok?good.revision:""),validRead);

  // Read-trust can throw on DB IO errors. Never fall back to optimistic execution.
  const trustRead=store.executableUnderTrust(project,"wf-good",()=>{throw new Error("FAKE_SETTINGS_IO_ERROR");});
  check("审批账本读取失败返回显式 io-error 而不是异常逃逸/假批准",!trustRead.ok && trustRead.kind==="io-error",trustRead);

  // 许多工作流短暂保存完毕后，应释放每个路径的队列引用；
  // 旧实现写入 Map 的是 next.catch Promise，却拿 next 比较，永远删不掉。
  const queued=Array.from({length:24},(_,n)=>
    store.saveFlow(project,"wf-queue-"+n,{nodes:[node]} as never,{expectedRevision:null}));
  const saved=await Promise.all(queued);
  check("多个独立 flow 并行保存全部成功",saved.every(s=>s.ok),saved);
  await Promise.resolve(); // allow settled queue cleanup microtasks
  check("已完成的 flow 写队列全部释放（不随保存历史无限增长）",pendingFlowSaveQueues()===0,
    {pending:pendingFlowSaveQueues()});
}finally{await rm(root,{recursive:true,force:true});}
console.log("flow-storage-integrity-smoke: "+(total-failures)+"/"+total+" 通过");
if(failures) process.exitCode=1;
