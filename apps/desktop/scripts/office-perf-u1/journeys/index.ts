/**
 * Dedicated, opt-in performance U1. Keep the normal six-format T7 run fast:
 * this registry is separate because its idle-worker check lasts >60 seconds.
 *
 * The registry is loaded once by plain Node before Electron is booted:
 * only materialize the real journey AFTER app.whenReady().
 */
export { beforeReady, afterReady } from "../../t7-genoffice-u1/journeys/index.js";
import type { U1Journey } from "../../electron-u1/driver/types.js";

export const journeyNames = ["sheets-shared-worker-idle-restart"] as const;
let loaded: U1Journey | null = null;
function getJourney() {
  if (loaded === null) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./sheets-shared-worker-idle-restart.js") as typeof import("./sheets-shared-worker-idle-restart.js");
    loaded = mod.sheetsSharedWorkerJourney;
  }
  return loaded!;
}
export const journeys = [{
  name: journeyNames[0],
  get launch() { return getJourney().launch; },
  get steps() { return getJourney().steps; },
  get expect() { return "pass" as const; },
}];
