/**
 * O22: deterministic SDK stand-in + REAL Mcode Documents host and GenOffice
 * renderer. No online credentials; never report as a live-model test.
 *
 * The request takes the real native Docs stream IPC, host-bound request/call
 * identity, real renderer ProseMirror transaction and tool-result ACK before
 * using Mcode's ordinary CAS save and fresh Electron-process reopen.
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { editorSetup, invokeAs, js, sha256Of, waitFor, type EditorRuntime } from "../../t7-genoffice-u1/editor-flow.js";
import { UNIQUE } from "../../t7-genoffice-u1/fixtures.js";

const AI_EDITED=UNIQUE.docs+"-MCODE-NATIVE-TOOL";
type RT=EditorRuntime & { nativeToolResult?:string; before?:string };
const docSetup=editorSetup("docs");
const definition={name:"replace_selection",description:"Replace the specified text in this native Docs editor",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"]}};
async function open(rt:RT) {
  const wc=rt.harness.webContentsOf(rt.docId);
  if(!wc) return {ok:false,detail:"missing Mcode Docs pane"};
  const r=await invokeAs(wc,rt.harness,"documentView:openPath",{docId:rt.docId,filePath:rt.fixtures.docs}) as {ok:boolean;reason?:string};
  if(!r.ok)return {ok:false,detail:r.reason};
  const session=await waitFor(async()=>rt.harness.host.sessionFor(rt.docId),30_000,150);
  return {ok:session!==null,observed:{filePath:session?.filePath}};
}
export const docsAiNativeToolJourney=defineU1Journey({
 name:"docs-ai-tool-native-transaction",
 launch:{
   window:false,size:{width:1280,height:900},defaultTimeoutMs:45_000,
   setup:async ctx=>{
     const setup=await docSetup(ctx);
     const rt=setup.runtime as RT;
     // Isolated deterministic model turn only: the real three-SDK adapters are
     // checked in existing T0/O1 suites, without consuming user credentials.
     rt.harness.host.setDocsAiPorts({
       describe:()=>({ok:true,provider:"claude-sdk",model:"synthetic-test-only"}),
       confirm:async()=>true, // Test-approved, production uses modal approval
       run:async(request,onChunk,signal,execute)=>{
         if(request.context.filePath!==rt.fixtures.docs ||
             request.context.sessionId!=="t7-u1-session" || !execute || signal.aborted) {
           throw Error("renderer forged Mcode session or no live tool ACK");
         }
         const result=await execute(
           {id:"mcode-model-call-1",name:definition.name,input:{text:AI_EDITED}},
           definition,
         );
         rt.nativeToolResult=result.status;
         if(result.status!=="success")throw Error("real renderer tool ACK was not successful: "+result.output);
         onChunk({requestId:request.requestId,type:"done",stopReason:"synthetic-tool-success"});
       },
     });
     return setup;
   },
   assertions:{dom:true,visual:false,sideEffect:true},
 },
 steps:[
  step.run(async({runtime})=>open(runtime as RT),"open-mcode-docs-before-ai-tool",{assert:true}),
  step.run(async({runtime})=>{
    const rt=runtime as RT;
    const wc=rt.harness.webContentsOf(rt.docId);
    if(!wc)return {ok:false,detail:"missing Docs renderer"};
    rt.before=sha256Of(rt.fixtures.docs);
    const result=await js<{ok:boolean;ack?:unknown;fakeDenied?:unknown;error?:string;updated?:boolean}>(wc,`(async()=>{
      const d=window.desktop;
      let toolAck=null,forgery=null;
      const unlisten=d.onAiStream(async(chunk)=>{
        if(chunk.type!=='tool-call')return;
        const call=chunk.toolCall;
        // A forged ACK cannot grant completion of a different native call.
        forgery=await d.aiToolResult({requestId:chunk.requestId,callId:call.id+'-forged',
          name:call.name,status:'success',output:'forged result'});
        let status='error',output='failed-to-edit';
        try {
          if(call.name!=='replace_selection'||call.input.text!==${JSON.stringify(AI_EDITED)})throw Error('unexpected tool');
          const pm=document.querySelector('.ProseMirror');
          const e=pm&&pm.editor;
          if(!e)throw Error('native editor not mounted');
          let from=-1,to=-1;
          e.state.doc.descendants((node,pos)=>{
            if(from>=0)return false;
            if(node.isText && node.text && node.text.includes(${JSON.stringify(UNIQUE.docs)})){
              from=pos+node.text.indexOf(${JSON.stringify(UNIQUE.docs)});
              to=from+${UNIQUE.docs.length};
              return false;
            }
            return true;
          });
          if(from<0)throw Error('source selection not found');
          e.commands.setTextSelection({from,to});
          e.commands.insertContent(call.input.text);
          status='success';output='native editor content replaced';
        }catch(err){output=String(err);}
        toolAck=await d.aiToolResult({requestId:chunk.requestId,callId:call.id,
          name:call.name,status,output});
      });
      try {
        await d.aiStream({
          requestId:'mcode-native-e2e',user:'Replace selection in this file',
          messages:[{role:'user',content:'Replace selection in this file'}],
          tools:[${JSON.stringify(definition)}],
          filePath:'C:/forged/other.docx',sessionId:'renderer-forged-session',
        });
        return {ok:toolAck?.ok===true && forgery?.ok===false &&
          document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(AI_EDITED)})===true,
          ack:toolAck,fakeDenied:forgery,updated:document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(AI_EDITED)})===true};
      }catch(e){return {ok:false,error:String(e),ack:toolAck,fakeDenied:forgery};}
      finally{unlisten();}
    })()`);
    return {ok:result.ok && rt.nativeToolResult==="success" && sha256Of(rt.fixtures.docs)===rt.before,
      observed:{...result,hostToolStatus:rt.nativeToolResult,originalDiskUnchanged:sha256Of(rt.fixtures.docs)===rt.before},
      detail:result.error};
  },"model-tool-call-reaches-native-docx-editor-and-matched-ack",{assert:true}),
  step.assertDom(".ProseMirror",{textContains:AI_EDITED},"edited-content-visible-after-native-model-tool"),
  step.press("s","save-ai-tool-edit-with-native-ctrl-s",["control"]),
  step.run(async({runtime})=>{
    const rt=runtime as RT;
    const updated=await waitFor(async()=>sha256Of(rt.fixtures.docs)!==rt.before,45_000,240);
    return {ok:updated===true,observed:{before:rt.before,after:sha256Of(rt.fixtures.docs)}};
  },"mcode-cas-saved-native-model-edit-to-disk",{assert:true}),
  step.relaunch("ai-editor-reopen","new process reads actual saved DOCX and verifies tool result"),
  step.run(async({runtime})=>open(runtime as RT),"fresh-process-opens-model-edited-docx",{assert:true}),
  step.assertDom(".ProseMirror",{textContains:AI_EDITED},"native-model-edit-survives-restart"),
 ],
});
