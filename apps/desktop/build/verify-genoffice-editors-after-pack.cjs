"use strict";
/**
 * ARC-007 Electron-builder afterPack: keep the original GenOffice renderers
 * together. Staging success alone cannot prove extraResources survived packing.
 * This does NOT assert editor Host RPC / Rust sidecar / AI parity.
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  EDITOR_APPS, assertRendererAssetsReady, assertVendorTreeSafe, hashRendererTree,
} = require("./stage-genoffice-resources.cjs");

/** lstat every ancestor: fs.stat/realpath(renderer) alone misses a junction
 * at apps/ or docs/out pointing to a sibling directory within resources. */
function verifyPhysicalDirChain(root, parts = []) {
  let dir = root;
  for (const next of [null, ...parts]) {
    if (next !== null) dir = path.join(dir, next);
    let stat;
    try { stat = fs.lstatSync(dir); } catch (err) {
      if (err?.code === "ENOENT") throw new Error("Missing GenOffice editor directory: " + dir);
      throw err;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Unsafe GenOffice resource ancestor symlink/junction: " + dir);
    }
  }
}
/** The same afterPack hook must verify native CLI/PDFium/licences, not only
 * Vite renderer assets. An editor page with a missing engine entrypoint or a
 * zeroed WASM is a broken release even when all six HTML hashes are valid. */
function verifyPackagedNativeRuntime(root, bundled) {
  const nativeRoots = ["cli", "wasm", "licenses"];
  if (!bundled) {
    if (nativeRoots.some(name => fs.existsSync(path.join(root, name)))) {
      throw new Error("GenOffice native runtime unexpectedly present in opt-out release");
    }
    return;
  }
  for (const name of nativeRoots) verifyPhysicalDirChain(root, [name]);
  verifyPhysicalDirChain(root, ["cli", "node_modules"]);
  const required = [
    ["cli/genoffice.cjs", "GenOffice CLI"],
    ["wasm/pdfium.wasm", "PDFium WASM"],
    ["licenses/GenOffice-LICENSE", "GenOffice LICENSE"],
    ["licenses/GenOffice-NOTICE", "GenOffice NOTICE"],
    ["licenses/PDFium-LICENSE", "PDFium LICENSE"],
    ["licenses/PDFium-LICENSE.pdfium", "PDFium LICENSE.pdfium"],
  ];
  for (const [name, label] of required) {
    const file = path.join(root, name);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (err) {
      if (err?.code === "ENOENT") throw new Error(`GenOffice packaged native ${label} missing: ${file}`);
      throw err;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
      throw new Error(`GenOffice packaged native ${label} invalid: ${file}`);
    }
  }
  const wasm = fs.readFileSync(path.join(root, "wasm", "pdfium.wasm"));
  if (wasm.subarray(0, 4).toString("hex") !== "0061736d") {
    throw new Error("GenOffice packaged PDFium WASM invalid magic");
  }
}
function verifyPackagedGenofficeEditorAssets(resourceRoot) {
  const root = path.resolve(resourceRoot);
  verifyPhysicalDirChain(path.dirname(root), [path.basename(root)]);
  const marker = path.join(root, "availability.json");
  if (!fs.statSync(marker).isFile()) throw new Error("GenOffice packaged availability.json missing");
  const info = JSON.parse(fs.readFileSync(marker, "utf8"));
  if (info?.format !== "mcode.genoffice.resources.v1"
    || typeof info.bundled !== "boolean"
    || typeof info.editorsBundled !== "boolean"
    || !Array.isArray(info.editors)) {
    throw new Error("GenOffice packaged editor availability manifest invalid");
  }
  verifyPackagedNativeRuntime(root, info.bundled);
  if (!info.editorsBundled) {
    if (info.editors.length > 0 || fs.existsSync(path.join(root, "apps"))) {
      throw new Error("GenOffice editor assets unexpectedly present despite editorsBundled=false");
    }
    return { editorsBundled: false };
  }
  if (!info.bundled || JSON.stringify(info.editors) !== JSON.stringify(EDITOR_APPS)) {
    throw new Error("GenOffice six original editors require a complete CLI bundle and exact six-app manifest");
  }
  const digests = info.editorAssetsSha256;
  if (!digests || typeof digests !== "object" || Array.isArray(digests)
    || JSON.stringify(Object.keys(digests).sort()) !== JSON.stringify([...EDITOR_APPS].sort())
    || EDITOR_APPS.some((name) => typeof digests[name] !== "string"
      || !/^[0-9a-f]{64}$/.test(digests[name]))) {
    throw new Error("GenOffice original editor resource integrity manifest is missing or invalid");
  }
  for (const name of EDITOR_APPS) {
    const renderer = path.join(root, "apps", name, "out", "renderer");
    verifyPhysicalDirChain(root, ["apps", name, "out", "renderer", "assets"]);
    if (!fs.statSync(renderer).isDirectory()) throw new Error("GenOffice " + name + " renderer directory missing");
    assertVendorTreeSafe(root, renderer);
    assertRendererAssetsReady(renderer, name);
    if (hashRendererTree(renderer) !== digests[name]) {
      throw new Error(`GenOffice ${name} renderer integrity digest mismatch (missing or changed vendor asset)`);
    }
  }
  return { editorsBundled: true, editors: [...EDITOR_APPS] };
}

/**
 * Electron-builder afterPack appOutDir varies: win-unpacked/resources, Linux
 * linux-unpacked/resources, mac/GenOffice.app/Contents/Resources.
 */
function verifyAfterPack(context) {
  if (!context || typeof context.appOutDir !== "string") {
    throw new Error("GenOffice post-pack gate requires Electron appOutDir");
  }
  const out = path.resolve(context.appOutDir);
  const candidates = [path.join(out, "resources", "genoffice")];
  for (const entry of fs.readdirSync(out, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith(".app")) {
      candidates.push(path.join(out, entry.name, "Contents", "Resources", "genoffice"));
    }
  }
  const matches = candidates.filter((dir) => fs.existsSync(dir));
  if (matches.length !== 1) {
    throw new Error("Expected exactly one packaged GenOffice resources directory, got " + matches.length);
  }
  return verifyPackagedGenofficeEditorAssets(matches[0]);
}

module.exports = verifyAfterPack;
module.exports.verifyPackagedGenofficeEditorAssets = verifyPackagedGenofficeEditorAssets;
module.exports.verifyPhysicalDirChain = verifyPhysicalDirChain;
