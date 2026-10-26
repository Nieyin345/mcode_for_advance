/** Deterministic IPC seam ONLY for renderer-side Electron U1; real host E1 is tested separately. */
export const calls:Array<Record<string,unknown>>=[];
export const settings={rejectRename:false};
const sessionId="82d01e07-2e5d-42b7-a090-78bd87a7047e";
const range={start:{line:0,character:0},end:{line:0,character:11}};
const languageResult=(extra:Record<string,unknown>)=>({
  kind:"languageResult",contents:[],suggestions:[],...extra
});
export const api={
  on:{theiaContributionChanged:(_fn:()=>void)=>()=>{}},
  modules:{theiaInstalled:async(input:Record<string,unknown>)=>{
    calls.push({...input});
    if(input.op==="list")return{kind:"list",items:[{
      id:"e07967bb-e5d9-4a42-b2f8-fb3f87e80564",extensionId:"f039.fixture",
      enabled:true,running:true,activeSession:{sessionId,
        languageProviders:[{kind:"rename",language:"plaintext",supportsRenameLocation:true},
          {kind:"codeActions",language:"plaintext"}]}}]};
    if(input.op==="editorSync")return{kind:"editorSynced",active:true};
    if(input.op==="languageQuery"){
      if(input.query==="rename"){
        const edit=input.editContext as {newName?:string;prepare?:boolean}|undefined;
        if(edit?.prepare===true)return languageResult({renameLocation:{range,text:"native-text"}});
        if(settings.rejectRename)return languageResult({renameRejectReason:"Extension refused this rename"});
        return languageResult({renameEdits:[{range,text:edit?.newName??""}]});
      }
      if(input.query==="codeActions")return languageResult({codeActions:[
        {title:"Fix native text",kind:"quickfix",isPreferred:true,
          edits:[{range,text:"fixed-text"}]}
      ]});
    }
    throw Error("Unexpected U1 IPC request: "+String(input.op));
  }}
};
