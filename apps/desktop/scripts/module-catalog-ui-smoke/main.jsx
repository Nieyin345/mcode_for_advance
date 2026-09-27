import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useSessionStore} from '@renderer/stores/sessionStore.js';
import {NodeTypeManifestSchema} from '@contracts/nodeType';
import {ModuleSurface,ModuleToolsButton} from '@renderer/components/modules/ModuleSurface.js';
import {NodeInspector} from '@renderer/components/settings/workflows/NodeInspector.js';
import {WorkflowNodeCard} from '@renderer/components/settings/workflows/WorkflowNodeCard.js';
const q=new URLSearchParams(location.search);
useSessionStore.setState({locale:q.get('locale')==='en'?'en':'zh'});
window.pendingRpc=[];const waiting=new Map();let sequence=0;
window.resolveRpc=({id,data,error})=>{const p=waiting.get(id);waiting.delete(id);if(error)p.reject(Error(error));else p.resolve(data);};
window.testApi.modules=Object.fromEntries(['catalog','install','remove','invoke','task','tasks','cancel'].map(name=>[name,input=>new Promise((resolve,reject)=>{const id=++sequence;waiting.set(id,{resolve,reject});window.pendingRpc.push({id,name,input});})]));

// TEST FIXTURE ONLY: the production `mcode.module-capability` node type is
// registered by task 05. This manifest follows interface-v2 §4 (three params)
// and is validated by the real NodeTypeManifestSchema.
const manifest=NodeTypeManifestSchema.parse({id:'mcode.module-capability',manifestVersion:1,name:'Module capability (fixture)',runner:{kind:'module-capability'},capability:'read',params:[{key:'moduleId',kind:'text',label:'moduleId',required:true},{key:'contributionId',kind:'text',label:'contributionId',required:true},{key:'path',kind:'text',label:'path',required:true}]});
const catalog={entries:[{id:manifest.id,source:'builtin',from:'mcode',manifest}],problems:[]};
const initialParams={
  blank:{},
  stale:{moduleId:'core.removed',contributionId:'gone',path:'a.txt'},
  forbidden:{moduleId:'core.file-report',contributionId:'inspect',path:'a.txt',projectPath:'C:/elsewhere',requestId:'forged',trusted:true},
}[q.get('doc')??'blank'];
const initialDoc={id:'wf-module',name:'module call',prompt:'',nodes:[{id:'call',type:manifest.id,title:'读取文件信息',position:{x:0,y:0},params:initialParams}],edges:[],builtin:false,updatedAt:0};
function Inspector(){
  const [doc,setDoc]=useState(initialDoc),[selected,setSelected]=useState('call');
  window.currentDoc=doc;window.setSelected=setSelected;window.loadDoc=setDoc;
  return <div className="flex gap-6"><div style={{position:'relative',width:240,height:80}} data-testid="card-host"><WorkflowNodeCard node={doc.nodes[0]} entry={catalog.entries[0]} selected={false} left={0} top={0} connecting={false} connectHint={null} onMouseDown={()=>{}} onStartConnect={()=>{}}/></div>
    <NodeInspector doc={doc} catalog={catalog} profiles={[]} profileError={null} selectedNodeId={selected} purpose="workflow"
      onUpdateNode={(id,patch)=>setDoc(d=>({...d,nodes:d.nodes.map(n=>n.id===id?{...n,...patch}:n)}))}
      onUpdateWorkflow={()=>{}} onRemoveNode={()=>{}} onSetDependency={()=>{}} onUpdateEdge={()=>{}} onSaveProfile={async()=>false} onRemoveProfile={async()=>{}} onRemoveWorkflow={()=>{}} onImported={()=>{}}/></div>;
}
const page=q.get('page')==='inspector'?<Inspector/>:<ModuleSurface projectPath={window.fixtureRoot}><ModuleToolsButton/></ModuleSurface>;
createRoot(document.getElementById('root')).render(<main className="min-h-screen bg-surface p-8 text-content">{page}</main>);window.__ready=true;
