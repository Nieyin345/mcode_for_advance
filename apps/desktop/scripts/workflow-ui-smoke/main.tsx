// Actual settings/components; all IPC is replaced by owned in-memory fixtures.
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsPage } from '@renderer/components/settings/SettingsPage.js';
import { useSessionStore } from '@renderer/stores/sessionStore.js';
import { defaultParamsOf, type NodeTypeCatalog } from '@contracts/nodeType';
import type { WorkflowDoc, WorkflowNode } from '@contracts/workflow';
import { newWorkflowDoc, newAutomationDoc, relayout } from '@renderer/components/settings/workflows/workflowEdit.js';
import catalogJson from './catalog.generated.js';
import { deriveTrigger } from './derive-trigger.generated.js';
const catalog = catalogJson as unknown as NodeTypeCatalog;
const query = new URLSearchParams(location.search);
const scenario = query.get('case') ?? 'workflow';
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
function node(id: string, type: string, title: string, params: Record<string,unknown> = {}): WorkflowNode {
  const manifest = catalog.entries.find(e => e.id===type)?.manifest;
  if (!manifest) throw new Error('No manifest '+type);
  return {id,type,title,position:{x:0,y:0},params:{...defaultParamsOf(manifest),...params}};
}
const workflow: WorkflowDoc = relayout({
  ...newWorkflowDoc('audit-workflow','资料整理流程'),
  description:'隔离审查用的普通工作流，不执行模型或命令。',
  frameworkNote:'已保存的框架说明',
  nodes:[
    node('main','mcode.main','整理需求',{instruction:'拆分任务并交给下游。'}),
    node('agent','mcode.agent','提取信息',{instruction:'只整理上游给出的文本。'}),
    node('condition','mcode.condition','内容是否齐全',{expression:{logic:'and',rules:[{ref:'{{agent.output}}',op:'exists'}]}}),
    node('command','mcode.command','生成清单',{command:'echo audit-only',timeoutMs:1000}),
    node('code','mcode.code','汇总结果',{language:'node',code:'process.stdout.write("audit-only");',input:'{}',timeoutMs:1000}),
    node('branch','mcode.branch','人工确认',{decider:'user'}),
    node('conversation','mcode.conversation','交付说明',{instruction:'总结本流程的结果。'}),
  ],
  edges:[
    {id:'e1',from:'main',to:'agent'},{id:'e2',from:'agent',to:'condition'},
    {id:'e3',from:'condition',to:'command',label:'true'},{id:'e4',from:'condition',to:'code',label:'false'},
    {id:'e5',from:'command',to:'branch'},{id:'e6',from:'code',to:'branch'},
    {id:'e7',from:'branch',to:'conversation',label:'交付'},{id:'e8',from:'branch',to:'agent',label:'再检查'},
  ],
});
const automation: WorkflowDoc = relayout({
  ...newAutomationDoc('audit-automation','文件清单自动化'),
  description:'两个独立触发入口；此预览不会运行任何任务。',
  frameworkNote:'已保存的自动化说明',
  nodes:[
    node('trigger-a','mcode.trigger','入口 A',{triggerKind:'manual',project:'audit-project',task:'已保存的请求 A',enabled:true,cron:'0 9 * * *',paths:'**/*.md',events:'turn.done',debounceMs:2000}),
    node('trigger-b','mcode.trigger','入口 B',{triggerKind:'manual',project:'audit-project',task:'已保存的请求 B',enabled:true}),
    node('auto-command','mcode.command','生成审查清单',{command:'echo audit-only',timeoutMs:1000}),
    node('auto-agent','mcode.agent','解释清单',{instruction:'解释上游信息，不调用外部工具。'}),
  ],
  edges:[{id:'ae1',from:'trigger-a',to:'auto-command'},{id:'ae2',from:'trigger-b',to:'auto-command'},{id:'ae3',from:'auto-command',to:'auto-agent'}],
});
const docs: Record<string,WorkflowDoc> = {
  [workflow.id]: clone(workflow),
  'audit-workflow-b': {...clone(workflow),id:'audit-workflow-b',name:'第二条普通工作流'},
  [automation.id]: clone(automation),
};
const workflowListeners = new Set<() => void>();
type RunStatus = 'running'|'success'|'failed';
let status: RunStatus = 'running';
let hasRun = false;
const runCalls: Array<{workflowId:string;triggerNodeId:string;savedTask:unknown}> = [];
const saves: WorkflowDoc[] = [];
const apiImpl: Record<string,Record<string,(...args: never[]) => unknown>> = {};
// The preview kit looks methods up on this object at call time. No real bridge exists.
const impl = {
  workflow:{
    nodeTypes:async()=>clone(catalog),
    agentProfiles:async()=>{
      if(scenario==='profiles-error') throw new Error('审查注入：档案读取失败');
      return {profiles:[],problems:[]};
    },
    list:async()=>({workflows:Object.values(docs).map(d=>clone({...d,edited:false,nodeCount:d.nodes.length}))}),
    get:async({id}:{id:string})=>({workflow:clone(docs[id] ?? null),review:{pending:false,revision:'fixture-revision'}}),
    save:async({workflow:d}:{workflow:WorkflowDoc})=>{
      saves.push(clone(d));
      // Real backend canonicalization (AST-extracted); persistence is in memory only.
      const derived=deriveTrigger(d,new Map(catalog.entries.map(e=>[e.id,e.manifest])));
      if(!derived.ok)return derived;
      docs[d.id]=clone({...derived.doc,updatedAt:Date.now()});
      for(const fn of workflowListeners) fn();
      return {ok:true};
    },
    validate:async()=>({ok:true,errors:[],warnings:[]}),
  },
  automation:{
    runs:async()=>{
      if(scenario==='automation-error') throw new Error('审查注入：运行历史读取失败');
      return {runs:hasRun ? [{runId:'audit-run',startedAt:Date.now()-5000,updatedAt:Date.now(),status,steps:[]}]:[]};
    },
    statusAll:async()=>{
      if(scenario==='automation-error') throw new Error('审查注入：触发状态读取失败');
      return docs['audit-automation'].nodes.filter(n=>n.type==='mcode.trigger').map(n=>({
        key:`audit-automation:${n.id}`,workflowId:'audit-automation',nodeId:n.id,title:n.title,
        kind:n.params.triggerKind,enabled:n.params.enabled!==false,armed:n.params.enabled!==false,
      }));
    },
    run:async({workflowId,triggerNodeId}:{workflowId:string;triggerNodeId:string})=>{
      const t=docs[workflowId]?.nodes.find(n=>n.id===triggerNodeId);
      runCalls.push({workflowId,triggerNodeId,savedTask:t?.params.task});
      hasRun=true;status='running';return {ok:true};
    },
    sessions:async()=>({sessionId:null,sessionIds:[]}),
  },
  runs:{history:async()=>[]},
  project:{list:async()=>({projects:[{id:'audit-project',name:'审查样例项目',path:'C:/audit-fixture'}]})},
  settings:{get:async()=>({settings:{}})},
  mcp:{list:async()=>({servers:[]})},
  plugins:{list:async()=>({plugins:[]})},
  library:{collections:async()=>({collections:[]}),listCollections:async()=>({collections:[]})},
};
Object.assign(apiImpl,impl);
interface AuditWindow {
  __apiImpl: typeof apiImpl;
  __apiCalls?: string[];
  api: {platform:string;on:{workflowsChanged:(fn:()=>void)=>()=>void}};
  __audit:{docs:typeof docs;saves:typeof saves;runCalls:typeof runCalls;completeRun:()=>void;emitWorkflowChange:()=>void};
  __ready:boolean;
}
const w=window as unknown as AuditWindow;
w.__apiImpl=apiImpl;
w.api={platform:'win32',on:{workflowsChanged:(fn)=>{workflowListeners.add(fn);return()=>{workflowListeners.delete(fn);};}}};
w.__audit={docs,saves,runCalls,completeRun:()=>{status='success';},emitWorkflowChange:()=>{for(const fn of workflowListeners)fn();}};
useSessionStore.setState({
  settingsSection: scenario.startsWith('automation') ? 'automation' : 'workflows',
  locale:query.get('locale')==='en'?'en':'zh',
  providers:[],
  projects:[{id:'audit-project',name:'审查样例项目',path:'C:/audit-fixture',archived:false,sortOrder:0,pinnedAt:null,createdAt:0,updatedAt:0}],
});
createRoot(document.getElementById('root')!).render(<div style={{display:'flex',height:'100%',width:'100%'}}><SettingsPage /></div>);
w.__ready=true;
