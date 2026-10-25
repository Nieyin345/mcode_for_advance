/**
 * O21: a real, three-generation Mcode DOCX crash-recovery journey.
 * Vendor DOCX bytes, native Docs preload, sender-bound Mcode IPC, OS lease,
 * restore/discard decision, Mcode CAS save and fresh-process reread.
 *
 * Recovery is not a second document writer; the original on-disk DOCX must
 * remain untouched until the regular Mcode save commits.
 */
import { readFileSync } from "node:fs";
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { UNIQUE } from "../../t7-genoffice-u1/fixtures.js";
import { editorSetup, invokeAs, js, sha256Of, waitFor, type EditorRuntime } from "../../t7-genoffice-u1/editor-flow.js";

const RECOVERED = UNIQUE.docs + "-RECOVERED";
type Run = EditorRuntime & { beforeSha?: string; savedSha?: string };

export async function candidateBytes(path: string, replacement = RECOVERED): Promise<Buffer> {
  // Same real JSZip dependency/OOXML bytes as the repository's T7 fixture,
  // retaining the original document structure, relationships and all parts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const JSZip = require("genoffice:jszip") as {
    new (): {
      loadAsync(bytes: Uint8Array): Promise<void>;
      file(name: string): { async(type: "string"): Promise<string> } | null;
      file(name: string, content: string): unknown;
      generateAsync(opts: { type: "uint8array"; compression: "DEFLATE" }): Promise<Uint8Array>;
    };
  };
  const zip = new JSZip();
  await zip.loadAsync(readFileSync(path));
  const part = zip.file("word/document.xml");
  if (!part) throw new Error("real DOCX fixture has no document.xml");
  const xml = await part.async("string");
  if (!xml.includes(UNIQUE.docs)) throw new Error("real DOCX fixture already overwritten unexpectedly");
  zip.file("word/document.xml", xml.replace(UNIQUE.docs, replacement));
  return Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}

export async function openRealDocs(rt: Run) {
  const wc=rt.harness.webContentsOf(rt.docId);
  if (!wc) return {ok:false,detail:"No Mcode Docs view"};
  const r=await invokeAs(wc,rt.harness,"documentView:openPath",{docId:rt.docId,filePath:rt.fixtures.docs}) as {ok:boolean;reason?:string};
  if (!r.ok) return {ok:false,detail:r.reason};
  const committed=await waitFor(async()=>rt.harness.host.sessionFor(rt.docId),30_000,180);
  return {ok:committed!==null,observed:{filePath:committed?.filePath,revision:committed?await committed.revision:null}};
}
const setupDocs=editorSetup("docs");
export const docsRecoveryJourney=defineU1Journey({
  name:"docs-crash-recovery-mcode",
  launch:{
    window:false, size:{width:1280,height:900}, defaultTimeoutMs:45_000,
    setup: async (ctx)=>{
      const s=await setupDocs(ctx);
      const rt=s.runtime as Run;
      if(ctx.generation===2) {
        rt.harness.host.setConfirmRecovery(async () => "restore");
      } else if(ctx.generation>=3) {
        rt.harness.host.setConfirmRecovery(async () => {throw new Error("saved snapshot must have been cleared");});
      }
      return s;
    },
    assertions:{dom:true,visual:false,sideEffect:true},
  },
  steps:[
    step.run(async ({runtime})=>openRealDocs(runtime as Run),"open-original-docx-and-commit-mcode-session",{assert:true}),
    step.run(async ({runtime})=>{
      const rt=runtime as Run;
      rt.beforeSha=sha256Of(rt.fixtures.docs);
      const bytes=await candidateBytes(rt.fixtures.docs);
      const wc=rt.harness.webContentsOf(rt.docId);
      if(!wc)return {ok:false,detail:"No Docs renderer to issue recovery"};
      const denied=await js<{ok:boolean}>(wc,`window.desktop.writeRecoveryCopy("C:/path-not-opened.docx",new Uint8Array(${JSON.stringify(Array.from(bytes))}).buffer)`);
      const accepted=await js<{ok:boolean;reason?:string}>(wc,`window.desktop.writeRecoveryCopy(${JSON.stringify(rt.fixtures.docs)},new Uint8Array(${JSON.stringify(Array.from(bytes))}).buffer)`);
      return {
        ok:denied.ok===false && accepted.ok===true && sha256Of(rt.fixtures.docs)===rt.beforeSha,
        observed:{denied,accepted,unchangedSource:sha256Of(rt.fixtures.docs)===rt.beforeSha,bytes:bytes.length},
        detail:accepted.reason,
      };
    },"reject-forged-path-write-guarded-recovery-copy-without-touching-docx",{assert:true}),
    step.recordSideEffect("@projectDir/t7-docs.docx","original-unmodified"),
    step.relaunch("simulate-crash-relaunch","restart separate Electron OS process before saving the dirty recovery copy"),
    step.run(async ({runtime})=>openRealDocs(runtime as Run),"restore-by-explicit-mcode-confirmation",{assert:true}),
    step.waitFor(".ProseMirror","recovered-docx-editor-mount",{text:RECOVERED,timeoutMs:30_000}),
    step.assertDom(".ProseMirror",{textContains:RECOVERED},"recovered-text-from-original-vendor-docx-bytes"),
    step.assertSideEffect("@projectDir/t7-docs.docx",{sha256UnchangedFrom:"original-unmodified"},"restore-did-not-overwrite-original-disk-file"),
    step.run(async ({runtime})=>{
      const rt=runtime as Run;
      const wc=rt.harness.webContentsOf(rt.docId);
      if(!wc)return {ok:false,detail:"No renderer for normal Mcode save"};
      const bytes=await candidateBytes(rt.fixtures.docs);
      const saved=await js<{ok?:boolean;reason?:string}>(wc,`window.desktop.saveDocx("C:/ignored-by-mcode.docx",new Uint8Array(${JSON.stringify(Array.from(bytes))}).buffer)`);
      rt.savedSha=sha256Of(rt.fixtures.docs);
      return {ok:saved?.ok===true,observed:{saved,savedSha:rt.savedSha},detail:saved?.reason};
    },"save-restored-docx-only-through-normal-mcode-cas",{assert:true}),
    step.assertSideEffect("@projectDir/t7-docs.docx",{sha256ChangedFrom:"original-unmodified"},"normal-save-writes-restored-docx-bytes"),
    step.relaunch("post-save-fresh-process","verify saved document no longer offers obsolete recovery copy"),
    step.run(async ({runtime})=>openRealDocs(runtime as Run),"open-saved-docx-without-obsolete-recovery-prompt",{assert:true}),
    step.assertDom(".ProseMirror",{textContains:RECOVERED},"recovered-text-persisted-after-third-os-process"),
  ],
});
