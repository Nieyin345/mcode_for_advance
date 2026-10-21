/** MC-036/ARC-006: uninstall and same-version privilege edits must not resurrect grants.
 * Pure in-memory store, fake capability, no user files, SDK, network, or Electron.
 */
import { ModuleHost } from "../../src/main/modules/ModuleHost.js";
import { EXAMPLE_MODULE, ResourceSchema, ResultSchema, type ModuleManifest } from "@contracts/modules";
import { classifyModuleWorkflowGrants, serializeModuleWorkflowGrants } from "@contracts/moduleCapability";

let total=0, failed=0;
function check(label:string, pass:boolean, detail?:unknown) {
  total++;if(!pass)failed++;
  console.log((pass?"  ok   ":"  FAIL ")+label+(pass?"":" "+JSON.stringify(detail)));
}
function fixture() {
  const base={...EXAMPLE_MODULE,id:"user.grant-transaction"} as ModuleManifest;
  let disk:ModuleManifest[]=[];
  let grantText:string|null=null;
  let failGrantWrite=false, failManifestWrite=false;
  const host=new ModuleHost({
    authorize:async()=>{},
    persist:async manifests=>{
      if(failManifestWrite)throw Error("SYNTHETIC_MANIFEST_IO_FAIL");
      disk=structuredClone(manifests);
    },
    readWorkflowGrants:()=>grantText,
    persistWorkflowGrants:async text=>{
      if(failGrantWrite)throw Error("SYNTHETIC_GRANT_IO_FAIL");
      grantText=text;
    },
  });
  host.register({id:"core.file.inspect",kind:"query",input:ResourceSchema,output:ResultSchema,run:async()=>({text:"synthetic"})});
  const grant={moduleId:base.id,moduleVersion:base.version,contributionId:base.contributions[0]!.id,
    capabilityId:"core.file.inspect",projectPath:"C:/synthetic-workspace"};
  return {
    host,base,grant,
    async setup(){await host.install(base);await host.issueWorkflowGrant(grant);},
    setGrantFailure(value:boolean){failGrantWrite=value;},
    setManifestFailure(value:boolean){failManifestWrite=value;},
    disk(){return disk;},
    grants(){return grantText;},
    archived(){return classifyModuleWorkflowGrants(grantText);},
    targets(){return host.catalog().workflowTargets?.filter(x=>x.moduleId===base.id)??[]},
  };
}
async function rejected(promise:Promise<unknown>):Promise<boolean> {
  try{await promise;return false;}catch{return true;}
}

