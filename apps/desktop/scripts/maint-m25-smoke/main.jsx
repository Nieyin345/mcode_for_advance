import React from 'react';
import {createRoot} from 'react-dom/client';
import {GeneralPanel} from '@renderer/components/settings/GeneralPanel.js';
import {RuntimesPanel} from '@renderer/components/settings/RuntimesPanel.js';
import {DataRootPanel} from '@renderer/components/settings/DataRootPanel.js';
import {useSessionStore} from '@renderer/stores/sessionStore.js';

window.labStore=useSessionStore;
// One installed runtime (claude) + two absent ones (codex/pi): covers both
// action sets (卸载/重装 vs 安装). reloadRuntimes is an isElectron no-op in
// this harness, so the seeded rows stay authoritative.
const rt=(agent,installed)=>({
  agent,
  expectedVersion:'1.2.3',
  installedVersion:installed?'1.2.3':null,
  source:installed?'managed':null,
  activeVersion:installed?'1.2.3':null,
  activePath:installed?('D:/runtimes/'+agent):null,
  latestVersion:null,
  installed,
  updateAvailable:false,
  installing:false,
  lastError:'',
  diskBytes:installed?123456789:0,
  installPath:installed?('D:/runtimes/'+agent):null,
});
useSessionStore.setState({locale:'zh',runtimes:[rt('claude',true),rt('codex',false),rt('pi',false)]});

const host=document.getElementById('root');
let root=null;
window.__mount=(name)=>{
  if(root)root.unmount();
  root=createRoot(host);
  root.render(name==='general'?<GeneralPanel/>:name==='dataroot'?<DataRootPanel/>:<RuntimesPanel/>);
};
window.__mount('runtimes');
window.__ready=true;

