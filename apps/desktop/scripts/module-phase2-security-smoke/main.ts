/** Independent P2-06 checks. All files and persisted manifests are isolated fixtures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, symlink, truncate, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXAMPLE_MODULE, ModuleManifestSchema, ResourceSchema, ResultSchema, type ModuleInvoke, type ModuleReply, type ModuleTask } from '@contracts/modules';
import { JsonSchemaDocumentSchema, ModuleCatalogSchema, ModuleWorkflowCallSchema } from '@contracts/moduleCapability';
import { ModuleHost } from '../../src/main/modules/ModuleHost.js';
import { fileCapabilities, resolveModuleResource } from '../../src/main/modules/fileCapabilities.js';
import { getModuleHost } from '../../src/main/modules/service.js';

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
const denyWorkflow = /工作流需要一个已注册的内置只读贡献/;

await test('AUTH user module works from menu but not workflow',async()=>{
  await host.install(EXAMPLE_MODULE);
  const menu=await terminal(host,await host.invoke(call(EXAMPLE_MODULE.id,'inspect','menu-user')));
  assert.equal(menu.status,'completed');assert.equal(menu.result?.bytes,Buffer.byteLength(body));
  await denies(host.invokeForWorkflow(call(EXAMPLE_MODULE.id,'inspect','workflow-user')),denyWorkflow);
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
  await denies(restarted.invokeForWorkflow(call(EXAMPLE_MODULE.id,'inspect','restore-wf')),denyWorkflow);
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
