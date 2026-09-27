import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ChatPane} from '@renderer/components/chat/ChatPane.js';
import {FileMentionPicker} from '@renderer/components/chat/FileMentionPicker.js';
import {SlashCommandPicker} from '@renderer/components/chat/SlashCommandPicker.js';
import {LibraryPicker} from '@renderer/components/chat/LibraryPicker.js';
import {useSessionStore} from '@renderer/stores/sessionStore.js';

window.labPicks=[];
window.labStore=useSessionStore;
const rect={top:400,left:40,width:400,height:30,right:440,bottom:430,x:40,y:400,toJSON(){}};
function Pickers(){
  const [mode,setMode]=useState('none');
  window.__setPicker=setMode;
  const pick=(kind)=>(v)=>labPicks.push({kind,v:JSON.parse(JSON.stringify(v))});
  const close=()=>{labPicks.push({kind:'close:'+mode});setMode('none');};
  return <div data-picker-mode={mode}>
    {mode==='file'&&<FileMentionPicker open projectPath="/proj" query="" anchorRect={rect} mode="mention" onPick={pick('file')} onClose={close}/>}
    {mode==='slash'&&<SlashCommandPicker open query="" skills={[]} engineName="Claude" engineUnsupported={false} anchorRect={rect} busy={false} onPickSkill={pick('skill')} onPickCommand={pick('command')} onPickEngineCommand={pick('engine')} onClose={close}/>}
    {mode==='library'&&<LibraryPicker open anchorRect={rect} onPick={pick('library')} onClose={close}/>}
  </div>;
}
// Side-chat layout: this pane shows session "side" while the app's
// activeSessionId is its parent "main" (SideChatPanel renders exactly this).
useSessionStore.setState({locale:'zh',activeSessionId:'main',pendingQuestionBySession:{}});
createRoot(document.getElementById('pickers')).render(<Pickers/>);
createRoot(document.getElementById('root')).render(<ChatPane sessionId="side" isActive chipsMode="collapsed"/>);
window.__ready=true;
