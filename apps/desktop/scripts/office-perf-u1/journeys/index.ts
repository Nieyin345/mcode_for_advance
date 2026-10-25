/**
 * Dedicated, opt-in performance U1. Keep the normal six-format T7 run fast:
 * this registry is separate because its idle-worker check lasts >60 seconds.
 *
 * The registry is loaded once by plain Node before Electron is booted:
 * only materialize the real journey AFTER app.whenReady().
 */
export { beforeReady, afterReady } from "../../t7-genoffice-u1/journeys/index.js";
import type { U1Journey } from "../../electron-u1/driver/types.js";

export const journeyNames = ["sheets-shared-worker-idle-restart", "six-editor-residency", "sheets-nonvisual-edit-save-reopen", "slides-native-semantics", "docs-crash-recovery-mcode", "docs-ai-tool-native-transaction", "sheets-formula-native-roundtrip", "docs-recovery-external-conflict"] as const;
const loaders: Record<string, () => U1Journey> = {
  "sheets-shared-worker-idle-restart": () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./sheets-shared-worker-idle-restart.js") as typeof import("./sheets-shared-worker-idle-restart.js");
    return mod.sheetsSharedWorkerJourney;
  },
  "six-editor-residency": () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./six-editor-residency.js") as typeof import("./six-editor-residency.js");
    return mod.sixEditorResidencyJourney;
  },
  "docs-recovery-external-conflict": () => {
    // Stale restored DOCX against external writer: normal Mcode CAS must reject.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./docs-recovery-external-conflict.js") as typeof import("./docs-recovery-external-conflict.js");
    return mod.docsRecoveryConflictJourney;
  },
  "sheets-formula-native-roundtrip": () => {
    // Native Univer formula and Rust sidecar XLSX save/reopen with independent readback.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./sheets-formula-native-roundtrip.js") as typeof import("./sheets-formula-native-roundtrip.js");
    return mod.sheetsFormulaJourney;
  },
  "docs-ai-tool-native-transaction": () => {
    // Synthetic Mcode SDK turn + real Docs renderer mutation, tool ACK and CAS save.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./docs-ai-tool-native-transaction.js") as typeof import("./docs-ai-tool-native-transaction.js");
    return mod.docsAiNativeToolJourney;
  },
  "docs-crash-recovery-mcode": () => {
    // True DOCX renderer and three independent OS generations of restore/save.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./docs-crash-recovery-mcode.js") as typeof import("./docs-crash-recovery-mcode.js");
    return mod.docsRecoveryJourney;
  },
  "slides-native-semantics": () => {
    // Real vendor Slides session/read/write/OOXML persistence, not the old Mcode stub.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./slides-native-semantics.js") as typeof import("./slides-native-semantics.js");
    return mod.slidesNativeSemanticJourney;
  },
  "sheets-nonvisual-edit-save-reopen": () => {
    // Same native click, save, independent XLSX readback and OS relaunch as T7.
    // The only removed steps are screen captures unavailable on some remote PCs.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./sheets-nonvisual-edit-save-reopen.js") as typeof import("./sheets-nonvisual-edit-save-reopen.js");
    return mod.sheetsNonvisualJourney;
  },
};
export const journeys = journeyNames.map((name) => {
  let loaded: U1Journey | null = null;
  const get = () => {
    loaded ??= loaders[name]!();
    return loaded;
  };
  return {
    name,
    get launch() { return get().launch; },
    get steps() { return get().steps; },
    get expect() { return "pass" as const; },
  };
});
