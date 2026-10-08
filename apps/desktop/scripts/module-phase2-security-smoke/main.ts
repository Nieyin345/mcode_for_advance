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
await test('AUTH actions cannot become builtin workflow contributions',()=>{
  const h=new ModuleHost({authorize:async()=>{},persist:async()=>{}});
  h.register({id:'core.test.action',kind:'action',input:ResourceSchema,output:ResultSchema,run:async()=>({bytes:1})});
  assert.throws(()=>h.addBuiltin({...EXAMPLE_MODULE,id:'core.action',contributions:[{...EXAMPLE_MODULE.contributions[0],capability:'core.test.action'}]}),/Actions/);
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
