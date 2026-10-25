/**
 * Regression: stale DOCX recovery is viewable but CANNOT overwrite a newer
 * disk version. Two real Electron OS processes, original Docs preload and
 * normal Mcode CAS save; uses isolated T7 fixture project, never user files.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { editorSetup, js, sha256Of, type EditorRuntime } from "../../t7-genoffice-u1/editor-flow.js";
import { UNIQUE } from "../../t7-genoffice-u1/fixtures.js";
import { candidateBytes, openRealDocs } from "./docs-crash-recovery-mcode.js";

const RECOVERED = UNIQUE.docs + "-RECOVERED";
const EXTERNAL = UNIQUE.docs + "-NEW-EXTERNAL-WRITER";
const candidatePath = (rt: EditorRuntime) => join(rt.harness.projectDir, "recovery-candidate-isolated.docx");
const externalHashPath = (rt: EditorRuntime) => join(rt.harness.projectDir, "external-revision-hash.txt");

export const docsRecoveryConflictJourney = defineU1Journey({
  name: "docs-recovery-external-conflict",
  launch: {
    window: false, size: { width: 1280, height: 900 }, defaultTimeoutMs: 45_000,
    setup: async (ctx) => {
      const result = await editorSetup("docs")(ctx);
      if (ctx.generation >= 2) {
        (result.runtime as EditorRuntime).harness.host.setConfirmRecovery(async () => "restore");
      }
      return result;
    },
    assertions: { dom: true, visual: false, sideEffect: true },
  },
  steps: [
    step.run(async ({runtime}) => openRealDocs(runtime as EditorRuntime), "open-original-disk-revision", {assert:true}),
    step.run(async ({runtime}) => {
      const rt = runtime as EditorRuntime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (!wc) return {ok:false, detail:"No trusted Docs renderer"};
      const original = sha256Of(rt.fixtures.docs);
      const recovery = await candidateBytes(rt.fixtures.docs, RECOVERED);
      writeFileSync(candidatePath(rt), recovery);
      const stored = await js<{ok:boolean;reason?:string}>(wc,
        `window.desktop.writeRecoveryCopy(${JSON.stringify(rt.fixtures.docs)},new Uint8Array(${JSON.stringify(Array.from(recovery))}).buffer)`);
      const untampered = sha256Of(rt.fixtures.docs) === original;
      const external = await candidateBytes(rt.fixtures.docs, EXTERNAL);
      writeFileSync(rt.fixtures.docs, external);
      const externalHash = sha256Of(rt.fixtures.docs);
      writeFileSync(externalHashPath(rt), externalHash);
      return {
        ok:stored.ok === true && untampered && externalHash !== original,
        observed:{stored,original,externalHash,untampered},
        detail:stored.reason,
      };
    }, "native-recovery-keeps-old-base-external-writer-updates-disk", {assert:true}),
    step.relaunch("restore-against-changed-file", "new OS process chooses Restore from a stale DOCX snapshot"),
    step.run(async ({runtime}) => openRealDocs(runtime as EditorRuntime), "recovered-original-base-session-committed", {assert:true}),
    step.waitFor(".ProseMirror", "recovered-old-draft-shown", {text:RECOVERED,timeoutMs:30_000}),
    step.run(async ({runtime}) => {
      const rt = runtime as EditorRuntime;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (!wc) return {ok:false,detail:"Docs renderer absent at conflict save"};
      const recovery = readFileSync(candidatePath(rt));
      const saved = await js<{ok?:boolean;reason?:string;message?:string}>(wc,
        `window.desktop.saveDocx(${JSON.stringify(rt.fixtures.docs)},new Uint8Array(${JSON.stringify(Array.from(recovery))}).buffer)`);
      const externalHash = readFileSync(externalHashPath(rt),"utf8");
      const stillExternal = sha256Of(rt.fixtures.docs) === externalHash;
      return {
        ok: saved?.ok === false && saved.reason === "conflict" && stillExternal,
        observed:{saved,externalHash,currentHash:sha256Of(rt.fixtures.docs),stillExternal},
        detail:"A restored old draft must never silently overwrite a newer external DOCX",
      };
    }, "normal-mcode-cas-refuses-stale-recovery-save-no-overwrite", {assert:true}),
  ],
});
