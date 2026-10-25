/**
 * Dedicated, opt-in performance U1. Keep the normal six-format T7 run fast:
 * this registry is separate because its idle-worker check lasts >60 seconds.
 *
 * The registry is loaded once by plain Node before Electron is booted:
 * only materialize the real journey AFTER app.whenReady().
 */
export { beforeReady, afterReady } from "../../t7-genoffice-u1/journeys/index.js";
import type { U1Journey } from "../../electron-u1/driver/types.js";

export const journeyNames = ["sheets-shared-worker-idle-restart", "six-editor-residency"] as const;
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
