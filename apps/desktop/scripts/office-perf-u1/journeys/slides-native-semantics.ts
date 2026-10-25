/**
 * ARC-007 functional U1, not a screenshot or renderer mock:
 * the actual vendor Slides WebContentsView, preload, IPC session, OOXML
 * journal, save and independent OS-process reopen.
 *
 * Specifically regresses native notes/animations/sections against Mcode's
 * old compatibility preload that returned fabricated empty values.
 */
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { editorSetup, js, sha256Of, waitFor, type EditorRuntime } from "../../t7-genoffice-u1/editor-flow.js";
import { UNIQUE } from "../../t7-genoffice-u1/fixtures.js";

const NOTES = "Mcode native Slides notes " + UNIQUE.slides + " safe roundtrip";
const SECTION = "Mcode native section " + UNIQUE.slides;
const COMMENT = "Mcode native comment " + UNIQUE.slides;
type SlidesRuntime = EditorRuntime & { beforeHash?: string };

export const slidesNativeSemanticJourney = defineU1Journey({
  name: "slides-native-semantics",
  launch: {
    window: false,
    size: { width: 1320, height: 920 },
    defaultTimeoutMs: 45_000,
    setup: editorSetup("slides"),
    assertions: { dom: true, visual: false, sideEffect: true },
  },
  steps: [
    step.waitFor(".app", "original-slides-page-mounted", { timeoutMs: 40_000 }),
    step.run(async ({ runtime }) => {
      const rt = runtime as SlidesRuntime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (!wc) return { ok: false, detail: "No original Slides WebContents" };
      const state = await js<{ ok: boolean; noteType: string; animationCount: number; sectionCount: number; transition: string; reason?: string }>(wc, `(async () => {
        const api = window.slidesApi;
        if (!api) return { ok:false,reason:"No upstream slidesApi preload",noteType:"",animationCount:-1,sectionCount:-1,transition:"" };
        try {
          const [notes, animations, sections, transition] = await Promise.all([
            api.getNotes(0), api.getAnimations(0), api.getSections(), api.getTransition(0),
          ]);
          return {
            ok:typeof notes==="string" && Array.isArray(animations) &&
              Array.isArray(sections) && typeof transition==="string",
            noteType:typeof notes, animationCount:animations?.length ?? -1,
            sectionCount:sections?.length ?? -1, transition:String(transition),
          };
        } catch(e) { return {ok:false,reason:String(e),noteType:"",animationCount:-1,sectionCount:-1,transition:""}; }
      })()`);
      return {
        ok: state.ok && rt.harness.host.sessionFor(rt.docId)?.filePath === rt.fixtures.slides,
        observed: state,
        detail: state.reason,
      };
    }, "native-notes-animations-sections-transition-routes", { assert: true }),
    step.run(async ({ runtime }) => {
      const rt = runtime as SlidesRuntime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (!wc) return { ok: false, detail: "Slides view not alive before mutation" };
      rt.beforeHash = sha256Of(rt.fixtures.slides);
      const reply = await js<{ ok: boolean; newNotes?: string; reason?: string }>(wc, `(async () => {
        try {
          const api=window.slidesApi;
          const changed = await api.setNotes({slideIndex:0,text:${JSON.stringify(NOTES)}});
          const now = await api.getNotes(0);
          return {ok:changed===true && now===${JSON.stringify(NOTES)},newNotes:now};
        } catch(e){return {ok:false,reason:String(e)};}
      })()`);
      return { ok: reply.ok, observed: reply, detail: reply.reason };
    }, "write-speaker-notes-through-original-journal", { assert: true }),
    step.run(async ({ runtime }) => {
      const rt = runtime as SlidesRuntime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (!wc) return { ok:false, detail:"Slides view destroyed before native structural edit" };
      const result = await js<{ok:boolean; transition?:string; sectionNames?:string[]; error?:string}>(wc, `(async () => {
        const api=window.slidesApi;
        try {
          const transitionOk=await api.setTransition({slideIndex:0,kind:'fade'});
          const sections=await api.addSection({atSlideIndex:0,name:${JSON.stringify(SECTION)}});
          const comments=await api.addComment({slideIndex:0,text:${JSON.stringify(COMMENT)}});
          const [transition,readSections,readComments]=await Promise.all([
            api.getTransition(0),api.getSections(),api.getComments(0),
          ]);
          const names=readSections.map(s=>s.name);
          const commentPresent=JSON.stringify(readComments).includes(${JSON.stringify(COMMENT)});
          return {ok:transitionOk===true && transition==='fade' &&
              Array.isArray(sections) && names.includes(${JSON.stringify(SECTION)}) &&
              Array.isArray(comments) && commentPresent,
            transition,sectionNames:names,commentPresent};
        } catch(e) {return {ok:false,error:String(e)};}
      })()`);
      return { ok:result.ok, observed:result, detail:result.error };
    }, "original-transition-and-section-journal-modifications", {assert:true}),
    step.run(async ({ runtime }) => {
      const rt = runtime as SlidesRuntime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (!wc) return {ok:false,detail:"Slides view disappeared before undo/redo"};
      const result=await js<{ok:boolean; before:boolean; undone:boolean; redone:boolean; error?:string}>(wc,`(async () => {
        try {
          const api=window.slidesApi;
          const hasComment=async () => JSON.stringify(await api.getComments(0)).includes(${JSON.stringify(COMMENT)});
          const before=await hasComment();
          const undoTree=await api.undo();
          const undone=Array.isArray(undoTree) && !(await hasComment());
          const redoTree=await api.redo();
          const redone=Array.isArray(redoTree) && (await hasComment());
          return {ok:before && undone && redone,before,undone,redone};
        } catch(e) {return {ok:false,before:false,undone:false,redone:false,error:String(e)};}
      })()`);
      return {ok:result.ok,observed:result,detail:result.error};
    }, "vendor-history-undo-redo-restores-native-comment", {assert:true}),
    step.run(async ({ runtime }) => {
      const rt = runtime as SlidesRuntime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (!wc) return { ok:false, detail:"Slides view destroyed before save" };
      const saved = await js<{ ok:boolean; reason?:string }>(wc, `(async () => {
        try {
          const r=await window.slidesApi.save();
          return {ok:r?.ok===true,reason:r?.error};
        }catch(e){return {ok:false,reason:String(e)};}
      })()`);
      const after = sha256Of(rt.fixtures.slides);
      return {
        ok:saved.ok && !!rt.beforeHash && rt.beforeHash!==after,
        observed:{ saved, originalHash:rt.beforeHash, savedHash:after },
        detail:saved.reason,
      };
    }, "save-original-pptx-with-notes-not-just-an-ipc-ack", { assert: true }),
    step.run(async ({ runtime }) => {
      const rt=runtime as SlidesRuntime;
      const response=rt.harness.host.close(rt.docId);
      return {
        ok:response.ok && !rt.harness.host.list().some(v=>v.docId===rt.docId),
        observed:response,
      };
    }, "close-native-view-without-stray-session", { assert: true }),
    step.relaunch("relaunch-native-notes", "Fresh Electron process verifies PPTX persisted native note"),
    step.waitFor(".app", "reopened-original-slides-renderer", { timeoutMs: 40_000 }),
    step.run(async ({ runtime }) => {
      const rt=runtime as SlidesRuntime;
      const wc=rt.harness.webContentsOf(rt.docId);
      if (!wc) return {ok:false,detail:"Reopened Slides WebContents missing"};
      const found=await waitFor(async()=>js<{
        notes:string;sections:Array<{name:string}>;animations:unknown[];transition:string;comments:unknown[]
      }>(wc,`(async () => {
        const api=window.slidesApi;
        return {
          notes:await api.getNotes(0),
          sections:await api.getSections(),
          animations:await api.getAnimations(0),
          transition:await api.getTransition(0),
          comments:await api.getComments(0),
        };
      })()`),15_000,300);
      const commentPresent=JSON.stringify(found?.comments ?? []).includes(COMMENT);
      return {
        ok:found?.notes===NOTES && found.transition==="fade" &&
          Array.isArray(found?.sections) &&
          found.sections.some(s=>s.name===SECTION) &&
          Array.isArray(found?.animations) && commentPresent,
        observed:{ notes:found?.notes, sectionNames:found?.sections?.map(s=>s.name),
          transition:found?.transition,animationCount:found?.animations?.length,commentPresent },
        detail:"Original vendor notes/transition/section/comment must survive an independent PPTX save and fresh-process reopen",
      };
    }, "reopened-pptx-retains-notes-transitions-sections-comments", { assert:true }),
  ],
});
