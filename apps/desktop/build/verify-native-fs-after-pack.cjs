"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function resourceRoots(appOutDir) {
  return [
    path.join(appOutDir, "resources", "native-fs"),
    path.join(appOutDir, "Resources", "native-fs"),
    path.join(appOutDir, "Contents", "Resources", "native-fs"),
    path.join(appOutDir, "Mcode.app", "Contents", "Resources", "native-fs"),
  ];
}

module.exports = async function verifyNativeFsAfterPack(context) {
  const roots = resourceRoots(context.appOutDir);
  // Prefer the candidate that actually contains the addon. Some bundle layouts
  // can expose both a generic resources directory and the app's real Resources.
  const resourceRoot = roots.find((candidate) =>
    fs.existsSync(path.join(candidate, "mcode_fs.node")),
  ) ?? roots.find((candidate) => fs.existsSync(candidate));
  if (!resourceRoot) {
    throw new Error(
      "[verify-native-fs] packaged app is missing resources/native-fs. " +
      "Check electron-builder.yml extraResources and build-native-fs.cjs. Searched: " +
      roots.join(", "),
    );
  }

  const binary = path.join(resourceRoot, "mcode_fs.node");
  let info;
  try {
    info = fs.lstatSync(binary);
  } catch {
    throw new Error("[verify-native-fs] packaged native addon is missing: " + binary);
  }
  if (!info.isFile() || info.size === 0) {
    throw new Error("[verify-native-fs] packaged native addon is not a non-empty regular file: " + binary);
  }

  let addon;
  try {
    addon = require(binary);
  } catch (error) {
    throw new Error(
      "[verify-native-fs] packaged native addon cannot be loaded by the build host: " +
      (error instanceof Error ? error.message : String(error)),
    );
  }
  if (typeof addon.openRoot !== "function" ||
      !Number.isFinite(Number(addon.napiVersion)) || Number(addon.napiVersion) < 8) {
    throw new Error("[verify-native-fs] packaged addon does not expose the required N-API 8 interface");
  }

  const root = addon.openRoot(os.tmpdir());
  try {
    const stat = await root.stat([]);
    if (stat.type !== "directory") {
      throw new Error("[verify-native-fs] packaged addon did not open a directory root");
    }
  } finally {
    root.close();
  }

  console.log("[verify-native-fs] ✓ packaged N-API addon exists, loads, and opens a pinned root");
};
