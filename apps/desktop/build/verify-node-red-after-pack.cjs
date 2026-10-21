"use strict";
/** T19: reject packaged Node-RED resources missing upstream editor, code or version. */
const fs = require("node:fs");
const path = require("node:path");
const { hashFile, BASE_COMMIT, VERSION } = require("./stage-node-red-resources.cjs");
function required(root, relative) {
  const file = path.join(root, relative);
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size === 0) {
    throw new Error("Invalid packaged Node-RED file: " + file);
  }
  return file;
}
function verifyNodeRedResource(root) {
  const marker = JSON.parse(fs.readFileSync(required(root, "manifest.json"), "utf8"));
  if (marker.format !== "mcode.node-red.release.v1" ||
      marker.version !== VERSION || marker.sourceCommit !== BASE_COMMIT) {
    throw new Error("Packaged Node-RED manifest/version/commit mismatch");
  }
  const files = [
    ["packages/node_modules/node-red/package.json", "packageSha256"],
    ["packages/node_modules/@node-red/editor-client/public/red/red.min.js", "editorSha256"],
    ["package-lock.json", "lockSha256"],
  ];
  for (const [relative, key] of files) {
    if (typeof marker[key] !== "string" || !/^[a-f0-9]{64}$/.test(marker[key]) ||
        hashFile(required(root, relative)) !== marker[key]) {
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
    "LICENSE",
  ]) required(root, relative);
  return { version: pkg.version, sourceCommit: marker.sourceCommit };
}
function verifyAfterPack(context) {
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
