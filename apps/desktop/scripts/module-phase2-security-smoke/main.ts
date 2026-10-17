/** Independent P2-06 checks. All files and persisted manifests are isolated fixtures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, symlink, truncate, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXAMPLE_MODULE, ModuleManifestSchema, ResourceSchema, ResultSchema, actionInvocationDenied, actionInvocationRefusal, moduleRefusal, moduleRefusalError, type ModuleInvoke, type ModuleReply, type ModuleTask } from '@contracts/modules';
import { JsonSchemaDocumentSchema, ModuleCatalogSchema, ModuleWorkflowCallSchema } from '@contracts/moduleCapability';
import { ModuleHost } from '../../src/main/modules/ModuleHost.js';
import type { ActionApprovalRequest } from '../../src/main/modules/ModuleHost.js';
import {
  runIsolatedAction, isolationFailure, configureIsolatedWorkerFactory, defaultIsolatedWorkerFactory,
} from '../../src/main/modules/isolatedActionRunner.js';
import { fileCapabilities, resolveModuleResource } from '../../src/main/modules/fileCapabilities.js';
import { getModuleHost, configureModuleApprovalPort, requestModuleActionApproval } from '../../src/main/modules/service.js';
import { thrownResultKind } from '../../src/main/appControl/commandOutcome.js';

const base = process.env.P2_TEST_DIR;
assert.ok(base, 'builder must provide isolated test directory');
const root = join(base, 'workspace'), outside = join(base, 'outside');
await mkdir(root, {recursive:true}); await mkdir(outside, {recursive:true});
const file = join(root, 'sample.txt'), secret = join(outside, 'secret.txt');
const body = 'Independent P2 regression\n';
await writeFile(file, body); await writeFile(secret, 'fixture only');
const host = await getModuleHost(); // real lazy service; only root lookup and data location are injected
const call = (moduleId = 'core.file-report', contributionId = 'inspect', requestId = 'attempt', path = file): ModuleInvoke =>
  ({moduleId, contributionId, requestId, resource: {projectPath:root, path}});
const delay = (ms:number) => new Promise<void>(resolve => setTimeout(resolve,ms));
async function terminal(h:ModuleHost, reply:ModuleReply):Promise<ModuleTask> {
  assert.equal(reply.type,'task'); if(reply.type!=='task') throw Error('Expected task');
  const deadline=Date.now()+35000;
  while(Date.now()<deadline){const t=h.task({moduleId:reply.task.moduleId,taskId:reply.task.id}); if(t.status!=='running')return t; await delay(5);}
  throw Error('Test deadline exceeded');
}
const results: Array<{name:string;status:string;error?:string}> = [];
async function test(name:string, fn:()=>unknown){try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){const error=String(e);results.push({name,status:'FAIL',error});console.error('FAIL '+name+' '+error);}}
async function denies(p:Promise<unknown>, pattern:RegExp){await assert.rejects(p,e=>{assert.ok(e instanceof Error);assert.notEqual(e.name,'TypeError');assert.match(e.message,pattern);return true;});}
// 【MC-036】用户模块的拒绝原因拆成两类:未授权(缺宿主核验的工作流授权)与
// 伪造/未知内置目标(仍沿用原判定)。`host`/`restarted` 都没有注入授权存档,故用户模块
// 在这里走的是"未授权"那一支。
const denyUserWorkflow = /需要宿主核验的工作流授权/;
const denyWorkflow = /工作流需要一个已注册的内置只读贡献/;

await test('AUTH user module works from menu but not workflow',async()=>{
  await host.install(EXAMPLE_MODULE);
  const menu=await terminal(host,await host.invoke(call(EXAMPLE_MODULE.id,'inspect','menu-user')));
  assert.equal(menu.status,'completed');assert.equal(menu.result?.bytes,Buffer.byteLength(body));
  await denies(host.invokeForWorkflow(call(EXAMPLE_MODULE.id,'inspect','workflow-user')),denyUserWorkflow);
});
// The mutation run intentionally executes exactly the security assertion above.
if(process.env.P2_SECURITY_MUTATION!=='workflow-auth') {
await test('COMPAT v1 manifest persists and restored module retains menu authorization only',async()=>{
  assert.equal(ModuleManifestSchema.parse(EXAMPLE_MODULE).apiVersion,1);
  const saved=JSON.parse(await readFile(join(base,'data','ui-modules','manifests.json'),'utf8')) as unknown[];
  const restarted=new ModuleHost({authorize:async r=>{await resolveModuleResource(r,p=>p===root);},persist:async()=>{}});
  for(const c of fileCapabilities(p=>p===root))restarted.register(c);
  for(const m of saved)restarted.restore(m);
  assert.equal((await terminal(restarted,await restarted.invoke(call(EXAMPLE_MODULE.id,'inspect','restore-menu')))).status,'completed');
  await denies(restarted.invokeForWorkflow(call(EXAMPLE_MODULE.id,'inspect','restore-wf')),denyUserWorkflow);
});
await test('COMPAT old catalog has no invented metadata or workflow targets',()=>{
  const old=ModuleCatalogSchema.parse({modules:[EXAMPLE_MODULE],capabilities:[{id:'core.file.inspect',kind:'task'}]});
  assert.equal(old.workflowTargets,undefined);assert.equal(old.capabilities[0].metadata,undefined);
});
await test('AUTH forged core ID and unavailable contribution are rejected',async()=>{
  await denies(host.install({...EXAMPLE_MODULE,id:'core.forged'}),/user/);
  await denies(host.invokeForWorkflow(call('core.forged')),denyWorkflow);
  await denies(host.invokeForWorkflow(call('core.file-report','missing')),denyWorkflow);
});
await test('AUTH actions cannot become builtin workflow contributions without the resource.write permission',()=>{
  const h=new ModuleHost({authorize:async()=>{},persist:async()=>{}});
  h.register({id:'core.test.action',kind:'action',input:ResourceSchema,output:ResultSchema,run:async()=>({bytes:1})});
  // 【MC-060】没声明 resource.write 的清单,挂 action 能力照旧拒(不靠一个 action 越过只读边界)。
  assert.throws(()=>h.addBuiltin({...EXAMPLE_MODULE,id:'core.action',contributions:[{...EXAMPLE_MODULE.contributions[0],capability:'core.test.action'}]}),/resource\.write/);
  // 【MC-060】显式声明 resource.write 的清单,其 action 能力**可以**接进来(写权限由清单显式请求)。
  const withWrite=new ModuleHost({authorize:async()=>{},persist:async()=>{}});
  withWrite.register({id:'core.test.action2',kind:'action',input:ResourceSchema,output:ResultSchema,run:async()=>({bytes:1})});
  withWrite.addBuiltin({...EXAMPLE_MODULE,id:'core.action-ok',permissions:['resource.read','resource.write'],contributions:[{...EXAMPLE_MODULE.contributions[0],capability:'core.test.action2'}]});
  const catalog=withWrite.catalog();
  assert.ok(catalog.modules.some(m=>m.id==='core.action-ok'),'declared resource.write => action module admitted');
});
// 【MC-060 承重】写权限判定只有**一份**:能力自身元数据(register)与模块清单(validate)
// 共用同一条 `missingCapabilityPermission`,而 validate 又被 addBuiltin(内置)、install(用户,
// 也就是菜单/面板/agent 经 `modules.invoke` 能装到的那条路)、restore(重启恢复)三个入口共用。
// 这条断言把「能力元数据这一侧也走同一判定」钉住:撤掉共享判定里 action→resource.write 那半句,
// register 不再抛,这条**真红**。
await test('AUTH an action capability must declare resource.write in its own metadata, not only in the manifest',()=>{
  const h=new ModuleHost({authorize:async()=>{},persist:async()=>{}});
  const actionMeta={
    schemaVersion:1 as const,version:'1.0.0',title:{zh:'写',en:'Write'},description:{zh:'改',en:'Mutate'},
    permissions:['resource.read'] as ('resource.read'|'resource.write')[],
    inputSchema:{type:'object',properties:{projectPath:{type:'string',minLength:1},path:{type:'string',minLength:1}},required:['projectPath','path'],additionalProperties:false},
    outputSchema:{type:'object'},supportsCancellation:false,
  };
  // 能力自称只读 → 注册就被拒(不能靠 manifest 那一道闸给一个撒谎的 action 元数据兜底)。
  assert.throws(
    ()=>h.register({id:'core.test.liar',kind:'action',metadata:actionMeta,input:ResourceSchema,output:ResultSchema,run:async()=>({bytes:1})}),
    /resource\.write/,
  );
  // 对照(证明不是空过):同一份元数据把权限如实写成两条,注册**通过**。
  const honest=new ModuleHost({authorize:async()=>{},persist:async()=>{}});
  honest.register({id:'core.test.honest',kind:'action',metadata:{...actionMeta,permissions:['resource.read','resource.write']},input:ResourceSchema,output:ResultSchema,run:async()=>({bytes:1})});
  const descriptor=honest.catalog().capabilities.find(c=>c.id==='core.test.honest');
  assert.deepEqual(descriptor?.metadata?.permissions,['resource.read','resource.write']);
});
// 【MC-060 承重】同一个 validate 判定被**用户安装**(install,agent/面板经 `modules.invoke`
// 能触达的那条路)与 addBuiltin 共用 —— 不是内置一套、用户另一套。撤掉 validate 里的判定,
// 这里两条 assert.rejects 都会静默装进去 → **真红**。
await test('AUTH user install shares the same resource.write gate as builtin admission',async()=>{
  const h=new ModuleHost({authorize:async()=>{},persist:async()=>{}});
  h.register({id:'core.test.task3',kind:'task',input:ResourceSchema,output:ResultSchema,run:async()=>({bytes:1})});
  h.register({id:'core.test.action3',kind:'action',input:ResourceSchema,output:ResultSchema,run:async()=>({bytes:1})});
  // 用户清单挂一个 action 能力、但只声明 resource.read → install 拒(不留只读谎报)。
  await assert.rejects(
    h.install({...EXAMPLE_MODULE,id:'user.action-no-write',contributions:[{...EXAMPLE_MODULE.contributions[0],capability:'core.test.action3'}]}),
    /resource\.write/,
  );
  // 对照:同一份用户清单显式声明 resource.write → install 通过(判定不是无条件拒)。
  const catalog=await h.install({...EXAMPLE_MODULE,id:'user.action-ok',permissions:['resource.read','resource.write'],contributions:[{...EXAMPLE_MODULE.contributions[0],capability:'core.test.action3'}]});
  assert.ok(catalog.modules.some(m=>m.id==='user.action-ok'),'user action module admitted with resource.write');
});
// 【MC-060 承重】action 能力的**受控执行宿主**:准入(能不能挂这个能力)在 register/validate 已判,
// 这条盯的是**执行点**的第二层 —— 一次 action  invocation 必须 ①模块清单持有 resource.write(作用域),
// ②存在审批通道,③经通道批准。三条任一不满足即拒,绝不落到 capability.run。判定复用 @contracts/modules
// 的 actionInvocationDenied(只有这一份)。撤掉 invoke 里那两行 → noChannel/refusing 两条 assert.rejects
// 会静默**执行成功**(不再是 Promise 拒绝)→ **真红**。
await test('AUTH action invocation needs an injected approval channel, scoped, once per call',async()=>{
  // (a) 没有审批通道的宿主:action 执行一律拒(fail-closed,与 gateAppAction 无审批环境同款)。
  const noChannel=new ModuleHost({authorize:async()=>{},persist:async()=>{}});
  noChannel.register({id:'core.test.mutate1',kind:'action',input:ResourceSchema,output:ResultSchema,run:async()=>({bytes:7})});
  noChannel.addBuiltin({...EXAMPLE_MODULE,id:'core.mutate1',permissions:['resource.read','resource.write'],contributions:[{...EXAMPLE_MODULE.contributions[0],capability:'core.test.mutate1'}]});
  await denies(noChannel.invoke(call('core.mutate1')),/审批通道/);

  // (b) 有审批通道但用户拒绝 → 拒,且审批请求带上**正确作用域**(模块贡献 + 具体资源)。
  let seen:ActionApprovalRequest|undefined;
  const refusing=new ModuleHost({authorize:async()=>{},persist:async()=>{},
    requestApproval:async req=>{seen=req;throw Error('用户拒绝了这次操作,未执行。');}});
  refusing.register({id:'core.test.mutate2',kind:'action',input:ResourceSchema,output:ResultSchema,run:async()=>({bytes:7})});
  refusing.addBuiltin({...EXAMPLE_MODULE,id:'core.mutate2',permissions:['resource.read','resource.write'],contributions:[{...EXAMPLE_MODULE.contributions[0],capability:'core.test.mutate2'}]});
  await denies(refusing.invoke(call('core.mutate2')),/用户拒绝/);
  assert.equal(seen?.moduleId,'core.mutate2');
  assert.equal(seen?.contributionId,'inspect');
  assert.equal(seen?.capabilityId,'core.test.mutate2');
  assert.equal(seen?.resource.path,file,'approval request must scope the exact resource');

  // (c) 对照(证明不是无条件拒):审批通道批准 → action 真执行、返回结果,且**每次调用只问一次**。
  let approved=0;
  const allowing=new ModuleHost({authorize:async()=>{},persist:async()=>{},
    requestApproval:async()=>{approved++;}});
  allowing.register({id:'core.test.mutate3',kind:'action',input:ResourceSchema,output:ResultSchema,run:async()=>({bytes:7})});
  allowing.addBuiltin({...EXAMPLE_MODULE,id:'core.mutate3',permissions:['resource.read','resource.write'],contributions:[{...EXAMPLE_MODULE.contributions[0],capability:'core.test.mutate3'}]});
  const reply=await allowing.invoke(call('core.mutate3'));
  assert.equal(reply.type,'result');if(reply.type==='result')assert.equal(reply.value.bytes,7);
  assert.equal(approved,1,'approval asked exactly once per action invocation');
  // 非 action(query/task)不弹审批:普通只读能力照常直接返回,不受这道闸影响。
  const plain=await host.invoke(call('core.file-report','info','no-approval-needed'));
  assert.equal(plain.type,'result');
});
// 【MC-060 承重】执行点拒绝必须**可区分** —— 命令没执行(REJECTED)vs 执行途中出错(UNCERTAIN)。
// 宿主拒绝一个 action 时抛的 Error 带 `moduleRefusal` 标记(scope_denied / approval_unavailable /
// approval_denied),上层结果分类器 `thrownResultKind` 据此落 REJECTED(可安全重来),**不**按
// 权限档一律报 UNCERTAIN。撤掉 ModuleHost 里 `moduleRefusalError(...)` 的抛 → 标记消失 →
// `moduleRefusal(err)` 回 null → 这条真红。
await test('AUTH action refusals carry a typed code so "nothing executed" is not misreported as UNCERTAIN',async()=>{
  // (a) 纯判据带 code;`actionInvocationDenied` 仍只取理由(既有调用端不变)。
  assert.equal(actionInvocationRefusal('query',['resource.read'],false),undefined);
  assert.deepEqual(actionInvocationRefusal('action',['resource.read'],true),{code:'scope_denied',reason:'action 能力执行需要模块声明 resource.write 权限'});
  assert.equal(actionInvocationRefusal('action',['resource.read','resource.write'],false)?.code,'approval_unavailable');
  assert.equal(actionInvocationDenied('action',['resource.read','resource.write'],false),actionInvocationRefusal('action',['resource.read','resource.write'],false)?.reason);

  // (b) 宿主无审批通道拒绝 → 抛出的 Error 带 approval_unavailable 标记。
  const noChannel=new ModuleHost({authorize:async()=>{},persist:async()=>{}});
  noChannel.register({id:'core.test.mutate-code1',kind:'action',input:ResourceSchema,output:ResultSchema,run:async()=>({bytes:7})});
  noChannel.addBuiltin({...EXAMPLE_MODULE,id:'core.mutate-code1',permissions:['resource.read','resource.write'],contributions:[{...EXAMPLE_MODULE.contributions[0],capability:'core.test.mutate-code1'}]});
  let noChannelErr:unknown;
  try{await noChannel.invoke(call('core.mutate-code1'));assert.fail('expected refusal');}catch(e){noChannelErr=e;}
  assert.equal(moduleRefusal(noChannelErr)?.code,'approval_unavailable','host refusal must be a typed module refusal');

  // (c) 审批端口拒绝 → approval_denied(不是裸 Error,也不是 UNCERTAIN)。
  const refusing=new ModuleHost({authorize:async()=>{},persist:async()=>{},requestApproval:async()=>{throw Error('用户拒绝了这次操作,未执行。');}});
  refusing.register({id:'core.test.mutate-code2',kind:'action',input:ResourceSchema,output:ResultSchema,run:async()=>({bytes:7})});
  refusing.addBuiltin({...EXAMPLE_MODULE,id:'core.mutate-code2',permissions:['resource.read','resource.write'],contributions:[{...EXAMPLE_MODULE.contributions[0],capability:'core.test.mutate-code2'}]});
  let refusedErr:unknown;
  try{await refusing.invoke(call('core.mutate-code2'));assert.fail('expected refusal');}catch(e){refusedErr=e;}
  assert.equal(moduleRefusal(refusedErr)?.code,'approval_denied');

  // (d) 结果分类器:带标记的拒绝 → REJECTED(即便方法档位是 write);裸错误仍按档位(写档 → UNCERTAIN)。
  //     撤掉 `thrownResultKind` 的 `moduleRefusal` 分支 → 写档标记拒绝会落 UNCERTAIN → 真红。
  assert.equal(thrownResultKind(noChannelErr,'write'),'REJECTED','a typed refusal is "nothing executed" => REJECTED even for a write-level method');
  assert.equal(thrownResultKind(refusedErr,'danger'),'REJECTED');
  assert.equal(thrownResultKind(Error('fsync 失败'),'write'),'UNCERTAIN','an untagged write-level error stays UNCERTAIN');
  assert.equal(thrownResultKind(Error('read failed'),'read'),'FAILED');
});

// 【MC-060 承重】**生产审批装配** —— 此前 `modules/service.ts` 的生产 host **没注入**审批端口,
// `action` 能力一旦接入会被 fail-closed 拒(装配缺席)。这条钉住:`service.ts` 交出的 host 带
// **生产审批端口**(`requestModuleActionApproval`),端口未装上时**抛 approval_unavailable 标记**
// 而不是静默放行;装上真端口后由它接管。撤掉 service.ts 里 `requestApproval: requestModuleActionApproval`
// 这一行 → 生产 host 又变回"无通道",action 调用无法区分"没通道"与"没装端口" → 真红。
await test('AUTH production host wires a real approval port, fail-closed until assembled',async()=>{
  // 端口默认(未装配)必须 fail-closed:抛带标记的 approval_unavailable,绝不静默放行。
  configureModuleApprovalPort(null);
  let before:unknown;
  try{await requestModuleActionApproval({moduleId:'m',contributionId:'c',capabilityId:'k',resource:{projectPath:root,path:file}});assert.fail('expected fail-closed');}catch(e){before=e;}
  assert.equal(moduleRefusal(before)?.code,'approval_unavailable','no assembled port must refuse, not allow');

  // 装上真端口 → 由它决定放行 / 拒绝(这里放行),且请求原样透传(作用域不丢)。
  let seen:ActionApprovalRequest|undefined;
  configureModuleApprovalPort(async req=>{seen=req;});
  try {
    await requestModuleActionApproval({moduleId:'m2',contributionId:'c2',capabilityId:'k2',resource:{projectPath:root,path:file}});
    assert.equal(seen?.moduleId,'m2');
    assert.equal(seen?.resource.path,file);

    // 真端口拒绝 → 原样抛(上层会包成 approval_denied)。
    configureModuleApprovalPort(async()=>{throw moduleRefusalError('approval_denied','用户拒绝了这次操作,未执行。');});
    let denied:unknown;
    try{await requestModuleActionApproval({moduleId:'m3',contributionId:'c3',capabilityId:'k3',resource:{projectPath:root,path:file}});assert.fail('expected denial');}catch(e){denied=e;}
    assert.equal(moduleRefusal(denied)?.code,'approval_denied');
  } finally {
    // 还原到未装配态:本套其它用例(以及真实 service host)不受这条的影响。
    configureModuleApprovalPort(null);
  }

  // 真实懒加载 service host:**装配端口后**,一个声明 resource.write 的内置 action 模块
  // 应当能**真执行**(approval 端口被调到并放行)。这是**判别性**证据:若 `service.ts` 的
  // createHost **没**把 `requestApproval: requestModuleActionApproval` 交下去,宿主就没有
  // 审批通道,`actionInvocationRefusal` 会在执行点先用 approval_unavailable 拒掉 —— 端口永远
  // 轮不到被调,这条会红(而不是"两种缺席看不出来")。
  const realHost=await getModuleHost();
  realHost.register({id:'core.test.prod-action',kind:'action',input:ResourceSchema,output:ResultSchema,run:async()=>({bytes:99})});
  realHost.addBuiltin({...EXAMPLE_MODULE,id:'core.prod-action',permissions:['resource.read','resource.write'],contributions:[{...EXAMPLE_MODULE.contributions[0],capability:'core.test.prod-action'}]});
  let prodAsked=0;
  configureModuleApprovalPort(async()=>{prodAsked++;});
  try {
    const reply=await realHost.invoke({moduleId:'core.prod-action',contributionId:'inspect',requestId:'prod-wired',resource:{projectPath:root,path:file}});
    assert.equal(prodAsked,1,'production host must route the action through the assembled approval port');
    assert.equal(reply.type,'result');if(reply.type==='result')assert.equal(reply.value.bytes,99);
  } finally {
    configureModuleApprovalPort(null);
  }
});
// 【MC-060 残余 承重】**第三方 action 的隔离执行进程** —— 台账原话：「运行时无 worker/child-process
// 的 action 执行路径」。这几条把那条路径钉住:**作用域/审批闸在派发到隔离进程之前**、**有超时**、
// **隔离进程崩了/超时了宿主不崩且回可区分的失败**、**取消真的停掉隔离进程**。判据一律「撤掉修复
// → 真红」,且**先证明副作用在非隔离路径下真会泄漏**(正控),再证明隔离后不泄漏 —— 否则「隔离
// 里的副作用没影响宿主」是假绿(测试 action 本来就没写那个副作用)。
await test('ISO isolated action runs in a worker thread and its result round-trips',async()=>{
  const result=await runIsolatedAction({source:'async (input) => ({ bytes: input.bytes * 2 })'},{bytes:21});
  assert.equal(result.bytes,42);
});
await test('ISO GLOBAL-POLLUTION: a global set in the isolated worker never reaches the host (with in-process positive control)',async()=>{
  const probe=(globalThis as Record<string,unknown>).__mcode_isolate_probe;
  assert.equal(probe,undefined,'precondition: probe global is clean');
  const source='async () => { globalThis.__mcode_isolate_probe = "leaked"; return { bytes: 1 }; }';
  // 正控:同一段源码在**宿主进程内**执行,全局**真的会被设上** —— 证明这条断言分得出「隔离」与「不隔离」。
  await (new Function('return ('+source+')')() as ()=>Promise<unknown>)();
  assert.equal((globalThis as Record<string,unknown>).__mcode_isolate_probe,'leaked','positive control: in-process eval leaks the global');
  delete (globalThis as Record<string,unknown>).__mcode_isolate_probe;
  // 隔离:同一段源码在 worker 线程里跑,宿主那份 globalThis 是**另一份** —— 宿主不被污染。
  await runIsolatedAction({source},{});
  assert.equal((globalThis as Record<string,unknown>).__mcode_isolate_probe,undefined,'isolated: host global stayed clean');
});
await test('ISO a runaway worker is terminated by the timeout and the host survives',async()=>{
  const start=Date.now();
  let failure:unknown;
  // **真挂死**:同步忙循环把 worker 线程**占住**(不会被事件循环排空而自退),只能靠 terminate 打断。
  const hang='async () => { const until = Date.now() + 3000; while (Date.now() < until) {} return { bytes: 1 }; }';
  try{await runIsolatedAction({source:hang},{},{timeoutMs:400});assert.fail('expected timeout');}catch(e){failure=e;}
  assert.equal(isolationFailure(failure)?.code,'isolated_timeout','a hung action must fail with a distinguishable timeout');
  assert.ok(Date.now()-start>=380,'the timeout must actually elapse');
  assert.ok(Date.now()-start<5000,'terminate must actually interrupt the busy loop, not wait for it');
  assert.equal((await runIsolatedAction({source:'async () => ({ alive: true })'},{})).alive,true,'host survives a runaway worker');
});
await test('ISO CRASH-ISOLATION: process.exit inside the worker does not take the host down',async()=>{
  let failure:unknown;
  try{await runIsolatedAction({source:'async () => { process.exit(7); }'},{},{timeoutMs:2000});assert.fail('expected crash');}catch(e){failure=e;}
  assert.equal(isolationFailure(failure)?.code,'isolated_crash','a worker that exits before returning is a distinguishable crash, not a success');
  // 宿主若被 process.exit 带走,这条之后的断言根本不会执行 —— 「宿主存活」由本行可达证明。
  assert.equal((await runIsolatedAction({source:'async () => ({ alive: true })'},{})).alive,true,'host still runs isolated actions after a worker crash');
});
await test('ISO CANCELLATION stops the worker and reports a distinguishable cancel',async()=>{
  const controller=new AbortController();
  // 同样用忙循环:线程一直活着,只有 abort 的 terminate 能停它。
  const hang='async () => { const until = Date.now() + 3000; while (Date.now() < until) {} return { bytes: 1 }; }';
  const running=runIsolatedAction({source:hang},{},{timeoutMs:4000,signal:controller.signal});
  setTimeout(()=>controller.abort(),40);
  let failure:unknown;
  try{await running;assert.fail('expected cancellation');}catch(e){failure=e;}
  assert.equal(isolationFailure(failure)?.code,'isolated_cancelled','an aborted action must fail with isolated_cancelled, not a timeout');
});
await test('ISO GATE-BEFORE-DISPATCH: a denied action spawns zero workers; an approved one spawns exactly one',async()=>{
  const created:Array<{ fired:boolean }>=[];
  try{
    configureIsolatedWorkerFactory(boot=>{const w=defaultIsolatedWorkerFactory(boot);created.push({fired:true});return w;});
    // (a) 无审批通道 → 执行点闸先拒,**绝不派发到隔离进程**(0 spawn)。
    const noChannel=new ModuleHost({authorize:async()=>{},persist:async()=>{}});
    noChannel.register({id:'core.test.iso1',kind:'action',input:ResourceSchema,output:ResultSchema,isolatedSource:'async () => ({ bytes: 1 })'});
    noChannel.addBuiltin({...EXAMPLE_MODULE,id:'core.iso1',permissions:['resource.read','resource.write'],contributions:[{...EXAMPLE_MODULE.contributions[0],capability:'core.test.iso1'}]});
    await denies(noChannel.invoke(call('core.iso1')),/审批通道/);
    assert.equal(created.length,0,'a refused action must never reach the isolated process');
    // (b) 有审批通道且放行 → 真派发一次隔离执行,结果带回宿主。
    const allowing=new ModuleHost({authorize:async()=>{},persist:async()=>{},requestApproval:async()=>{}});
    allowing.register({id:'core.test.iso2',kind:'action',input:ResourceSchema,output:ResultSchema,isolatedSource:'async (input) => ({ bytes: input.path.length })'});
    allowing.addBuiltin({...EXAMPLE_MODULE,id:'core.iso2',permissions:['resource.read','resource.write'],contributions:[{...EXAMPLE_MODULE.contributions[0],capability:'core.test.iso2'}]});
    const reply=await allowing.invoke(call('core.iso2'));
    assert.equal(reply.type,'result');if(reply.type==='result')assert.equal(reply.value.bytes,file.length);
    assert.equal(created.length,1,'an approved action dispatches exactly one isolated worker');
  } finally { configureIsolatedWorkerFactory(null); }
});
await test('ISO REGISTRATION: a capability is exactly one of run/isolatedSource, and isolation is action-only',async()=>{
  const h=new ModuleHost({authorize:async()=>{},persist:async()=>{}});
  // 两者都给 / 都不给 → 拒(执行体恰好一种)。
  assert.throws(()=>h.register({id:'core.test.both',kind:'action',input:ResourceSchema,output:ResultSchema,run:async()=>({bytes:1}),isolatedSource:'async () => ({ bytes: 1 })'}),/exactly one/);
  assert.throws(()=>h.register({id:'core.test.neither',kind:'action',input:ResourceSchema,output:ResultSchema}),/exactly one/);
  // query/task 不许走隔离(只有会改东西的 action 才挪出宿主线程)。
  assert.throws(()=>h.register({id:'core.test.iso-query',kind:'query',input:ResourceSchema,output:ResultSchema,isolatedSource:'async () => ({ bytes: 1 })'}),/action/);
  // 对照(证明不是空过):action + isolatedSource 注册**通过**。
  const ok=new ModuleHost({authorize:async()=>{},persist:async()=>{}});
  ok.register({id:'core.test.iso-ok',kind:'action',input:ResourceSchema,output:ResultSchema,isolatedSource:'async () => ({ bytes: 1 })'});
  assert.ok(ok.catalog().capabilities.some(c=>c.id==='core.test.iso-ok'));
});
await test('AUTH extra trusted source projectPath capabilityId and requestId cannot enter user parameters',async()=>{
  const params={moduleId:'core.file-report',contributionId:'inspect',path:file};
  for(const key of ['trusted','source','projectPath','capabilityId','requestId','script'])assert.equal(ModuleWorkflowCallSchema.safeParse({...params,[key]:'attacker'}).success,false,key);
  await denies(host.invokeForWorkflow({...call(),trusted:true} as ModuleInvoke),/Unrecognized key/);
});
await test('RESOURCE unknown registered root is rejected',async()=>{
  await denies(host.invokeForWorkflow({...call(),resource:{projectPath:outside,path:secret}}),/未知工作区/);
});
await test('RESOURCE absolute outside file is rejected',async()=>{
  await denies(host.invokeForWorkflow(call('core.file-report','inspect','absolute',secret)),/资源在工作区之外/);
});
await test('RESOURCE dot-dot path escaping root is rejected',async()=>{
  await denies(host.invokeForWorkflow(call('core.file-report','inspect','relative',join(root,'..','outside','secret.txt'))),/资源在工作区之外/);
});
await test('RESOURCE symlink or Windows junction escape is rejected',async()=>{
  const link=join(root,'escape');await symlink(outside,link,process.platform==='win32'?'junction':'dir');
  await denies(host.invokeForWorkflow(call('core.file-report','inspect','link',join(link,'secret.txt'))),/资源在工作区之外/);
});
await test('RESOURCE directory is not a regular file',async()=>{
  await denies(host.invokeForWorkflow(call('core.file-report','info','directory',root)),/需要一个普通文件/);
});
await test('RESOURCE oversize inspect fails but info still works',async()=>{
  const large=join(root,'large.bin');await writeFile(large,'');await truncate(large,32*1024*1024+1);
  const task=await terminal(host,await host.invokeForWorkflow(call('core.file-report','inspect','large',large)));
  assert.equal(task.status,'failed');assert.match(task.error??'',/32 MiB/);
  const info=await host.invokeForWorkflow(call('core.file-report','info','large-info',large));
  assert.equal(info.type,'result');if(info.type==='result')assert.equal(info.value.bytes,32*1024*1024+1);
});
await test('DATA catalog roundtrips and returned mutation cannot change host state',()=>{
  const before=host.catalog();ModuleCatalogSchema.parse(JSON.parse(JSON.stringify(before)));
  const changed=host.catalog();changed.modules[0].contributions[0].capability='core.fake';
  changed.capabilities[0].metadata!.permissions.length=0;changed.workflowTargets!.length=0;
  assert.deepEqual(host.catalog(),before);
});
await test('DATA schema rejects remote refs oversize depth and pollution',()=>{
  let deep:unknown={type:'string'};for(let i=0;i<20;i++)deep={type:'object',properties:{next:deep}};
  for(const invalid of [{$ref:'https://invalid.example/schema'},{$ref:'file:///secret'}, {description:'x'.repeat(32769)},deep,JSON.parse('{"properties":{"__proto__":{"type":"string"}}}'),{default:{constructor:'pollution'}},{execute:'code'}])assert.equal(JsonSchemaDocumentSchema.safeParse(invalid).success,false);
  assert.equal(({} as Record<string,unknown>).pollution,undefined);
});
await test('DATA schema rejects accessors without invoking them',()=>{
  let calls=0;const bad={};Object.defineProperty(bad,'description',{enumerable:true,get(){calls++;return 'x';}});
  assert.equal(JsonSchemaDocumentSchema.safeParse(bad).success,false);assert.equal(calls,0);
});
await test('DATA duplicate registration cannot replace file implementation',()=>{
  assert.throws(()=>host.register(fileCapabilities(p=>p===root)[0]),/Duplicate capability/);
});
await test('IDENTITY concurrent same attempt deduplicates and new attempt reexecutes',async()=>{
  const input=call('core.file-report','inspect','same-concurrent');
  const replies=await Promise.all([host.invokeForWorkflow(input),host.invokeForWorkflow(input)]);
  assert.equal(replies[0].type,'task');assert.equal(replies[1].type,'task');
  if(replies[0].type!=='task'||replies[1].type!=='task')throw Error('Expected tasks');
  assert.equal(replies[0].task.id,replies[1].task.id);
  const result=await terminal(host,replies[0]);assert.equal(result.status,'completed');
  assert.equal(result.result?.sha256,createHash('sha256').update(body).digest('hex'));
  const next=await host.invokeForWorkflow(call('core.file-report','inspect','next-attempt'));
  assert.equal(next.type,'task');if(next.type==='task')assert.notEqual(next.task.id,replies[0].task.id);
  await terminal(host,next);
  await denies(host.invokeForWorkflow({...input,resource:{projectPath:root,path:join(root,'large.bin')}}),/请求 ID 被复用于不同的输入/);
});
function controlled(run:(signal:AbortSignal)=>Promise<{bytes:number}>) {
  const h=new ModuleHost({authorize:async r=>{await resolveModuleResource(r,p=>p===root);},persist:async()=>{}});
  h.register({id:'core.test.task',kind:'task',input:ResourceSchema,output:ResultSchema,run:async(_r,c)=>run(c.signal)});
  h.addBuiltin({...EXAMPLE_MODULE,id:'core.controlled',contributions:[{...EXAMPLE_MODULE.contributions[0],capability:'core.test.task'}]});return h;
}
await test('LIFECYCLE cancellation is terminal despite late capability completion',async()=>{
  let finish!:(v:{bytes:number})=>void;const h=controlled(()=>new Promise(resolve=>{finish=resolve;}));
  const reply=await h.invokeForWorkflow(call('core.controlled'));
  assert.equal(reply.type,'task');if(reply.type!=='task')throw Error('Expected task');
  const ref={moduleId:'core.controlled',taskId:reply.task.id};h.cancel(ref);finish({bytes:999});await delay(10);
  assert.equal(h.task(ref).status,'cancelled');assert.equal(h.task(ref).result,undefined);
});
await test('LIFECYCLE real host 30s timeout aborts task and does not report success',async()=>{
  let aborted=false;const h=controlled(signal=>new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve({bytes:1});},{once:true})));
  const start=Date.now();const task=await terminal(h,await h.invokeForWorkflow(call('core.controlled')));
  assert.equal(task.status,'failed');assert.match(task.error??'',/模块能力任务超时/);assert.ok(Date.now()-start>=29000);assert.equal(aborted,true);
});
await test('LIFECYCLE evicted and restarted task handles fail explicitly',async()=>{
  const h=controlled(async()=>({bytes:1}));let first:ModuleTask|undefined;
  for(let i=0;i<65;i++){const t=await terminal(h,await h.invokeForWorkflow(call('core.controlled','inspect','evict-'+i)));first??=t;}
  assert.ok(first);const ref={moduleId:'core.controlled',taskId:first.id};
  assert.throws(()=>h.task(ref),/找不到该模块的这个任务/);
  const restarted=controlled(async()=>({bytes:2}));assert.throws(()=>restarted.task(ref),/找不到该模块的这个任务/);
});
}
await writeFile(join(base,'checks.json'),JSON.stringify(results,null,2));
console.log(`${results.filter(r=>r.status==='PASS').length} passed; ${results.filter(r=>r.status==='FAIL').length} failed`);
process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
