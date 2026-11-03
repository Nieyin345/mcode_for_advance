"use strict";
/** electron-builder beforePack hook: hide root node_modules for both extraResources trees. */
const { hideNodeModules, restoreSourceNodeModules } = require("./node-red-nodemodules-shim.cjs");
const { hideTheiaNodeModules, restoreTheiaSourceNodeModules } = require("./theia-nodemodules-shim.cjs");

let cleanupRegistered = false;

function restoreSourcesOnExit() {
  for (const restore of [restoreSourceNodeModules, restoreTheiaSourceNodeModules]) {
    try { restore(); }
    catch (error) { console.error("[beforePack] source node_modules restore failed:", error); }
  }
}

module.exports = async function nodeRedBeforePack(context) {
  await hideNodeModules(context);
  try {
    hideTheiaNodeModules();
  } catch (error) {
    // Do not leave Node-RED renamed if the second resource cannot be prepared.
    restoreSourceNodeModules();
    restoreTheiaSourceNodeModules();
    throw error;
  }
  if (!cleanupRegistered) {
    // afterPack normally restores the sources. This synchronous exit fallback
    // also restores them when electron-builder aborts before afterPack.
    process.once("exit", restoreSourcesOnExit);
    cleanupRegistered = true;
  }
};
