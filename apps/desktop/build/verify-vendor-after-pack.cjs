"use strict";
/**
 * Single electron-builder afterPack hook: keep existing GenOffice gate AND T19
 * Node-RED gate, bracketed by the T118 node_modules shim.
 *
 * 顺序是硬性的：
 *
 *   1. `restorePackedNodeModules` —— 产物里 `__mcode_node_modules` → `node_modules`
 *      （`extraResources` 不能复制根本 `node_modules`，见 shim 文件头）；
 *   2. GenOffice / Node-RED 两道验证 —— 它们要的是 `node_modules` 这个名字；
 *   3. `restoreSourceNodeModules` —— **无论第 2 步成功与否**都要把源目录改回去，
 *      否则 `.tmp/node-red-release` 会停在一棵被改过名的树上，让 t19/t88 那些
 *      直接读它的套件看到缺 `node_modules` 的假象。
 *
 * 第 3 步放在 `finally` 里而不是函数末尾 —— 验证器抛错时也要还原。
 */
const verifyGenoffice = require("./verify-genoffice-editors-after-pack.cjs");
const verifyNodeRed = require("./verify-node-red-after-pack.cjs");
const { restorePackedNodeModules, restoreSourceNodeModules } = require("./node-red-nodemodules-shim.cjs");

module.exports = async function verifyVendorAfterPack(context) {
  restorePackedNodeModules(context.appOutDir);
  try {
    await verifyGenoffice(context);
    return await verifyNodeRed(context);
  } finally {
    restoreSourceNodeModules();
  }
};