{
  const f=fixture();await f.setup();const before=f.grants();
  f.setGrantFailure(true);
  const refuses=await rejected(f.host.remove(f.base.id));
  check("★ 卸载无法保存授权撤销时必须显式拒绝", refuses);
  check("★ 撤销失败时模块在内存和持久清单仍存在",
    f.disk().some(m=>m.id===f.base.id) &&
    f.host.catalog().modules.some(m=>m.id===f.base.id));
  check("★ 撤销失败时原始授权字节不变，不能假装撤销成功",f.grants()===before);
  f.setGrantFailure(false);
  const removed=await f.host.remove(f.base.id);
  check("成功撤销后模块真正卸载",!removed.catalog.modules.some(m=>m.id===f.base.id));
  const afterRemove=f.archived();
  check("★ 成功卸载必须清掉授权存档",afterRemove.state==="valid" &&
    afterRemove.grants.every(x=>x.moduleId!==f.base.id));
  await f.host.install(f.base);
  check("★ 卸载再装相同模块和版本不能复活旧工作流授权",f.targets().length===0);
}
{
  const f=fixture();await f.setup();const before=f.grants();
  f.setManifestFailure(true);
  const refused=await rejected(f.host.remove(f.base.id));
  check("清单保存失败时卸载必须拒绝",refused);
  check("★ 清单保存失败后已撤销的授权须回滚到原始字节",f.grants()===before);
  check("★ 清单保存失败后旧模块仍安装",f.host.catalog().modules.some(m=>m.id===f.base.id));
}
{
  const f=fixture();await f.setup();
  await f.host.install({...f.base,permissions:["resource.read","network"]});
  check("★ 同版本加入 network 权限必须撤销先前自动执行授权",f.targets().length===0);
  const afterNetworkChange=f.archived();
  check("★ 同版本加 network 后旧授权存档应无该模块项",
    afterNetworkChange.state==="valid" && afterNetworkChange.grants.every(x=>x.moduleId!==f.base.id));
}
{
  const f=fixture();await f.setup();
  const first = f.base.contributions[0]!;
  if (first.slot !== "files.context") throw Error("fixture must be a file-context contribution");
  const modified:ModuleManifest={...f.base,contributions:[{...first,extensions:[".pdf"]}]};
  await f.host.install(modified);
  check("★ 同版本更换贡献允许文件类型必须撤销先前工作流授权",f.targets().length===0);
  const afterContributionChange=f.archived();
  check("★ 同版本更换贡献权限后不留可恢复旧档案",
    afterContributionChange.state==="valid" && afterContributionChange.grants.every(x=>x.moduleId!==f.base.id));
}
{
  const f=fixture();await f.setup();const original=f.grants();
  await f.host.install({...f.base,title:{zh:"改名但不改权限",en:"New title"}});
  check("安全非执行元信息同版本更新不应无故清掉授权",f.grants()===original && f.targets().length===1);
}
{
  const scopes:string[]=[];
  let executions=0;
  const host=new ModuleHost({
    authorize:async()=>{},persist:async()=>{},
    requestApproval:async request=>{scopes.push(request.scope??"write");},
  });
  host.register({id:"core.test.network-action",kind:"action",
    input:ResourceSchema,output:ResultSchema,run:async()=>{executions++;return {text:"done"};}});
  const manifest={...EXAMPLE_MODULE,id:"core.network-action",
    permissions:["resource.read","resource.write","network"],
    contributions:[{...EXAMPLE_MODULE.contributions[0]!,capability:"core.test.network-action"}]};
  host.addBuiltin(manifest);
  await host.invoke({moduleId:"core.network-action",contributionId:manifest.contributions[0]!.id,
    requestId:"synthetic-action",resource:{projectPath:"C:/synthetic",path:"C:/synthetic/demo"}});
  check("★ 联网且写文件的 action 必须分别获得明确的 network 和 write 真人许可",
    scopes.includes("network") && scopes.includes("write"),scopes);
  check("两个许可都通过后只执行一次 action",executions===1,executions);
}
{
  const scopes:string[]=[];
  let executions=0;
  const host=new ModuleHost({
    authorize:async()=>{},persist:async()=>{},
    requestApproval:async request=>{
      scopes.push(request.scope??"write");
      if(request.scope==="network")throw Error("SYNTHETIC_NETWORK_DENIED");
    },
  });
  host.register({id:"core.test.network-deny",kind:"action",
    input:ResourceSchema,output:ResultSchema,run:async()=>{executions++;return {text:"danger"};}});
  const manifest={...EXAMPLE_MODULE,id:"core.network-deny",
    permissions:["resource.read","resource.write","network"],
    contributions:[{...EXAMPLE_MODULE.contributions[0]!,capability:"core.test.network-deny"}]};
  host.addBuiltin(manifest);
  const blocked=await rejected(host.invoke({moduleId:"core.network-deny",
    contributionId:manifest.contributions[0]!.id,requestId:"deny-network",
    resource:{projectPath:"C:/synthetic",path:"C:/synthetic/demo"}}));
  check("★ 明确拒绝网络许可必须阻断 action，不得凭写许可执行",
    blocked && executions===0 && scopes.includes("network"),{blocked,executions,scopes});
}
// In-flight menu query still uses a live capability after the host removed/replaced
// its manifest. It must receive AbortSignal and never publish a stale result.
async function pendingQueryFixture() {
  let unblock!: () => void;
  const gate=new Promise<void>(resolve=>{unblock=resolve;});
  let started!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;});
  let wasAborted=false;
  const host=new ModuleHost({authorize:async()=>{},persist:async()=>{}});
  host.register({id:"core.test.long-query",kind:"query",input:ResourceSchema,output:ResultSchema,
    run:async (_resource,ctx)=>{
      ctx.signal.addEventListener("abort",()=>{wasAborted=true;},{once:true});
      started();
      await gate;
      return {text:"STALE_SHOULD_NOT_LEAK"};
    },
  });
  const manifest={...EXAMPLE_MODULE,id:"user.long-query",
    contributions:[{...EXAMPLE_MODULE.contributions[0]!,capability:"core.test.long-query"}]};
  await host.install(manifest);
  const pending=host.invoke({moduleId:manifest.id,contributionId:manifest.contributions[0]!.id,
    requestId:"query-in-flight",resource:{projectPath:"C:/fake",path:"C:/fake/file"}});
  await entered;
  return {host,manifest,pending,unblock,aborted:()=>wasAborted};
}
{
  const f=await pendingQueryFixture();
  await f.host.remove(f.manifest.id);
  check("★ 卸载模块时进行中的 query 必须收到取消信号",f.aborted());
  f.unblock();
  check("★ 卸载之后迟到的 query 结果不能重新发布",await rejected(f.pending));
}
{
  const f=await pendingQueryFixture();
  await f.host.install({...f.manifest,version:"1.0.1"});
  check("★ 替换模块时进行中的旧 query 必须收到取消信号",f.aborted());
  f.unblock();
  check("★ 替换模块后旧 query 结果不能当新版本成功",await rejected(f.pending));
}
// A workflow grant can be revoked between invokeForWorkflow's initial grant read
// and the real capability dispatch, while authorize awaits IO. The host must
// revalidate at the final launch boundary rather than only checking at entry.
{
  let enter!:()=>void, release!:()=>void;
  const reached=new Promise<void>(resolve=>{enter=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let grantText:string|null=null, executed=0;
  const host=new ModuleHost({
    authorize:async()=>{enter();await gate;},
    persist:async()=>{},
    readWorkflowGrants:()=>grantText,
    persistWorkflowGrants:async raw=>{grantText=raw;},
  });
  host.register({id:"core.test.grant-race",kind:"query",input:ResourceSchema,output:ResultSchema,
    run:async()=>{executed++;return {text:"DENIED_SHOULD_NOT_RUN"};}});
  const module={...EXAMPLE_MODULE,id:"user.grant-race",
    contributions:[{...EXAMPLE_MODULE.contributions[0]!,capability:"core.test.grant-race"}]};
  await host.install(module);
  const grant={moduleId:module.id,moduleVersion:module.version,
    contributionId:module.contributions[0]!.id,capabilityId:"core.test.grant-race",
    projectPath:"C:/grant-race"};
  await host.issueWorkflowGrant(grant);
  const running=host.invokeForWorkflow({moduleId:module.id,contributionId:grant.contributionId,
    requestId:"synthetic-grant-race",resource:{projectPath:grant.projectPath,path:"C:/grant-race/file"}});
  await reached;
  await host.revokeWorkflowGrant(grant);
  release();
  const prevented=await rejected(running);
  check("★ 工作流在 authorize 挂起期间撤授权后不得继续执行",prevented && executed===0,
    {prevented,executed});
}
// E1 real ModuleHost grant revoked while a query has entered its capability.
// The ordinary menu invoke of the same module is deliberately concurrent: only
// the workflow-authorized execution must be revoked.
{
  let grantText:string|null=null;
  let startCount=0;
  const reached:Array<()=>void>=[];
  const release:Array<()=>void>=[];
  const abortSignals:boolean[]=[];
  const host=new ModuleHost({
    authorize:async()=>{},persist:async()=>{},
    readWorkflowGrants:()=>grantText,persistWorkflowGrants:async raw=>{grantText=raw;},
  });
  host.register({id:"core.test.live-query",kind:"query",input:ResourceSchema,output:ResultSchema,
    run:async (_r,ctx)=>{
      const index=startCount++;
      let letGo!:()=>void;
      const holding=new Promise<void>(resolve=>{letGo=resolve;});
      release[index]=letGo;
      abortSignals[index]=ctx.signal.aborted;
      ctx.signal.addEventListener("abort",()=>{abortSignals[index]=true;},{once:true});
      reached[index]?.();
      await holding;
      return {text:"query-result-"+index};
    }});
  const module={...EXAMPLE_MODULE,id:"user.live-query",
    contributions:[{...EXAMPLE_MODULE.contributions[0]!,capability:"core.test.live-query"}]};
  await host.install(module);
  const grant={moduleId:module.id,moduleVersion:module.version,
    contributionId:module.contributions[0]!.id,capabilityId:"core.test.live-query",
    projectPath:"C:/synthetic-live"};
  await host.issueWorkflowGrant(grant);
  let workflowEntered!:()=>void, menuEntered!:()=>void;
  const wfEntered=new Promise<void>(r=>{workflowEntered=r;});
  const menuEnteredPromise=new Promise<void>(r=>{menuEntered=r;});
  reached[0]=workflowEntered;reached[1]=menuEntered;
  const request={moduleId:module.id,contributionId:grant.contributionId,
    resource:{projectPath:grant.projectPath,path:"C:/synthetic-live/file"}};
  const workflow=host.invokeForWorkflow({...request,requestId:"grant-workflow"});
  await wfEntered;
  const menu=host.invoke({...request,requestId:"grant-menu"});
  await menuEnteredPromise;
  await host.revokeWorkflowGrant(grant);
  check("★ 撤销授权立即通知正在运行的工作流 query 取消",abortSignals[0]===true,abortSignals);
  check("★ 菜单 query 没有工作流 grant 依赖，撤权不应误取消它",abortSignals[1]===false,abortSignals);
  release[0]?.();release[1]?.();
  const oldRejected=await rejected(workflow);
  const menuResult=await menu;
  check("★ 工作流 query 撤权后迟到成功必须拒收",oldRejected);
  check("★ 同一模块仍可经正常菜单获得只读结果",menuResult.type==="result" && menuResult.value.text==="query-result-1");
}
// Long task was accepted under workflow grant; revocation must cancel its
// outstanding task record. A late worker completion must stay cancelled.
{
  let grantText:string|null=null, started!:()=>void, release!:()=>void, aborted=false;
  const entered=new Promise<void>(resolve=>{started=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const host=new ModuleHost({
    authorize:async()=>{},persist:async()=>{},
    readWorkflowGrants:()=>grantText,persistWorkflowGrants:async raw=>{grantText=raw;},
  });
  host.register({id:"core.test.live-task",kind:"task",input:ResourceSchema,output:ResultSchema,
    run:async (_r,ctx)=>{
      ctx.signal.addEventListener("abort",()=>{aborted=true;},{once:true});
      started();await gate;return {text:"LATE_SUCCESS"};
    }});
  const module={...EXAMPLE_MODULE,id:"user.live-task",
    contributions:[{...EXAMPLE_MODULE.contributions[0]!,capability:"core.test.live-task"}]};
  await host.install(module);
  const grant={moduleId:module.id,moduleVersion:module.version,
    contributionId:module.contributions[0]!.id,capabilityId:"core.test.live-task",
    projectPath:"C:/synthetic-live-task"};
  await host.issueWorkflowGrant(grant);
  const reply=await host.invokeForWorkflow({moduleId:module.id,contributionId:grant.contributionId,
    requestId:"task-grant-test",resource:{projectPath:grant.projectPath,path:"C:/synthetic-live-task/file"}});
  await entered;
  await host.revokeWorkflowGrant(grant);
  const current=reply.type==="task"?host.task({moduleId:module.id,taskId:reply.task.id}):null;
  check("★ 撤销工作流授权会取消先前已签发的工作流任务",current?.status==="cancelled" && aborted,{status:current?.status,aborted});
  release();await new Promise<void>(r=>setImmediate(r));
  const after=reply.type==="task"?host.task({moduleId:module.id,taskId:reply.task.id}):null;
  check("★ 已撤权的 task 迟到完成不会重新变成功",after?.status==="cancelled");
}
// Grant-key scope and failed persistence: revoking one project must not abort
// another project's workflow; if the store rejects revocation neither task
// should be cancelled. Both grants are synthetic and held only in memory.
{
  let grantText:string|null=null, throwRevoke=false;
  const release:Array<()=>void>=[], aborted:boolean[]=[];
  let enteredCount=0;const arrived:Array<()=>void>=[];
  const firstReady=new Promise<void>(r=>{arrived[0]=r;});
  const secondReady=new Promise<void>(r=>{arrived[1]=r;});
  const host=new ModuleHost({
    authorize:async()=>{},persist:async()=>{},
    readWorkflowGrants:()=>grantText,
    persistWorkflowGrants:async value=>{
      if(throwRevoke)throw Error("SYNTHETIC_REVOKE_PERSIST_FAIL");
      grantText=value;
    },
  });
  host.register({id:"core.test.scoped",kind:"query",input:ResourceSchema,output:ResultSchema,
    run:async (_r,ctx)=>{
      const index=enteredCount++;
      const gate=new Promise<void>(r=>{release[index]=r;});
      aborted[index]=ctx.signal.aborted;
      ctx.signal.addEventListener("abort",()=>{aborted[index]=true;},{once:true});
      arrived[index]?.();await gate;
      return {text:"SCOPED_"+index};
    }});
  const module={...EXAMPLE_MODULE,id:"user.scoped-grant",
    contributions:[{...EXAMPLE_MODULE.contributions[0]!,capability:"core.test.scoped"}]};
  await host.install(module);
  const base={moduleId:module.id,moduleVersion:module.version,
    contributionId:module.contributions[0]!.id,capabilityId:"core.test.scoped"};
  const grantA={...base,projectPath:"C:/project-a"};
  const grantB={...base,projectPath:"C:/project-b"};
  await host.issueWorkflowGrant(grantA);
  await host.issueWorkflowGrant(grantB);
  const invoke=(projectPath:string,requestId:string)=>host.invokeForWorkflow({
    moduleId:module.id,contributionId:base.contributionId,requestId,
    resource:{projectPath,path:projectPath+"/file"},
  });
  const flowA=invoke(grantA.projectPath,"project-a-run");
  await firstReady;
  const flowB=invoke(grantB.projectPath,"project-b-run");
  await secondReady;
  throwRevoke=true;
  check("★ 授权撤销持久化失败不得上报为撤销成功",
    await rejected(host.revokeWorkflowGrant(grantA)));
  check("★ 存储拒绝撤销时，运行中 A/B 工作流均不该收到取消信号",
    !aborted[0] && !aborted[1],aborted);
  throwRevoke=false;
  await host.revokeWorkflowGrant(grantA);
  check("★ 撤销项目 A 的授权仅取消 A 的运行中工作流",
    aborted[0]===true && aborted[1]===false,aborted);
  release[0]?.();release[1]?.();
  check("★ 被撤权的项目 A 迟到结果拒绝；项目 B 返回原结果",
    (await rejected(flowA)) && (await flowB).type==="result");
}
// Simulate grant store changed by another host/process, without this host's
// revokeWorkflowGrant being called. No real disk IO; publishing must re-read
// the shared persisted authority rather than trust an earlier snapshot.
for (const kind of ["query","task"] as const) {
  let grantText:string|null=null, started!:()=>void, release!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const host=new ModuleHost({
    authorize:async()=>{},persist:async()=>{},
    readWorkflowGrants:()=>grantText,
    persistWorkflowGrants:async raw=>{grantText=raw;},
  });
  const capId="core.test.external-"+kind;
  host.register({id:capId,kind,input:ResourceSchema,output:ResultSchema,
    run:async()=>{started();await gate;return {text:"OUTDATED_"+kind};}});
  const module={...EXAMPLE_MODULE,id:"user.external-"+kind,
    contributions:[{...EXAMPLE_MODULE.contributions[0]!,capability:capId}]};
  await host.install(module);
  const grant={moduleId:module.id,moduleVersion:module.version,
    contributionId:module.contributions[0]!.id,capabilityId:capId,
    projectPath:"C:/external-revoke-"+kind};
  await host.issueWorkflowGrant(grant);
  const pending=host.invokeForWorkflow({moduleId:module.id,contributionId:grant.contributionId,
    requestId:"external-race-"+kind,resource:{projectPath:grant.projectPath,path:grant.projectPath+"/file"}});
  if (kind==="query") {
    await entered;
    // Other store writer removed grant, no signal dispatch on this host.
    grantText=serializeModuleWorkflowGrants([]);
    release();
    check("★ 外部撤权后在飞 query 不得返回过期授权下的成功",await rejected(pending));
  } else {
    const reply=await pending;
    await entered;
    grantText=serializeModuleWorkflowGrants([]);
    release();await new Promise<void>(resolve=>setImmediate(resolve));
    const snap=reply.type==="task"?host.task({moduleId:module.id,taskId:reply.task.id}):null;
    check("★ 外部撤权后任务完成时不可发布旧授权下的 success",
      snap?.status==="cancelled" || snap?.status==="failed",{status:snap?.status});
  }
}
console.log("module-grant-revoke-safety-smoke: "+(total-failed)+"/"+total+" PASS");
if(failed)process.exitCode=1;
