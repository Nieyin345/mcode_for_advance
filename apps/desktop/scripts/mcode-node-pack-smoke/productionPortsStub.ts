/* The existing node-pack smoke supplies fake ports in Node-RED; never
 * initialize real Mcode SDKs/ModuleHost in a headless test host. */
import type { NodePackHostServices } from "../../src/main/workflowEngines/nodePackHost.js";
export function productionNodePackServices(): NodePackHostServices {
  return {
    execute: async () => { throw new Error("Node-pack smoke has no real Mcode approval session"); },
    subscribe: () => { throw new Error("Node-pack smoke has no real Mcode event source"); },
  };
}
