import React from "react";
import {createRoot} from "react-dom/client";
import {ModuleViewDock,ModuleSettingsPanel} from "@renderer/components/modules/ModuleContributions.js";
import {CommandPalette} from "@renderer/components/layout/CommandPalette.js";
const title={zh:"扩展视图",en:"Extension view"};
const fields=[{key:"bytes",title:{zh:"字节数",en:"Bytes"}}];
const capabilities=["right","left","bottom"].map((location,i)=>({
 id:"view"+location,slot:"view",title:{zh:location+" 面板",en:location+" view"},
 capability:"core.file.info",location,view:{kind:"fields",fields},icon:"chart",
}));
const command={id:"hello",slot:"command",title:{zh:"打招呼",en:"Say hello"},capability:"core.file.info",command:"acme.hello",icon:"sparkles"};
const settings={id:"settings",slot:"settings",title:{zh:"我的设置",en:"My settings"},capability:"core.file.info",
 properties:[{key:"apiEndpoint",title:{zh:"接口地址",en:"API endpoint"},type:"string",default:""}]};
const manifest={apiVersion:1,id:"user.t50.ui",version:"1.0.0",title,permissions:["resource.read"],contributions:[...capabilities,command,settings]};
window.__writes=[];
window.__calls=[];
window.__store={settingsOpen:false,locale:"zh",activeProjectId:"project",projects:[{id:"project",path:"C:/t50"}],ideActiveFileByProject:{project:"C:/t50/report.txt"},shortcutOverrides:{},commandPaletteOpen:false,setCommandPaletteOpen(v){window.__store.commandPaletteOpen=v;}};
window.testApi={
 modules:{
  catalog:async()=>({modules:[manifest],capabilities:[]}),
  invoke:async(input)=>{window.__calls.push(input);return {type:"result",value:{bytes:24},view:{title,fields}};},
  task:async()=>{throw Error("unexpected task")},
 },
 extensionStore:{
  get:async()=>({value:null}),
  set:async(input)=>{window.__writes.push(input);return {ok:true};}
 },
 setting:{set:async()=>{throw Error("core settings must never be used")}},
};
const root=createRoot(document.getElementById("root"));
window.__mountPalette=()=>{window.__store.commandPaletteOpen=true;root.render(<CommandPalette/>);};
root.render(<><ModuleViewDock location="right"/><ModuleViewDock location="left"/><ModuleViewDock location="bottom"/><ModuleSettingsPanel/></>);
window.__ready=true;
