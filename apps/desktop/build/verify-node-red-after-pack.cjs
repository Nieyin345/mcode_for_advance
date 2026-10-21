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
  const pkg = JSON.parse(fs.readFileSync(required(root, files[0][0]), "utf8"));
  if (pkg.name !== "node-red" || pkg.version !== VERSION) {
    throw new Error("Packaged Node-RED package version mismatch");
  }
  for (const relative of [
    "node_modules/express/package.json",
    "packages/node_modules/@node-red/runtime/package.json",
    "packages/node_modules/@node-red/editor-api/package.json",
  ]) required(root, relative);

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
      + (item.license == null ? "unknown" : JSON.stringify(item.license)) + "; " + item.path + "]"
    );
    throw new Error("Node-RED third-party license coverage incomplete; release blocked: "
      + details.join("; "));
  }
  return {
    version: pkg.version,
    sourceCommit: marker.sourceCommit,
    licenseCoverage: inventory.summary,
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
