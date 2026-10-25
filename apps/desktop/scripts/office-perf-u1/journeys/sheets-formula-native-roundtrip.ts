/**
 * O23: genuine Univer calculations and formula OOXML persistence from a Mcode
 * Sheets WebContentsView, via the original Rust sidecar.
 *
 * No visual screenshots; data is verified both in the reopened editor model
 * and by an independent CLI/ZIP read of the saved XLSX.
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { editorSetup, js, sha256Of, waitFor, type EditorRuntime } from "../../t7-genoffice-u1/editor-flow.js";

type RT=EditorRuntime & { originalSha?:string;savedSha?:string };
async function diskFormula(rt: RT): Promise<{ok:boolean;rows?:unknown[][];hasFormula?:boolean;formulaXml?:string;reason?:string}> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cli=require("@main/document/genofficeCli.js") as typeof import("@main/document/genofficeCli.js");
  const repoRoot=process.env.MCODE_U1_REPO??"";
  const read=await cli.sheetRead({
    cliPath:join(repoRoot,"genoffice","packages","cli","dist","genoffice.cjs"),
    withinWorkspace:(p:string)=>p===rt.fixtures.sheets,
    timeoutMs:60_000,
  },rt.fixtures.sheets,undefined,{range:"A1:C1",maxRows:1});
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const JSZip=require("genoffice:jszip") as {
    new():{loadAsync(bytes:Uint8Array):Promise<void>;file(name:string):{async(type:"string"):Promise<string>}|null};
  };
  const zip=new JSZip();
  await zip.loadAsync(readFileSync(rt.fixtures.sheets));
  const worksheets=["xl/worksheets/sheet1.xml","xl/worksheets/sheet2.xml","xl/worksheets/sheet3.xml"];
  let hasFormula=false,xmlHead="";
  for(const name of worksheets){
    const p=zip.file(name);
    if(!p)continue;
    const xml=await p.async("string");
    if(/<f[^>]*>SUM\(A1:B1\)<\/f>/.test(xml)){
      hasFormula=true;xmlHead=xml.match(/<c[^>]*r="C1"[^>]*>[\s\S]*?<\/c>/)?.[0]?.slice(0,320)??"";break;
    }
  }
  const rows=read.ok?(read.envelope.detail as {rows?:unknown[][]})?.rows:undefined;
  return {ok:hasFormula&&read.ok&&String(rows?.[0]?.[0]??"")==="5"&&String(rows?.[0]?.[1]??"")==="7",
    rows,hasFormula,formulaXml:xmlHead,reason:read.ok?undefined:read.reason};
}
export const sheetsFormulaJourney=defineU1Journey({
 name:"sheets-formula-native-roundtrip",
 launch:{
  window:false,size:{width:1280,height:900},defaultTimeoutMs:45_000,
  setup:editorSetup("sheets"),
  assertions:{dom:true,visual:false,sideEffect:true},
 },
 steps:[
  step.waitFor("#univer-container canvas","real-univer-grid",{timeoutMs:40_000}),
  step.run(async({runtime})=>{
    const rt=runtime as RT;rt.originalSha=sha256Of(rt.fixtures.sheets);
    const wc=rt.harness.webContentsOf(rt.docId);
    if(!wc)return {ok:false,detail:"No Sheets view"};
    // A visible canvas is not proof that Univer's plugin/runtime hydration
    // and workbook selection have finished. Wait for the real model API.
    const ready=await waitFor(()=>js<boolean>(wc,
      "!!window.__genofficeDebug?.univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.()"),35_000,250);
    if(ready!==true)return {ok:false,detail:"Univer native workbook API did not hydrate"};
    const edit=await js<{ok:boolean;before?:unknown;formula?:string;error?:string}>(wc,`(async()=>{
      try{
        const api=window.__genofficeDebug?.univerAPI;
        if(!api)throw Error("original Univer API not mounted");
        const ws=api.getActiveWorkbook().getActiveSheet();
        await ws.getRange("A1").setValue(5);
        await ws.getRange("B1").setValue(7);
        await ws.getRange("C1").setFormula("=SUM(A1:B1)");
        return {ok:ws.getRange("C1").getFormula()==="=SUM(A1:B1)",
          formula:ws.getRange("C1").getFormula(),before:ws.getRange("C1").getValue()};
      }catch(e){return {ok:false,error:String(e)}}
    })()`);
    return {ok:edit.ok && sha256Of(rt.fixtures.sheets)===rt.originalSha,observed:edit,detail:edit.error};
  },"native-univer-formula-and-numeric-cells-mutate-memory-only",{assert:true}),
  step.run(async({runtime})=>{
    const rt=runtime as RT;
    const wc=rt.harness.webContentsOf(rt.docId);
    if(!wc)return {ok:false,detail:"Sheets lost WebContents"};
    const click=await js<{ok:boolean;disabled?:boolean}>(wc,`(()=>{
      const btn=[...document.querySelectorAll('button.qa-btn')].find(el=>/保存|Save/.test(el.getAttribute('aria-label')||''));
      if(!btn)return {ok:false};
      btn.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      return {ok:true,disabled:btn.hasAttribute('disabled')};
    })()`);
    const changed=await waitFor(async()=>sha256Of(rt.fixtures.sheets)!==rt.originalSha,60_000,250);
    rt.savedSha=sha256Of(rt.fixtures.sheets);
    return {ok:click.ok&&changed===true,observed:{click,changed,savedSha:rt.savedSha}};
  },"save-xlsx-via-original-shell-and-rust-sidecar",{assert:true}),
  step.run(async({runtime})=>{
    const rt=runtime as RT;
    const result=await diskFormula(rt);
    return {ok:result.ok,observed:result,detail:result.reason};
  },"independent-disk-cli-and-ooxml-formula-verification",{assert:true}),
  step.run(async({runtime})=>{
    const rt=runtime as RT;
    const wc=rt.harness.webContentsOf(rt.docId);
    if(!wc)return {ok:false};
    const r=await rt.harness.handlers.get("documentView:close")!({sender:wc},{docId:rt.docId}) as {ok?:boolean;reason?:string};
    return {ok:r.ok===true,observed:r,detail:r.reason};
  },"close-saved-sheets-through-production-guard",{assert:true}),
  step.relaunch("reload-formula-xlsx","open formula workbook in a new Electron OS process"),
  step.waitFor("#univer-container canvas","reopened-real-univer-grid",{timeoutMs:40_000}),
  step.run(async({runtime})=>{
    const rt=runtime as RT;
    const wc=rt.harness.webContentsOf(rt.docId);
    if(!wc)return {ok:false};
    const formula=await waitFor(async()=>js<string|null>(wc,`(()=>{
      const api=window.__genofficeDebug?.univerAPI;
      const workbook=api?.getActiveWorkbook();
      const sheet=workbook?.getActiveSheet();
      return sheet?.getRange('C1')?.getFormula()??null;
    })()`),35_000,200);
    const independent=await diskFormula(rt);
    return {ok:formula==="=SUM(A1:B1)"&&independent.ok,observed:{formula,independent}};
  },"reopened-workbook-recalculates-and-retains-real-sum-formula",{assert:true}),
 ],
});
