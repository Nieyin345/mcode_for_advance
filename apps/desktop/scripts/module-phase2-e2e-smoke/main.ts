/** P2-06 integration probes. Local registration is explicitly a segment test,
 * never evidence that runner/scheduler/UI production wiring is complete. */
import assert from 'node:assert/strict';
import {z} from 'zod';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ExecutionEngine, executionEngine } from '../../src/main/orchestration/executionEngine.js';
import { ModuleCapabilityExecutor, type WorkflowModuleHostPort } from '../../src/main/orchestration/moduleCapabilityExecutor.js';
import { ModuleHost } from '../../src/main/modules/ModuleHost.js';
import { getModuleHost } from '../../src/main/modules/service.js';
import { resolveModuleResource } from '../../src/main/modules/fileCapabilities.js';
import { EXAMPLE_MODULE, ResourceSchema, ResultSchema } from '@contracts/modules';
import { ModuleWorkflowExecutionInputSchema } from '@contracts/moduleCapability';
import type { ExecutionContext } from '../../src/main/orchestration/executionContext.js';
const dir=process.env.P2_TEST_DIR;assert.ok(dir);
const root=join(dir,'workspace');await mkdir(root,{recursive:true});
const body='P2 independent integration fixture';await writeFile(join(root,'sample.txt'),body);
const host=await getModuleHost();
const results:Array<{name:string;status:string;error?:string}>=[];
async function test(name:string,fn:()=>unknown){try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:String(e)});console.error('FAIL '+name+' '+String(e));}}
function context(requestId:string,contributionId='inspect',signal=new AbortController().signal):ExecutionContext{
 return {node:{id:'n1',type:'mcode.module-capability',title:'Fixture',params:{},position:{x:0,y:0}},
 manifest:{id:'mcode.module-capability',manifestVersion:1,name:'Fixture (not production catalog)',runner:{kind:'module-capability'},capability:'read',params:[]},
 input:{prompt:'',data:{userInput:'',upstreamText:'',upstreamOutputs:{},upstreamArtifacts:[]},skills:[],mcpServerNames:[],pluginNames:[],returnMode:'result',signal,
 moduleCall:ModuleWorkflowExecutionInputSchema.parse({moduleId:'core.file-report',contributionId,path:'sample.txt',requestId})},
 cwd:root,metadata:{sessionId:'s1',runId:'r1',nodeId:'n1'}};
}
const executor=new ModuleCapabilityExecutor({host,pollIntervalMs:2,maxPollIntervalMs:5});
const segment=new ExecutionEngine().register(executor);
await test('SEGMENT real registry executor service host file query returns bytes',async()=>{
 const result=await segment.execute(context('query','info'));
 assert.equal(result.status,'success');assert.equal(result.outputs?.bytes,Buffer.byteLength(body));assert.equal(typeof result.outputs?.modifiedAt,'number');assert.equal(result.execution?.executorKind,'module-capability');
});
await test('SEGMENT real registry task computes SHA256 and uses the menu host',async()=>{
 const result=await segment.execute(context('task'));assert.equal(result.status,'success');
 assert.equal(result.outputs?.sha256,createHash('sha256').update(body).digest('hex'));
 assert.equal(host.tasks({projectPath:root}).length,1);
 const again=await segment.execute(context('task'));assert.deepEqual(again.outputs,result.outputs);assert.equal(host.tasks({projectPath:root}).length,1);
 await segment.execute(context('new-dispatch'));assert.equal(host.tasks({projectPath:root}).length,2);
});
await test('SEGMENT user module and relative path traversal fail at real host',async()=>{
 await host.install(EXAMPLE_MODULE);
 const user=context('user');user.input.moduleCall!.moduleId=EXAMPLE_MODULE.id;
 const denied=await segment.execute(user);assert.equal(denied.status,'failed');assert.match(denied.error??'',/工作流需要一个已注册的内置只读贡献/);
 await writeFile(join(dir,'outside.txt'),'fixture only');const outside=context('outside');outside.input.moduleCall!.path='../outside.txt';
 const rejected=await segment.execute(outside);assert.equal(rejected.status,'failed');assert.match(rejected.error??'',/资源在工作区之外/);
});
function controlled(){
 const resolvers:Array<()=>void>=[];
 const h=new ModuleHost({authorize:async r=>{await resolveModuleResource(r,p=>p===root);},persist:async()=>{}});
 h.register({id:'core.test.task',kind:'task',input:ResourceSchema,output:ResultSchema,run:async()=>new Promise(resolve=>resolvers.push(()=>resolve({bytes:1})))});
 h.addBuiltin({...EXAMPLE_MODULE,id:'core.file-report',contributions:[{...EXAMPLE_MODULE.contributions[0],capability:'core.test.task'}]});
 return {h,finish:()=>resolvers.forEach(r=>r())};
}
await test('LIFECYCLE pre-cancel performs zero host calls',async()=>{
 const ac=new AbortController();ac.abort();let invokes=0;
 const port:WorkflowModuleHostPort={invokeForWorkflow:i=>{invokes++;return host.invokeForWorkflow(i);},task:r=>host.task(r),cancel:r=>host.cancel(r)};
 const ex=new ModuleCapabilityExecutor({host:port});const result=await ex.execute(context('precancel','inspect',ac.signal));
 assert.equal(result.status,'cancelled');assert.equal(invokes,0);assert.equal(result.outputs,undefined);
});
await test('LIFECYCLE late real task handle is cancelled and unrelated task stays running',async()=>{
 const {h,finish}=controlled();const ac=new AbortController();
 const unrelated=await h.invokeForWorkflow({moduleId:'core.file-report',contributionId:'inspect',requestId:'unrelated',resource:{projectPath:root,path:join(root,'sample.txt')}});
 assert.equal(unrelated.type,'task');
 const port:WorkflowModuleHostPort={invokeForWorkflow:async i=>{const result=await h.invokeForWorkflow(i);ac.abort();return result;},task:r=>h.task(r),cancel:r=>h.cancel(r)};
 try{
 const result=await new ModuleCapabilityExecutor({host:port}).execute(context('late','inspect',ac.signal));
 assert.equal(result.status,'cancelled');assert.equal(result.outputs,undefined);
 const tasks=h.tasks({projectPath:root});assert.equal(tasks.filter(t=>t.status==='cancelled').length,1);
 if(unrelated.type==='task')assert.equal(h.task({moduleId:'core.file-report',taskId:unrelated.task.id}).status,'running');
 }finally{finish();for(const task of h.tasks({projectPath:root}))if(task.status==='running')h.cancel({moduleId:task.moduleId,taskId:task.id});}
});
await test('LIFECYCLE abort while polling cancels its real host task',async()=>{
 const {h,finish}=controlled();const ac=new AbortController();const ctx=context('poll-cancel','inspect',ac.signal);ctx.emitProgress=()=>ac.abort();
 try{const result=await new ModuleCapabilityExecutor({host:h,pollIntervalMs:2}).execute(ctx);assert.equal(result.status,'cancelled');assert.equal(h.tasks({projectPath:root})[0].status,'cancelled');}finally{finish();}
});
await test('LIFECYCLE restarted host loses task explicitly without repeating invoke',async()=>{
 const {h,finish}=controlled();const restarted=new ModuleHost({authorize:async()=>{},persist:async()=>{}});let invokes=0;
 const port:WorkflowModuleHostPort={invokeForWorkflow:i=>{invokes++;return h.invokeForWorkflow(i);},task:r=>restarted.task(r),cancel:r=>h.cancel(r)};
 try{const result=await new ModuleCapabilityExecutor({host:port,pollIntervalMs:1}).execute(context('lost'));assert.equal(result.status,'failed');assert.match(result.error??'',/不可用/);assert.equal(invokes,1);}finally{finish();for(const t of h.tasks({projectPath:root}))h.cancel({moduleId:t.moduleId,taskId:t.id});}
});
await test('SECURITY missing capability executor must never reach model fallback',async()=>{
 let fallbackCalls=0;const engine=new ExecutionEngine().setDefault({execute:async()=>{fallbackCalls++;return {status:'success',summary:'FORBIDDEN fake model fallback'};}});
 const result=await engine.execute(context('missing-executor'));assert.equal(fallbackCalls,0,'module-capability reached model fallback');assert.equal(result.status,'failed');
});
await test('PRODUCTION exported engine must register module-capability',()=>{
 assert.equal(executionEngine.has('module-capability'),true,'task 05 production engine registration is missing');
});
// A segment cannot grant full acceptance. Fresh native + production scheduler +
// browser negative-state evidence must exist and pass in this same build run.
let receiptText: string | undefined;
try { receiptText = await readFile(join(dir,'integration-receipt.json'),'utf8'); } catch {}
if(receiptText===undefined){
 results.push({name:'FULL production/UI completion receipt',status:'BLOCKED',error:'Run build.mjs; isolated segment execution does not prove native persistence/UI integration.'});
}else{
 await test('FULL native persistence/UI plus real scheduler and browser negative states completed',async()=>{
  const receipt=z.object({schemaVersion:z.literal(1),stages:z.array(z.object({name:z.string(),exitCode:z.number().nullable(),evidence:z.string().optional(),proof:z.unknown()}))}).parse(JSON.parse(receiptText!));
  assert.equal(receipt.stages.length,4);
  const stage=(name:string)=>{const value=receipt.stages.find(s=>s.name===name);assert.ok(value);assert.equal(value.exitCode,0,name);assert.ok(value.evidence);return value;};
  const native=stage('native-window');
  const nativeProof=z.object({exitCode:z.literal(0),mutation:z.literal(false),phases:z.array(z.object({phase:z.string(),exitCode:z.literal(0),complete:z.literal(true),checks:z.number().int().positive()})).length(2)}).parse(native.proof);
  assert.deepEqual(nativeProof.phases.map(p=>p.phase),['create','reopen']);
  for(const phase of nativeProof.phases){
   const checks=z.array(z.object({name:z.string(),status:z.literal('PASS')})).parse(JSON.parse(await readFile(join(native.evidence!,phase.phase+'-checks.json'),'utf8')));
   assert.ok(checks.length>=(phase.phase==='create'?12:7));
   assert.equal(checks.at(-1)?.name,'no real provider/model call, page exception or remote page request occurred');
  }
  const workflow=stage('production-workflow');
  z.object({nativeGateOpen:z.literal(true),exitCode:z.literal(0),records:z.array(z.object({phase:z.literal('native-open'),exitCode:z.literal(0)})).length(1)}).parse(workflow.proof);
  const checks=z.object({passed:z.number().int().min(25),failed:z.literal(0),results:z.array(z.object({name:z.string(),ok:z.literal(true)}))}).parse(JSON.parse(await readFile(join(workflow.evidence!,'native-open/native-open-checks.json'),'utf8')));
  for(const wanted of ['loop iterations get fresh identities','explicit retry after failure','missing executor fails closed','both actual registration paths'])assert.ok(checks.results.some(c=>c.name.includes(wanted)),`Missing actual scheduler assertion: ${wanted}`);
  const save=stage('shared-save-guard');
  z.object({exitCode:z.literal(0),saveGuard:z.literal(true)}).parse(save.proof);
  const browser=stage('catalog-browser');
  z.object({passed:z.number().int().min(15)}).parse(browser.proof);
 });
}
await writeFile(join(dir,'checks.json'),JSON.stringify(results,null,2));
console.log(`${results.filter(r=>r.status==='PASS').length} passed; ${results.filter(r=>r.status==='FAIL').length} failed; ${results.filter(r=>r.status==='BLOCKED').length} blocked`);
process.exitCode=results.some(r=>r.status==='FAIL')?1:results.some(r=>r.status==='BLOCKED')?2:0;
