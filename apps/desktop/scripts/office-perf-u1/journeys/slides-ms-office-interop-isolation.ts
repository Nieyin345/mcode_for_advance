/**
 * Actual Mcode native Slides / vendor PPTX writer. Isolate independent
 * Microsoft PowerPoint interoperability regressions by publishing a real
 * saved PPTX after EACH native operation (never fabricating OOXML).
 *
 * All artifacts go to the Electron-U1 disposable evidence directory; the
 * user's installed MS Office is NOT launched from the Electron process.
 */
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { editorSetup, js, type EditorRuntime } from "../../t7-genoffice-u1/editor-flow.js";

const actions = [
  {
    name:"notes",
    javascript:`const r=await api.setNotes({slideIndex:0,text:"Interop stage notes"});return {ok:r===true};`,
  },
  {
    name:"transition",
    javascript:`const r=await api.setTransition({slideIndex:0,kind:"fade"});return {ok:r===true};`,
  },
  {
    name:"section",
    javascript:`const r=await api.addSection({atSlideIndex:0,name:"Interop stage section"});return {ok:Array.isArray(r)};`,
  },
  {
    name:"comment",
    javascript:`const r=await api.addComment({slideIndex:0,text:"Interop stage comment"});return {ok:Array.isArray(r)};`,
  },
  {
    name:"animation",
    javascript:`const shapes=await api.getShapeKeys(0);const sourceId=shapes.find(s=>s.spid!=null)?.sourceId;
      if(!sourceId)throw Error("No text shape to animate");
      const r=await api.setAnimations({slideIndex:0,items:[{sourceId,effect:"fade",trigger:"onClick",durationMs:900,delayMs:100}]});
      return {ok:r===true,sourceId};`,
  },
  {
    name:"chart",
    javascript:`const r=await api.addChart({slideIndex:0,kind:"bar",title:"Interop stage chart",
      categories:["2025","2026"],series:[{name:"Series",values:[4,9]}],
      xPx:150,yPx:170,wPx:440,hPx:310,fitWidthPx:1280});
      return {ok:!!r?.sourceId,sourceId:r?.sourceId};`,
  },
];

export const slidesInteropIsolationJourney = defineU1Journey({
  name:"slides-ms-office-interop-isolation",
  launch:{
    window:false,
    size:{width:1280,height:900},
    defaultTimeoutMs:50_000,
    setup:editorSetup("slides"),
    assertions:{dom:true,visual:false,sideEffect:true},
  },
  steps:[
    step.waitFor(".app","real-slides-native-editor-mounted",{timeoutMs:38_000}),
    step.run(async({runtime,evidenceDir})=>{
      const rt=runtime as EditorRuntime;
      const wc=rt.harness.webContentsOf(rt.docId);
      if(!wc)return {ok:false,detail:"Missing native preload WebContents"};
      const api=await js<boolean>(wc,"!!window.slidesApi");
      if(!api)return {ok:false,detail:"Native slides API missing"};
      const dest=join(evidenceDir,"stage-0-baseline.pptx");
      copyFileSync(rt.fixtures.slides,dest);
      return {ok:true,observed:{dest}};
    },"export-real-pptx-unmodified-baseline",{assert:true}),
    ...actions.map((action,index)=>step.run(async({runtime,evidenceDir})=>{
      const rt=runtime as EditorRuntime;
      const wc=rt.harness.webContentsOf(rt.docId);
      if(!wc)return {ok:false,detail:"Native Slides view closed"};
      const result=await js<{ok:boolean;error?:string;sourceId?:string;saved?:boolean}>(wc,`(async()=>{
        try{
          const api=window.slidesApi;
          const operation=await (async()=>{${action.javascript}})();
          if(!operation.ok)return {ok:false,error:"vendor native operation failed"};
          const save=await api.save();
          return {ok:save?.ok===true,saved:save?.ok===true,sourceId:operation.sourceId,error:save?.error};
        }catch(e){return {ok:false,error:String(e)};}
      })()`);
      if(!result.ok)return {ok:false,detail:result.error,observed:result};
      const dest=join(evidenceDir,"stage-"+(index+1)+"-"+action.name+".pptx");
      copyFileSync(rt.fixtures.slides,dest);
      return {ok:true,observed:{dest,action:action.name,sourceId:result.sourceId}};
    },"native-save-checkpoint-"+action.name,{assert:true})),
  ],
});
