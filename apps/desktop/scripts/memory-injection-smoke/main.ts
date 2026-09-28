import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { memoryRoot, saveMemoryFile } from '@main/memory/store.js';
import { searchMemory, scopedMemorySnapshot, SNAPSHOT_CAP } from '@main/memory/retrieval.js';
import { automaticMemoryForTurn } from '@main/memory/policy.js';
import { buildNodeInput, type ModelInputScope } from '@main/orchestration/nodeInputBuilders.js';
import { builtinManifestById } from '@main/orchestration/nodeTypes.js';
import { queueBackflow, replaceBackflowSource, pendingBackflowPrompt, clearBackflow } from '@main/lib/pendingBackflow.js';
const results: Array<{name: string; ok: boolean; error?: string}> = [];
async function test(name: string, check: () => unknown) { try { await check(); results.push({name,ok:true}); console.log('PASS '+name); } catch(e) { results.push({name,ok:false,error:String(e)}); console.log('FAIL '+name+' '+String(e)); } }
function reset() { rmSync(memoryRoot(), {recursive:true,force:true}); mkdirSync(memoryRoot(), {recursive:true}); }
function note(path:string,content:string,title='Reference',pinned=false) { return saveMemoryFile({path,content,title,pinned}); }
function build(instruction: string, extra: Partial<ModelInputScope> = {}, memory?: unknown) {
 const scope: ModelInputScope = {userPrompt:'Prepare the deliverable',upstream:'',upstreamArtifacts:[],upstreamOutputs:{},nodeId:'audit',
  plan:[[{id:'audit',title:'Audit',isLast:true}]],root:true,terminal:true,contextLines:()=>[],...extra};
 return buildNodeInput({instruction,memory:arguments.length<3?true:memory}, builtinManifestById('mcode.agent')!, scope, new AbortController().signal);
}
await test('automatic snapshot includes a relevant match deep inside a long record',()=>{
 reset(); note('projects/A/experiences/long.md','Neutral background. '.repeat(140)+' DEEP_ORBIT_MARKER is the verified evidence. '+'Trailing context. '.repeat(90));
 assert.match(searchMemory('DEEP_ORBIT_MARKER',{projectId:'A'})[0]!.body,/DEEP_ORBIT_MARKER/);
 assert.match(scopedMemorySnapshot('A','DEEP_ORBIT_MARKER'),/DEEP_ORBIT_MARKER/);
});
await test('project, global, foreign and unclassified boundaries are retained',()=>{
 reset(); note('projects/A/rules/a.md','PROJECT_A'); note('global/preferences/shared.md','GLOBAL_SHARED'); note('projects/B/rules/b.md','FOREIGN_B'); note('rules/old.md','UNCLASSIFIED');
 const text=scopedMemorySnapshot('A','PROJECT');assert.match(text,/PROJECT_A/);assert.match(text,/GLOBAL_SHARED/);assert.doesNotMatch(text,/FOREIGN_B|UNCLASSIFIED/);
});
await test('automatic snapshot stays bounded and discloses truncation',()=>{
 reset(); for(let i=0;i<25;i++) note(`projects/A/experiences/n${i}.md`,'evidence '.repeat(300),`Note ${i}`);
 const text=scopedMemorySnapshot('A','evidence');assert.ok(text.length<=SNAPSHOT_CAP);assert.match(text,/截断|预算限制/);assert.ok((text.match(/revision=/g)??[]).length<=12);
});
await test('each node passes its resolved instruction and current request to retrieval',()=>{
 let query:unknown;build('CHECK_REFERENCE_ACCURACY',{userPrompt:'USER_TASK_REVIEW',memorySnapshot:(q?:string)=>{query=q;return 'KNOWN_BACKGROUND';}});
 assert.equal(typeof query,'string');assert.match(query as string,/CHECK_REFERENCE_ACCURACY/);assert.match(query as string,/USER_TASK_REVIEW/);
});
await test('different node roles produce different memory selections',()=>{
 const lookup=(q?:string)=>q?.includes('AUDIT_REFERENCES')?'CITATION_FACT':q?.includes('WRITE_REPORT')?'WRITING_FACT':'WRONG_GENERIC_FACT';
 assert.match(build('AUDIT_REFERENCES',{memorySnapshot:lookup}).prompt,/CITATION_FACT/);
 assert.match(build('WRITE_REPORT',{memorySnapshot:lookup}).prompt,/WRITING_FACT/);
});
await test('disabled and missing node switches do not call retrieval',()=>{
 let calls=0; for(const value of [false,'off',undefined]) assert.doesNotMatch(build('TASK',{memorySnapshot:()=>{calls++;return 'DO_NOT_INJECT';}},value).prompt,/DO_NOT_INJECT/);
 assert.equal(calls,0);
});
await test('node preview metadata is the exact section appended to its prompt',()=>{
 const input=build('TASK',{memorySnapshot:()=> 'CAPTURED_ORIGINAL'});
 const meta=(input as unknown as {memoryInjection?:{text:string;state:string}}).memoryInjection;
 assert.equal(meta?.state,'included'); assert.ok(meta?.text);assert.ok(input.prompt.endsWith(meta!.text));
});
await test('empty selection is distinct from read failure in diagnostic metadata',()=>{
 const empty=build('TASK',{memorySnapshot:()=>''}) as unknown as {memoryInjection?:{state:string}};
 const failed=build('TASK',{memorySnapshot:()=>{throw Error('fixture unavailable');}}) as unknown as {memoryInjection?:{state:string}};
 assert.equal(empty.memoryInjection?.state,'empty');assert.equal(failed.memoryInjection?.state,'error');
});
await test('host callback uses node query without giving the caller project authority',()=>{
 const path=join(process.cwd(),'src/main/orchestration/runner.ts'),source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const matches:ts.PropertyAssignment[]=[];const visit=(node:ts.Node)=>{if(ts.isPropertyAssignment(node)&&node.name.getText(source)==='memorySnapshot')matches.push(node);ts.forEachChild(node,visit);};visit(source);
 assert.equal(matches.length,1);
 const calls:string[][]=[];const js=ts.transpileModule('('+matches[0]!.initializer.getText(source)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const callback=runInNewContext(js,{session:{projectId:'TRUSTED_PROJECT'},prompt:'GENERIC_TASK',scopedMemorySnapshot:(id:string,q:string)=>{calls.push([id,q]);return 'MEMORY';}}) as (query?:string)=>string;
 callback('SPECIFIC_NODE_TASK');assert.deepEqual(calls,[['TRUSTED_PROJECT','SPECIFIC_NODE_TASK']]);
});
await test('ordinary chat, workflow and side-chat defaults are unchanged',()=>{
 assert.equal(automaticMemoryForTurn('chat'),true);assert.equal(automaticMemoryForTurn('chat',true),false);
 for(const kind of ['side','node','automation'] as const) assert.equal(automaticMemoryForTurn(kind),false);
});
await test('creation snapshot retains its own framing and independent backflow',()=>{
 queueBackflow('fixture','WORKFLOW_RESULT');replaceBackflowSource('fixture','memory.creation-snapshot','CREATION_MEMORY');
 const text=pendingBackflowPrompt('fixture');assert.match(text,/创建时的记忆快照/);assert.match(text,/CREATION_MEMORY/);assert.match(text,/WORKFLOW_RESULT/);
 replaceBackflowSource('fixture','memory.creation-snapshot','');assert.doesNotMatch(pendingBackflowPrompt('fixture'),/CREATION_MEMORY/);assert.match(pendingBackflowPrompt('fixture'),/WORKFLOW_RESULT/);clearBackflow('fixture');
});
// Extension tests for the new in-memory diagnostic store are appended after the
// initial red run. Above cases load the existing production implementation.
const failed=results.filter(r=>!r.ok).length;
writeFileSync(join(process.env.MEMORY_INJECTION_ARTIFACTS!,'results.json'),JSON.stringify({passed:results.length-failed,failed,checks:results},null,2));
console.log(`${results.length-failed}/${results.length} memory-injection checks passed; ${failed} failed`);
if(failed)process.exitCode=1;
