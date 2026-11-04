"use strict";
/**
 * B-02/B-05 release gate. Verify the ACTUAL electron-builder appOutDir, not
 * the source native build directory: extraResources can silently omit files.
 * This runs under the build host whose N-API ABI matches the Electron bundle.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function resourcesIn(appOutDir) {
  const out = path.resolve(appOutDir);
  // electron-builder provides the .app bundle itself on macOS; some isolated
  // package fixtures instead supply its containing directory. Never search
  // for an arbitrary resources/native-fs tree: a decoy could satisfy the
  // verifier while the real application lacks its native addon.
  if (path.extname(out).toLowerCase() === ".app") {
    return [path.join(out, "Contents", "Resources")];
  }
  const macApp = path.join(out, "Mcode.app");
  const windowsResources = path.join(out, "resources");
  if (fs.existsSync(macApp)) {
    if (fs.existsSync(windowsResources)) {
      throw new Error("[verify-native-fs] ambiguous packaged app layout: both macOS and Windows resources exist");
    }
    return [path.join(macApp, "Contents", "Resources")];
  }
  return [windowsResources];
}

function verifiedResources(appOutDir) {
  const out = path.resolve(appOutDir);
  const rootInfo = fs.lstatSync(out);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("[verify-native-fs] packaged appOutDir is a symbolic link or not a real directory: " + out);
  }
  const resources = resourcesIn(out)[0];
  // Check each package-owned ancestor rather than just the final resources
  // directory: .app/Contents could be a symlink/junction to an outside tree.
  const parts = path.relative(out, resources).split(path.sep).filter(Boolean);
  let current = out;
  for (const part of parts) {
    current = path.join(current, part);
    let info;
    try { info = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      throw new Error("[verify-native-fs] packaged app has no resources directory: " + resources);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("[verify-native-fs] packaged resources ancestor is a symbolic link or not a real directory: " + current);
    }
  }
  return resources;
}

async function verifyNativeFsAfterPack(context) {
  if (!context || typeof context.appOutDir !== "string" || !path.isAbsolute(context.appOutDir)) {
    throw new Error("[verify-native-fs] appOutDir must be an absolute packaged output path");
  }
  const resources = verifiedResources(context.appOutDir);
  const directory = path.join(resources, "native-fs");
  let folder;
  try { folder = fs.lstatSync(directory); }
  catch { throw new Error("[verify-native-fs] packaged native-fs directory missing: " + directory); }
  if (!folder.isDirectory() || folder.isSymbolicLink()) {
    throw new Error("[verify-native-fs] packaged native-fs directory is not a real directory: " + directory);
  }

  const binary = path.join(directory, "mcode_fs.node");
  let info;
  try { info = fs.lstatSync(binary); }
  catch { throw new Error("[verify-native-fs] packaged native addon missing: " + binary); }
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) {
    throw new Error("[verify-native-fs] packaged native addon must be a non-empty regular file: " + binary);
  }

  // Probe in an isolated Node process. Loading a DLL in the electron-builder
  // parent would keep the packaged .node locked on Windows through NSIS staging.
  const result = spawnSync(process.execPath,
    [path.join(__dirname, "probe-native-fs.cjs"), binary],
    { encoding: "utf8", timeout: 15000, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  if (result.error || result.status !== 0 || !result.stdout.includes("NATIVE_FS_PROBE_OK")) {
    throw new Error("[verify-native-fs] packaged addon cannot load or openRoot probe failed: " +
      String(result.error?.message || result.stderr || result.stdout || result.signal || "unknown error").slice(0, 2000));
  }
  console.log("[verify-native-fs] PASS: packaged N-API addon exists, loads, and opens a pinned root: " + binary);
}

module.exports = verifyNativeFsAfterPack;
module.exports.resourcesIn = resourcesIn;
