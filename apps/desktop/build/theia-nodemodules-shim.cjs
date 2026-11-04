"use strict";

/**
 * Theia is an extraResources tree, not an appDir dependency. electron-builder
 * hard-codes an exclusion for a source-root directory literally named
 * "node_modules" before applying filters. Rename that one root for the copy,
 * then restore it in the packaged resources before the Theia afterPack probe.
 *
 * This mirrors the Node-RED shim but handles both Windows resources/ and the
 * macOS .app/Contents/Resources/ layout.
 */
const fs = require("node:fs");
const path = require("node:path");

const THEIA_RUNTIME = path.resolve(__dirname, "../../../vendor/theia-runtime");
const ORIGINAL = path.join(THEIA_RUNTIME, "node_modules");
const RENAMED = path.join(THEIA_RUNTIME, "__mcode_node_modules");
function packagedTheiaRoots(appOutDir) {
  const out = path.resolve(appOutDir);
  const candidates = [
    path.join(out, "resources", "theia"),
    path.join(out, "Contents", "Resources", "theia"),
  ];
  let entries = [];
  try { entries = fs.readdirSync(out, { withFileTypes: true }); } catch { return []; }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.toLowerCase().endsWith(".app")) {
      candidates.push(path.join(out, entry.name, "Contents", "Resources", "theia"));
    }
  }
  return [...new Set(candidates.filter(candidate => fs.existsSync(candidate)))];
}

function hideTheiaNodeModules(runtimeRoot = THEIA_RUNTIME) {
  const root = path.resolve(runtimeRoot);
  if (!fs.existsSync(path.join(root, "package.json"))) {
    throw new Error("[Theia node_modules shim] runtime package.json missing: " + root);
  }
  const original = path.join(root, "node_modules");
  const renamed = path.join(root, "__mcode_node_modules");
  if (!fs.existsSync(original)) {
    if (fs.existsSync(renamed)) return false;
    throw new Error("[Theia node_modules shim] neither node_modules nor __mcode_node_modules exists: " + root);
  }
  if (fs.existsSync(renamed)) {
    throw new Error("[Theia node_modules shim] both source directories exist; refusing to guess: " + root);
  }
  const stat = fs.lstatSync(original);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("[Theia node_modules shim] source node_modules must be a real directory: " + original);
  }
  fs.renameSync(original, renamed);
  console.log("[Theia node_modules shim] source node_modules hidden for extraResources");
  return true;
}

function restoreTheiaSourceNodeModules(runtimeRoot = THEIA_RUNTIME) {
  const root = path.resolve(runtimeRoot);
  const original = path.join(root, "node_modules");
  const renamed = path.join(root, "__mcode_node_modules");
  if (!fs.existsSync(renamed)) return false;
  if (fs.existsSync(original)) {
    throw new Error("[Theia node_modules shim] both source directories exist during restore: " + root);
  }
  fs.renameSync(renamed, original);
  console.log("[Theia node_modules shim] source node_modules restored");
  return true;
}

function restorePackedTheiaNodeModules(appOutDir) {
  const roots = packagedTheiaRoots(appOutDir);
  if (roots.length > 1) {
    throw new Error("[Theia node_modules shim] multiple packaged Theia roots found: " + roots.join("; "));
  }
  if (roots.length === 0) return false;

  const root = roots[0];
  const original = path.join(root, "node_modules");
  const renamed = path.join(root, "__mcode_node_modules");
  if (!fs.existsSync(renamed)) return false;
  if (fs.existsSync(original)) {
    throw new Error("[Theia node_modules shim] both packed directories exist; refusing to overwrite: " + root);
  }
  fs.renameSync(renamed, original);
  console.log("[Theia node_modules shim] packed node_modules restored before Theia verification");
  return true;
}

module.exports = {
  hideTheiaNodeModules,
  restoreTheiaSourceNodeModules,
  restorePackedTheiaNodeModules,
  THEIA_RUNTIME,
  ORIGINAL,
  RENAMED,
  packagedTheiaRoots,
};
