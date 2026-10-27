"use strict";
/** T19/T76: verify packaged Node-RED resources, dependency integrity and license coverage. */
const fs = require("node:fs");
const path = require("node:path");
const {
  hashFile, hashTree, assertSafeTree, createNodeRedLicenseInventory, BASE_COMMIT, VERSION,
} = require("./stage-node-red-resources.cjs");

function required(root, relative) {
  const file = path.join(root, relative);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Unsafe packaged Node-RED resource root: " + root);
  }
  let current = root;
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) {
      throw new Error("Unsafe packaged Node-RED resource ancestor: " + current);
    }
    if (index === parts.length - 1 && (!stat.isFile() || stat.size === 0)) {
      throw new Error("Invalid packaged Node-RED file: " + current);
    }
  }
  return file;
}
function requiredDirectory(root, relative) {
  const directory = path.join(root, relative);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Unsafe packaged Node-RED resource root: " + root);
  }
  let current = root;
  for (const part of relative.split(/[\\/]+/).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Unsafe packaged Node-RED directory/ancestor: " + current);
    }
  }
  return directory;
}
function verifyNodeRedResource(inputRoot) {
  const root = path.resolve(inputRoot);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Unsafe packaged Node-RED resource root: " + root);
  }
  const marker = JSON.parse(fs.readFileSync(required(root, "manifest.json"), "utf8"));
  if (marker.format !== "mcode.node-red.release.v1" ||
      marker.version !== VERSION || marker.sourceCommit !== BASE_COMMIT) {
    throw new Error("Packaged Node-RED manifest/version/commit mismatch");
  }
  const files = [
    ["packages/node_modules/node-red/package.json", "packageSha256"],
    ["packages/node_modules/@node-red/editor-client/public/red/red.min.js", "editorSha256"],
    ["package-lock.json", "lockSha256"],
    ["LICENSE", "licenseSha256"],
    ["third-party-license-inventory.json", "licenseInventorySha256"],
  ];
  for (const [relative, key] of files) {
    const file = required(root, relative);
    if (typeof marker[key] !== "string" || !/^[a-f0-9]{64}$/.test(marker[key]) ||
        hashFile(file) !== marker[key]) {
      throw new Error("Packaged Node-RED " + key + " digest mismatch");
    }
  }
  const licenseManifestPath = path.join(root, "licenses", "node-red", "manifest.json");
  const hasLicenseManifest = fs.existsSync(licenseManifestPath);
  const thirdPartyLicenseFields = [
    ["licenses/node-red/manifest.json", "thirdPartyLicenseManifestSha256"],
    ["licenses/node-red/THIRD-PARTY-LICENSES.txt", "thirdPartyLicenseNoticeSha256"],
  ];
  if (hasLicenseManifest) {
    const thirdPartyLicenseRoot = requiredDirectory(root, "licenses/node-red");
    assertSafeTree(thirdPartyLicenseRoot);
    for (const [relative, key] of thirdPartyLicenseFields) {
      const file = required(root, relative);
      if (typeof marker[key] !== "string" || !/^[a-f0-9]{64}$/.test(marker[key])
          || hashFile(file) !== marker[key]) {
        throw new Error("Packaged Node-RED " + key + " digest mismatch");
      }
    }
    if (typeof marker.thirdPartyLicensesTreeSha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(marker.thirdPartyLicensesTreeSha256)
        || hashTree(thirdPartyLicenseRoot, "mcode.node-red.licenses.tree.v1") !== marker.thirdPartyLicensesTreeSha256) {
      throw new Error("Packaged Node-RED third-party license tree digest mismatch");
    }
  } else if (thirdPartyLicenseFields.some(([, key]) => marker[key] != null)
      || marker.thirdPartyLicensesTreeSha256 != null) {
    throw new Error("Packaged Node-RED third-party license manifest missing");
  }
  const pkg = JSON.parse(fs.readFileSync(required(root, files[0][0]), "utf8"));
  if (pkg.name !== "node-red" || pkg.version !== VERSION) {
    throw new Error("Packaged Node-RED package version mismatch");
  }
  for (const relative of [
    "node_modules/express/package.json",
    "packages/node_modules/@node-red/runtime/package.json",
    "packages/node_modules/@node-red/editor-api/package.json",
  ]) required(root, relative);

  /* 【Q9e】**光"文件在"不等于"Node 能 require 到它"。**
   *
   * 生产 bootstrap 里是裸 `require("express")`（`registry.ts` 的引导脚本），靠
   * `NODE_PATH = <vendor>/packages/node_modules + <vendor>/node_modules` 解析。
   * 这个布局一旦变了（依赖被挪层、vendor 少一级），产物里仍然**每个文件都在、
   * 摘要全对**，而引擎一起来就是 `Error: Cannot find module 'express'` ——
   * 实测在 e2e 里正是这么挂的。
   *
   * 判据用**真的 `require.resolve`**，验的是"解析得到"，不是"我以为该有的文件在"。
   *
   * ⚠️ **摘要/清单类套件（t10/t88）用的是最小化假树**：它们的目的是验摘要与许可
   * 账本，不带真实依赖。这里按「树里到底有没有 node_modules/express」决定跑不跑，
   * 并在返回值里**如实标出**有没有验过 —— 不静默假装验了。
   */
  /* 判据用「**真依赖在不在**」而不是「package.json 在不在」：t10/t88 的假树会写一个
   * 只有 `{}` 的 `express/package.json` 占位，靠它判会误以为这是真实树。
   * `express/lib/express.js` 是真包的实际入口 —— 假树不会有。 */
  const looksReal = fs.existsSync(path.join(root, "node_modules", "express", "lib", "express.js"));
  let runtimeResolvable = false;
  if (looksReal) {
    const nodePath = [
      path.join(root, "packages", "node_modules"),
      path.join(root, "node_modules"),
    ].join(path.delimiter);
    const saved = process.env.NODE_PATH;
    process.env.NODE_PATH = nodePath;
    // Node 只在启动时读 NODE_PATH；运行时改完必须让 module 子系统重新算一次。
    require("node:module").Module._initPaths();
    try {
      // 引擎引导脚本里真正 require 的那几个（见 registry.ts 的 bootstrap 常量）。
      for (const id of ["express", "node-red", "@node-red/runtime"]) require.resolve(id);
      runtimeResolvable = true;
    } catch (error) {
      throw new Error("Packaged Node-RED runtime cannot resolve " + String(error && error.message)
        + " with NODE_PATH=" + nodePath);
    } finally {
      if (saved === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = saved;
      require("node:module").Module._initPaths();
    }
  }

  // Do not let a symlinked package root or nested dependency escape the copied
  // release tree; the source staging check alone cannot prove post-pack paths.
  const dependenciesRoot = requiredDirectory(root, "node_modules");
  const packagesRoot = requiredDirectory(root, "packages");
  assertSafeTree(dependenciesRoot);
  assertSafeTree(packagesRoot);
  if (typeof marker.dependenciesTreeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(marker.dependenciesTreeSha256)
      || hashTree(dependenciesRoot, "mcode.node-red.dependencies.tree.v1") !== marker.dependenciesTreeSha256) {
    throw new Error("Packaged Node-RED production dependency tree digest mismatch");
  }
  if (typeof marker.packageTreeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(marker.packageTreeSha256)
      || hashTree(packagesRoot, "mcode.node-red.packages.tree.v1") !== marker.packageTreeSha256) {
    throw new Error("Packaged Node-RED runtime/editor package tree digest mismatch");
  }
  const inventory = JSON.parse(fs.readFileSync(required(root, "third-party-license-inventory.json"), "utf8"));
  if (inventory.format !== "mcode.node-red.third-party-license-inventory.v1"
      || inventory.inventoryType !== "license-coverage-audit-not-sbom"
      || inventory.sourceCommit !== BASE_COMMIT
      || inventory.packageLockSha256 !== marker.lockSha256
      || !Array.isArray(inventory.packages)
      || !inventory.summary || typeof inventory.summary !== "object") {
    throw new Error("Packaged Node-RED third-party license inventory is invalid");
  }
  const actualInventory = createNodeRedLicenseInventory(root);
  if (JSON.stringify(inventory) !== JSON.stringify(actualInventory)) {
    throw new Error("Packaged Node-RED third-party license inventory differs from actual dependency/license files");
  }
  if (!inventory.summary.releaseEligible) {
    const unresolved = inventory.packages.filter(item => item.status !== "collected");
    const details = unresolved.map(item =>
      item.name + "@" + item.version + " [" + item.status + "; license="
      + (item.license == null ? "unknown" : JSON.stringify(item.license)) + "; " + item.path
      + (item.releaseBlocker ? "; reason=" + item.releaseBlocker.reason : "") + "]"
    );
    if (inventory.summary.unknownSpdxExpressions) details.push("unknown SPDX expressions=" + inventory.summary.unknownSpdxExpressions);
    if (inventory.summary.unmatchedLicenseManifestEntries) details.push("unmatched license manifest entries=" + inventory.summary.unmatchedLicenseManifestEntries);
    if (inventory.summary.unmatchedReleaseBlockers) details.push("unmatched release blockers=" + inventory.summary.unmatchedReleaseBlockers);
    throw new Error("Node-RED third-party license coverage incomplete; release blocked: "
      + details.join("; "));
  }
  return {
    version: pkg.version,
    sourceCommit: marker.sourceCommit,
    licenseCoverage: inventory.summary,
    /* 【Q9e】**如实标出这一棵树有没有验过"能 require"**。
     * 真实发布树里必须为 `true`；最小化假树（t10/t88）为 `false`。
     * 消费方可以据此区分「验过且通过」与「没验」—— 而不是把两者都读成"没问题"。 */
    runtimeResolvable,
  };
}
function verifyAfterPack(context) {
  if (!context || typeof context.appOutDir !== "string") {
    throw new Error("Node-RED post-pack gate requires Electron appOutDir");
  }
  const out = path.resolve(context.appOutDir);
  const candidates = [path.join(out, "resources", "node-red")];
  for (const item of fs.readdirSync(out, { withFileTypes: true })) {
    if (item.isDirectory() && item.name.endsWith(".app")) {
      candidates.push(path.join(out, item.name, "Contents", "Resources", "node-red"));
    }
  }
  const present = candidates.filter((candidate) => fs.existsSync(candidate));
  if (present.length !== 1) throw new Error("Expected one packaged Node-RED vendor resource directory, found " + present.length);
  return verifyNodeRedResource(present[0]);
}
module.exports = verifyAfterPack;
module.exports.verifyNodeRedResource = verifyNodeRedResource;
module.exports.required = required;
module.exports.requiredDirectory = requiredDirectory;
