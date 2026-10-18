/**
 * ARC-006 MERGE-1: untrusted flow bytes must never change workflow identity or gain approval.
 * All writes use a newly-created OS temporary root, never the user's Node-RED data dir.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRedFlowStorage, safeFlowFileName, flowRevision, pendingFlowSaveQueues, FLOWS_SUBDIR } from "@main/workflowEngines/nodeRedStorage.js";

let total=0, failures=0;
function check(name:string, ok:boolean, detail?:unknown):void{
  total++;
  if(ok) console.log("  ok   "+name);
  else {failures++;console.error("  FAIL "+name+" — "+JSON.stringify(detail));}
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
  const invalidMeta=await store.saveFlow(project,"wf-bad-meta",{nodes:[node],"x-mcode":"bad"} as never,{expectedRevision:null});
  check("非对象元信息在落盘前拒绝",!invalidMeta.ok && invalidMeta.kind==="corrupt",invalidMeta);

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
