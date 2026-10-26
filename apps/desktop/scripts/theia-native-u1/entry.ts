/** F039. Real Chromium/Monaco with the PRODUCTION registerTheiaLanguageProviders. */
import * as monaco from "monaco-editor";
import {registerTheiaLanguageProviders} from "../../src/renderer/lib/theiaLanguageProviders.js";
import {registerTheiaMonacoOwner} from "../../src/renderer/lib/theiaMonacoOwner.js";
import {calls,settings} from "./transport.js";

const node=document.getElementById("editor");
if(!node)throw Error("Monaco mount is missing");
const model=monaco.editor.createModel("native-text","plaintext",monaco.Uri.file("C:/mcode/f039.txt"));
const instance=monaco.editor.create(node,{
  model,fontSize:18,automaticLayout:false,minimap:{enabled:false},
  lineNumbers:"on",contextmenu:true,scrollBeyondLastLine:false,
});
const detachOwner=registerTheiaMonacoOwner(()=>({editor:instance,model,filePath:"C:/mcode/f039.txt"}));
const disposeProviders=registerTheiaLanguageProviders(instance,monaco);
(window as unknown as {__probe:unknown}).__probe={instance,model,monaco,calls,settings,
  dispose:()=>{disposeProviders();detachOwner();instance.dispose();model.dispose()}};
const ready=document.getElementById("ready");
if(ready)ready.textContent="ready";
instance.setPosition({lineNumber:1,column:3});
