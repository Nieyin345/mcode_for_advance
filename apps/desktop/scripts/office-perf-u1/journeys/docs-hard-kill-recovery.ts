/**
 * Real ungraceful Electron host SIGKILL while an unsaved native Docs
 * recovery snapshot is committed. Unlike the previous graceful U1 relaunch,
 * NO WebContentsView.dispose(), app.exit(), close guard or save handler runs.
 * Data root and DOCX fixture belong exclusively to this U1 journey.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { UNIQUE } from "../../t7-genoffice-u1/fixtures.js";
import {
  editorSetup, js, sha256Of, waitFor, type EditorRuntime,
} from "../../t7-genoffice-u1/editor-flow.js";
import { candidateBytes, openRealDocs } from "./docs-crash-recovery-mcode.js";

const RECOVERED = UNIQUE.docs + "-HARD-KILL-RECOVERED";
type Run = EditorRuntime & { beforeHash?: string };
const setupDocs = editorSetup("docs");

export const docsHardKillRecoveryJourney = defineU1Journey({
  name: "docs-hard-kill-recovery",
  launch: {
    window: false, size: { width: 1280, height: 900 }, defaultTimeoutMs: 45_000,
    setup: async (ctx) => {
      const result = await setupDocs(ctx);
      const rt = result.runtime as Run;
      if (ctx.generation === 2) rt.harness.host.setConfirmRecovery(async () => "restore");
      if (ctx.generation >= 3) {
        rt.harness.host.setConfirmRecovery(async () => {
          throw Error("Recovery copy was already committed and should be cleaned");
        });
      }
      return result;
    },
    assertions: { dom: true, visual: false, sideEffect: true },
  },
  steps: [
    step.run(async ({ runtime }) => openRealDocs(runtime as Run),
      "original-docx-opens-before-ungraceful-kill", { assert: true }),
    step.run(async ({ runtime }) => {
      const rt = runtime as Run;
      rt.beforeHash = sha256Of(rt.fixtures.docs);
      const wc = rt.harness.webContentsOf(rt.docId);
      if (!wc) return { ok: false, detail: "Missing native Docs webContents" };
      const bytes = await candidateBytes(rt.fixtures.docs, RECOVERED);
      const saved = await js<{ok:boolean;reason?:string}>(wc,
        `window.desktop.writeRecoveryCopy(${JSON.stringify(rt.fixtures.docs)},new Uint8Array(${JSON.stringify(Array.from(bytes))}).buffer)`);
      return {
        ok: saved.ok === true && sha256Of(rt.fixtures.docs) === rt.beforeHash,
        observed: {saved, sourceUntouched: sha256Of(rt.fixtures.docs) === rt.beforeHash },
        detail: saved.reason,
      };
    }, "real-docs-preload-commits-recovery-copy-without-modifying-source", { assert: true }),
    step.recordSideEffect("@projectDir/t7-docs.docx", "before-sigkill-source"),
    step.crashRelaunch("kill-mcode-electron-host-without-cleanup",
      "OS forcibly kills the native editor host; no dispose, close, save or IPC response"),
    step.run(async ({ projectDir, generation }) => {
      const state = JSON.parse(readFileSync(join(projectDir, "..", "state.json"), "utf8")) as {
        confirmedCrash?: {pid:number;generation:number;status:number|null;signal:string|null};
      };
      const c = state.confirmedCrash;
      return {
        ok: generation === 2 && !!c && c.generation === 1 &&
          c.pid > 0 && (c.signal === "SIGKILL" || (process.platform === "win32" && c.status !== 0)),
        observed: {generation, confirmedCrash:c},
        detail: "Supervisor must observe previous Electron PID's OS-level abrupt exit",
      };
    }, "supervisor-proves-prior-electron-pid-was-hard-killed", { assert: true }),
    step.run(async ({ runtime }) => openRealDocs(runtime as Run),
      "second-real-electron-process-restores-committed-unsaved-draft", { assert: true }),
    step.assertDom(".ProseMirror", {textContains: RECOVERED},
      "native-docs-recovery-contents-survive-ungraceful-electron-host-kill"),
    step.assertSideEffect("@projectDir/t7-docs.docx",
      { sha256UnchangedFrom: "before-sigkill-source" },
      "hard-kill-recovery-kept-original-file-bytes"),
    step.run(async ({ runtime }) => {
      const rt = runtime as Run;
      const wc = rt.harness.webContentsOf(rt.docId);
      if (!wc) return {ok:false,detail:"Missing native Docs WebContents"};
      const bytes = await candidateBytes(rt.fixtures.docs, RECOVERED);
      const result = await js<{ok:boolean;reason?:string}>(wc,
        `window.desktop.saveDocx(${JSON.stringify(rt.fixtures.docs)},new Uint8Array(${JSON.stringify(Array.from(bytes))}).buffer)`);
      return {ok:result.ok===true,observed:result,detail:result.reason};
    }, "mcode-normal-cas-saves-hard-kill-recovered-draft", { assert: true }),
    step.assertSideEffect("@projectDir/t7-docs.docx",
      {sha256ChangedFrom:"before-sigkill-source"},
      "hard-kill-recovered-content-now-durable-in-original-docx"),
    step.relaunch("restart-after-recovered-cas-save",
      "third process verifies no stale recovery prompt and native docx content persists"),
    step.run(async ({ runtime }) => openRealDocs(runtime as Run),
      "third-electron-process-opens-saved-draft-without-obsolete-recovery", { assert:true }),
    step.assertDom(".ProseMirror", {textContains:RECOVERED},
      "saved-hard-kill-recovered-docx-reopens-cleanly"),
  ],
});
