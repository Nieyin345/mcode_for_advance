"use strict";
/** electron-builder beforePack 钩子（T118）——见 `node-red-nodemodules-shim.cjs` 的文件头。 */
const { hideNodeModules } = require("./node-red-nodemodules-shim.cjs");

module.exports = async function nodeRedBeforePack(context) {
  await hideNodeModules(context);
};
