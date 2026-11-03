"use strict";
/**
 * Single electron-builder afterPack hook: restore the root node_modules
 * directories hidden for the Node-RED and Theia extraResources trees, then
 * verify every packaged runtime. Source trees are restored in finally even if
 * a package audit fails.
 */
const verifyGenoffice = require("./verify-genoffice-editors-after-pack.cjs");
const verifyNodeRed = require("./verify-node-red-after-pack.cjs");
const verifyTheia = require("./verify-theia-after-pack.cjs");
const verifyNativeFs = require("./verify-native-fs-after-pack.cjs");
const { restorePackedNodeModules, restoreSourceNodeModules } = require("./node-red-nodemodules-shim.cjs");
const {
  restorePackedTheiaNodeModules,
  restoreTheiaSourceNodeModules,
} = require("./theia-nodemodules-shim.cjs");

module.exports = async function verifyVendorAfterPack(context) {
  try {
    // extraResources excludes a source-root node_modules directory by default.
    // Both roots were renamed before pack and must be restored before runtime
    // checks. Handles Windows resources/ and macOS .app/Contents/Resources/.
    restorePackedNodeModules(context.appOutDir);
    restorePackedTheiaNodeModules(context.appOutDir);

    await verifyGenoffice(context);
    await verifyNodeRed(context);
    await verifyNativeFs(context);
    // Theia is the only extension runtime; missing resources make all installed
    // extensions unavailable even though development mode may still work.
    return await verifyTheia(context);
  } finally {
    restoreSourceNodeModules();
    restoreTheiaSourceNodeModules();
  }
};
