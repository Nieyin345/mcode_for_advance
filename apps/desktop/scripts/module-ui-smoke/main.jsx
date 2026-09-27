import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ContextMenu} from '@base-ui/react/context-menu';
import {ModuleSurface,ModuleToolsButton,ModuleMenuItems} from '@renderer/components/modules/ModuleSurface.js';
window.pendingRpc=[];const waiting=new Map();let sequence=0;
window.resolveRpc=({id,data,error})=>{const p=waiting.get(id);waiting.delete(id);if(error)p.reject(Error(error));else p.resolve(data);};
window.testApi.modules=Object.fromEntries(['catalog','install','remove','invoke','task','tasks','cancel'].map(name=>[name,input=>new Promise((resolve,reject)=>{const id=++sequence;waiting.set(id,{resolve,reject});window.pendingRpc.push({id,name,input});})]));
function App(){const [shown,setShown]=useState(true);return <main className="min-h-screen bg-surface p-8 text-content"><button id="toggle" onClick={()=>setShown(v=>!v)}>Toggle fixture</button>{shown&&<ModuleSurface projectPath={window.fixtureRoot}><ModuleToolsButton/><ContextMenu.Root><ContextMenu.Trigger id="fixture-file" className="mt-6 block rounded border border-edge p-6">report.txt</ContextMenu.Trigger><ContextMenu.Portal><ContextMenu.Positioner><ContextMenu.Popup className="z-50 rounded bg-surface p-2 shadow-lg"><ModuleMenuItems path={window.fixturePath}/></ContextMenu.Popup></ContextMenu.Positioner></ContextMenu.Portal></ContextMenu.Root></ModuleSurface>}</main>}
createRoot(document.getElementById('root')).render(<App/>);window.__ready=true;
