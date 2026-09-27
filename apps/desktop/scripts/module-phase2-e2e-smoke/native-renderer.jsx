// Real feature components + real preload. No renderer API replacement.
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ContextMenu} from '@base-ui/react/context-menu';
import {api} from '@renderer/lib/api.js';
import {useSessionStore} from '@renderer/stores/sessionStore.js';
import {WorkflowsPanel} from '@renderer/components/settings/workflows/WorkflowsPanel.js';
import {WorkflowStepCard} from '@renderer/components/chat/WorkflowStepCard.js';
import {ModuleSurface,ModuleToolsButton,ModuleMenuItems,ModuleResultDialog} from '@renderer/components/modules/ModuleSurface.js';
window.p2Errors=[];
window.addEventListener('error',e=>window.p2Errors.push(String(e.error??e.message)));
window.addEventListener('unhandledrejection',e=>window.p2Errors.push(String(e.reason)));
const {projects}=await api.project.list();
useSessionStore.setState({projects,activeProjectId:projects[0]?.id??null,locale:'zh'});
function FeatureWindow(){
 const [view,setView]=useState('automation'),[events,setEvents]=useState([]),[reply,setReply]=useState(null);
 window.p2={setView,setReply,events,setLocale:locale=>useSessionStore.setState({locale})};
 useEffect(()=>api.on.claudeEvent(message=>setEvents(all=>[...all,message.event])),[]);
 return <main className="min-h-screen bg-surface text-content">
   <nav className="flex gap-4 border-b border-edge p-2"><button onClick={()=>setView('automation')}>Automation fixture</button><button onClick={()=>setView('modules')}>Module file menu</button><button onClick={()=>setView('results')}>Real workflow results</button></nav>
   {view==='automation'&&<div style={{height:'calc(100vh - 60px)'}}><WorkflowsPanel purpose="automation"/></div>}
   {view==='modules'&&<div className="p-8"><ModuleSurface projectPath={projects[0].path}>
    <ModuleToolsButton/>
    <ContextMenu.Root><ContextMenu.Trigger data-testid="native-file" className="m-6 block rounded border border-edge p-6">manual.txt</ContextMenu.Trigger>
     <ContextMenu.Portal><ContextMenu.Positioner><ContextMenu.Popup className="rounded border border-edge bg-surface p-2"><ModuleMenuItems path={projects[0].path+'/manual.txt'}/></ContextMenu.Popup></ContextMenu.Positioner></ContextMenu.Portal>
    </ContextMenu.Root>
   </ModuleSurface></div>}
   {view==='results'&&<section data-testid="native-results" className="space-y-4 p-8">{events.filter(e=>e.type==='workflow.node.result').map((e,i)=><WorkflowStepCard key={i} block={{...e,kind:'workflow-step',nodeTranscript:e.transcript}}/>)}</section>}
   {reply&&<ModuleResultDialog reply={reply} onClose={()=>setReply(null)}/>}
 </main>;
}
createRoot(document.getElementById('root')).render(<FeatureWindow/>);
window.p2Ready=true;
