import React,{useState,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryAssistantButton} from '../../src/renderer/components/chat/MemoryAssistantButton.tsx';
import {MemoryExplorerPanel} from '../../src/renderer/components/memory/MemoryExplorerPanel.tsx';
import {NewSubChatPicker} from '../../src/renderer/components/chat/NewSubChatPicker.tsx';
import {ParamField} from '../../src/renderer/components/settings/workflows/ParamField.tsx';
function Lab(){
 const state=useSyncExternalStore(labSubscribe,()=>labState),q=new URLSearchParams(location.search);
 const [value,setValue]=useState(q.get('value')==='false'?false:q.get('value')??true);
 const view=q.get('view');
 return <main className="h-screen bg-surface p-8 text-content"><div className="mx-auto max-w-3xl">
  {view==='library'?<MemoryExplorerPanel/>:view==='mref'?<ParamField spec={{key:'skills',kind:'ref',from:'skills',multiple:true,label:'技能'}} value={['pdf','docx']} onChange={()=>{}}/>:view==='param'?<ParamField spec={{key:'memory',kind:'boolean',label:'注入记忆',help:'Old generic help'}} value={value} onChange={v=>{setValue(v);window.labValue=v;}}/>:view==='picker'?<NewSubChatPicker open anchorRect={new DOMRect(450,200,32,32)} onClose={()=>{}} onPick={choice=>labPicks.push({id:choice.profile?.id,memory:choice.memory})}/>:<MemoryAssistantButton sessionId={state.sessionId}/>}
 </div></main>;
}
const root=createRoot(document.getElementById('root'));window.labRemount=()=>root.render(<Lab/>);window.labRemount();window.__ready=true;
