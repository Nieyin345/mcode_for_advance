"use strict";
/** Single electron-builder afterPack hook: keep existing GenOffice gate AND T19 Node-RED gate. */
const verifyGenoffice = require("./verify-genoffice-editors-after-pack.cjs");
const verifyNodeRed = require("./verify-node-red-after-pack.cjs");
module.exports = async function verifyVendorAfterPack(context) {
  await verifyGenoffice(context);
  return verifyNodeRed(context);
};
