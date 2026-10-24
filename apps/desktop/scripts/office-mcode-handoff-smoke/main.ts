import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canDockOfficeFile, handoffOfficeToMcode, officeDraftWithFile } from "../../src/renderer/components/ide/officeChatHandoff.js";
import type { ComposerDraft } from "../../src/renderer/stores/sessionStoreTypes.js";

let count=0,fail=0;
function check(name:string, ok:boolean, observed?:unknown) {
  count++;
  if (!ok) fail++;
  console.log((ok?"PASS ":"FAIL ")+name+(ok?"":` — ${JSON.stringify(observed)}`));
}
for (const path of ["report.docx", "report.ODT", "budget.xlsx", "book.csv", "slides.pptx", "notes.pdf", "notes.md", "page.html"]) {
  check(`native Office right-dock routes ${path}`, canDockOfficeFile(path));
}
for (const path of ["file.exe", "payload.bin", "", "file.docm"]) {
  check(`unknown extension not docked: ${path}`, !canDockOfficeFile(path));
}
check("null path cannot dock", !canDockOfficeFile(null));
const path="D:\\workspace\\annual report.xlsx";
const previous:ComposerDraft = {
  text:"不要删除我已经写好的说明", html:"<p>不要删除我已经写好的说明</p>",
  tags:[{id:"existing",kind:"paste",preview:"test",content:"original quote"}],
};
const withFile=officeDraftWithFile(path,previous);
check("only a path chip appended, existing unsent text/html/tags preserved",
  withFile.text===previous.text && withFile.html===previous.html &&
  withFile.tags.length===2 && withFile.tags[0]===previous.tags[0] &&
  withFile.tags[1]?.kind==="file" && withFile.tags[1]?.filePath===path &&
  withFile.tags[1]?.content===`@${path}`,withFile);
const again=officeDraftWithFile(path,withFile);
check("repeated Ask Mcode does not duplicate the same Office attachment",again.tags.length===2);
const actions:string[]=[];
const drafts:Record<string,ComposerDraft>={m1:previous,m2:{text:"other user",html:"",tags:[]}};
const mock={
  composerDraftBySession:drafts,
  deliverComposerDraft:(id:string,draft:ComposerDraft)=>{actions.push("draft:"+id);drafts[id]=draft;},
  setLayoutPaneContent:(_pane:"right",value:{kind:"document";documentId:string})=>{actions.push("dock:"+value.documentId);},
  setRightOpen:(v:boolean)=>{actions.push("right:"+v);},
  setCenterTabFocus:(focus:"chat")=>{actions.push("center:"+focus);},
};
check("no active Mcode session means NO side effect",
  !handoffOfficeToMcode(path,null,mock) && actions.length===0);
check("no unsupported file forwarding",!handoffOfficeToMcode("evil.exe","m1",mock) && actions.length===0);
check("handoff attaches draft, docks editor, reveals Mcode chat without sending",handoffOfficeToMcode(path,"m1",mock) &&
  actions.join("|")===`draft:m1|dock:${path}|right:true|center:chat` &&
  drafts.m2?.text==="other user" && drafts.m1?.tags.length===2,actions);
check("repeated click keeps only one file chip",handoffOfficeToMcode(path,"m1",mock) && drafts.m1?.tags.length===2);
const right=readFileSync(resolve("src/renderer/components/layout/RightPanel.tsx"),"utf8");
const pane=readFileSync(resolve("src/renderer/components/ide/GenofficeViewHostPane.tsx"),"utf8");
check("right rail uses shared 6-editor routing, not DOCX-only regex",
  right.includes("canDockOfficeFile(activeFile)") && !right.includes("/\\.docx$/i.test(activeFile)"));
check("Mcode button outside native measured stage and using handoff (no vendor AI)",
  pane.indexOf("data-office-ask-mcode") > 0 &&
  pane.indexOf("data-office-mcode-toolbar") < pane.lastIndexOf('ref={stageRef}') &&
  pane.includes("handoffOfficeToMcode(filePath, mcodeSessionId, useSessionStore.getState())") &&
  !pane.includes("window.genofficeAi"));
console.log(`office-mcode-handoff-smoke: ${count-fail}/${count} PASS`);
if(fail) process.exitCode=1;
